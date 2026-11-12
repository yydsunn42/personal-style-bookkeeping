import { GROUPS } from "./hierarchy";
import { weeklyPath, weeklyBody } from "./weekly";
import { App, TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import { canRecordTransfer, customFieldDefaultValue, customFieldKey, isReservedTransactionProperty, usableDefaultType } from "./types";
import type { BookkeepingSettings, CustomFieldConfig, EntryField, MonthSummary, Transaction, TransactionDraft } from "./types";
import { errorMessageZh, escapeCsv, monthOf, normalizeDate, normalizeTime, parseCsv, roundMoney, safeFolder, sanitizeFileName } from "./utils";
import { PRINCIPAL_TYPES, currencyCode, outstanding, validateFinance } from "./finance";
import type { FinanceDetails } from "./types";

type Frontmatter = Record<string, unknown>;

function isFrontmatter(value: unknown): value is Frontmatter {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface ImportFailure {
  row: number;
  reason: string;
  raw: string[];
}

export interface ImportResult {
  imported: number;
  skipped: number;
  failures: ImportFailure[];
  failureReport?: TFile;
}

export interface LegacyConversionResult {
  converted: number;
  skipped: number;
  failed: number;
  total: number;
  failureFolder?: string;
}

export interface ExternalLegacyImportResult {
  imported: number;
  skipped: number;
  failed: number;
  total: number;
  failureFolder?: string;
}

interface LegacyFailureSource {
  name: string;
  path: string;
  reason: string;
  content: string;
}

interface VaultLegacyCandidate {
  file: TFile;
  content: string;
  draft?: TransactionDraft;
  reason?: string;
}

export interface CsvMetadataAnalysis {
  differences: string[];
  hasDifferences: boolean;
}

export interface CsvCustomFieldConfiguration {
  version: 1;
  builtInEnabled: {
    account: boolean;
    type: boolean;
    necessity: boolean;
    category: boolean;
    note: boolean;
    attachments: boolean;
  };
  fields: CustomFieldConfig[];
  optionFieldOrder: EntryField[];
}

export interface PendingDelete {
  file: TFile;
  originalPath: string;
  transactionId?: string;
  /** Daily-storage deletion is a record tombstone, not a whole-file move. */
  deletedRecord?: Frontmatter;
  /** Preserves the source when deleting the final record also removes its daily file. */
  deletedDailyFileContent?: string;
}

export interface StorageMigrationResult {
  migrated: number;
  skipped: number;
  from: "single" | "daily" | "weekly";
  to: "single" | "daily" | "weekly";
}

export interface ExportOptions {
  folder?: string;
  fileName?: string;
  dateFrom?: string;
  dateTo?: string;
  transactionIds?: string[];
  includeFieldConfig?: boolean;
}

const CSV_FIELD_CONFIG_PREFIX = "#EasyBookkeepingCustomFields=";

export class TransactionStore {
  private writes: Promise<unknown> = Promise.resolve();
  private recoveryBlocked = false;
  private migrationSnapshot: Transaction[] | null = null;
  private cacheGeneration = 0;
  private parsedFiles = new Map<string, { stamp: string; properties: Frontmatter }>();
  private indexedTransactions: { generation: number; stamp: string; items: Transaction[] } | null = null;

  invalidate(path?: string): void {
    this.cacheGeneration++;
    this.indexedTransactions = null;
    if (path) this.parsedFiles.delete(path);
    else this.parsedFiles.clear();
  }

  private async listingProperties(file: TFile): Promise<Frontmatter> {
    const stamp = file.stat ? `${file.stat.mtime}:${file.stat.size}` : "";
    const cached = this.parsedFiles.get(file.path);
    if (stamp && cached?.stamp === stamp) return cached.properties;
    const generation = this.cacheGeneration;
    const properties = await this.properties(file);
    if (stamp && generation === this.cacheGeneration) this.parsedFiles.set(file.path, { stamp, properties });
    return properties;
  }
  private exclusive<T>(operation: () => Promise<T>, recovery = false): Promise<T> {
    const run = (): Promise<T> => {
      if (this.recoveryBlocked && !recovery) throw new Error("存在未解决的恢复冲突，已暂停写入");
      return operation();
    };
    const next = this.writes.then(run, run).finally(() => this.invalidate());
    this.writes = next.catch(() => undefined);
    return next;
  }

  private excludedPath(path: string): boolean {
    return path.split("/").some((part) => part.startsWith(".bookkeeping-") || part.startsWith("_bookkeeping-") || part.startsWith("旧版转换失败-"));
  }

  private document(content: string): { properties: Frontmatter; body: string } {
    const match = content.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
    if (!match) throw new Error("账目文件缺少可读的Properties");
    const properties: unknown = parseYaml(match[1] ?? "");
    if (!isFrontmatter(properties)) throw new Error("账目文件格式不正确");
    return { properties, body: match[2] ?? "" };
  }

  private serialize(properties: Frontmatter, body = ""): string {
    return `---\n${stringifyYaml(properties)}---\n${body}`;
  }

  private async properties(file: TFile): Promise<Frontmatter> {
    return this.document(await this.app.vault.read(file)).properties;
  }

  private dailyRecords(properties: Frontmatter): Frontmatter[] {
    const records = properties["账目列表"];
    if (!Array.isArray(records) || records.some((record) => !isFrontmatter(record))) throw new Error("每日账目文件格式不正确");
    return records as Frontmatter[];
  }

  private withAttachments(content: string, records: Frontmatter[], format = this.getSettings().storageFormat): string {
    const paths = [...new Set([...records].sort((a,b) => String(a["时间"]).localeCompare(String(b["时间"]))).flatMap((record) => this.readStringList(record["附件"])))];
    const body = content.replace(/\n?<!-- bookkeeping-attachments:start -->[\s\S]*?<!-- bookkeeping-attachments:end -->\n?/g, "");
    return body.replace(/\n?<!-- bookkeeping-weekly:start -->[\s\S]*?<!-- bookkeeping-weekly:end -->\n?/g, "") + (format === "weekly" ? weeklyBody(records) : "") + this.attachmentSection(paths);
  }
  constructor(private readonly app: App, private readonly getSettings: () => BookkeepingSettings) {}

  async list(): Promise<Transaction[]> {
    if (this.migrationSnapshot) return [...this.migrationSnapshot];
    const settings = this.getSettings();
    const root = `${safeFolder(settings.ledgerFolder)}/`;
    const trashRoot = `${safeFolder(settings.ledgerFolder)}/_bookkeeping-trash/`;
    const transactions: Transaction[] = [];

    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(root) && !file.path.startsWith(trashRoot) && !this.excludedPath(file.path));
    const stamp = files.every((file) => file.stat) ? files.map((file) => `${file.path}:${file.stat.mtime}:${file.stat.size}`).sort().join("|") : "";
    const generation = this.cacheGeneration;
    const clone = (items: Transaction[]): Transaction[] => items.map((item) => ({ ...item, tags: [...item.tags], attachments: [...item.attachments], customValues: { ...item.customValues }, finance: item.finance ? { ...item.finance } : undefined, rawProperties: item.rawProperties ? JSON.parse(JSON.stringify(item.rawProperties)) as Frontmatter : undefined }));
    if (stamp && this.indexedTransactions?.stamp === stamp && this.indexedTransactions.generation === generation) return clone(this.indexedTransactions.items);
    for (const file of files) {
      let frontmatter: Frontmatter;
      try { frontmatter = await this.listingProperties(file); } catch { continue; }
      if (!isFrontmatter(frontmatter)) continue;
      const dailyRecords = frontmatter["账目列表"];
      if (Array.isArray(dailyRecords)) {
        for (const record of dailyRecords) {
          if (!isFrontmatter(record)) continue;
          const transaction = this.fromFrontmatter(file, record);
          if (transaction) transactions.push(transaction);
        }
      } else {
        const transaction = this.fromFrontmatter(file, frontmatter);
        if (transaction) transactions.push(transaction);
      }
    }

    transactions.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
    if (stamp && generation === this.cacheGeneration) this.indexedTransactions = { generation, stamp, items: transactions };
    return clone(transactions);
  }

  async transactionById(id: string): Promise<Transaction | null> {
    const matches = (await this.list()).filter((item) => item.id === id);
    if (matches.length > 1) throw new Error("存在重复账目ID，请先处理冲突");
    return matches[0] ?? null;
  }

  async setBaseCurrency(value: string): Promise<void> {
    return this.exclusive(async () => {
      const settings = this.getSettings(), code = currencyCode(value);
      if (code === settings.finance.baseCurrency) return;
      if ((await this.list()).some((item) => item.finance) || settings.finance.templates.length || settings.finance.recurring.length || settings.planning?.goals.length || Object.keys(settings.planning?.budgetBases ?? {}).length) throw new Error("已有账目时不能直接更换本位币");
      settings.finance.baseCurrency = code; settings.finance.rates = {}; settings.currency = code;
    });
  }

  async exportHealthReport(): Promise<TFile> {
    const issues = await this.healthCheck();
    const folder = `${safeFolder(this.getSettings().ledgerFolder)}/.bookkeeping-reports`;
    await this.ensureFolder(folder);
    return this.app.vault.create(`${folder}/health-${this.makeId()}.json`, JSON.stringify({ createdAt: new Date().toISOString(), issues }, null, 2));
  }

  async restoreCompletedBackup(file: TFile): Promise<number> {
    await this.exclusive(async () => {
      const root = `${safeFolder(this.getSettings().ledgerFolder)}/`;
      if (!file.path.startsWith(`${root}_bookkeeping-recovery/`) || file.extension !== "json") throw new Error("恢复备份格式不正确");
      const journal: unknown = JSON.parse(await this.app.vault.read(file));
      if (!isFrontmatter(journal) || journal["status"] !== "complete" || journal["version"] !== 1 || !["single", "daily", "weekly"].includes(String(journal["from"])) || !isFrontmatter(journal["before"]) || !isFrontmatter(journal["after"])) throw new Error("恢复备份格式不正确");
      const before = journal["before"], after = journal["after"];
      if (Object.keys(before).length !== Object.keys(after).length) throw new Error("恢复备份格式不正确");
      for (const path of Object.keys(before)) {
        if (!path.startsWith(root) || path.split("/").some((part) => part === ".." || part === ".") || this.excludedPath(path) || !path.endsWith(".md") || !(path in after) || ![before[path], after[path]].every((value) => value === null || typeof value === "string")) throw new Error("恢复备份格式不正确");
        const current = this.app.vault.getAbstractFileByPath(path);
        if ((current instanceof TFile ? await this.app.vault.read(current) : null) !== after[path]) throw new Error("账目已发生变化，请刷新后重试");
      }
      await this.app.vault.modify(file, JSON.stringify({ ...journal, status: "prepared" }, null, 2));
      this.recoveryBlocked = true;
    });
    return this.recoverInterruptedMigrations();
  }

  async create(draft: TransactionDraft, skipContentCheck = false, preserveFields = false, importedId = ""): Promise<TFile> {
    return this.exclusive(async () => {
      if (importedId && (await this.list()).some((item) => item.id === importedId)) throw new Error("存在重复账目ID，请先处理冲突");
      return this.createInternal(draft, skipContentCheck, preserveFields, importedId);
    });
  }

  /** Journal an entire multi-record operation before changing any Markdown file. */
  async settleRelated(source: Transaction, draft: TransactionDraft): Promise<string[]> {
    return this.commitDrafts([draft], undefined, "", source);
  }

  async commitDrafts(drafts: TransactionDraft[], replace?: Transaction, occurrence = "", related?: Transaction): Promise<string[]> {
    return this.exclusive(async () => {
      if (!drafts.length) return [];
      const settings = this.getSettings();
      const existing = await this.list();
      if (related) {
        const original = existing.find((item) => item.id === related.id);
        if (!original || drafts.length !== 1 || drafts[0]?.finance?.relatedId !== original.id || drafts[0].amount <= 0 || drafts[0].amount > outstanding(original, existing) + 0.001) throw new Error("Settlement exceeds outstanding amount");
        this.assertSnapshot(original.rawProperties ?? {}, related);
        const kind = drafts[0]!.finance?.kind;
        const expected = original.finance?.kind === "borrow" ? ["repayment"] : original.finance?.kind === "lend" ? ["collection"] : this.typeEffect(original.type) === "negative" && (!original.finance?.kind || original.finance.kind === "split") ? ["refund", "reimbursement"] : [];
        if (!expected.includes(kind ?? "")) throw new Error("Invalid finance data");
      }
      if (occurrence && existing.some((item) => item.finance?.occurrence === occurrence)) return [];
      if (replace && existing.some((item) => item.finance?.relatedId === replace.id)) throw new Error("Linked transactions cannot be split");
      const before: Record<string, string | null> = {}, after: Record<string, string | null> = {};
      const ids: string[] = [];
      const load = async (path: string): Promise<string | null> => {
        if (Object.prototype.hasOwnProperty.call(after, path)) return after[path] ?? null;
        const file = this.app.vault.getAbstractFileByPath(path);
        const content = file instanceof TFile ? await this.app.vault.read(file) : null;
        before[path] = content; after[path] = content; return content;
      };
      for (let index = 0; index < drafts.length; index++) {
        const draft = drafts[index]!;
        if (!normalizeDate(draft.date) || !draft.title.trim() || !Number.isFinite(draft.amount) || draft.amount < 0) throw new Error("Invalid transaction");
        validateFinance(draft, settings);
        const replacing = index === 0 ? replace : undefined;
        if (replacing && replacing.date !== draft.date) throw new Error("Split date must match original date");
        const id = replacing?.id ?? this.makeId(); ids.push(id);
        const raw = replacing ? this.mergeRecord(replacing.rawProperties ?? {}, draft, replacing) : this.toFrontmatter(draft, false, id, true);
        const [year, month, day] = draft.date.split("-");
        let path = replacing?.file.path ?? (settings.storageFormat !== "single" ? this.storagePathForDraft(draft, settings.storageFormat) : `${safeFolder(settings.ledgerFolder)}/${year}/${month}/${day}/${id}.md`);
        path = normalizePath(path);
        const content = await load(path);
        if (replacing) {
          if (content === null) throw new Error("账目已发生变化，请刷新后重试");
          const doc = this.document(content);
          if (Array.isArray(doc.properties["账目列表"])) {
            let found = false;
            const records = this.dailyRecords(doc.properties).map((record) => {
              if (record["账目ID"] !== replacing.id) return record;
              this.assertSnapshot(record, replacing); found = true; return raw;
            });
            if (!found) throw new Error("账目已发生变化，请刷新后重试");
            after[path] = this.serialize({ ...doc.properties, "账目列表": records }, this.withAttachments(doc.body, records));
          } else { this.assertSnapshot(doc.properties, replacing); after[path] = this.serialize(raw, this.withAttachments(doc.body, [raw])); }
        } else if (settings.storageFormat !== "single") {
          const doc = content === null ? { properties: { "记账插件": true, "账目列表": [] }, body: "" } : this.document(content);
          const records = [...this.dailyRecords(doc.properties), raw];
          after[path] = this.serialize({ ...doc.properties, "账目列表": records }, this.withAttachments(doc.body, records));
        } else {
          if (content !== null) throw new Error("存在重复账目ID，请先处理冲突");
          after[path] = this.serialize(raw, this.withAttachments("", [raw]));
        }
      }
      const root = `${safeFolder(settings.ledgerFolder)}/_bookkeeping-recovery`;
      await this.ensureFolder(root);
      const journal = { version: 1, from: settings.storageFormat, to: settings.storageFormat, status: "prepared", operation: "batch", before, after };
      const backup = await this.app.vault.create(`${root}/${this.makeId()}.json`, JSON.stringify(journal, null, 2));
      this.migrationSnapshot = existing;
      const changed: string[] = [];
      try {
        for (const [path, content] of Object.entries(after)) {
          if (content === null) continue;
          await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
          const file = this.app.vault.getAbstractFileByPath(path);
          changed.push(path);
          if (file instanceof TFile) await this.app.vault.process(file, (current) => {
            if (current !== before[path]) throw new Error("账目已发生变化，请刷新后重试");
            return content;
          });
          else {
            if (before[path] !== null) throw new Error("账目已发生变化，请刷新后重试");
            await this.app.vault.create(path, content);
          }
        }
        await this.app.vault.modify(backup, JSON.stringify({ ...journal, status: "complete" }, null, 2));
      } catch (error) {
        try {
          for (const path of changed.reverse()) {
            const file = this.app.vault.getAbstractFileByPath(path);
            const current = file instanceof TFile ? await this.app.vault.read(file) : null;
            if (current === before[path]) continue;
            if (current !== after[path]) throw new Error("存在未解决的恢复冲突，已暂停写入");
            if (file instanceof TFile) {
              if (before[path] === null) await this.app.fileManager.trashFile(file);
              else await this.app.vault.process(file, (text) => { if (text !== after[path]) throw new Error("账目已发生变化，请刷新后重试"); return before[path]!; });
            }
          }
          await this.app.vault.modify(backup, JSON.stringify({ ...journal, status: "rolled-back" }, null, 2));
        } catch { this.recoveryBlocked = true; }
        throw error;
      } finally { this.migrationSnapshot = null; }
      return ids;
    });
  }

  /** Read-only diagnostics include malformed files deliberately omitted from list(). */
  async healthCheck(): Promise<Array<{ code: string; path: string; id: string; detail: string }>> {
    this.invalidate();
    const issues: Array<{ code: string; path: string; id: string; detail: string }> = [];
    const ids = new Set<string>();
    const items = await this.list();
    const root = `${safeFolder(this.getSettings().ledgerFolder)}/`;
    for (const file of this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(root) && !this.excludedPath(file.path))) {
      try {
        const content = await this.app.vault.read(file);
        if (!/^(?:记账插件|账目列表|金额)\s*:/m.test(content)) continue;
        const props = this.document(content).properties;
        if (!props["记账插件"] && !("金额" in props) && !("账目列表" in props)) continue;
        const records = "账目列表" in props ? this.dailyRecords(props) : [props];
        for (const record of records) {
          if (!this.fromFrontmatter(file, record)) issues.push({ code: "invalid-record", path: file.path, id: String(record["账目ID"] ?? ""), detail: "Invalid date or amount" });
          if (Number(record["金额"]) < 0) issues.push({ code: "negative-amount", path: file.path, id: String(record["账目ID"] ?? ""), detail: "Negative stored amount" });
          if (!String(record["账目ID"] ?? "").trim()) issues.push({ code: "missing-id", path: file.path, id: "", detail: "Legacy record without UUID" });
        }
      } catch (error) { issues.push({ code: "invalid-file", path: file.path, id: "", detail: errorMessageZh(error) }); }
    }
    const byId = new Map(items.map((item) => [item.id, item]));
    const occurrences = new Set<string>();
    const settlements = new Map<string, number>();
    for (const item of items) if (item.finance?.relatedId) settlements.set(item.finance.relatedId, (settlements.get(item.finance.relatedId) ?? 0) + item.amount);
    for (const item of items) {
      const report = (code: string, detail: string): void => { issues.push({ code, path: item.file.path, id: item.id, detail }); };
      if (ids.has(item.id)) report("duplicate-id", item.id); ids.add(item.id);
      if (item.finance?.occurrence) { if (occurrences.has(item.finance.occurrence)) report("duplicate-occurrence", item.finance.occurrence); occurrences.add(item.finance.occurrence); }
      if (item.finance?.relatedId && !byId.has(item.finance.relatedId)) report("missing-related", item.finance.relatedId);
      if (item.finance?.relatedId === item.id) report("self-related", item.id);
      if (item.finance) try { validateFinance(item, this.getSettings()); } catch (error) { report("invalid-currency", errorMessageZh(error)); }
      for (const path of item.attachments) if (!this.app.vault.getAbstractFileByPath(path)) report("missing-attachment", path);
      const repaid = settlements.get(item.id) ?? 0;
      if (repaid > item.amount + 0.001) report("over-settled", String(repaid));
    }
    const recovery = this.app.vault.getAbstractFileByPath(`${root}_bookkeeping-recovery`);
    if (recovery instanceof TFolder) for (const file of recovery.children) if (file instanceof TFile && file.extension === "json") {
      try { if ((JSON.parse(await this.app.vault.read(file)) as { status?: string }).status === "prepared") issues.push({ code: "pending-recovery", path: file.path, id: "", detail: "Interrupted operation" }); }
      catch { issues.push({ code: "invalid-backup", path: file.path, id: "", detail: "Invalid JSON" }); }
    }
    return issues;
  }
  /** A preview is not write authority: application re-derives and compares it under the write lock. */
  async previewMissingIds(path: string): Promise<{ path: string; before: string; after: string; count: number }> {
    const root = `${safeFolder(this.getSettings().ledgerFolder)}/`;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!path.startsWith(root) || path.split("/").some((part) => part === "." || part === "..") || this.excludedPath(path) || !(file instanceof TFile) || file.extension !== "md") throw new Error("账目文件格式不正确");
    const before = await this.app.vault.read(file), doc = this.document(before);
    const records = "账目列表" in doc.properties ? this.dailyRecords(doc.properties) : [doc.properties];
    const items = await this.list();
    let count = 0;
    for (const record of records) {
      const item = this.fromFrontmatter(file, record);
      if (!item) throw new Error("账目文件格式不正确");
      if (!String(record["账目ID"] ?? "").trim() && items.some((other) => other.finance?.relatedId === item.id)) throw new Error("账目已发生变化，请刷新后重试");
      if (!String(record["账目ID"] ?? "").trim()) { record["账目ID"] = this.makeId(); count++; }
    }
    return { path, before, after: this.serialize(doc.properties, doc.body), count };
  }
  async repairMissingIds(preview: { path: string; before: string; after: string; count: number }): Promise<void> {
    return this.exclusive(async () => {
      const fresh = await this.previewMissingIds(preview.path);
      if (fresh.before !== preview.before || !fresh.count) throw new Error("账目已发生变化，请刷新后重试");
      const proposed = this.document(preview.after), original = this.document(preview.before);
      const rows = "账目列表" in proposed.properties ? this.dailyRecords(proposed.properties) : [proposed.properties];
      const oldRows = "账目列表" in original.properties ? this.dailyRecords(original.properties) : [original.properties];
      const ids = new Set((await this.list()).map((item) => item.id));
      if (rows.length !== oldRows.length || proposed.body !== original.body) throw new Error("账目文件格式不正确");
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!, old = oldRows[index]!;
        if (!String(old["账目ID"] ?? "").trim()) {
          const id = row["账目ID"];
          if (typeof id !== "string" || !id.trim() || ids.has(id)) throw new Error("账目文件格式不正确");
          ids.add(id); delete row["账目ID"]; delete old["账目ID"];
        }
      }
      if (this.canonical(proposed) !== this.canonical(original)) throw new Error("账目文件格式不正确");
      const folder = `${safeFolder(this.getSettings().ledgerFolder)}/_bookkeeping-recovery`;
      await this.ensureFolder(folder);
      const format = this.getSettings().storageFormat, journal = { version: 1, from: format, to: format, status: "prepared", operation: "repair-id", before: { [preview.path]: preview.before }, after: { [preview.path]: preview.after } };
      const backup = await this.app.vault.create(`${folder}/${this.makeId()}.json`, JSON.stringify(journal, null, 2));
      const file = this.app.vault.getAbstractFileByPath(preview.path);
      if (!(file instanceof TFile)) throw new Error("账目已发生变化，请刷新后重试");
      try {
        await this.app.vault.process(file, (text) => { if (text !== preview.before) throw new Error("账目已发生变化，请刷新后重试"); return preview.after; });
        await this.app.vault.modify(backup, JSON.stringify({ ...journal, status: "complete" }, null, 2));
      } catch (error) {
        try {
          await this.app.vault.process(file, (text) => { if (text === preview.before) return text; if (text !== preview.after) throw new Error("存在未解决的恢复冲突，已暂停写入"); return preview.before; });
          await this.app.vault.modify(backup, JSON.stringify({ ...journal, status: "rolled-back" }, null, 2));
        } catch { this.recoveryBlocked = true; }
        throw error;
      }
    });
  }

  private async createInternal(draft: TransactionDraft, skipContentCheck = false, preserveFields = false, importedId = ""): Promise<TFile> {
    if (!skipContentCheck) await this.assertContentAvailable(draft.title, "", draft.date);
    return this.createWithId(draft, importedId || this.makeId(), true, preserveFields);
  }

  /** Single public write boundary for both Markdown layouts. */
  private async createWithId(draft: TransactionDraft, id: string, skipContentCheck = true, preserveFields = false): Promise<TFile> {
    const settings = this.getSettings();
    if (!skipContentCheck) await this.assertContentAvailable(draft.title, "", draft.date);
    const [year = "0000", month = "00", day = "00"] = draft.date.split("-");
    const properties = this.toFrontmatter(draft, false, id, preserveFields);
    if (settings.storageFormat !== "single") {
      const path = this.storagePathForDraft(draft, settings.storageFormat);
      const folder = path.slice(0, path.lastIndexOf("/"));
      await this.ensureFolder(folder);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) { await this.updateDailyRecords(existing, (records) => [...records, properties]); return existing; }
      return this.app.vault.create(path, this.dailyFileContent(draft.date, [properties]));
    }
    const folder = normalizePath(`${safeFolder(settings.ledgerFolder)}/${year}/${month}/${day}`);
    await this.ensureFolder(folder);

    const timePart = draft.time.replace(":", "");
    const baseName = `${timePart}-${sanitizeFileName(draft.title)}`;
    const path = this.uniquePath(folder, baseName);
    const attachments = preserveFields || settings.enableEntryAttachments ? draft.attachments : [];
    const content = `---\n${stringifyYaml(properties)}---\n${this.attachmentSection(attachments)}`;
    return this.app.vault.create(path, content);
  }

  private async createDailyRecord(draft: TransactionDraft, record: Frontmatter): Promise<TFile> {
    const path = this.storagePathForDraft(draft, this.getSettings().storageFormat === "weekly" ? "weekly" : "daily");
    const folder = path.slice(0, path.lastIndexOf("/"));
    await this.ensureFolder(folder);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.updateDailyRecords(existing, (records) => {
        if (records.some((item) => item["账目ID"] === record["账目ID"])) throw new Error("存在重复账目ID，请先处理冲突");
        return [...records, record];
      });
      return existing;
    }
    return this.app.vault.create(path, this.dailyFileContent(draft.date, [record]));
  }

  private dailyFileContent(_date: string, records: Frontmatter[]): string {
    return this.serialize({ "记账插件": true, ...(this.getSettings().storageFormat === "weekly" ? { cssclasses: ["style-weekly-ledger"] } : {}), "账目列表": records }, this.withAttachments("", records));
  }

  private async isDailyFile(file: TFile): Promise<boolean> {
    const frontmatter = await this.properties(file);
    return isFrontmatter(frontmatter) && Array.isArray(frontmatter["账目列表"]);
  }

  private async dailyRecord(file: TFile, id: string): Promise<Frontmatter | null> {
    const frontmatter = await this.properties(file);
    if (!isFrontmatter(frontmatter) || !Array.isArray(frontmatter["账目列表"])) return null;
    const matches = frontmatter["账目列表"].filter((item): item is Frontmatter => isFrontmatter(item) && String(item["账目ID"]) === id);
    if (matches.length > 1) throw new Error("存在重复账目ID，请先处理冲突");
    return matches[0] ?? null;
  }

  private async updateDailyRecords(file: TFile, update: (records: Frontmatter[]) => Frontmatter[]): Promise<void> {
    // Vault.process protects the read/modify/write against other local writers.
    // Keep an empty daily container: it may contain user notes or pending undo data.
    await this.app.vault.process(file, (content) => {
      const { properties, body } = this.document(content);
      const next = update(this.dailyRecords(properties));
      return this.serialize({ ...properties, "记账插件": true, "账目列表": next }, this.withAttachments(body, next));
    });
  }

  async update(transaction: Transaction, draft: TransactionDraft): Promise<void> {
    return this.exclusive(() => this.updateInternal(transaction, draft));
  }

  private async updateInternal(transaction: Transaction, draft: TransactionDraft): Promise<void> {
    if (transaction.finance?.kind && draft.type !== transaction.type) throw new Error("Linked transaction type cannot be changed");
    if (transaction.finance && !draft.finance) draft = { ...draft, finance: { ...transaction.finance } };
    const items = await this.list();
    if (transaction.finance?.relatedId) {
      const source = items.find((item) => item.id === transaction.finance!.relatedId);
      if (!source || draft.finance?.relatedId !== source.id || draft.amount > outstanding(source, items.filter((item) => item.id !== transaction.id)) + 0.001) throw new Error("Settlement exceeds outstanding amount");
    }
    const settled = items.filter((item) => item.finance?.relatedId === transaction.id).reduce((sum, item) => sum + item.amount, 0);
    if (settled > draft.amount + 0.001) throw new Error("Settlement exceeds outstanding amount");
    if (settled > 0 && draft.type !== transaction.type) throw new Error("Linked transaction type cannot be changed");
    if (draft.date !== transaction.date || draft.title.trim().toLocaleLowerCase() !== transaction.title.trim().toLocaleLowerCase()) {
      await this.assertContentAvailable(draft.title, transaction.id, draft.date);
    }
    const dateChanged = draft.date !== transaction.date;
    if (await this.isDailyFile(transaction.file)) {
      const current = await this.dailyRecord(transaction.file, transaction.id);
      if (!current) throw new Error("未找到要更新的每日账目记录");
      const next = this.mergeRecord(current, draft, transaction);
      if (dateChanged && this.storagePathForDraft(draft, this.getSettings().storageFormat === "weekly" ? "weekly" : "daily") !== transaction.file.path) {
        const target = await this.createDailyRecord(draft, next);
        try {
          await this.updateDailyRecords(transaction.file, (records) => this.withoutRecord(records, transaction));
        } catch (error) {
          await this.updateDailyRecords(target, (records) => {
            const inserted = records.find((record) => String(record["账目ID"]) === transaction.id);
            if (inserted && this.canonical(inserted) !== this.canonical(next)) throw new Error("账目已发生变化，请刷新后重试");
            return records.filter((record) => String(record["账目ID"]) !== transaction.id);
          });
          throw error;
        }
      } else await this.updateDailyRecords(transaction.file, (records) => {
        if (records.filter((record) => String(record["账目ID"]) === transaction.id).length !== 1) throw new Error("账目已发生变化，请刷新后重试");
        return records.map((record) => String(record["账目ID"]) === transaction.id ? this.mergeRecord(record, draft, transaction) : record);
      });
      return;
    }
    let originalContent = "", writtenContent = "";
    const originalPath = transaction.file.path;
    let targetFolder = "";
    if (dateChanged) {
      const [year = "0000", month = "00", day = "00"] = draft.date.split("-");
      targetFolder = normalizePath(`${safeFolder(this.getSettings().ledgerFolder)}/${year}/${month}/${day}`);
      await this.ensureFolder(targetFolder);
    }
    await this.app.vault.process(transaction.file, (content) => {
      const doc = this.document(content);
      const next = this.mergeRecord(doc.properties, draft, transaction);
      originalContent = content;
      writtenContent = this.serialize(next, this.withAttachments(doc.body, [next]));
      return writtenContent;
    });
    if (dateChanged) {
      try { await this.app.fileManager.renameFile(transaction.file, this.uniquePath(targetFolder, transaction.file.basename)); }
      catch (error) {
        if (transaction.file.path === originalPath) await this.app.vault.process(transaction.file, (current) => {
          if (current !== writtenContent) throw new Error("账目已发生变化，请刷新后重试");
          return originalContent;
        });
        throw error;
      }
    }
  }

  async saveAttachment(file: File, _draft: Pick<TransactionDraft, "date" | "time" | "title">): Promise<TFile> {
    return this.exclusive(async () => {
      const folder = normalizePath(`${safeFolder(this.getSettings().attachmentFolder)}`);
      await this.ensureFolder(folder);
      const data = await file.arrayBuffer();
      const hash = async (bytes: ArrayBuffer): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(value => value.toString(16).padStart(2, "0")).join("");
      const digest = await hash(data);
      for (const existing of this.app.vault.getFiles()) {
        if (!existing.path.startsWith(`${folder}/`) || existing.stat.size !== data.byteLength) continue;
        if (await hash(await this.app.vault.readBinary(existing)) === digest) return existing;
      }
      const dot = file.name.lastIndexOf(".");
      const extension = dot > 0 ? file.name.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, "").toLowerCase() : "";
      const path = normalizePath(`${folder}/凭证-${digest}${extension ? "." + extension : ""}`);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        if (await hash(await this.app.vault.readBinary(existing)) !== digest) throw new Error("凭证文件校验失败，未覆盖现有文件");
        return existing;
      }
      return this.app.vault.createBinary(path, data);
    });
  }

  private async assertContentAvailable(title: string, excludedId = "", date = ""): Promise<void> {
    if (this.getSettings().allowDuplicateContent) return;
    const normalized = title.trim().toLocaleLowerCase();
    if (!normalized) return;
    const duplicate = (await this.list()).some((item) => item.id !== excludedId && (!date || item.date === date) && item.title.trim().toLocaleLowerCase() === normalized);
    if (duplicate) throw new Error(`同日内容“${title.trim()}”已存在，不允许重复`);
  }

  async remove(transaction: Transaction): Promise<void> {
    return this.exclusive(() => this.removeInternal(transaction));
  }

  private async removeInternal(transaction: Transaction): Promise<void> {
    await this.assertNoRelated(transaction.id);
    if (await this.isDailyFile(transaction.file)) {
      await this.updateDailyRecords(transaction.file, (records) => this.withoutRecord(records, transaction));
      return;
    }
    this.assertSnapshot(await this.properties(transaction.file), transaction);
    await this.app.fileManager.trashFile(transaction.file);
  }

  private assertSnapshot(current: Frontmatter, original: Transaction): void {
    if (original.rawProperties && this.canonical(current) !== this.canonical(original.rawProperties)) throw new Error("账目已发生变化，请刷新后重试");
  }

  private withoutRecord(records: Frontmatter[], original: Transaction): Frontmatter[] {
    const matches = records.filter((record) => String(record["账目ID"]) === original.id);
    const current = matches[0];
    if (matches.length !== 1 || !current) throw new Error("账目已发生变化，请刷新后重试");
    this.assertSnapshot(current, original);
    return records.filter((record) => String(record["账目ID"]) !== original.id);
  }

  async stageRemove(transaction: Transaction): Promise<PendingDelete> {
    return this.exclusive(() => this.stageRemoveInternal(transaction));
  }

  private async stageRemoveInternal(transaction: Transaction): Promise<PendingDelete> {
    await this.assertNoRelated(transaction.id);
    if (await this.isDailyFile(transaction.file)) {
      const record = await this.dailyRecord(transaction.file, transaction.id);
      if (!record) throw new Error("未找到要删除的每日账目记录");
      const originalPath = transaction.file.path;
      const originalContent = await this.app.vault.read(transaction.file);
      await this.updateDailyRecords(transaction.file, (records) => this.withoutRecord(records, transaction));
      return { file: transaction.file, originalPath, transactionId: transaction.id, deletedRecord: record, deletedDailyFileContent: originalContent };
    }
    const folder = normalizePath(`${safeFolder(this.getSettings().ledgerFolder)}/_bookkeeping-trash`);
    await this.ensureFolder(folder);
    const target = this.uniquePath(folder, `${this.makeId()}-${sanitizeFileName(transaction.file.basename)}`);
    const originalPath = transaction.file.path;
    this.assertSnapshot(await this.properties(transaction.file), transaction);
    await this.app.fileManager.renameFile(transaction.file, target);
    return { file: transaction.file, originalPath };
  }

  private async assertNoRelated(id: string): Promise<void> {
    if ((await this.list()).some((item) => item.finance?.relatedId === id)) throw new Error("Remove related settlements first");
  }

  async undoRemove(pending: PendingDelete): Promise<void> {
    return this.exclusive(() => this.undoRemoveInternal(pending));
  }

  private async undoRemoveInternal(pending: PendingDelete): Promise<void> {
    const raw = pending.deletedRecord ?? await this.properties(pending.file);
    if (isFrontmatter(raw["财务扩展"])) {
      const relatedId = raw["财务扩展"]["relatedId"];
      if (relatedId && !(await this.list()).some((item) => item.id === relatedId)) throw new Error("请先恢复原始账目");
    }
    if (pending.deletedRecord && pending.transactionId) {
      const existing = this.app.vault.getAbstractFileByPath(pending.originalPath);
      if (existing instanceof TFile) {
        await this.updateDailyRecords(existing, (records) => {
          const current = records.find((item) => String(item["账目ID"]) === pending.transactionId);
          if (current && this.canonical(current) !== this.canonical(pending.deletedRecord)) throw new Error("账目已发生变化，请刷新后重试");
          return current ? records : [...records, pending.deletedRecord as Frontmatter];
        });
      } else {
        const original = this.document(pending.deletedDailyFileContent ?? "");
        const records = [pending.deletedRecord];
        await this.ensureFolder(pending.originalPath.slice(0, pending.originalPath.lastIndexOf("/")));
        await this.app.vault.create(pending.originalPath, this.serialize({ ...original.properties, "账目列表": records }, this.withAttachments(original.body, records)));
      }
      return;
    }
    if (!this.app.vault.getAbstractFileByPath(pending.file.path)) return;
    const target = this.availableMarkdownPath(pending.originalPath);
    await this.ensureFolder(target.slice(0, target.lastIndexOf("/")));
    await this.app.fileManager.renameFile(pending.file, target);
  }

  async finalizeRemove(pending: PendingDelete): Promise<void> {
    if (pending.deletedRecord) return;
    if (this.app.vault.getAbstractFileByPath(pending.file.path)) await this.app.fileManager.trashFile(pending.file);
  }

  async cleanupPendingDeletes(): Promise<void> {
    const trashRoot = `${safeFolder(this.getSettings().ledgerFolder)}/_bookkeeping-trash/`;
    for (const file of this.app.vault.getMarkdownFiles().filter((item) => item.path.startsWith(trashRoot))) {
      await this.app.fileManager.trashFile(file);
    }
  }

  // Dot folders are not indexed by Vault. Retain old backups and copy their
  // journals into a Vault-visible folder before attempting interrupted recovery.
  private async importLegacyRecoveryBackups(root: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const legacy = `${root}.bookkeeping-recovery`;
    if (!adapter.list || !adapter.read || !await adapter.exists(legacy)) return;
    const entries = await adapter.list(legacy);
    for (const path of entries.files) {
      if (!path.startsWith(legacy + "/") || path.slice(legacy.length + 1).includes("/") || !path.endsWith(".json")) continue;
      const content = await adapter.read(path);
      const journal: unknown = JSON.parse(content);
      if (!isFrontmatter(journal) || journal["version"] !== 1 || !isFrontmatter(journal["before"]) || !isFrontmatter(journal["after"])) throw new Error("恢复备份格式不正确");
      const folder = `${root}_bookkeeping-recovery`;
      await this.ensureFolder(folder);
      const destination = `${folder}/${path.slice(legacy.length + 1)}`;
      const existing = this.app.vault.getAbstractFileByPath(destination);
      if (existing instanceof TFile) {
        const current: unknown = JSON.parse(await this.app.vault.read(existing));
        if (!isFrontmatter(current) || this.canonical({ ...current, status: "" }) !== this.canonical({ ...journal, status: "" })) throw new Error("存在未解决的恢复冲突，已暂停写入");
      } else {
        if (await adapter.exists(destination)) throw new Error("存在未解决的恢复冲突，已暂停写入");
        const file = await this.app.vault.create(destination, content);
        if (!(file instanceof TFile) || await this.app.vault.read(file) !== content) throw new Error("恢复备份格式不正确");
      }
    }
  }

  /** Resume only journals whose files still match the saved before/after states. */
  async recoverInterruptedMigrations(): Promise<number> {
    return this.exclusive(async () => {
      const root = `${safeFolder(this.getSettings().ledgerFolder)}/`;
      try { await this.importLegacyRecoveryBackups(root); }
      catch (error) { this.recoveryBlocked = true; throw error; }
      const folder = this.app.vault.getAbstractFileByPath(`${root}_bookkeeping-recovery`);
      if (!(folder instanceof TFolder)) return 0;
      let recovered = 0;
      try {
        for (const file of folder.children) {
          if (!(file instanceof TFile) || file.extension !== "json") continue;
          const journal: unknown = JSON.parse(await this.app.vault.read(file));
          if (!isFrontmatter(journal) || journal["status"] !== "prepared") continue;
          const before = journal["before"], after = journal["after"];
          if (!isFrontmatter(before) || !isFrontmatter(after) || journal["version"] !== 1 || !["single", "daily", "weekly"].includes(String(journal["from"]))) throw new Error("恢复备份格式不正确");
          const paths = Object.keys(before);
          if (paths.length !== Object.keys(after).length) throw new Error("恢复备份格式不正确");
          for (const path of paths) {
            if (!path.startsWith(root) || path.split("/").some((part) => part === ".." || part === ".") || this.excludedPath(path) || !path.endsWith(".md") || !(path in after) || ![before[path], after[path]].every((value) => value === null || typeof value === "string")) throw new Error("恢复备份格式不正确");
            const currentFile = this.app.vault.getAbstractFileByPath(path);
            const current = currentFile instanceof TFile ? await this.app.vault.read(currentFile) : null;
            if (current !== before[path] && current !== after[path]) throw new Error("存在未解决的恢复冲突，已暂停写入");
          }
          // Restore removed sources before rolling back generated targets.
          for (const path of paths.sort((a, b) => Number(after[b] === null) - Number(after[a] === null))) {
            const original = before[path] as string | null;
            const currentFile = this.app.vault.getAbstractFileByPath(path);
            if (currentFile instanceof TFile) {
              if (await this.app.vault.read(currentFile) === original) continue;
              if (original === null) {
                if (await this.app.vault.read(currentFile) !== after[path]) throw new Error("存在未解决的恢复冲突，已暂停写入");
                await this.app.fileManager.trashFile(currentFile);
              } else await this.app.vault.process(currentFile, (current) => {
                if (current !== after[path] && current !== original) throw new Error("存在未解决的恢复冲突，已暂停写入");
                return original;
              });
            } else if (original !== null) {
              await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
              await this.app.vault.create(path, original);
            }
          }
          await this.app.vault.modify(file, JSON.stringify({ ...journal, status: "recovered" }, null, 2));
          this.getSettings().storageFormat = journal["from"] as "single" | "daily" | "weekly";
          recovered++;
        }
        this.recoveryBlocked = false;
        return recovered;
      } catch (error) { this.recoveryBlocked = true; throw error; }
    }, true);
  }

  async migrateStorageFormat(target: "single" | "daily" | "weekly", onProgress?: (done: number, total: number) => void): Promise<StorageMigrationResult> {
    return this.exclusive(async () => {
      this.migrationSnapshot = await this.list();
      try { return await this.migrateStorageFormatInternal(target, onProgress); }
      finally { this.migrationSnapshot = null; }
    });
  }

  private async migrateStorageFormatInternal(target: "single" | "daily" | "weekly", onProgress?: (done: number, total: number) => void): Promise<StorageMigrationResult> {
    const from = this.getSettings().storageFormat;
    const root = `${safeFolder(this.getSettings().ledgerFolder)}/`;
    const before = new Map<string, string | null>();
    const after = new Map<string, string | null>();
    const sourceFiles: TFile[] = [];
    const sources: Array<{ file: TFile; record: Frontmatter; body: string; properties: Frontmatter; daily: boolean }> = [];
    const targetIds = new Map<string, Frontmatter>();
    const sourceIds = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(root) || this.excludedPath(file.path)) continue;
      const content = await this.app.vault.read(file);
      if (!/^\uFEFF?---/.test(content)) continue;
      const doc = this.document(content);
      const daily = Array.isArray(doc.properties["账目列表"]);
      if (!daily && !this.looksLikeTransactionProperties(doc.properties)) continue;
      const records = daily ? this.dailyRecords(doc.properties) : [doc.properties];
      const isTarget = target === "single" ? !daily : daily && records.every(record => { const item = this.fromFrontmatter(file, record); return item && this.storagePathForDraft(item, target) === file.path; });
      for (const record of records) {
        if (!this.fromFrontmatter(file, record)) throw new Error(`账目文件格式不正确：${file.path}`);
        const id = String(record["账目ID"] ?? "");
        if (isTarget) {
          if (id && targetIds.has(id)) throw new Error("存在重复账目ID，请先处理冲突");
          if (id) targetIds.set(id, record);
        } else {
          if (id && sourceIds.has(id)) throw new Error("存在重复账目ID，请先处理冲突");
          if (id) sourceIds.add(id);
          sources.push({ file, record, body: doc.body, properties: doc.properties, daily });
        }
      }
      const sharedKeys = Object.keys(doc.properties).filter((key) => !["记账插件", "账目列表"].includes(key));
      if (!isTarget && (records.length || daily && !sharedKeys.length && !doc.body.replace(/<!-- bookkeeping-(?:weekly|attachments):start -->[\s\S]*?<!-- bookkeeping-(?:weekly|attachments):end -->/g, "").trim())) {
        before.set(file.path, content);
        after.set(file.path, null);
        sourceFiles.push(file);
      }
    }
    let migrated = 0;
    let skipped = 0;
    for (const source of sources) {
      const item = this.fromFrontmatter(source.file, source.record)!;
      const record: Frontmatter = { ...source.record, "账目ID": source.record["账目ID"] || this.makeId() };
      const id = String(record["账目ID"]);
      // Preserve arbitrary record properties and Markdown, independently of UI switches.
      const unmanagedBody = source.body.replace(/\n?<!-- bookkeeping-attachments:start -->[\s\S]*?<!-- bookkeeping-attachments:end -->\n?/g, "");
      let body = "";
      if (target !== "single") {
        if (unmanagedBody && !source.daily) record["_bookkeepingBody"] = unmanagedBody;
      } else {
        body = String(record["_bookkeepingBody"] ?? "");
        delete record["_bookkeepingBody"];
        const shared = { ...source.properties };
        delete shared["账目列表"]; delete shared["记账插件"];
        if (Object.keys(shared).length || unmanagedBody) record["_bookkeepingDaily"] = { properties: shared, body: unmanagedBody };
      }
      const duplicate = targetIds.get(id);
      if (duplicate) {
        if (this.canonical(duplicate) !== this.canonical(record) || body.trim()) throw new Error("同ID账目内容不同，已停止转换");
        skipped++; continue;
      }
      let path = this.storagePathForDraft(item, target);
      if (target === "single") {
        const base = path.slice(0, -3);
        let suffix = 1;
        while (after.has(path) || this.app.vault.getAbstractFileByPath(path)) path = `${base}-${++suffix}.md`;
      }
      if (!before.has(path)) {
        const file = this.app.vault.getAbstractFileByPath(path);
        before.set(path, file instanceof TFile ? await this.app.vault.read(file) : null);
      }
      if (target !== "single") {
        const existing = after.get(path) ?? before.get(path);
        const doc = existing ? this.document(existing) : { properties: { "记账插件": true, "账目列表": [] } as Frontmatter, body: "" };
        const shared = record["_bookkeepingDaily"];
        if (isFrontmatter(shared)) {
          const properties = isFrontmatter(shared["properties"]) ? shared["properties"] : {};
          for (const [key, value] of Object.entries(properties)) {
            if (key in doc.properties && this.canonical(doc.properties[key]) !== this.canonical(value)) throw new Error("每日文件属性冲突，已停止转换");
            doc.properties[key] = value;
          }
          const savedBody = String(shared["body"] ?? "");
          const currentBody = doc.body.replace(/\n?<!-- bookkeeping-attachments:start -->[\s\S]*?<!-- bookkeeping-attachments:end -->\n?/g, "");
          if (savedBody && currentBody && savedBody !== currentBody) throw new Error("每日文件正文冲突，已停止转换");
          if (savedBody) doc.body = savedBody;
          delete record["_bookkeepingDaily"];
        }
        const records = [...this.dailyRecords(doc.properties), record];
        after.set(path, this.serialize({ ...doc.properties, "账目列表": records }, this.withAttachments(doc.body, records, target)));
      } else {
        after.set(path, this.serialize(record, this.withAttachments(body, [record], target)));
      }
      targetIds.set(id, record);
      migrated++;
    }
    if (!sourceFiles.length) { this.getSettings().storageFormat = target; return { migrated, skipped, from, to: target }; }
    const recoveryFolder = `${root}_bookkeeping-recovery`;
    await this.ensureFolder(recoveryFolder);
    const journal = await this.app.vault.create(`${recoveryFolder}/${this.makeId()}.json`, JSON.stringify({ version: 1, from, to: target, status: "prepared", before: Object.fromEntries(before), after: Object.fromEntries(after) }, null, 2));
    const changed = new Set<string>();
    try {
      let done = 0;
      for (const [path, content] of after) {
        if (content === null) continue;
        changed.add(path);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.app.vault.process(file, (current) => {
            if (current !== before.get(path)) throw new Error("账目已发生变化，请刷新后重试");
            return content;
          });
        } else {
          if (before.get(path) !== null) throw new Error("账目已发生变化，请刷新后重试");
          await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
          await this.app.vault.create(path, content);
        }
        changed.add(path);
        const written = this.app.vault.getAbstractFileByPath(path);
        if (!(written instanceof TFile) || await this.app.vault.read(written) !== content) throw new Error("转换校验失败");
        onProgress?.(++done, [...after.values()].filter((value) => value !== null).length);
      }
      for (const file of sourceFiles) {
        if (await this.app.vault.read(file) !== before.get(file.path)) throw new Error("账目已发生变化，请刷新后重试");
        changed.add(file.path);
        await this.app.fileManager.trashFile(file);
      }
      await this.removeEmptyMigrationFolders(sourceFiles);
      await this.app.vault.modify(journal, JSON.stringify({ version: 1, from, to: target, status: "complete", before: Object.fromEntries(before), after: Object.fromEntries(after) }, null, 2));
      this.getSettings().storageFormat = target;
      return { migrated, skipped, from, to: target };
    } catch (error) {
      // Restore sources first. Never overwrite a concurrent external edit.
      let recoveryFailed = false;
      for (const path of [...changed].sort((a, b) => Number(after.get(b) === null) - Number(after.get(a) === null))) {
        if (recoveryFailed && after.get(path) !== null) continue;
        try {
          const content = before.get(path) ?? null;
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) {
            const current = await this.app.vault.read(file);
            if (current === content) continue;
            if (current !== after.get(path)) throw new Error("conflict");
            if (content === null) await this.app.fileManager.trashFile(file);
            else await this.app.vault.process(file, (latest) => { if (latest !== current) throw new Error("conflict"); return content; });
          } else if (content !== null) {
            await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
            await this.app.vault.create(path, content);
          }
        } catch { recoveryFailed = true; }
      }
      if (recoveryFailed) { this.recoveryBlocked = true; throw new Error(`转换未完成，恢复备份保存在：${journal.path}`); }
      await this.app.vault.modify(journal, JSON.stringify({ version: 1, from, to: target, status: "rolled-back", before: Object.fromEntries(before), after: Object.fromEntries(after) }, null, 2));
      throw error;
    }
  }

  private async removeEmptyMigrationFolders(files: TFile[]): Promise<void> {
    const root = safeFolder(this.getSettings().ledgerFolder);
    const candidates = new Set<string>();
    for (const file of files) {
      let path = file.path.split("/").slice(0, -1).join("/");
      while (path.startsWith(root + "/")) {
        candidates.add(path);
        path = path.split("/").slice(0, -1).join("/");
      }
    }
    for (const path of [...candidates].sort((a, b) => b.length - a.length)) {
      const folder = this.app.vault.getAbstractFileByPath(path);
      if (!(folder instanceof TFolder)) continue;
      const adapter = this.app.vault.adapter;
      if (adapter.list) {
        const entries = await adapter.list(path);
        if (!entries.files.length && !entries.folders.length) await this.app.fileManager.trashFile(folder);
      } else if (!folder.children.length) await this.app.fileManager.trashFile(folder);
    }
  }

  private storagePathForDraft(draft: TransactionDraft, format: "single" | "daily" | "weekly"): string {
    const [year = "0000", month = "00", day = "00"] = draft.date.split("-");
    if (format === "weekly") return normalizePath(weeklyPath(safeFolder(this.getSettings().ledgerFolder), draft.date));
    const folder = format === "daily"
      ? `${safeFolder(this.getSettings().ledgerFolder)}/${year}/${month}`
      : `${safeFolder(this.getSettings().ledgerFolder)}/${year}/${month}/${day}`;
    return normalizePath(format === "daily" ? `${folder}/${day}.md` : `${folder}/${draft.time.replace(":", "")}-${sanitizeFileName(draft.title)}.md`);
  }

  async legacyFileCount(folder = ""): Promise<number> {
    return (await this.scanVaultLegacyCandidates(folder)).length;
  }

  async convertLegacyFiles(onProgress?: (done: number, total: number) => void, folder = ""): Promise<LegacyConversionResult> {
    const candidates = await this.scanVaultLegacyCandidates(folder);
    const existing = new Set((await this.list()).filter((item) => !item.legacy).map((item) => this.fingerprint(item)));
    const failures: LegacyFailureSource[] = [];
    let converted = 0, skipped = 0;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index] as VaultLegacyCandidate;
      const draft = candidate.draft;
      if (!draft) {
        failures.push({ name: candidate.file.name, path: candidate.file.path, reason: candidate.reason ?? "无法读取旧版账目属性", content: candidate.content });
      } else {
        try {
          const fingerprint = this.fingerprint(draft);
          if (existing.has(fingerprint)) skipped++;
          else {
            await this.create(draft, true);
            if (this.app.vault.getAbstractFileByPath(candidate.file.path)) await this.app.fileManager.trashFile(candidate.file);
            existing.add(fingerprint);
            converted++;
          }
        } catch (error) {
          failures.push({ name: candidate.file.name, path: candidate.file.path, reason: errorMessageZh(error, "转换失败"), content: candidate.content });
        }
      }
      if ((index + 1) % 10 === 0 || index + 1 === candidates.length) onProgress?.(index + 1, candidates.length);
    }
    const failureFolder = failures.length ? await this.writeLegacyFailureFolder(failures) : undefined;
    return { converted, skipped, failed: failures.length, total: candidates.length, failureFolder };
  }

  async importExternalLegacyMarkdown(files: Array<{ name: string; path?: string; content: string }>, onProgress?: (done: number, total: number) => void): Promise<ExternalLegacyImportResult> {
    const existing = new Set((await this.list()).map((item) => this.fingerprint(item)));
    const failures: LegacyFailureSource[] = [];
    let imported = 0, skipped = 0;
    for (let index = 0; index < files.length; index++) {
      const source = files[index] as { name: string; path?: string; content: string };
      try {
        const match = source.content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (!match?.[1]) throw new Error("缺少Properties");
        const parsed: unknown = parseYaml(match[1]);
        if (!isFrontmatter(parsed)) throw new Error("Properties格式不合法");
        const frontmatter = parsed;
        const draft = this.legacyDraftFromProperties(frontmatter, source.path ?? source.name, source.name.replace(/\.md$/i, ""));
        const fingerprint = this.fingerprint(draft);
        if (existing.has(fingerprint)) {
          skipped++;
        } else {
          await this.create(draft); existing.add(fingerprint); imported++;
        }
      } catch (error) {
        failures.push({
          name: source.name,
          path: source.path ?? source.name,
          reason: errorMessageZh(error, "无法转换该文件"),
          content: source.content
        });
      }
      if ((index + 1) % 10 === 0 || index + 1 === files.length) onProgress?.(index + 1, files.length);
    }
    const failureFolder = failures.length ? await this.writeLegacyFailureFolder(failures) : undefined;
    return { imported, skipped, failed: failures.length, total: files.length, failureFolder };
  }

  async rewriteExpressionStorage(onProgress?: (done: number, total: number) => void): Promise<number> {
    const transactions = await this.list();
    for (let index = 0; index < transactions.length; index++) {
      const item = transactions[index] as Transaction;
      await this.update(item, this.toDraft(item));
      if ((index + 1) % 10 === 0 || index + 1 === transactions.length) onProgress?.(index + 1, transactions.length);
    }
    return transactions.length;
  }

  async updateTagGlobally(oldTag: string, newTag: string | null, onProgress?: (done: number, total: number) => void): Promise<number> {
    const transactions = (await this.list()).filter((item) => item.tags.includes(oldTag));
    for (let index = 0; index < transactions.length; index++) {
      const item = transactions[index] as Transaction;
      const replacement = newTag?.replace(/^#/, "").trim();
      const tags = item.tags.flatMap((tag) => tag === oldTag ? (replacement ? [replacement] : []) : [tag]);
      const draft = this.toDraft(item);
      draft.tags = [...new Set(tags)];
      draft.note = this.replaceTagInNote(draft.note, oldTag, replacement || null);
      await this.update(item, draft);
      if ((index + 1) % 10 === 0 || index + 1 === transactions.length) onProgress?.(index + 1, transactions.length);
    }
    return transactions.length;
  }

  async deleteTransactionsWithTag(tag: string, onProgress?: (done: number, total: number) => void): Promise<number> {
    const transactions = (await this.list()).filter((item) => item.tags.includes(tag));
    for (let index = 0; index < transactions.length; index++) {
      await this.remove(transactions[index] as Transaction);
      if ((index + 1) % 10 === 0 || index + 1 === transactions.length) onProgress?.(index + 1, transactions.length);
    }
    return transactions.length;
  }

  async updateAttachmentPath(oldPath: string, newPath: string): Promise<number> {
    const transactions = (await this.list()).filter((item) => item.attachments.includes(oldPath));
    for (const item of transactions) {
      const draft = this.toDraft(item);
      draft.attachments = draft.attachments.map((path) => path === oldPath ? newPath : path);
      await this.update(item, draft);
    }
    return transactions.length;
  }

  async renameAccountGlobally(oldName: string, newName: string): Promise<number> {
    if (!oldName || !newName || oldName === newName) return 0;
    const transactions = (await this.list()).filter((item) => item.account === oldName || item.targetAccount === oldName);
    for (const item of transactions) {
      const draft = this.toDraft(item);
      if (draft.account === oldName) draft.account = newName;
      if (draft.targetAccount === oldName) draft.targetAccount = newName;
      await this.update(item, draft);
    }
    return transactions.length;
  }

  async renameCategoryGlobally(oldName: string, newName: string): Promise<number> {
    if (!oldName || !newName || oldName === newName) return 0;
    const transactions = (await this.list()).filter((item) => item.category === oldName);
    for (const item of transactions) {
      const draft = this.toDraft(item);
      draft.category = newName;
      await this.update(item, draft);
    }
    return transactions.length;
  }

  async renameCustomFieldValueGlobally(property: string, oldValue: string, newValue: string): Promise<number> {
    if (!property || !oldValue || !newValue || oldValue === newValue) return 0;
    return this.mutateRecords((record) => {
      if (String(record[property] ?? "") !== oldValue) return false;
      record[property] = newValue; return true;
    });
  }

  async clearCustomFieldProperties(properties: string[], onProgress?: (done: number, total: number) => void): Promise<number> {
    const propertySet = new Set(properties.map((property) => property.trim()).filter(Boolean));
    if (!propertySet.size) return 0;
    return this.mutateRecords((record) => {
      const changed = [...propertySet].some((property) => property in record);
      for (const property of propertySet) delete record[property];
      return changed;
    }, onProgress);
  }

  private async mutateRecords(change: (record: Frontmatter) => boolean, onProgress?: (done: number, total: number) => void): Promise<number> {
    return this.exclusive(async () => {
      const files = [...new Set((await this.list()).map((item) => item.file))];
      let count = 0;
      for (const [index, file] of files.entries()) {
        await this.app.vault.process(file, (content) => {
          const doc = this.document(content);
          const records = Array.isArray(doc.properties["账目列表"]) ? this.dailyRecords(doc.properties) : [doc.properties];
          let changes = 0;
          records.forEach((record) => { if (change(record)) changes++; });
          count += changes;
          return changes ? this.serialize(doc.properties, doc.body) : content;
        });
        onProgress?.(index + 1, files.length);
      }
      return count;
    });
  }

  async syncAttachmentPreviews(): Promise<number> {
    return this.exclusive(async () => {
      const transactions = await this.list();
      for (const file of new Set(transactions.map((item) => item.file))) {
        await this.app.vault.process(file, (content) => {
          const doc = this.document(content);
          const records = Array.isArray(doc.properties["账目列表"]) ? this.dailyRecords(doc.properties) : [doc.properties];
          return this.serialize(doc.properties, this.withAttachments(doc.body, records));
        });
      }
      return transactions.length;
    });
  }

  summarize(transactions: Transaction[], month: string): MonthSummary {
    const current = transactions.filter((item) => monthOf(item.date) === month && this.typeEffect(item.type) !== "neutral");
    const incomeItems = current.filter((item) => this.typeEffect(item.type) === "positive");
    const expenseItems = current.filter((item) => this.typeEffect(item.type) === "negative");
    const income = roundMoney(incomeItems.reduce((sum, item) => sum + item.amount, 0));
    const expense = roundMoney(expenseItems.reduce((sum, item) => sum + item.amount, 0));
    const byCategory = new Map<string, number>();
    const byDay = new Map<string, number>();

    for (const item of expenseItems) {
      const category = item.category || "未分类";
      byCategory.set(category, roundMoney((byCategory.get(category) ?? 0) + item.amount));
      byDay.set(item.date, roundMoney((byDay.get(item.date) ?? 0) + item.amount));
    }

    return {
      income,
      expense,
      balance: roundMoney(income - expense),
      expenseCount: expenseItems.length,
      incomeCount: incomeItems.length,
      byCategory,
      byDay
    };
  }

  accountMonthlyBalances(transactions: Transaction[], month: string): { opening: Map<string, number>; closing: Map<string, number> } {
    const settings = this.getSettings();
    const accountNames = new Set(settings.accounts.map((account) => account.name));
    transactions.forEach((item) => {
      if (item.account) accountNames.add(item.account);
      if (item.targetAccount) accountNames.add(item.targetAccount);
    });
    const opening = new Map<string, number>();
    for (const accountName of accountNames) {
      const configured = settings.accounts.find((account) => account.name === accountName);
      const overrides = Object.entries(settings.monthlyOpeningBalances)
        .filter(([overrideMonth, values]) => overrideMonth <= month && Number.isFinite(values[accountName]))
        .sort(([a], [b]) => b.localeCompare(a));
      const latest = overrides[0];
      const baseMonth = latest?.[0] ?? "";
      let balance = latest ? Number(latest[1][accountName]) : (configured?.initialBalance ?? 0);
      for (const item of transactions) {
        if (item.date >= `${month}-01`) continue;
        if (baseMonth && item.date < `${baseMonth}-01`) continue;
        balance = this.applyAccountTransaction(balance, item, accountName);
      }
      opening.set(accountName, roundMoney(balance));
    }
    const closing = new Map(opening);
    for (const item of transactions) {
      if (monthOf(item.date) !== month) continue;
      for (const accountName of accountNames) {
        closing.set(accountName, roundMoney(this.applyAccountTransaction(closing.get(accountName) ?? 0, item, accountName)));
      }
    }
    return { opening, closing };
  }

  private applyAccountTransaction(balance: number, item: Transaction, accountName: string): number {
    if (PRINCIPAL_TYPES.includes(item.type) && item.finance?.cashEffect && item.account === accountName) return balance + (item.finance.cashEffect === "positive" ? item.amount : -item.amount);
    const effect = this.typeEffect(item.type);
    if (item.type === "转账" && effect === "neutral") {
      if (item.account === accountName) balance -= item.amount;
      if (item.targetAccount === accountName) balance += item.amount;
      return balance;
    }
    if (effect === "positive" && item.account === accountName) return balance + item.amount;
    if (effect === "negative" && item.account === accountName) return balance - item.amount;
    return balance;
  }

  typeEffect(type: Transaction["type"]): "positive" | "negative" | "neutral" {
    if (PRINCIPAL_TYPES.includes(type)) return "neutral";
    if (type === "退款" || type === "报销到账") return "positive";
    return this.getSettings().typeEffects[type] ?? (type === "收入" ? "positive" : type === "支出" ? "negative" : "neutral");
  }

  async exportCsv(options: ExportOptions = {}): Promise<TFile> {
    const settings = this.getSettings();
    const folder = safeFolder(options.folder || settings.exportFolder);
    await this.ensureFolder(folder);
    const csv = await this.buildCsv(options);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const requestedName = (options.fileName || `账目导出-${stamp}`).replace(/\.csv$/i, "");
    const path = this.uniqueFilePath(folder, sanitizeFileName(requestedName), "csv");
    return this.app.vault.create(path, csv);
  }

  async buildCsv(options: ExportOptions = {}): Promise<string> {
    const settings = this.getSettings();
    const customFields = settings.customFields;
    const allowedIds = options.transactionIds ? new Set(options.transactionIds) : null;
    const transactions = (await this.list()).filter((item) => {
      if (allowedIds && !allowedIds.has(item.id)) return false;
      if (options.dateFrom && item.date < options.dateFrom) return false;
      if (options.dateTo && item.date > options.dateTo) return false;
      return true;
    });
    const rows = transactions.map((item) => [
      item.date,
      item.time,
      item.type,
      item.necessity,
      item.category,
      item.account,
      item.targetAccount,
      item.title,
      item.amount.toFixed(2),
      item.expression || String(item.amount),
      item.note,
      item.tags.join(" "),
      item.attachments.join(" | "),
      ...customFields.map((field) => item.customValues[field.id] ?? ""),
      item.file.path,
      item.id,
      item.finance ? JSON.stringify(item.finance) : ""
    ].map(escapeCsv).join(","));
    const header = ["日期", "时间", "类型", "标签", "分类", "账户", "目标账户", "内容", "金额", "算式", "备注", "附加标签", "附件", ...customFields.map((field) => field.name), "文件", "账目ID", "财务扩展"];
    const csv = [header.map(escapeCsv).join(","), ...rows].join("\n");
    const configuration = options.includeFieldConfig
      ? `${CSV_FIELD_CONFIG_PREFIX}${encodeURIComponent(JSON.stringify({
        version: 1,
        builtInEnabled: {
          account: settings.enableAccount,
          type: settings.enableType,
          necessity: settings.enableNecessity,
          category: settings.enableCategory,
          note: settings.enableNote,
          attachments: settings.enableEntryAttachments
        },
        fields: customFields.map((field) => ({ ...field, options: [...field.options] })),
        optionFieldOrder: [...settings.optionFieldOrder]
      } satisfies CsvCustomFieldConfiguration))}\n`
      : "";
    return `\uFEFF${configuration}${csv}`;
  }

  inspectCsvCustomFieldConfiguration(text: string): CsvCustomFieldConfiguration | null {
    return this.splitCsvDocument(text).configuration;
  }

  validateCsvImportStructure(text: string): void {
    const rows = parseCsv(this.splitCsvDocument(text).body);
    if (rows.length < 2) throw new Error("CSV没有可导入的数据行");
    const headers = (rows[0] ?? []).map((header) => header.toLocaleLowerCase("zh-CN").replace(/[\s_-]/g, ""));
    const hasDate = headers.some((header) => ["日期", "交易日期", "date", "datetime", "时间"].includes(header));
    const hasAmount = headers.some((header) => ["金额", "交易金额", "amount", "money"].includes(header));
    if (!hasDate || !hasAmount) throw new Error("CSV至少需要日期和金额两列");
  }

  inspectCsvMetadata(text: string): CsvMetadataAnalysis {
    const rows = parseCsv(this.splitCsvDocument(text).body);
    if (rows.length < 2) return { differences: [], hasDifferences: false };
    const headers = (rows[0] ?? []).map((header) => header.toLocaleLowerCase("zh-CN").replace(/[\s_-]/g, ""));
    const find = (...aliases: string[]): number => headers.findIndex((header) => aliases.includes(header));
    const indexes = {
      type: find("类型", "收支类型", "交易类型", "type"),
      necessity: find("必要性", "标签", "necessity"),
      category: find("分类", "category"),
      account: find("账户", "account")
    };
    const unique = (index: number): string[] => index < 0 ? [] : [...new Set(rows.slice(1).map((row) => String(row[index] ?? "").trim()).filter(Boolean))];
    const settings = this.getSettings();
    const differences: string[] = [];
    const unknownTypes = unique(indexes.type).filter((value) => !settings.typeOrder.includes(value) && !["支出", "收入", "转账", "expense", "income", "transfer"].includes(value.toLocaleLowerCase("zh-CN")));
    const unknownNecessity = unique(indexes.necessity).filter((value) => !settings.necessityOrder.includes(value));
    const categories = new Set([...settings.categories, ...settings.incomeCategories, "未分类"]);
    const unknownCategories = unique(indexes.category).filter((value) => !categories.has(value));
    const accounts = new Set(settings.accounts.map((account) => account.name));
    const unknownAccounts = unique(indexes.account).filter((value) => !accounts.has(value));
    if (unknownTypes.length) differences.push(`未知类型：${unknownTypes.join("、")}`);
    if (unknownNecessity.length) differences.push(`未知必要性：${unknownNecessity.join("、")}`);
    if (unknownCategories.length) differences.push(`仓库中没有的分类：${unknownCategories.join("、")}`);
    if (unknownAccounts.length) differences.push(`仓库中没有的账户：${unknownAccounts.join("、")}`);
    for (const field of settings.customFields.filter((item) => item.kind === "select")) {
      const aliases = [field.name, field.property].map((value) => value.toLocaleLowerCase("zh-CN").replace(/[\s_-]/g, ""));
      const index = headers.findIndex((header) => aliases.includes(header));
      const unknown = unique(index).filter((value) => !field.options.includes(value));
      if (unknown.length) differences.push(`自定义字段“${field.name}”中没有的预设：${unknown.join("、")}`);
    }
    return { differences, hasDifferences: differences.length > 0 };
  }

  async importCsv(text: string, onProgress?: (done: number, total: number) => void, normalizeMetadata = false): Promise<ImportResult> {
    const rows = parseCsv(this.splitCsvDocument(text).body);
    if (rows.length < 2) throw new Error("CSV没有可导入的数据行");
    const headers = (rows[0] ?? []).map((header) => header.toLocaleLowerCase("zh-CN").replace(/[\s_-]/g, ""));
    const aliases: Record<string, string[]> = {
      date: ["日期", "交易日期", "date", "datetime", "时间"],
      time: ["时间", "时刻", "交易时间", "time"],
      type: ["类型", "收支类型", "交易类型", "type"],
      necessity: ["必要性", "标签", "necessity"],
      category: ["分类", "category"],
      account: ["账户", "account"],
      targetAccount: ["目标账户", "转入账户", "targetaccount"],
      title: ["内容", "名称", "摘要", "商品", "description", "title", "memo"],
      amount: ["金额", "交易金额", "amount", "money"],
      expression: ["算式", "expression", "formula"],
      note: ["备注", "note", "remark"],
      tags: ["附加标签", "tags", "tag"],
      attachments: ["附件", "attachments", "attachment"],
      id: ["账目id", "transactionid"],
      finance: ["财务扩展", "finance"]
    };
    const indexOf = (key: string): number => headers.findIndex((header) => (aliases[key] ?? []).includes(header));
    const indexes: Record<string, number> = {};
    for (const key of Object.keys(aliases)) indexes[key] = indexOf(key);
    const customIndexes = Object.fromEntries(this.getSettings().customFields.map((field) => {
      const aliases = [field.name, field.property].map((value) => value.toLocaleLowerCase("zh-CN").replace(/[\s_-]/g, ""));
      return [field.id, headers.findIndex((header) => aliases.includes(header))];
    }));
    if ((indexes["date"] ?? -1) < 0 || (indexes["amount"] ?? -1) < 0) throw new Error("CSV至少需要日期和金额两列");
    const currentRecords = await this.list();
    const existing = new Set(currentRecords.map((item) => this.fingerprint(item)));
    const knownIds = new Map<string, TransactionDraft>(currentRecords.map((item) => [item.id, item]));
    const failures: ImportFailure[] = [];
    let imported = 0;
    let skipped = 0;
    const dataRows = rows.slice(1);
    for (let index = 0; index < dataRows.length; index++) {
      const row = dataRows[index] ?? [];
      try {
        const get = (key: string): string => (indexes[key] ?? -1) >= 0 ? String(row[indexes[key] as number] ?? "").trim() : "";
        const rawDate = get("date");
        const date = normalizeDate(rawDate);
        if (!date) throw new Error("日期无效");
        const amountText = get("amount").replace(/[￥¥$€,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
        const signedAmount = Number(amountText);
        if (!amountText || !/^-?\d+(?:\.\d{1,2})?$/.test(amountText) || !Number.isFinite(signedAmount)) throw new Error("金额必须是最多两位小数的数字");
        const settings = this.getSettings();
        const originalType = get("type");
        const rawType = originalType.toLocaleLowerCase("zh-CN");
        const type: Transaction["type"] = [...settings.typeOrder, ...PRINCIPAL_TYPES, "退款", "报销到账"].includes(originalType) ? originalType : /^(收入|income|入账|收款)$/.test(rawType) ? "收入"
          : /转账|transfer/.test(rawType) ? "转账"
          : /^(支出|expense|付款|消费)$/.test(rawType) ? "支出"
          : originalType && !normalizeMetadata ? originalType
          : signedAmount < 0 ? "支出" : usableDefaultType(settings);
        const title = get("title") || get("note") || "CSV导入账目";
        const timeText = get("time") || rawDate;
        const directTime = timeText.match(/^(\d{1,2}):(\d{2})$/);
        if (directTime && (Number(directTime[1]) > 23 || Number(directTime[2]) > 59)) throw new Error("时间无效");
        const time = directTime ? `${String(Number(directTime[1])).padStart(2, "0")}:${directTime[2]}` : normalizeTime(timeText);
        const amount = Math.abs(roundMoney(signedAmount));
        const validAccounts = new Set(settings.accounts.map((account) => account.name));
        const rawAccount = get("account") || settings.defaultAccount;
        const account = normalizeMetadata && !validAccounts.has(rawAccount) ? settings.defaultAccount : rawAccount;
        const rawTargetAccount = get("targetAccount");
        const targetAccount = normalizeMetadata && rawTargetAccount && !validAccounts.has(rawTargetAccount)
          ? (settings.accounts.find((item) => item.name !== account)?.name ?? "") : rawTargetAccount;
        if (type === "转账" && !canRecordTransfer(settings)) {
          throw new Error("转账需启用类型和账户功能，并至少添加两个账户");
        }
        if (type === "转账" && (!targetAccount || targetAccount === account)) throw new Error("转账缺少有效的目标账户");
        const rawCategory = get("category") || "未分类";
        const positiveType = this.typeEffect(type) === "positive";
        const validCategories = new Set(positiveType ? settings.incomeCategories : settings.categories);
        const category = normalizeMetadata && rawCategory !== "未分类" && !validCategories.has(rawCategory)
          ? (positiveType ? settings.defaultIncomeCategory : settings.defaultCategory) || "未分类"
          : rawCategory;
        const rawNecessity = get("necessity");
        const draft: TransactionDraft = {
          date,
          time,
          type,
          necessity: !rawNecessity ? settings.defaultNecessity : !normalizeMetadata || settings.necessityOrder.includes(rawNecessity) ? rawNecessity : settings.defaultNecessity,
          category,
          account,
          targetAccount,
          title,
          amount,
          expression: get("expression") || String(amount),
          note: get("note"),
          tags: [...new Set(get("tags").split(/[\s,，]+/).map((tag) => tag.replace(/^#/, "")).filter(Boolean))],
          attachments: get("attachments").split(/[|,，\n]+/).map((path) => path.trim()).filter(Boolean),
          customValues: Object.fromEntries(this.getSettings().customFields.map((field) => {
            const customIndex = customIndexes[field.id] ?? -1;
            const value = customIndex >= 0 ? String(row[customIndex] ?? "").trim() : "";
            const normalized = normalizeMetadata && field.kind === "select" && value && !field.options.includes(value) ? "" : value;
            return [field.id, normalized || customFieldDefaultValue(field)];
          }))
        };
        if (get("finance")) {
          const finance: unknown = JSON.parse(get("finance"));
          if (!isFrontmatter(finance)) throw new Error("Invalid finance data");
          draft.finance = finance as unknown as FinanceDetails;
          validateFinance(draft, settings);
        }
        const fingerprint = this.fingerprint(draft);
        const importedId = get("id");
        const known = importedId ? knownIds.get(importedId) : undefined;
        const comparable = (item: TransactionDraft): unknown => ({ date: item.date, time: item.time, type: item.type, amount: item.amount, title: item.title, note: item.note, category: item.category, necessity: item.necessity, account: item.account, targetAccount: item.targetAccount, tags: item.tags, attachments: item.attachments, customValues: item.customValues, finance: item.finance });
        if (known && this.canonical(comparable(known)) !== this.canonical(comparable(draft))) throw new Error("存在重复账目ID，请先处理冲突");
        if (known || !importedId && existing.has(fingerprint)) {
          skipped++;
          throw new Error("疑似重复账目，已跳过");
        }
        await this.create(draft, Boolean(importedId), true, importedId);
        if (importedId) knownIds.set(importedId, draft);
        existing.add(fingerprint);
        imported++;
      } catch (error) {
        failures.push({ row: index + 2, reason: errorMessageZh(error, "该行数据无法导入"), raw: row });
      }
      if ((index + 1) % 10 === 0 || index + 1 === dataRows.length) onProgress?.(index + 1, dataRows.length);
    }
    const realFailures = failures.filter((failure) => !failure.reason.includes("重复"));
    const failureReport = failures.length ? await this.writeImportFailureReport(headers, failures) : undefined;
    return { imported, skipped, failures: realFailures, failureReport };
  }

  private splitCsvDocument(text: string): { body: string; configuration: CsvCustomFieldConfiguration | null } {
    const normalized = text.replace(/^\uFEFF/, "");
    const newline = normalized.indexOf("\n");
    const firstLine = (newline >= 0 ? normalized.slice(0, newline) : normalized).replace(/\r$/, "");
    if (!firstLine.startsWith(CSV_FIELD_CONFIG_PREFIX)) return { body: text, configuration: null };
    const body = newline >= 0 ? normalized.slice(newline + 1) : "";
    try {
      const parsed: unknown = JSON.parse(decodeURIComponent(firstLine.slice(CSV_FIELD_CONFIG_PREFIX.length)));
      const configuration = this.normalizeCsvCustomFieldConfiguration(parsed);
      return { body, configuration };
    } catch {
      return { body, configuration: null };
    }
  }

  private normalizeCsvCustomFieldConfiguration(value: unknown): CsvCustomFieldConfiguration | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    if (raw["version"] !== 1 || !Array.isArray(raw["fields"]) || !Array.isArray(raw["optionFieldOrder"]) || !raw["builtInEnabled"] || typeof raw["builtInEnabled"] !== "object") return null;
    const rawBuiltIn = raw["builtInEnabled"] as Record<string, unknown>;
    const builtInKeys = ["account", "type", "necessity", "category", "note", "attachments"] as const;
    if (builtInKeys.some((key) => typeof rawBuiltIn[key] !== "boolean")) return null;
    const builtInEnabled: CsvCustomFieldConfiguration["builtInEnabled"] = {
      account: rawBuiltIn["account"] as boolean,
      type: rawBuiltIn["type"] as boolean,
      necessity: rawBuiltIn["necessity"] as boolean,
      category: rawBuiltIn["category"] as boolean,
      note: rawBuiltIn["note"] as boolean,
      attachments: rawBuiltIn["attachments"] as boolean
    };
    const ids = new Set<string>();
    const properties = new Set<string>();
    const fields: CustomFieldConfig[] = [];
    for (const item of raw["fields"]) {
      if (!item || typeof item !== "object") return null;
      const source = item as Record<string, unknown>;
      const id = String(source["id"] ?? "").trim();
      const name = String(source["name"] ?? "").trim();
      const property = String(source["property"] ?? name).trim();
      const normalizedProperty = property.toLocaleLowerCase("zh-CN");
      if (!/^[a-zA-Z0-9_-]+$/.test(id) || !name || !property || isReservedTransactionProperty(normalizedProperty) || ids.has(id) || properties.has(normalizedProperty)) return null;
      const kind = source["kind"] === "select" ? "select" : "text";
      const options = kind === "select" ? [...new Set((Array.isArray(source["options"]) ? source["options"] : []).map(String).map((option) => option.trim()).filter(Boolean))] : [];
      const rawCodes = source["optionCodes"] && typeof source["optionCodes"] === "object" ? source["optionCodes"] as Record<string, unknown> : {};
      const optionCodes = Object.fromEntries(options.map((option, index) => [option, String(rawCodes[option] ?? index + 1).trim() || String(index + 1)]));
      const defaultValue = options.includes(String(source["defaultValue"] ?? "")) ? String(source["defaultValue"]) : (options[0] ?? "");
      const loadedInitial = Array.isArray(source["initialOptions"])
        ? [...new Set(source["initialOptions"].map(String).map((option) => option.trim()).filter(Boolean))]
        : [];
      const initialOptions = kind === "select" && loadedInitial.length ? loadedInitial : [...options];
      const rawInitialCodes = source["initialOptionCodes"] && typeof source["initialOptionCodes"] === "object" ? source["initialOptionCodes"] as Record<string, unknown> : {};
      const initialOptionCodes = Object.fromEntries(initialOptions.map((option, index) => [option, String(rawInitialCodes[option] ?? optionCodes[option] ?? index + 1).trim() || String(index + 1)]));
      const initialDefaultValue = initialOptions.includes(String(source["initialDefaultValue"] ?? "")) ? String(source["initialDefaultValue"]) : (initialOptions[0] ?? "");
      ids.add(id);
      properties.add(normalizedProperty);
      fields.push({ id, name, property, kind, options, optionCodes, defaultValue, initialOptions, initialOptionCodes, initialDefaultValue, enabled: source["enabled"] !== false });
    }
    const builtinOrder: EntryField[] = ["date", "account", "type", "necessity", "category", "title", "amount", "note", "attachments"];
    const customKeys = fields.map((field) => customFieldKey(field.id));
    const allowed = new Set<EntryField>([...builtinOrder, ...customKeys]);
    const importedOrder = raw["optionFieldOrder"]
      .map(String)
      .filter((item): item is EntryField => allowed.has(item as EntryField));
    const optionFieldOrder = [...new Set([...importedOrder, ...builtinOrder, ...customKeys])];
    return { version: 1, builtInEnabled, fields, optionFieldOrder };
  }

  private fromFrontmatter(file: TFile, frontmatter: Frontmatter): Transaction | null {
    const typeValue = String(frontmatter["类型"] ?? this.getSettings().defaultType).trim() || this.getSettings().defaultType;
    const date = normalizeDate(frontmatter["日期"] ?? frontmatter["时间"]);
    const amount = Number(frontmatter["金额"]);
    if (!date || !Number.isFinite(amount)) return null;
    const necessityValue = String(frontmatter["标签"] ?? "").trim();
    const necessity = necessityValue || this.getSettings().defaultNecessity;
    const frontmatterTags = this.readFrontmatterTags(frontmatter["tags"]);
    const rawNote = String(frontmatter["备注"] ?? "");
    const extracted = this.extractExpression(rawNote, String(frontmatter["算式"] ?? ""), Math.abs(roundMoney(amount)));
    const note = extracted.note;
    const noteTags = frontmatter["记账插件"] === true ? [] : [...note.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((match) => match[1] ?? "").filter(Boolean);
    const tags = [...new Set([...frontmatterTags, ...noteTags].map((tag) => tag.replace(/^#/, "")))];
    return {
      // Files created before v3 have no record ID. Keep them readable and
      // give each a deterministic temporary identity until migration writes it.
      id: String(frontmatter["账目ID"] ?? "").trim() || "legacy-" + this.hashId(file.path + "|" + String(frontmatter["时间"] ?? "") + "|" + String(frontmatter["内容"] ?? "") + "|" + String(frontmatter["金额"] ?? "")),
      file,
      rawProperties: JSON.parse(JSON.stringify(frontmatter)) as Frontmatter,
      ...(isFrontmatter(frontmatter["财务扩展"]) ? { finance: JSON.parse(JSON.stringify(frontmatter["财务扩展"])) as FinanceDetails } : {}),
      legacy: !this.isCurrentTransactionProperties(frontmatter),
      date,
      time: String(frontmatter["时刻"] ?? normalizeTime(frontmatter["时间"])),
      type: typeValue,
      necessity,
      category: String(frontmatter["分类"] ?? (this.typeEffect(typeValue) === "positive" ? this.getSettings().defaultIncomeCategory : this.getSettings().defaultCategory)),
      account: String(frontmatter["账户"] ?? this.getSettings().defaultAccount),
      targetAccount: String(frontmatter["目标账户"] ?? ""),
      title: String(frontmatter["内容"] ?? file.basename),
      amount: Math.abs(roundMoney(amount)),
      expression: extracted.expression,
      note,
      tags,
      attachments: this.readStringList(frontmatter["附件"]),
      customValues: Object.fromEntries(this.getSettings().customFields.map((field) => [field.id, String(frontmatter[field.property] ?? "").trim() || customFieldDefaultValue(field)]))
    };
  }

  private toFrontmatter(draft: TransactionDraft, preserveExistingTransfer = false, id = this.makeId(), preserveFields = false): Frontmatter {
    const settings = this.getSettings();
    const groups = GROUPS;
    if (draft.category === "外卖") draft.category = "外卖配送";
    if (draft.category === "堂食") draft.category = "到店就餐";
    const major = Object.entries(groups).find(([,values])=>values.includes(draft.category))?.[0];
    if (settings.typeEffects[draft.type] === "positive") draft.customValues={...draft.customValues,major:"收入"};
    else if(major) draft.customValues={...draft.customValues,major};
    validateFinance(draft, settings);
    const account = draft.account || settings.defaultAccount;
    const isTransfer = draft.type === "转账";
    if (isTransfer && !preserveExistingTransfer && !canRecordTransfer(settings)) {
      throw new Error("转账需启用类型和账户功能，并至少添加两个账户");
    }
    if (isTransfer && (!draft.targetAccount || draft.targetAccount === account)) {
      throw new Error("转账缺少有效的目标账户");
    }
    const note = !draft.note || draft.note === "无" ? "" : draft.note.trim();
    const tags = settings.customFields.some(field=>field.id === "major" && field.enabled) ? [settings.typeEffects[draft.type] === "positive" ? "收入" : major || draft.customValues["major"] || "其他"] : draft.tags.filter(tag=>tag.replace(/^#/, "").trim() !== "记账");
    const customProperties = new Map(settings.customFields
      .filter((field) => preserveFields || field.enabled)
      .map((field) => [field.id, field.property] as const));
    for (const [id, property] of Object.entries(draft.customProperties ?? {})) {
      if (id && property.trim()) customProperties.set(id, property.trim());
    }
    return {
      "记账插件": true,
      "账目ID": id,
      "时间": `${draft.date} ${draft.time}`,
      ...(preserveFields || settings.enableType || preserveExistingTransfer ? { "类型": draft.type } : {}),
      ...((preserveFields || settings.enableNecessity) && !isTransfer ? { "标签": draft.necessity } : {}),
      ...((preserveFields || settings.enableCategory) && !isTransfer ? { "分类": draft.category || "未分类" } : {}),
      ...(preserveFields || settings.enableAccount || preserveExistingTransfer ? { "账户": account } : {}),
      ...(isTransfer && (settings.enableAccount || preserveExistingTransfer) ? { "目标账户": draft.targetAccount } : {}),
      "大类": draft.category && ["厨房用品","清洁日用","学习用品","床上用品","衣物鞋袜","家用电器"].includes(draft.category) ? "购物" : ["肉禽","鱼虾海鲜","蛋奶豆制品","蔬菜","主食粮油","调味品","水果"].includes(draft.category) ? "买菜" : draft.customValues["major"] || "其他",
      "内容": draft.title,
      "金额": roundMoney(draft.amount),
      ...(draft.finance ? { "财务扩展": draft.finance } : {}),
      ...(preserveFields || settings.enableNote && settings.saveExpressionInNote ? { "算式": this.normalizedExpression(draft) } : {}),
      ...(preserveFields ? { "备注": note } : settings.enableNote && (note || settings.saveExpressionInNote) ? { "备注": this.storedNote(draft) } : {}),
      ...(tags.length ? { "tags": tags } : {}),
      ...((preserveFields || settings.enableEntryAttachments) && draft.attachments.length ? { "附件": draft.attachments } : {}),
      ...Object.fromEntries([...customProperties]
        .map(([id, property]) => {
          const field = settings.customFields.find((item) => item.id === id);
          const value = String(draft.customValues[id] ?? "").trim() || (field ? customFieldDefaultValue(field) : "");
          return [property, value] as const;
        })
        .filter(([, value]) => value))
    };
  }

  private canonical(value: unknown): string {
    if (Object.prototype.toString.call(value) === "[object Date]") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => this.canonical(item)).join(",")}]`;
    if (isFrontmatter(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${this.canonical(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  }

  private mergeRecord(current: Frontmatter, draft: TransactionDraft, original: Transaction): Frontmatter {
    this.assertSnapshot(current, original);
    const settings = this.getSettings();
    const next = { ...current };
    const keys = ["日期", "时刻", "时间", "内容", "金额", "tags"];
    if (settings.enableType) keys.push("类型");
    if (settings.enableAccount) keys.push("账户", "目标账户");
    if (settings.enableCategory) keys.push("分类");
    if (settings.enableNecessity) keys.push("标签");
    if (settings.enableNote) keys.push("备注", "算式");
    if (settings.enableEntryAttachments) keys.push("附件");
    keys.push(...settings.customFields.filter((field) => field.enabled).map((field) => field.property));
    keys.forEach((key) => delete next[key]);
    return Object.assign(next, this.toFrontmatter(draft, original.type === "转账" && draft.type === "转账", original.id));
  }

  private hashId(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(36);
  }

  private normalizedExpression(draft: Pick<TransactionDraft, "expression" | "amount">): string {
    return draft.expression.trim() || String(roundMoney(draft.amount));
  }

  private storedNote(draft: TransactionDraft): string {
    const note = !draft.note || draft.note === "无" ? "" : draft.note.trim();
    if (!this.getSettings().saveExpressionInNote) return note || "无";
    const expression = this.normalizedExpression(draft);
    return note ? `${note}\n算式：${expression}` : `算式：${expression}`;
  }

  private extractExpression(rawNote: string, storedExpression: string, amount: number): { note: string; expression: string } {
    let note = rawNote === "无" ? "" : rawNote.trim();
    let expression = storedExpression.trim();
    const explicit = note.match(/(?:^|\n)\s*(?:算式|计算式|金额算式)\s*[:：]\s*([^\n]+)\s*$/i);
    if (explicit?.[1]) {
      if (!expression) expression = explicit[1].trim();
      note = note.replace(explicit[0], "").trim();
    }
    const trailing = note.match(/^(.*?)[（(]\s*([\d.＋+\-－—*/×÷()（）\s]+)\s*[）)]$/);
    if (trailing?.[2] && /[+\-－—*/×÷]/.test(trailing[2])) {
      if (!expression) expression = trailing[2].trim();
      note = (trailing[1] ?? "").trim();
    } else if (/^[\d.＋+\-－—*/×÷()（）\s]+$/.test(note) && /[+\-－—*/×÷]/.test(note)) {
      if (!expression) expression = note;
      note = "";
    }
    return { note: note || "无", expression: expression || String(amount) };
  }

  private readStringList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
    if (typeof value === "string") return value.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean);
    return [];
  }

  private readFrontmatterTags(value: unknown): string[] {
    const tags = Array.isArray(value)
      ? value.map(String)
      : typeof value === "string" ? value.split(/[ ,，]+/) : [];
    return tags.map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean);
  }

  private isCurrentTransactionProperties(frontmatter: Frontmatter): boolean {
    // A daily-v2 document is a container, not one transaction frontmatter.
    // Its records are individually validated by fromFrontmatter.
    if (Array.isArray(frontmatter["账目列表"])) return true;
    const marker = frontmatter["记账插件"] === true || this.readFrontmatterTags(frontmatter["tags"]).includes("记账");
    // Files written before v3 have the current-looking Properties but no
    // record UUID. Keep reading them, then expose them to the legacy converter
    // so the user can upgrade them into fully compatible v3 records.
    return marker && typeof frontmatter["账目ID"] === "string" && Boolean(String(frontmatter["账目ID"]).trim()) && !("日期" in frontmatter) && !("时刻" in frontmatter);
  }

  private legacyDraftFromProperties(frontmatter: Frontmatter, sourcePath: string, fallbackTitle: string): TransactionDraft {
    const settings = this.getSettings();
    const date = normalizeDate(frontmatter["日期"] ?? frontmatter["时间"]) ?? this.inferDateFromPath(sourcePath);
    if (!date) throw new Error("缺少有效日期，且无法从年月日文件夹补全");
    const signedAmount = Number(frontmatter["金额"]);
    if (!Number.isFinite(signedAmount)) throw new Error("缺少有效金额");
    const type = String(frontmatter["类型"] ?? settings.defaultType).trim() || settings.defaultType;
    const rawMoment = String(frontmatter["时刻"] ?? "").trim();
    const directTime = rawMoment.match(/^(\d{1,2}):(\d{2})$/);
    const time = directTime && Number(directTime[1]) <= 23 && Number(directTime[2]) <= 59
      ? `${String(Number(directTime[1])).padStart(2, "0")}:${directTime[2]}`
      : normalizeTime(frontmatter["时间"]);
    const rawNote = String(frontmatter["备注"] ?? "");
    const extracted = this.extractExpression(rawNote, String(frontmatter["算式"] ?? ""), Math.abs(roundMoney(signedAmount)));
    const frontmatterTags = this.readFrontmatterTags(frontmatter["tags"]);
    const noteTags = [...extracted.note.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((match) => match[1] ?? "").filter(Boolean);
    const tags = [...new Set([...frontmatterTags, ...noteTags]
      .map((tag) => tag.replace(/^#/, "").trim())
      .filter((tag) => tag && tag !== "记账"))];
    return {
      date,
      time,
      type,
      necessity: String(frontmatter["标签"] ?? settings.defaultNecessity).trim() || settings.defaultNecessity,
      category: String(frontmatter["分类"] ?? (this.typeEffect(type) === "positive" ? settings.defaultIncomeCategory : settings.defaultCategory)),
      account: String(frontmatter["账户"] ?? settings.defaultAccount),
      targetAccount: String(frontmatter["目标账户"] ?? ""),
      title: String(frontmatter["内容"] ?? fallbackTitle).trim() || fallbackTitle,
      amount: Math.abs(roundMoney(signedAmount)),
      expression: extracted.expression,
      note: extracted.note === "无" ? "" : extracted.note,
      tags,
      attachments: this.readStringList(frontmatter["附件"]),
      customValues: Object.fromEntries(settings.customFields.map((field) => [field.id, String(frontmatter[field.property] ?? "").trim() || customFieldDefaultValue(field)]))
    };
  }

  private inferDateFromPath(sourcePath: string): string | null {
    const directories = sourcePath.replace(/\\/g, "/").split("/").slice(0, -1);
    for (let index = directories.length - 3; index >= 0; index--) {
      const year = directories[index]?.match(/^(\d{4})年?$/)?.[1];
      const month = directories[index + 1]?.match(/^(\d{1,2})月?$/)?.[1];
      const day = directories[index + 2]?.match(/^(\d{1,2})日?$/)?.[1];
      if (!year || !month || !day) continue;
      const normalized = normalizeDate(`${year}-${month}-${day}`);
      if (normalized) return normalized;
    }
    return null;
  }

  private async scanVaultLegacyCandidates(folder: string): Promise<VaultLegacyCandidate[]> {
    const rawFolder = folder.trim().replace(/^\/+|\/+$/g, "");
    const selectedFolder = rawFolder ? safeFolder(rawFolder) : "";
    const prefix = selectedFolder ? `${selectedFolder}/` : "";
    const candidates: VaultLegacyCandidate[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.excludedPath(file.path)) continue;
      if (prefix && !file.path.startsWith(prefix)) continue;
      const content = await this.app.vault.cachedRead(file);
      let frontmatter: unknown;
      if (!isFrontmatter(frontmatter)) {
        const match = content.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (!match?.[1]) continue;
        if (!this.looksLikeLegacyProperties(match[1])) continue;
        try {
          const parsed: unknown = parseYaml(match[1]);
          if (!isFrontmatter(parsed)) {
            candidates.push({ file, content, reason: "Properties格式不合法" });
            continue;
          }
          frontmatter = parsed;
        } catch (error) {
          candidates.push({ file, content, reason: errorMessageZh(error, "Properties解析失败") });
          continue;
        }
      }
      if (!isFrontmatter(frontmatter) || !this.looksLikeTransactionProperties(frontmatter)) continue;
      const legacy = !this.isCurrentTransactionProperties(frontmatter);
      if (!legacy) continue;
      try {
        candidates.push({ file, content, draft: this.legacyDraftFromProperties(frontmatter, file.path, file.basename) });
      } catch (error) {
        candidates.push({ file, content, reason: errorMessageZh(error, "无法读取旧版账目属性") });
      }
    }
    return candidates;
  }

  private looksLikeLegacyProperties(yaml: string): boolean {
    return /^(?:记账插件|类型|金额|时间|日期|内容|分类|账户|标签)\s*:/mu.test(yaml);
  }

  private looksLikeTransactionProperties(frontmatter: Frontmatter): boolean {
    if ("记账插件" in frontmatter) return true;
    const keys = ["类型", "金额", "时间", "日期", "内容", "分类", "账户", "标签"];
    return keys.filter((key) => key in frontmatter).length >= 2 && ("金额" in frontmatter || "时间" in frontmatter || "日期" in frontmatter);
  }

  private toDraft(item: Transaction): TransactionDraft {
    return {
      ...(item.finance ? { finance: { ...item.finance } } : {}),
      date: item.date,
      time: item.time,
      type: item.type,
      necessity: item.necessity,
      category: item.category,
      account: item.account,
      targetAccount: item.targetAccount,
      title: item.title,
      amount: item.amount,
      expression: item.expression || String(item.amount),
      note: item.note === "无" ? "" : item.note,
      tags: [...item.tags],
      attachments: [...item.attachments],
      customValues: { ...item.customValues }
    };
  }

  private fingerprint(item: Pick<TransactionDraft, "date" | "time" | "type" | "amount" | "title">): string {
    return `${item.date}|${item.time}|${item.type}|${roundMoney(item.amount)}|${item.title.trim().toLocaleLowerCase("zh-CN")}`;
  }

  private replaceTagInNote(note: string, oldTag: string, replacement: string | null): string {
    const escaped = oldTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`#${escaped}(?=$|[\\s,，。.!！？;；])`, "gu");
    const next = note.replace(pattern, replacement ? `#${replacement}` : "").replace(/\s{2,}/g, " ").trim();
    return next === "无" ? "" : next;
  }

  private async writeImportFailureReport(headers: string[], failures: ImportFailure[]): Promise<TFile> {
    const folder = safeFolder(this.getSettings().exportFolder);
    await this.ensureFolder(folder);
    const lines = ["行号,失败原因," + headers.map(escapeCsv).join(","), ...failures.map((failure) => [failure.row, failure.reason, ...failure.raw].map(escapeCsv).join(","))];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return this.app.vault.create(normalizePath(`${folder}/CSV导入失败-${stamp}.csv`), `\uFEFF${lines.join("\n")}`);
  }

  private async writeLegacyFailureFolder(failures: LegacyFailureSource[]): Promise<string> {
    const root = safeFolder(this.getSettings().exportFolder);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const folder = normalizePath(root ? `${root}/旧版转换失败-${stamp}` : `旧版转换失败-${stamp}`);
    await this.ensureFolder(folder);
    const reportRows: string[] = ["文件,原始路径,失败原因"];
    for (const failure of failures) {
      const baseName = sanitizeFileName(failure.name.replace(/\.md$/i, "")) || "转换失败文件";
      const copyPath = this.uniqueFilePath(folder, baseName, "md");
      await this.app.vault.create(copyPath, failure.content);
      reportRows.push([copyPath.split("/").pop() ?? failure.name, failure.path, failure.reason].map(escapeCsv).join(","));
    }
    const reportPath = this.uniqueFilePath(folder, "失败说明", "csv");
    await this.app.vault.create(reportPath, `\uFEFF${reportRows.join("\n")}`);
    return folder;
  }

  private availableMarkdownPath(originalPath: string): string {
    if (!this.app.vault.getAbstractFileByPath(originalPath)) return originalPath;
    const dot = originalPath.toLowerCase().endsWith(".md") ? originalPath.length - 3 : originalPath.length;
    const base = originalPath.slice(0, dot);
    let index = 2;
    let path = `${base}-${index}.md`;
    while (this.app.vault.getAbstractFileByPath(path)) path = `${base}-${++index}.md`;
    return path;
  }

  private uniquePath(folder: string, baseName: string): string {
    let index = 1;
    let path = normalizePath(`${folder}/${baseName}.md`);
    while (this.app.vault.getAbstractFileByPath(path)) {
      index++;
      path = normalizePath(`${folder}/${baseName}-${index}.md`);
    }
    return path;
  }

  private uniqueFilePath(folder: string, baseName: string, extension: string): string {
    const suffix = extension ? `.${extension}` : "";
    let index = 1;
    let path = normalizePath(`${folder}/${baseName}${suffix}`);
    while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder}/${baseName}-${++index}${suffix}`);
    return path;
  }

  private attachmentSection(paths: string[]): string {
    if (!paths.length) return "";
    const attachments = paths.map((path, index) => {
      const safePath = path.replace(/\]\]/g, "] ]");
      const fileName = path.split("/").pop()?.replace(/[|\]]/g, " ") || "查看附件";
      return `### 凭证${index + 1} · ${fileName}\n![[${safePath}]]`;
    }).join("\n\n");
    return `\n<!-- bookkeeping-attachments:start -->\n## 关联附件\n${attachments}\n<!-- bookkeeping-attachments:end -->\n`;
  }

  private async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (!normalized) return;
    let current = "";
    for (const part of normalized.split("/")) {
      current = current ? `${current}/${part}` : part;
      if (this.app.vault.getAbstractFileByPath(current) || await this.app.vault.adapter.exists(current)) continue;
      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? "");
        const exists = Boolean(this.app.vault.getAbstractFileByPath(current)) || await this.app.vault.adapter.exists(current);
        if (!exists && !/folder.*already exists|already exists.*folder|eexist/i.test(message)) throw error;
      }
    }
  }

  private makeId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

}
