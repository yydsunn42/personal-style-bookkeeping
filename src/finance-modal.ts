import { App, ButtonComponent, Modal, Setting, TFile } from "obsidian";
import type BookkeepingPlugin from "./main";
import type { RecurringRule, Transaction, TransactionDraft } from "./types";
import { blankDraft, currencyCode, draftFromTransaction, dueOccurrences, latestRates, nextOccurrence, outstanding, priceDraft, splitDrafts, transactionLink } from "./finance";
import { currentTime, errorMessageZh, normalizeDate, today } from "./utils";
import { TransactionModal } from "./transaction-modal";
import { saveSettingField } from "./settings-write";
import { betaEnabled, financePageEnabled } from "./beta";
import { addDays, claimProgress, effectiveBudgets, forecast, HEALTH_LABELS, healthAdvice, planningOptions } from "./planning";

export type FinancePage = "loans" | "recurring" | "templates" | "currencies" | "health" | "recovery" | "transaction" | "planning" | "goals";

/** One management surface, with transaction-specific actions kept next to the record. */
export class FinanceModal extends Modal {
  private busy = false;
  private closed = false;
  private page: FinancePage;
  constructor(app: App, private readonly plugin: BookkeepingPlugin, page: FinancePage = "loans", private readonly source?: Transaction) { super(app); this.page = page; }
  onOpen(): void { this.closed = false; this.modalEl.addClass("bookkeeping-modal", "bookkeeping-finance-modal"); this.setTitle(this.plugin.t("账本管理")); void this.render().catch((error: unknown) => this.plugin.notice(errorMessageZh(error))); }
  onClose(): void { this.closed = true; this.contentEl.empty(); }
  private t(text: string): string { return this.plugin.t(text); }
  private field(parent: HTMLElement, name: string, value: string, change: (value: string) => void, type = "text"): void {
    new Setting(parent).setName(this.t(name)).addText((input) => { input.inputEl.type = type; input.inputEl.setAttribute("aria-label", this.t(name)); input.setValue(value).onChange(change); });
  }
  private button(parent: HTMLElement, label: string, action: () => Promise<void>, refresh = true): void {
    new ButtonComponent(parent).setButtonText(this.t(label)).onClick(() => { void (async () => {
      if (this.busy) return;
      if (!financePageEnabled(this.plugin.settings, this.page)) return void this.plugin.notice("请先在设置中启用对应Beta功能");
      this.busy = true; this.contentEl.setAttribute("aria-busy", "true");
      let completed = false;
      try { await action(); completed = true; await this.plugin.refreshDashboards(); }
      catch (error) { this.plugin.notice(errorMessageZh(error)); }
      finally { this.busy = false; if (!this.closed) { this.contentEl.removeAttribute("aria-busy"); if (refresh && completed) await this.render().catch((error: unknown) => this.plugin.notice(errorMessageZh(error))); } }
    })(); });
  }
  private openDraft(draft: TransactionDraft): void {
    new TransactionModal(this.app, this.plugin.store, this.plugin.settings, null, false, draft.date.slice(0, 7), async () => { await this.plugin.refreshDashboards(); if (!this.closed) await this.render(); }, draft).open();
  }
  private async render(): Promise<void> {
    if (this.closed) return;
    if (!financePageEnabled(this.plugin.settings, this.page)) { this.contentEl.empty(); this.contentEl.createEl("p", { text: this.t("请先在设置中启用对应Beta功能") }); return; }
    const content = this.contentEl; content.empty();
    const pages: Record<FinancePage, string> = { planning: "待办与预测", goals: "预算与目标", loans: "借贷管理", recurring: "周期记账", templates: "记账模板", currencies: "多币种与汇率", health: "账本健康检查", recovery: "安全迁移与恢复", transaction: "账目关联操作" };
    new Setting(content).setName(this.t("管理功能")).addDropdown((dropdown) => dropdown.addOptions(Object.fromEntries(Object.entries(pages).filter(([key]) => financePageEnabled(this.plugin.settings, key) && (key !== "transaction" || this.source)).map(([key, label]) => [key, this.t(label)]))).setValue(this.page).onChange((value) => { if (!this.busy) { this.page = value as FinancePage; void this.render().catch((error: unknown) => this.plugin.notice(errorMessageZh(error))); } }));
    const body = content.createDiv({ cls: "bookkeeping-finance-body" });
    if (this.page === "currencies") this.currencies(body);
    else if (this.page === "templates") this.templates(body);
    else if (this.page === "recurring") this.recurring(body);
    else if (this.page === "loans") await this.loans(body);
    else if (this.page === "health") await this.health(body);
    else if (this.page === "recovery") await this.recovery(body);
    else if (this.page === "planning") await this.planning(body);
    else if (this.page === "goals") await this.goals(body);
    else if (this.source) await this.transaction(body, this.source);
  }
  private currencies(body: HTMLElement): void {
    const settings = this.plugin.settings;
    const finance = settings.finance;
    body.createEl("p", { text: this.t("汇率仅影响新账目，历史账目使用保存时的汇率。") });
    let base = finance.baseCurrency;
    this.field(body, "本位币", base, (value) => base = value.toUpperCase());
    body.createEl("p", { text: this.t("旧账目没有币种时沿用本位币；已有币种快照后不能直接更换。") });
    this.button(body, "保存本位币", async () => {
      const previous = { baseCurrency: finance.baseCurrency, rates: finance.rates, currency: settings.currency };
      await this.plugin.store.setBaseCurrency(base);
      try { await this.plugin.saveSettingsQuietly(); }
      catch (error) { finance.baseCurrency = previous.baseCurrency; finance.rates = previous.rates; settings.currency = previous.currency; throw error; }
    });
    let code = "USD", rate = "", date = today();
    this.field(body, "币种", code, (value) => code = value.toUpperCase());
    this.field(body, "汇率", rate, (value) => rate = value);
    this.field(body, "日期", date, (value) => date = value, "date");
    body.createEl("p", { text: `1 ${this.t("外币")} = ? ${finance.baseCurrency}` });
    this.button(body, "保存汇率", async () => {
      const currency = currencyCode(code), value = Number(rate);
      if (currency === finance.baseCurrency || !Number.isFinite(value) || value <= 0 || !normalizeDate(date)) throw new Error(this.t("汇率或日期无效"));
      await saveSettingField(this.plugin, finance, "rates", { ...finance.rates, [currency]: { rate: value, date, source: "manual" } });
    });
    this.button(body, "一键获取最新汇率", async () => {
      const codes = [...new Set([...Object.keys(finance.rates), currencyCode(code)])];
      // Fetch all before applying; failure never discards offline rates.
      const updated = await latestRates(finance.baseCurrency, codes);
      await saveSettingField(this.plugin, finance, "rates", { ...finance.rates, ...updated });
      this.plugin.notice("汇率已更新");
    });
    const link = body.createEl("a", { text: "Frankfurter", href: "https://frankfurter.dev/" }); link.rel = "noopener noreferrer";
    body.createEl("p", { text: this.t("只发送币种代码；参考汇率按发布日更新，并非实时成交价。") });
    for (const [currency, saved] of Object.entries(finance.rates)) {
      const row = new Setting(body).setName(currency).setDesc(`1 ${currency} = ${saved.rate} ${finance.baseCurrency} · ${saved.date} · ${saved.source}`);
      row.nameEl.addClass("bookkeeping-user-text");
      this.button(row.controlEl, "删除", async () => { const rates = { ...finance.rates }; delete rates[currency]; await saveSettingField(this.plugin, finance, "rates", rates); });
    }
  }
  private draftFields(body: HTMLElement, showType = true): { draft: TransactionDraft; get: () => TransactionDraft } {
    const settings = this.plugin.settings;
    const draft = blankDraft(settings);
    let amount = "", currency = settings.finance.baseCurrency;
    this.field(body, "内容", draft.title, (value) => draft.title = value);
    this.field(body, "金额", amount, (value) => amount = value);
    this.field(body, "币种", currency, (value) => currency = value.toUpperCase());
    this.field(body, "账户", draft.account, (value) => draft.account = value);
    this.field(body, "分类", draft.category, (value) => draft.category = value);
    if (draft.type === "转账") draft.type = settings.typeOrder.find((type) => type !== "转账") ?? "支出";
    if (showType) new Setting(body).setName(this.t("类型")).addDropdown((dropdown) => dropdown.addOptions(Object.fromEntries(settings.typeOrder.filter((type) => type !== "转账").map((type) => [type, settings.typeLabels[type] ?? type]))).setValue(draft.type).onChange((value) => draft.type = value));
    return { draft, get: () => {
      if (!draft.title.trim() || !/^\d+(?:\.\d{1,2})?$/.test(amount.trim())) throw new Error(this.t("内容或金额无效"));
      return priceDraft({ ...draft }, settings, currency, Number(amount));
    } };
  }
  private templates(body: HTMLElement): void {
    const finance = this.plugin.settings.finance;
    let name = "";
    this.field(body, "名称", name, (value) => name = value);
    const entry = this.draftFields(body);
    this.button(body, "保存模板", async () => {
      if (!name.trim()) throw new Error(this.t("名称不得为空"));
      await saveSettingField(this.plugin, finance, "templates", [...finance.templates, { id: crypto.randomUUID(), name: name.trim(), draft: entry.get() }]);
    });
    for (const template of finance.templates) {
      const row = new Setting(body).setName(template.name).setDesc(`${template.draft.title} · ${template.draft.finance?.nativeAmount ?? template.draft.amount} ${template.draft.finance?.currency ?? finance.baseCurrency}`);
      row.nameEl.addClass("bookkeeping-user-text"); row.descEl.addClass("bookkeeping-user-text");
      row.addButton((button) => button.setButtonText(this.t("使用模板")).onClick(() => { const draft = { ...template.draft, date: today(), time: currentTime() }; this.openDraft(draft); }));
      this.button(row.controlEl, "删除", async () => { await saveSettingField(this.plugin, finance, "templates", finance.templates.filter((item) => item.id !== template.id)); });
    }
  }
  private recurring(body: HTMLElement): void {
    const finance = this.plugin.settings.finance;
    body.createEl("p", { text: this.t("到期账目先预览，确认后生成；插件关闭时不会后台记账。") });
    let name = "", start = today(), end = "", frequency: RecurringRule["frequency"] = "monthly";
    this.field(body, "名称", name, (value) => name = value);
    const entry = this.draftFields(body);
    this.field(body, "开始日期", start, (value) => start = value, "date");
    this.field(body, "结束日期", end, (value) => end = value, "date");
    new Setting(body).setName(this.t("周期")).addDropdown((dropdown) => dropdown.addOptions({ daily: this.t("每天"), weekly: this.t("每周"), monthly: this.t("每月"), yearly: this.t("每年") }).setValue(frequency).onChange((value) => frequency = value as RecurringRule["frequency"]));
    this.button(body, "保存周期规则", async () => {
      if (!name.trim() || !normalizeDate(start) || end && (!normalizeDate(end) || end < start)) throw new Error(this.t("名称或日期无效"));
      await saveSettingField(this.plugin, finance, "recurring", [...finance.recurring, { id: crypto.randomUUID(), name: name.trim(), draft: entry.get(), startDate: start, nextDate: start, endDate: end, frequency, enabled: true }]);
    });
    for (const rule of finance.recurring) {
      let dates: string[] = [], invalid = false;
      try { dates = dueOccurrences(rule); } catch { invalid = true; }
      const row = new Setting(body).setName(rule.name).setDesc(invalid ? this.t("名称或日期无效") : `${rule.nextDate} · ${this.t("待生成")}: ${dates.length}${dates.length === 120 ? "+" : ""}`);
      row.nameEl.addClass("bookkeeping-user-text");
      row.addToggle((toggle) => toggle.setValue(rule.enabled).onChange((value) => { if (this.busy) { toggle.setValue(rule.enabled); return; } void (async () => {
        this.busy = true;
        try { await saveSettingField(this.plugin, rule, "enabled", value); }
        catch (error) { this.plugin.notice(errorMessageZh(error)); }
        finally { this.busy = false; if (!this.closed) await this.render().catch((error: unknown) => this.plugin.notice(errorMessageZh(error))); }
      })(); }));
      if (dates.length) this.button(row.controlEl, "预览并生成", async () => {
        new FinanceConfirmModal(this.app, this.plugin, dates.join("\n"), async () => {
          for (const date of dates) {
            if (!rule.enabled || !finance.recurring.some((item) => item.id === rule.id)) throw new Error(this.t("周期规则已停用"));
            const key = `${rule.id}:${date}`;
            const priced = priceDraft({ ...rule.draft, date }, this.plugin.settings, rule.draft.finance?.currency ?? finance.baseCurrency, rule.draft.finance?.nativeAmount ?? rule.draft.amount);
            const draft = { ...priced, finance: { ...priced.finance!, occurrence: key } };
            await this.plugin.store.commitDrafts([draft], undefined, key);
            const next = nextOccurrence(rule, date);
            if (next > rule.nextDate) await saveSettingField(this.plugin, rule, "nextDate", next);
          }
          await this.plugin.refreshDashboards(); if (!this.closed) await this.render();
        }).open();
      });
      this.button(row.controlEl, "删除", async () => { await saveSettingField(this.plugin, finance, "recurring", finance.recurring.filter((item) => item.id !== rule.id)); });
    }
  }
  private async loans(body: HTMLElement): Promise<void> {
    let direction = "borrow", party = "", due = "";
    new Setting(body).setName(this.t("借贷方向")).addDropdown((dropdown) => dropdown.addOptions({ borrow: this.t("借入"), lend: this.t("借出") }).onChange((value) => direction = value));
    this.field(body, "往来对象", party, (value) => party = value);
    this.field(body, "到期日期", due, (value) => due = value, "date");
    const entry = this.draftFields(body, false);
    this.field(body, "日期", entry.draft.date, (value) => entry.draft.date = value, "date");
    this.button(body, "保存借贷", async () => {
      if (!party.trim() || !normalizeDate(entry.draft.date) || due && !normalizeDate(due)) throw new Error(this.t("对象或日期无效"));
      const draft = entry.get();
      draft.type = direction === "borrow" ? "借入本金" : "借出本金";
      draft.finance = { ...draft.finance!, kind: direction as "borrow" | "lend", party: party.trim(), dueDate: due, cashEffect: direction === "borrow" ? "positive" : "negative" };
      await this.plugin.store.commitDrafts([draft]);
    });
    body.createEl("p", { text: this.t("本金影响账户余额，不计入收入支出；利息请另记普通账目。") });
    const items = await this.plugin.store.list(); if (this.closed) return;
    for (const item of items.filter((item) => item.finance?.kind === "borrow" || item.finance?.kind === "lend")) {
      const left = outstanding(item, items);
      const row = new Setting(body).setName(`${item.finance!.party} · ${item.title}`).setDesc(`${this.t(item.finance!.kind === "borrow" ? "借入" : "借出")} · ${this.t("未结清")}: ${left} ${this.plugin.settings.finance.baseCurrency} · ${item.finance!.dueDate ?? ""}${left > 0 && item.finance!.dueDate && item.finance!.dueDate < today() ? ` · ${this.t("已逾期")}` : ""}`);
      row.nameEl.addClass("bookkeeping-user-text");
      if (left > 0) this.button(row.controlEl, "还款或收款", async () => { new FinanceModal(this.app, this.plugin, "transaction", item).open(); });
    }
  }
  private async transaction(body: HTMLElement, source: Transaction): Promise<void> {
    const fresh = (await this.plugin.store.list()).find((item) => item.id === source.id);
    if (!fresh) throw new Error(this.t("账目已发生变化，请刷新后重试"));
    body.createEl("p", { text: `${fresh.title} · ${fresh.amount} ${this.plugin.settings.finance.baseCurrency}`, cls: "bookkeeping-user-text" });
    if (betaEnabled(this.plugin.settings, "embeds")) this.button(body, "复制账目链接", async () => { await navigator.clipboard.writeText(transactionLink(this.app.vault.getName(), fresh.id)); }, false);
    if (betaEnabled(this.plugin.settings, "templates")) this.button(body, "保存为模板", async () => {
      const draft = { ...draftFromTransaction(fresh), finance: fresh.finance ? { ...fresh.finance, claim: undefined, kind: undefined, relatedId: undefined, occurrence: undefined, splitId: undefined, cashEffect: undefined, party: undefined, dueDate: undefined } : undefined };
      if (["借入本金", "借出本金", "偿还本金", "收回本金"].includes(draft.type)) draft.type = this.plugin.settings.defaultType === "转账" ? "支出" : this.plugin.settings.defaultType;
      const finance = this.plugin.settings.finance;
      await saveSettingField(this.plugin, finance, "templates", [...finance.templates, { id: crypto.randomUUID(), name: fresh.title, draft }]);
    });
    const canSettle = betaEnabled(this.plugin.settings, "loans") && (fresh.finance?.kind === "borrow" || fresh.finance?.kind === "lend") || betaEnabled(this.plugin.settings, "settlements") && ((!fresh.finance?.kind || fresh.finance?.kind === "split") && this.plugin.store.typeEffect(fresh.type) === "negative");
    if (betaEnabled(this.plugin.settings, "planning") && planningOptions(this.plugin.settings).claimsEnabled && this.plugin.store.typeEffect(fresh.type) === "negative" && (!fresh.finance?.kind || fresh.finance.kind === "split")) {
      body.createEl("h3", { text: this.t("预计到账") });
      let kind = fresh.finance?.claim?.kind ?? "reimbursement", amount = String(fresh.finance?.claim?.amount ?? fresh.amount), due = fresh.finance?.claim?.dueDate ?? "";
      new Setting(body).setName(this.t("类型")).addDropdown((input) => input.addOptions({ refund: this.t("待退款"), reimbursement: this.t("待报销") }).setValue(kind).onChange((value) => kind = value as typeof kind));
      this.field(body, "预计到账金额", amount, (value) => amount = value);
      this.field(body, "到期日期", due, (value) => due = value, "date");
      this.button(body, "保存待办", async () => {
        const draft = fresh.finance ? draftFromTransaction(fresh) : priceDraft(draftFromTransaction(fresh), this.plugin.settings, this.plugin.settings.finance.baseCurrency, fresh.amount);
        draft.expression = fresh.expression;
        draft.finance!.claim = { kind, amount: Number(amount), dueDate: due, closed: false };
        await this.plugin.store.update(fresh, draft);
      });
      if (fresh.finance?.claim) {
        const progress = claimProgress(fresh, await this.plugin.store.list());
        body.createEl("p", { text: `${this.t("已到账")}: ${progress.received} · ${this.t("未结清")}: ${progress.remaining}` });
        this.button(body, fresh.finance.claim.closed ? "重新打开待办" : "关闭待办", async () => { const draft = draftFromTransaction(fresh); draft.finance!.claim!.closed = !fresh.finance!.claim!.closed; await this.plugin.store.update(fresh, draft); });
        this.button(body, "移除待办", async () => { const draft = draftFromTransaction(fresh); delete draft.finance!.claim; await this.plugin.store.update(fresh, draft); });
      }
    }
    if (canSettle) {
      let kind = fresh.finance?.kind === "borrow" ? "repayment" : fresh.finance?.kind === "lend" ? "collection" : "refund";
      const options: Record<string, string> = kind === "repayment" ? { repayment: this.t("还款") } : kind === "collection" ? { collection: this.t("收款") } : { refund: this.t("退款"), reimbursement: this.t("报销到账") };
      new Setting(body).setName(this.t("关联操作")).addDropdown((dropdown) => dropdown.addOptions(options).setValue(kind).onChange((value) => kind = value));
      let amount = "", date = today(), account = fresh.account;
      this.field(body, "金额", amount, (value) => amount = value);
      this.field(body, "日期", date, (value) => date = value, "date");
      this.field(body, "账户", account, (value) => account = value);
      body.createEl("p", { text: this.t("关联金额以本位币填写；退款和报销显示为独立入账，原支出保留。") });
      this.button(body, "保存关联账目", async () => {
        if (!normalizeDate(date) || !/^\d+(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) throw new Error(this.t("内容或金额无效"));
        const draft = priceDraft({ ...blankDraft(this.plugin.settings), date, account, title: `${this.t(options[kind as keyof typeof options] ?? "关联操作")} · ${fresh.title}` }, this.plugin.settings, this.plugin.settings.finance.baseCurrency, Number(amount));
        draft.type = kind === "repayment" ? "偿还本金" : kind === "collection" ? "收回本金" : kind === "refund" ? "退款" : "报销到账";
        draft.finance = { ...draft.finance!, kind: kind as "repayment", relatedId: fresh.id, cashEffect: kind === "repayment" ? "negative" : "positive" };
        await this.plugin.store.settleRelated(fresh, draft);
      });
    }
    if (betaEnabled(this.plugin.settings, "settlements") && !fresh.finance?.kind && !fresh.finance?.claim && fresh.type !== "转账") {
      body.createEl("h3", { text: this.t("拆分交易") });
      body.createEl("p", { text: this.t("每行填写内容、分类、金额，以制表符分隔；金额合计必须等于原账目。") });
      let text = "";
      new Setting(body).setName(this.t("拆分明细")).addTextArea((input) => input.setPlaceholder(`${this.t("内容")}\t${this.t("分类")}\t30\n${this.t("内容")}\t${this.t("分类")}\t20`).onChange((value) => text = value));
      this.button(body, "预览拆分", async () => {
        const parts = text.trim().split(/\r?\n/).map((line) => { const [title = "", category = "", amount = ""] = line.split("\t"); if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) throw new Error(this.t("内容或金额无效")); return { title, category, amount: Number(amount) }; });
        const drafts = splitDrafts(fresh, parts, this.plugin.settings);
        new FinanceConfirmModal(this.app, this.plugin, drafts.map((draft) => `${draft.title} · ${draft.category} · ${draft.amount}`).join("\n"), async () => { await this.plugin.store.commitDrafts(drafts, fresh); await this.plugin.refreshDashboards(); this.close(); }).open();
      });
    }
  }
  private async health(body: HTMLElement): Promise<void> {
    const issues = await this.plugin.store.healthCheck(); if (this.closed) return;
    body.createEl("p", { text: `${this.t("问题数量")}: ${issues.length}` });
    for (const issue of issues.slice(0, planningOptions(this.plugin.settings).healthLimit)) {
      const row = body.createDiv({ cls: "bookkeeping-planning-card" });
      row.createEl("h4", { text: this.t(HEALTH_LABELS[issue.code] ?? issue.code) });
      row.createEl("p", { text: issue.path, cls: "bookkeeping-user-text" });
      row.createEl("p", { text: this.t(healthAdvice(issue.code)) });
      this.button(row, "修复预览", async () => {
        if (issue.code === "missing-id") {
          const preview = await this.plugin.store.previewMissingIds(issue.path);
          new FinanceConfirmModal(this.app, this.plugin, `${this.t(healthAdvice(issue.code))}\n\n${this.t("修改前")}\n${preview.before}\n\n${this.t("修改后")}\n${preview.after}`, async () => { await this.plugin.store.repairMissingIds(preview); await this.plugin.refreshDashboards(); if (!this.closed) await this.render(); }).open();
          return;
        }
        const file = this.app.vault.getAbstractFileByPath(issue.path);
        const original = file instanceof TFile ? await this.app.vault.read(file) : "";
        new FinanceConfirmModal(this.app, this.plugin, `${this.t(healthAdvice(issue.code))}\n\n${issue.path}\n${issue.detail}\n\n${original}`, async () => { if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file); }).open();
      }, false);
    }
    this.button(body, "重建索引", async () => { this.plugin.store.invalidate(); await this.plugin.refreshDashboards(); });
    this.button(body, "导出检查报告", async () => {
      const file = await this.plugin.store.exportHealthReport(); await this.app.workspace.getLeaf(false).openFile(file);
    });
  }
  private async planning(body: HTMLElement): Promise<void> {
    const settings = this.plugin.settings, options = planningOptions(settings), items = await this.plugin.store.list();
    if (this.closed) return;
    if (options.claimsEnabled) {
      body.createEl("h3", { text: this.t("待报销与待退款") });
      const pending = items.filter((item) => item.finance?.claim && !claimProgress(item, items).closed);
      if (!pending.length) body.createEl("p", { text: this.t("没有待办事项") });
      for (const item of pending) {
        const progress = claimProgress(item, items), claim = item.finance!.claim!;
        const row = new Setting(body).setName(item.title).setDesc(`${this.t(claim.kind === "refund" ? "待退款" : "待报销")} · ${progress.received}/${progress.expected} ${settings.finance.baseCurrency} · ${claim.dueDate}`);
        row.nameEl.addClass("bookkeeping-user-text");
        this.button(row.controlEl, "打开", async () => { new FinanceModal(this.app, this.plugin, "transaction", item).open(); }, false);
      }
    }
    if (!options.forecastEnabled) return;
    body.createEl("h3", { text: this.t("未来现金流") });
    body.createEl("p", { text: this.t("仅预测已设置日期的待办、借贷和周期规则；不自动记账，不代表可用余额。") });
    const result = forecast(items, settings, (type) => this.plugin.store.typeEffect(type));
    const due = addDays(today(), options.dueDays);
    body.createEl("p", { text: `${this.t("到期提醒")}: ${result.events.filter((item) => item.date <= due).length} · ${this.t("预计净流入")}: ${result.events.reduce((sum, item) => sum + item.amount, 0).toFixed(2)} ${settings.finance.baseCurrency}` });
    if (result.warnings.length) body.createEl("p", { text: `${this.t("部分周期规则无法预测，请检查日期和汇率。")} ${result.warnings.join("、")}`, cls: "bookkeeping-user-text" });
    for (const event of result.events) {
      const row = new Setting(body).setName(event.title).setDesc(`${event.date} · ${event.amount > 0 ? "+" : ""}${event.amount} ${settings.finance.baseCurrency}${event.overdue ? ` · ${this.t("已逾期")}` : ""}`);
      row.nameEl.addClass("bookkeeping-user-text");
    }
  }
  private async goals(body: HTMLElement): Promise<void> {
    const settings = this.plugin.settings, options = planningOptions(settings);
    body.createEl("p", { text: this.t("预算结转在设置中启用；储蓄进度手动维护，不改变账户余额。") });
    const budgets = effectiveBudgets(settings, await this.plugin.store.list(), today().slice(0, 7), (type) => this.plugin.store.typeEffect(type));
    for (const [category, budget] of Object.entries(budgets)) {
      const row = new Setting(body).setName(category).setDesc(`${this.t("基础预算")}: ${budget.base} · ${this.t("结转")}: ${budget.carry} · ${this.t("可用预算")}: ${budget.available}`); row.nameEl.addClass("bookkeeping-user-text");
    }
    if (!options.goalsEnabled) return;
    body.createEl("h3", { text: this.t("储蓄目标") });
    let name = "", target = "", saved = "0", due = "";
    this.field(body, "名称", name, (value) => name = value);
    this.field(body, "目标金额", target, (value) => target = value);
    this.field(body, "已存金额", saved, (value) => saved = value);
    this.field(body, "到期日期", due, (value) => due = value, "date");
    this.button(body, "保存目标", async () => {
      if (!name.trim() || !Number.isFinite(Number(target)) || Number(target) <= 0 || !Number.isFinite(Number(saved)) || Number(saved) < 0 || due && !normalizeDate(due)) throw new Error(this.t("内容或金额无效"));
      await saveSettingField(this.plugin, settings.planning, "goals", [...settings.planning.goals, { id: crypto.randomUUID(), name: name.trim(), target: Number(target), saved: Number(saved), dueDate: due }]);
    });
    for (const goal of options.goals) {
      let progress = String(goal.saved);
      const row = body.createDiv({ cls: "bookkeeping-planning-card" });
      row.createEl("h4", { text: `${goal.name} · ${Math.min(100, goal.saved / goal.target * 100).toFixed(0)}% · ${goal.target} ${settings.finance.baseCurrency} · ${goal.dueDate}`, cls: "bookkeeping-user-text" });
      this.field(row, "已存金额", progress, (value) => progress = value);
      this.button(row, "保存", async () => { if (!Number.isFinite(Number(progress)) || Number(progress) < 0) throw new Error(this.t("内容或金额无效")); await saveSettingField(this.plugin, goal, "saved", Number(progress)); });
      this.button(row, "删除", async () => { await saveSettingField(this.plugin, settings.planning, "goals", settings.planning.goals.filter((item) => item.id !== goal.id)); });
    }
  }
  private async recovery(body: HTMLElement): Promise<void> {
    body.createEl("p", { text: this.t("恢复前会检查文件是否仍匹配备份；外部改动不会被覆盖。") });
    this.button(body, "检查并恢复中断操作", async () => { await this.plugin.store.recoverInterruptedMigrations(); await this.plugin.saveSettings(); });
    if (betaEnabled(this.plugin.settings, "storage")) this.button(body, "切换账目存储格式", async () => { this.plugin.openStorageMigration(this.plugin.settings.storageFormat === "single" ? "daily" : "single"); }, false);
    body.createEl("p", { text: `${this.plugin.settings.ledgerFolder}/_bookkeeping-recovery` });
    const folder = `${this.plugin.settings.ledgerFolder.replace(/\/$/, "")}/_bookkeeping-recovery/`;
    for (const file of this.app.vault.getFiles().filter((file) => file.path.startsWith(folder) && file.extension === "json")) {
      const row = new Setting(body).setName(file.name);
      row.nameEl.addClass("bookkeeping-user-text");
      this.button(row.controlEl, "查看备份", async () => { await this.app.workspace.getLeaf(false).openFile(file); }, false);
      let journal: { status?: string };
      try { journal = JSON.parse(await this.app.vault.read(file)) as { status?: string }; }
      catch { continue; }
      if (journal && journal.status === "complete") this.button(row.controlEl, "恢复此备份", async () => {
        new FinanceConfirmModal(this.app, this.plugin, this.t("只在相关文件仍匹配备份时撤销此操作，新增文件将移至回收站。"), async () => { await this.plugin.store.restoreCompletedBackup(file); await this.plugin.saveSettings(); if (!this.closed) await this.render(); }).open();
      });
    }
  }
}

class FinanceConfirmModal extends Modal {
  private running = false;
  constructor(app: App, private readonly plugin: BookkeepingPlugin, private readonly preview: string, private readonly action: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("bookkeeping-modal", "bookkeeping-finance-modal");
    this.setTitle(this.plugin.t("确认操作"));
    this.contentEl.createEl("pre", { text: this.preview, cls: "bookkeeping-user-text" });
    new ButtonComponent(this.contentEl).setButtonText(this.plugin.t("确认")).setCta().onClick(() => { void (async () => {
      if (this.running) return; this.running = true;
      try { await this.action(); this.close(); } catch (error) { this.plugin.notice(errorMessageZh(error)); } finally { this.running = false; }
    })(); });
  }
}
