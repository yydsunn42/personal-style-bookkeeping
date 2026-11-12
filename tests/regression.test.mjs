import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { parse, stringify } from 'yaml';
import { webcrypto } from 'node:crypto';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
class TFile {
  constructor(path) { this.path = path; }
  get name() { return this.path.split('/').at(-1); }
  get basename() { return this.name.replace(/\.[^.]+$/, ''); }
  get extension() { return this.name.split('.').at(-1); }
}
class TFolder { constructor(path) { this.path = path; this.children = []; } }
let responder = async () => ({ status: 200, json: { choices: [{ message: { content: 'OK' } }] } });
const obsidian = { TFile, TFolder, Modal: class {}, Setting: class {}, TextComponent: class {}, Notice: class {}, Platform: { isDesktop: true, isMacOS: false }, normalizePath: (path) => path.replaceAll('\\', '/').replace(/\/{2,}/g, '/'), parseYaml: parse, stringifyYaml: stringify, requestUrl: (request) => responder(request) };
const result = await build({ stdin: { contents: `export * from './src/hierarchy'; export * from './src/transaction-store'; export * from './src/types'; export * from './src/utils'; export * from './src/ai'; export * from './src/finance'; export * from './src/planning'; export * from './src/lock'; export {translate} from './src/locales';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'] });
const mod = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module: mod, exports: mod.exports, require: (name) => name === 'obsidian' ? obsidian : require(name), crypto: webcrypto, btoa, atob, TextEncoder, window: {}, URL, AbortController, setTimeout, clearTimeout, console });
const { TransactionStore, DEFAULT_SETTINGS, parseNoteTags, evaluateAmount, analysisRequest, analysisText, analysisPayload, analyze, listModels, defaultAnalysisPrompt, translate } = mod.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const { priceDraft, splitDrafts, nextOccurrence, dueOccurrences, latestRates, outstanding, draftFromTransaction, normalizeFinanceSettings, transactionLink } = mod.exports;
function environment(mode = 'single') {
  const settings = plain(DEFAULT_SETTINGS);
  settings.beta.enabled = true; for (const key of Object.keys(settings.beta.features)) settings.beta.features[key] = true;
  Object.assign(settings, { storageFormat: mode, ledgerFolder: 'ledger', exportFolder: 'ledger/export', attachmentFolder: '记账/附件', enableNote: true, enableEntryAttachments: true, allowDuplicateContent: true });
  const files = new Map();
  const contents = new Map();
  const trash = new Map();
  const fault = { next: null };
  const fail = (op, path) => { if (fault.next?.(op, path)) { fault.next = null; throw new Error('injected failure'); } };
  const app = {
    vault: {
      adapter: { exists: async (path) => files.has(path) },
      getMarkdownFiles: () => [...files.values()].filter((file) => file instanceof TFile && file.extension === 'md'),
      getAbstractFileByPath: (path) => files.get(path),
      read: async (file) => { if (!contents.has(file.path)) throw Error('missing file'); return contents.get(file.path); },
      cachedRead: async (file) => app.vault.read(file),
      createFolder: async (path) => { if (files.has(path)) throw Error('exists'); const folder = new TFolder(path); Object.defineProperty(folder, 'children', { get: () => [...files.values()].filter((file) => file.path.slice(0, file.path.lastIndexOf('/')) === path) }); files.set(path, folder); },
      create: async (path, content) => { fail('create', path); if (files.has(path)) throw Error('exists'); const file = new TFile(path); files.set(path, file); contents.set(path, content); return file; },
      modify: async (file, content) => { fail('modify', file.path); contents.set(file.path, content); },
      process: async (file, update) => { fail('process', file.path); const next = update(contents.get(file.path)); contents.set(file.path, next); return next; },
      delete: async (file) => { fail('delete', file.path); files.delete(file.path); contents.delete(file.path); }
    },
    metadataCache: { getFileCache: () => undefined }, // Deliberately stale: no cache dependency.
    fileManager: {
      trashFile: async (file) => { fail('trash', file.path); trash.set(file.path, contents.get(file.path)); files.delete(file.path); contents.delete(file.path); },
      renameFile: async (file, path) => { fail('rename', path); if (files.has(path)) throw Error('exists'); const content = contents.get(file.path); files.delete(file.path); contents.delete(file.path); file.path = path; files.set(path, file); contents.set(path, content); },
      processFrontMatter: async (file, update) => app.vault.process(file, (content) => { const doc = document(content); update(doc.properties); return serialize(doc.properties, doc.body); })
    }
  };
  const store = new TransactionStore(app, () => settings);
  return { app, store, settings, files, contents, trash, fault };
}
const serialize = (properties, body = '') => `---\n${stringify(properties)}---\n${body}`;
function document(content) { const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/); return { properties: parse(match[1]), body: match[2] }; }
const draft = (extra = {}) => ({ date: '2026-07-01', time: '12:00', type: '支出', necessity: '必需', category: '餐饮', account: 'A', targetAccount: '', title: 'lunch', amount: 10, expression: '10', note: 'note', tags: ['food'], attachments: [], customValues: {}, ...extra });
const record = (id, extra = {}) => ({ '记账插件': true, '账目ID': id, '时间': '2026-07-01 12:00', '类型': '支出', '金额': 10, '内容': id, ...extra });
const { claimProgress, forecast, effectiveBudgets, normalizePlanning } = mod.exports;

for (const mode of ['single', 'daily']) {
  test(`${mode}: disabling beta preserves existing financial records and ordinary editing`, async () => {
    const e = environment(mode), entry = priceDraft(draft(), e.settings, 'CNY', 100);
    entry.finance.claim = { kind: 'refund', amount: 50, dueDate: '2026-07-20', closed: false };
    await e.store.create(entry);
    e.settings.beta = plain(DEFAULT_SETTINGS.beta);
    const [existing] = await e.store.list(); const snapshot = plain(existing.finance);
    await e.store.update(existing, draftFromTransaction({ ...existing, title: 'Updated without beta' }));
    const [after] = await e.store.list(); assert.deepEqual(plain(after.finance), snapshot); assert.equal(after.amount, 100); assert.equal(after.title, 'Updated without beta');
    assert.equal(forecast([after], e.settings, (type) => e.settings.typeEffects[type], '2026-07-01').events.length, 0);
  });
  test(`${mode}: pending reimbursement survives CSV and migration without creating income`, async () => {
    const e = environment(mode);
    const priced = priceDraft(draft({ amount: 100 }), e.settings, 'CNY', 100);
    priced.finance.claim = { kind: 'reimbursement', amount: 80, dueDate: '2026-07-10', closed: false };
    await e.store.create(priced);
    let items = await e.store.list(); const id = items[0].id;
    assert.equal(items.length, 1); assert.equal(claimProgress(items[0], items).remaining, 80);
    const settle = priceDraft(draft({ date: '2026-07-02', type: '报销到账', title: 'part' }), e.settings, 'CNY', 30);
    settle.finance = { ...settle.finance, kind: 'reimbursement', relatedId: id, cashEffect: 'positive' };
    await e.store.settleRelated(items[0], settle);
    items = await e.store.list(); assert.equal(claimProgress(items.find((item) => item.id === id), items).remaining, 50);
    await e.store.migrateStorageFormat(mode === 'single' ? 'daily' : 'single');
    items = await e.store.list(); assert.equal(items.find((item) => item.id === id).finance.claim.amount, 80);
    const csv = await e.store.exportCsv('2026-07'); const target = environment(mode);
    await target.store.importCsv(await e.app.vault.read(csv));
    const imported = await target.store.list(); assert.equal(imported.length, 2); assert.equal(imported.find((item) => item.id === id).finance.claim.kind, 'reimbursement');
    assert.equal((await target.store.healthCheck()).length, 0);
  });
  test(`${mode}: missing-ID repair previews, checks snapshots, journals and restores`, async () => {
    const e = environment(mode), path = 'ledger/legacy.md';
    const properties = record('old'); delete properties['账目ID'];
    const raw = mode === 'daily' ? { '记账插件': true, custom: 'keep', '账目列表': [properties, record('existing')] } : properties;
    const before = serialize(raw, 'Body stays\n'); const file = await e.app.vault.create(path, before);
    const preview = await e.store.previewMissingIds(path); assert.equal(preview.count, 1); assert.equal(await e.app.vault.read(file), before);
    await assert.rejects(e.store.repairMissingIds({ ...preview, after: preview.after.replace('金额: 10', '金额: 11') }));
    await e.store.repairMissingIds(preview); assert.notEqual(await e.app.vault.read(file), before);
    assert.equal((await e.store.healthCheck()).filter((issue) => issue.code === 'missing-id').length, 0);
    const backup = [...e.files.values()].find((file) => file.extension === 'json'); await e.store.restoreCompletedBackup(backup);
    assert.equal(await e.app.vault.read(file), before);
    const stale = await e.store.previewMissingIds(path); await e.app.vault.modify(file, before + 'external');
    await assert.rejects(e.store.repairMissingIds(stale)); assert.equal(await e.app.vault.read(file), before + 'external');
  });
  test(`${mode}: ID repair rolls back a failed completion without losing the original`, async () => {
    const e = environment(mode), raw = record('old'); delete raw['账目ID'];
    const file = await e.app.vault.create('ledger/legacy.md', serialize(mode === 'daily' ? { '记账插件': true, '账目列表': [raw] } : raw, 'body'));
    const before = await e.app.vault.read(file), preview = await e.store.previewMissingIds(file.path);
    e.fault.next = (operation, path) => operation === 'modify' && path.endsWith('.json');
    await assert.rejects(e.store.repairMissingIds(preview)); assert.equal(await e.app.vault.read(file), before);
    assert.equal((await e.store.list()).length, 1);
  });
  test(`${mode}: explicit empty IDs repair without changing other fields`, async () => {
    for (const id of ['', null, '   ']) {
      const e = environment(mode), raw = record(id);
      const before = serialize(mode === 'daily' ? { '记账插件': true, '账目列表': [raw] } : raw, 'untouched body');
      const file = await e.app.vault.create('ledger/empty-id.md', before);
      assert.equal((await e.store.healthCheck()).filter((issue) => issue.code === 'missing-id').length, 1);
      const preview = await e.store.previewMissingIds(file.path); assert.equal(preview.count, 1);
      await e.store.repairMissingIds(preview);
      assert.equal((await e.store.healthCheck()).filter((issue) => issue.code === 'missing-id').length, 0);
      const backup = [...e.files.values()].find((file) => file.extension === 'json');
      await e.store.restoreCompletedBackup(backup); assert.equal(await e.app.vault.read(file), before);
    }
  });
}

test('malformed recurrence dates and frequencies fail instead of repeating one occurrence', () => {
  const valid = { enabled: true, frequency: 'monthly', startDate: '2026-07-01', nextDate: '2026-07-01', endDate: '' };
  for (const change of [{ frequency: 'invalid' }, { startDate: '2026-02-30' }, { nextDate: '2026-06-01' }, { endDate: '2026-02-30' }, { endDate: '2026-06-01' }]) {
    assert.throws(() => dueOccurrences({ ...valid, ...change }, '2026-08-01'), /recurrence/);
  }
  assert.throws(() => nextOccurrence({ ...valid, frequency: 'invalid' }, valid.nextDate), /recurrence/);
  assert.throws(() => dueOccurrences(valid, '2026-08-01', Infinity), /recurrence/);
});

test('due reminder horizon can exceed the forecast horizon without changing settings', () => {
  const e = environment(); e.settings.planning.forecastDays = 1;
  const claim = { ...draft({ amount: 100 }), id: 'pending', finance: { claim: { kind: 'refund', amount: 100, dueDate: '2026-07-20', closed: false } } };
  const effect = (type) => e.settings.typeEffects[type];
  assert.equal(forecast([claim], e.settings, effect, '2026-07-01').events.length, 0);
  assert.equal(forecast([claim], e.settings, effect, '2026-07-01', 30).events.length, 1);
  assert.equal(e.settings.planning.forecastDays, 1);
});
test('pending tasks reject impossible amounts, dates and income sources without modifying files', async () => {
  for (const change of [{ amount: 101 }, { amount: -1 }, { dueDate: '2026-02-30' }]) {
    const e = environment(), entry = priceDraft(draft(), e.settings, 'CNY', 100);
    entry.finance.claim = { kind: 'refund', amount: 80, dueDate: '', closed: false, ...change };
    await assert.rejects(e.store.create(entry)); assert.equal((await e.store.list()).length, 0);
  }
  const e = environment(), entry = priceDraft(draft({ type: '收入' }), e.settings, 'CNY', 100);
  entry.finance.claim = { kind: 'refund', amount: 80, dueDate: '', closed: false };
  await assert.rejects(e.store.create(entry));
});
test('forecast loan directions and partial settlements exclude repaid principal', () => {
  const e = environment(), borrow = { ...draft({ amount: 100 }), id: 'a', finance: { kind: 'borrow', dueDate: '2026-07-10' } }, lend = { ...draft({ amount: 60 }), id: 'b', finance: { kind: 'lend', dueDate: '2026-07-11' } };
  const settlement = { ...draft({ amount: 40 }), id: 'c', finance: { kind: 'repayment', relatedId: 'a' } };
  const result = forecast([borrow, lend, settlement], e.settings, (type) => e.settings.typeEffects[type], '2026-07-01');
  assert.deepEqual(plain(result.events.map((item) => item.amount)), [-60, 60]);
  e.settings.planning.includeLoans = false; assert.equal(forecast([borrow, lend], e.settings, () => 'neutral', '2026-07-01').events.length, 0);
});
test('forecast deducts settlements, excludes closed claims and skips existing recurring occurrences', () => {
  const e = environment(); e.settings.planning.forecastDays = 31;
  const claim = { ...priceDraft(draft(), e.settings, 'CNY', 100), id: 'a' };
  claim.finance.claim = { kind: 'refund', amount: 80, dueDate: '2026-07-03', closed: false };
  const receipt = { ...draft({ amount: 30 }), id: 'b', finance: { kind: 'refund', relatedId: 'a' } };
  e.settings.finance.recurring.push({ id: 'r', name: 'rent', draft: draft(), nextDate: '2026-07-01', startDate: '2026-07-01', endDate: '', frequency: 'monthly', enabled: true });
  const existing = { ...draft(), id: 'c', finance: { occurrence: 'r:2026-07-01' } };
  const effect = (type) => e.settings.typeEffects[type];
  let result = forecast([claim, receipt, existing], e.settings, effect, '2026-07-05');
  assert.equal(result.events.find((item) => item.id === 'a').amount, 50); assert.equal(result.events.find((item) => item.id === 'a').overdue, true);
  assert.equal(result.events.filter((item) => item.source === 'recurring').length, 1);
  claim.finance.claim.closed = true; assert.equal(forecast([claim, receipt, existing], e.settings, effect, '2026-07-05').events.some((item) => item.id === 'a'), false);
});
test('budget rollover crosses year boundaries, carries deficits only on request, preserves base snapshots', () => {
  const e = environment(), effect = (type) => e.settings.typeEffects[type];
  e.settings.monthlyBudgets = { '总预算': 999 }; Object.assign(e.settings.planning, { rollover: 'positive', rolloverStart: '2025-12', budgetBases: { '2025-12': { '总预算': 100 }, '2026-02': { '总预算': 200 } } });
  const items = [draft({ date: '2025-12-02', amount: 130 }), draft({ date: '2026-01-02', amount: 50 })];
  assert.equal(effectiveBudgets(e.settings, items, '2026-02', effect)['总预算'].available, 250);
  e.settings.planning.rollover = 'all'; assert.equal(effectiveBudgets(e.settings, items, '2026-02', effect)['总预算'].available, 220);
  e.settings.planning.rollover = 'off'; assert.equal(effectiveBudgets(e.settings, items, '2026-02', effect)['总预算'].available, 999);
});
test('planning normalization tolerates older or malformed settings and repairs filter shapes', () => {
  const e = environment(); e.settings.planning = { views: [{ id: 'a', name: 'x', month: '2026-07', filters: { types: 'invalid' } }], budgetBases: { bad: null }, pageSize: Infinity };
  normalizePlanning(e.settings); assert.equal(e.settings.planning.pageSize, 100); assert.deepEqual(plain(e.settings.planning.views[0].filters.types), []); assert.deepEqual(plain(e.settings.planning.budgetBases), {});
});

test('opt-in real-vault disk copy: complete migration roundtrip preserves each transaction and original files', { skip: !process.env.BOOKKEEPING_TEST_VAULT }, async (context) => {
  const vault = path.resolve(process.env.BOOKKEEPING_TEST_VAULT);
  const sandbox = await fs.mkdtemp(path.join(vault, '.bookkeeping-qa-'));
  const e = environment();
  const loaded = JSON.parse(await fs.readFile(path.join(vault, '.obsidian/plugins/personal-style-bookkeeping/data.json'), 'utf8'));
  Object.assign(e.settings, loaded, { ledgerFolder: 'ledger', exportFolder: 'ledger/export', storageFormat: loaded.storageFormat ?? 'single' });
  normalizeFinanceSettings(e.settings, !loaded.finance);
  const ledger = path.resolve(vault, loaded.ledgerFolder);
  assert.ok(ledger.startsWith(vault + path.sep), 'Source ledger must stay inside the specified test vault');
  const diskPath = (name) => {
    const resolved = path.resolve(sandbox, ...name.split('/'));
    assert.ok(resolved.startsWith(sandbox + path.sep), 'All writes must stay in the isolated sandbox');
    return resolved;
  };
  const syncFile = async (file) => {
    const target = diskPath(file.path); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, e.contents.get(file.path));
  };
  for (const operation of ['create', 'modify', 'process']) {
    const original = e.app.vault[operation];
    e.app.vault[operation] = async (...args) => {
      const result = await original(...args); await syncFile(operation === 'create' ? result : args[0]); return result;
    };
  }
  const createFolder = e.app.vault.createFolder;
  e.app.vault.createFolder = async (name) => { await createFolder(name); await fs.mkdir(diskPath(name), { recursive: true }); };
  const remove = e.app.vault.delete;
  e.app.vault.delete = async (file) => { const target = diskPath(file.path); await remove(file); if (file instanceof TFolder) await fs.rmdir(target); else await fs.unlink(target); };
  const trash = e.app.fileManager.trashFile;
  e.app.fileManager.trashFile = async (file) => {
    const target = diskPath(file.path), destination = diskPath(`.trash/${webcrypto.randomUUID()}-${file.name}`);
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.rename(target, destination); await trash(file);
  };
  const rename = e.app.fileManager.renameFile;
  e.app.fileManager.renameFile = async (file, name) => {
    const source = diskPath(file.path), target = diskPath(name);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.rename(source, target); await rename(file, name);
  };
  const hashes = new Map();
  const seed = async (folder, relative = 'ledger') => {
    await e.app.vault.createFolder(relative);
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const source = path.join(folder, entry.name), name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await seed(source, name);
      else if (entry.isFile()) {
        const data = await fs.readFile(source); hashes.set(source, createHash('sha256').update(data).digest('hex'));
        if (entry.name.endsWith('.md') || entry.name.endsWith('.json')) await e.app.vault.create(name, data.toString('utf8'));
        else { const target = diskPath(name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target); }
      }
    }
  };
  await seed(ledger);
  const fingerprint = (items) => items.map((item) => JSON.stringify(plain({ date: item.date, time: item.time, type: item.type, title: item.title, amount: item.amount, necessity: item.necessity, category: item.category, account: item.account, targetAccount: item.targetAccount, note: item.note, expression: item.expression, tags: item.tags, attachments: item.attachments, customValues: item.customValues, finance: item.finance }))).sort();
  const initial = await e.store.list(), expected = fingerprint(initial), originalMode = e.settings.storageFormat;
  assert.ok(initial.length > 0, 'The supplied vault must contain readable transactions');
  await e.store.migrateStorageFormat(originalMode === 'single' ? 'daily' : 'single');
  const daily = await e.store.list(); assert.deepEqual(fingerprint(daily), expected);
  const ids = daily.map((item) => item.id).sort(); assert.equal(new Set(ids).size, initial.length);
  await e.store.migrateStorageFormat(originalMode);
  const restored = await e.store.list(); assert.deepEqual(fingerprint(restored), expected); assert.deepEqual(restored.map((item) => item.id).sort(), ids);
  const other = environment('daily'); Object.assign(other.settings, plain(e.settings), { storageFormat: 'daily' });
  const imported = await other.store.importCsv(await e.store.buildCsv()); assert.equal(imported.imported, initial.length); assert.equal(imported.failures.length, 0);
  assert.deepEqual(fingerprint(await other.store.list()), expected);
  for (const [source, hash] of hashes) assert.equal(createHash('sha256').update(await fs.readFile(source)).digest('hex'), hash, 'Original source changed');
  const report = { sandbox, records: initial.length, filesVerifiedUnchanged: hashes.size, sumBefore: initial.reduce((sum, item) => sum + Math.round(item.amount * 100), 0), sumAfter: restored.reduce((sum, item) => sum + Math.round(item.amount * 100), 0), migrationRoundtrip: true, csvRoundtrip: true };
  await fs.writeFile(diskPath('verification.json'), JSON.stringify(report, null, 2));
  context.diagnostic(JSON.stringify(report));
});

for (const mode of ['single', 'daily']) {
  test(`${mode}: splitting a recurring entry retains one occurrence key without duplicate health warnings`, async () => {
    const e = environment(mode);
    const scheduled = priceDraft(draft({ amount: 50 }), e.settings, 'CNY', 50);
    scheduled.finance.occurrence = 'rule:2026-07-01';
    await e.store.commitDrafts([scheduled], undefined, scheduled.finance.occurrence);
    const [source] = await e.store.list();
    const parts = splitDrafts(source, [{ title: 'food', category: '餐饮', amount: 30 }, { title: 'taxi', category: '交通', amount: 20 }], e.settings);
    assert.ok(parts.every((part) => !('file' in part) && !('id' in part) && !('rawProperties' in part)));
    await e.store.commitDrafts(parts, source);
    assert.equal((await e.store.list()).filter((item) => item.finance?.occurrence).length, 1);
    assert.equal((await e.store.healthCheck()).filter((issue) => issue.code === 'duplicate-occurrence').length, 0);
    await e.store.commitDrafts([scheduled], undefined, scheduled.finance.occurrence);
    assert.equal((await e.store.list()).length, 2);
  });
  test(`${mode}: a refunded expense cannot change into income while its settlement remains`, async () => {
    const e = environment(mode); await e.store.create(draft()); const [source] = await e.store.list();
    const refund = priceDraft(draft({ title: 'refund', type: '退款' }), e.settings, 'CNY', 3);
    Object.assign(refund.finance, { kind: 'refund', relatedId: source.id });
    await e.store.settleRelated(source, refund);
    await assert.rejects(e.store.update(source, { ...source, type: '收入' }), /type cannot/);
    assert.equal((await e.store.transactionById(source.id)).type, '支出');
  });
  test(`${mode}: borrowing principal affects cash balance without inflating income; partial repayment is capped`, async () => {
    const e = environment(mode); e.settings.accounts = [{ name: 'A', initialBalance: 0 }];
    const loan = priceDraft(draft({ type: '借入本金', title: 'loan' }), e.settings, 'CNY', 100);
    Object.assign(loan.finance, { kind: 'borrow', party: 'friend', cashEffect: 'positive' });
    await e.store.commitDrafts([loan]); const [source] = await e.store.list();
    assert.equal(e.store.summarize([source], '2026-07').income, 0);
    assert.equal(e.store.accountMonthlyBalances([source], '2026-07').closing.get('A'), 100);
    const payment = priceDraft(draft({ title: 'payment', type: '偿还本金' }), e.settings, 'CNY', 40);
    Object.assign(payment.finance, { kind: 'repayment', relatedId: source.id, cashEffect: 'negative' });
    await e.store.settleRelated(source, payment);
    const items = await e.store.list(); assert.equal(outstanding(source, items), 60);
    assert.equal(e.store.accountMonthlyBalances(items, '2026-07').closing.get('A'), 60);
    await assert.rejects(e.store.settleRelated(source, { ...payment, amount: 70, finance: { ...payment.finance, nativeAmount: 70 } }), /exceeds/);
    await assert.rejects(e.store.remove(source), /related/);
  });
  test(`${mode}: foreign currency snapshot survives edits, CSV and storage roundtrip`, async () => {
    const e = environment(mode); e.settings.finance.rates.USD = { rate: 7, date: '2026-07-01', source: 'manual' };
    await e.store.create(priceDraft(draft(), e.settings, 'USD', 10));
    let [item] = await e.store.list(); assert.equal(item.amount, 70);
    e.settings.finance.rates.USD.rate = 8;
    await e.store.update(item, { ...item, title: 'changed' });
    [item] = await e.store.list(); assert.equal(item.amount, 70); assert.equal(item.finance.rate, 7);
    const csv = await e.store.buildCsv(); const other = environment(mode === 'single' ? 'daily' : 'single');
    assert.equal((await other.store.importCsv(csv)).imported, 1);
    const [copy] = await other.store.list(); assert.equal(copy.id, item.id); assert.deepEqual(plain(copy.finance), plain(item.finance));
    await e.store.migrateStorageFormat(mode === 'single' ? 'daily' : 'single'); await e.store.migrateStorageFormat(mode);
    assert.deepEqual(plain((await e.store.list())[0].finance), plain(item.finance));
  });
  test(`${mode}: split is atomic, retains total and ID, and restores from completed backup`, async () => {
    const e = environment(mode); await e.store.create(draft({ amount: 50 }));
    const [source] = await e.store.list();
    const parts = splitDrafts(source, [{ title: 'food', category: '餐饮', amount: 30 }, { title: 'taxi', category: '交通', amount: 20 }], e.settings);
    const ids = await e.store.commitDrafts(parts, source);
    const items = await e.store.list(); assert.equal(items.length, 2); assert.equal(ids[0], source.id); assert.equal(items.reduce((sum, item) => sum + item.amount, 0), 50);
    const backup = [...e.files.values()].find((file) => file.path.endsWith('.json'));
    assert.equal(await e.store.restoreCompletedBackup(backup), 1);
    const restored = await e.store.list(); assert.equal(restored.length, 1); assert.equal(restored[0].id, source.id); assert.equal(restored[0].amount, 50);
  });
  test(`${mode}: failed multi-record split rolls back all writes`, async () => {
    const e = environment(mode); await e.store.create(draft({ amount: 50 })); const [source] = await e.store.list();
    const parts = splitDrafts(source, [{ title: 'a', category: '', amount: 30 }, { title: 'b', category: '', amount: 20 }], e.settings);
    let writes = 0;
    e.fault.next = (op, path) => { if (path.endsWith('.md') && ['process', 'create'].includes(op)) writes++; return mode === 'single' ? writes === 2 : op === 'modify' && path.endsWith('.json'); };
    await assert.rejects(e.store.commitDrafts(parts, source), /injected/);
    const items = await e.store.list(); assert.equal(items.length, 1); assert.equal(items[0].amount, 50); assert.equal(items[0].title, source.title);
  });
  test(`${mode}: recurring occurrence ID makes retries and concurrent confirms idempotent`, async () => {
    const e = environment(mode);
    const scheduled = priceDraft(draft(), e.settings, 'CNY', 10); scheduled.finance.occurrence = 'rule:2026-07-01';
    await Promise.all([e.store.commitDrafts([scheduled], undefined, scheduled.finance.occurrence), e.store.commitDrafts([scheduled], undefined, scheduled.finance.occurrence)]);
    assert.equal((await e.store.list()).length, 1);
  });
  test(`${mode}: CSV preserves two identical-content UUIDs and related settlement links`, async () => {
    const e = environment(mode); await e.store.create(draft()); await e.store.create(draft());
    const [source] = await e.store.list();
    const refund = priceDraft(draft({ title: 'refund', type: '退款' }), e.settings, 'CNY', 3);
    Object.assign(refund.finance, { kind: 'refund', relatedId: source.id }); await e.store.settleRelated(source, refund);
    const csv = await e.store.buildCsv(); const other = environment(mode === 'single' ? 'daily' : 'single');
    assert.equal((await other.store.importCsv(csv)).imported, 3);
    assert.equal((await other.store.importCsv(csv)).imported, 0);
    const items = await other.store.list(); assert.equal(items.filter((item) => item.title === 'lunch').length, 2);
    assert.equal(items.find((item) => item.type === '退款').finance.relatedId, source.id);
  });
  test(`${mode}: bulk metadata changes preserve every shared-file record`, async () => {
    const e = environment(mode);
    e.settings.enableAccount = true; e.settings.enableCategory = true;
    for (let i = 0; i < 4; i++) await e.store.create(draft({ title: `entry-${i}` }));
    assert.equal(await e.store.renameAccountGlobally('A', 'B'), 4);
    assert.equal(await e.store.renameCategoryGlobally('餐饮', '饮食'), 4);
    const items = await e.store.list();
    assert.equal(items.length, 4);
    assert.ok(items.every((item) => item.account === 'B' && item.category === '饮食'));
  });
  test(`${mode}: cross-month move preserves identity and CSV selection roundtrips across layouts`, async () => {
    const e = environment(mode);
    await e.store.create(draft({ title: 'move' }));
    await e.store.create(draft({ title: 'stay' }));
    const source = (await e.store.list()).find((item) => item.title === 'move');
    await e.store.update(source, { ...source, date: '2026-08-01' });
    const moved = (await e.store.list()).find((item) => item.id === source.id);
    assert.equal(moved.date, '2026-08-01');
    assert.equal((await e.store.list()).length, 2);
    const csv = await e.store.buildCsv({ transactionIds: [source.id], dateFrom: '2026-07-31', dateTo: '2026-08-02' });
    const other = environment(mode === 'daily' ? 'single' : 'daily');
    assert.equal((await other.store.importCsv(csv)).imported, 1);
    const [imported] = await other.store.list();
    assert.equal(imported.title, 'move'); assert.equal(imported.date, '2026-08-01'); assert.equal(imported.amount, 10);
  });
  test(`${mode}: failed cross-month move restores the original record`, async () => {
    const e = environment(mode); await e.store.create(draft());
    const [source] = await e.store.list();
    e.fault.next = (op, path) => mode === 'single' ? op === 'rename' : op === 'process' && path === source.file.path;
    await assert.rejects(e.store.update(source, { ...source, date: '2026-08-01', amount: 20 }), /injected/);
    const items = await e.store.list();
    assert.equal(items.length, 1); assert.equal(items[0].date, '2026-07-01'); assert.equal(items[0].amount, 10);
  });
  test(`${mode}: create/read/update/remove/undo with no metadata cache`, async () => {
    const e = environment(mode);
    await e.store.create(draft());
    let [item] = await e.store.list();
    await e.store.update(item, { ...item, amount: 20, expression: '20' });
    [item] = await e.store.list();
    assert.equal(item.amount, 20);
    const pending = await e.store.stageRemove(item);
    assert.equal((await e.store.list()).length, 0);
    await e.store.undoRemove(pending);
    assert.equal((await e.store.list())[0].id, item.id);
  });
  test(`${mode}: hidden fields and unknown properties survive editing`, async () => {
    const e = environment(mode);
    await e.store.create(draft({ attachments: ['receipt.png'] }));
    const [original] = await e.store.list();
    const doc = document(e.contents.get(original.file.path));
    const raw = mode === 'daily' ? doc.properties['账目列表'][0] : doc.properties;
    raw.retiredField = 'keep';
    e.contents.set(original.file.path, serialize(doc.properties, 'USER BODY\n'));
    Object.assign(e.settings, { enableNote: false, enableEntryAttachments: false, enableCategory: false, enableAccount: false, enableType: false });
    const [item] = await e.store.list();
    await e.store.update(item, { ...item, title: 'changed', note: '', attachments: [] });
    const [changed] = await e.store.list();
    assert.equal(changed.note, 'note'); assert.deepEqual(plain(changed.attachments), ['receipt.png']);
    assert.equal(changed.rawProperties.retiredField, 'keep');
    assert.match(e.contents.get(changed.file.path), /USER BODY/);
  });
  test(`${mode}: date-only edit enforces same-day duplicate rule`, async () => {
    const e = environment(mode);
    await e.store.create(draft()); await e.store.create(draft({ date: '2026-07-02' }));
    e.settings.allowDuplicateContent = false;
    const item = (await e.store.list()).find((item) => item.date === '2026-07-01');
    await assert.rejects(e.store.update(item, { ...item, date: '2026-07-02' }), /重复/);
  });
  test(`${mode}: concurrent creations retain all records`, async () => {
    const e = environment(mode);
    await Promise.all(Array.from({ length: 12 }, (_, i) => e.store.create(draft({ title: String(i) }))));
    assert.equal((await e.store.list()).length, 12);
  });
  test(`${mode}: custom-field rename/cleanup operates on records`, async () => {
    const e = environment(mode);
    await e.store.create(draft({ customValues: { purpose: 'old' }, customProperties: { purpose: '用途' } }));
    assert.equal(await e.store.renameCustomFieldValueGlobally('用途', 'old', 'new'), 1);
    assert.equal((await e.store.list())[0].rawProperties['用途'], 'new');
    assert.equal(await e.store.clearCustomFieldProperties(['用途']), 1);
    assert.ok(!('用途' in (await e.store.list())[0].rawProperties));
  });
  test(`${mode}: CSV preserves custom type, necessity, zero and hidden fields`, async () => {
    const e = environment(mode);
    e.settings.typeOrder.push('报销'); e.settings.typeEffects['报销'] = 'positive';
    const csv = '日期,时间,类型,标签,内容,金额,备注,附件\n2026-07-01,12:00,报销,自定义必要性,refund,0,preserved,receipt.png';
    e.settings.enableNote = false; e.settings.enableEntryAttachments = false;
    const result = await e.store.importCsv(csv);
    assert.equal(result.imported, 1);
    const [item] = await e.store.list();
    assert.equal(item.type, '报销'); assert.equal(item.necessity, '自定义必要性'); assert.equal(item.amount, 0); assert.equal(item.note, 'preserved'); assert.deepEqual(plain(item.attachments), ['receipt.png']);
  });
  test(`${mode}: stale edit rejected without overwriting external change`, async () => {
    const e = environment(mode); await e.store.create(draft()); const [item] = await e.store.list();
    await e.store.update(item, { ...item, note: 'new' });
    await assert.rejects(e.store.update(item, { ...item, title: 'stale' }), /变化/);
    assert.equal((await e.store.list())[0].note, 'new');
  });
}

test('daily undo restores only the selected record even if container was removed', async () => {
  const e = environment('daily'); await e.store.create(draft({ title: 'A' })); await e.store.create(draft({ title: 'B' }));
  const items = await e.store.list(); const a = items.find((i) => i.title === 'A'), b = items.find((i) => i.title === 'B');
  const pending = await e.store.stageRemove(a); await e.store.stageRemove(b);
  await e.app.fileManager.trashFile(a.file);
  await e.store.undoRemove(pending);
  assert.deepEqual(plain((await e.store.list()).map((i) => i.title)), ['A']);
});

test('recurring schedules preserve month-end anchors, leap years and catch-up limits', () => {
  const rule = { startDate: '2024-01-31', nextDate: '2024-01-31', frequency: 'monthly', enabled: true, endDate: '' };
  assert.equal(nextOccurrence(rule, '2024-01-31'), '2024-02-29');
  assert.equal(nextOccurrence(rule, '2024-02-29'), '2024-03-31');
  assert.deepEqual(plain(dueOccurrences(rule, '2024-04-01')), ['2024-01-31', '2024-02-29', '2024-03-31']);
  assert.equal(dueOccurrences({ ...rule, frequency: 'daily' }, '2026-10-22').length, 120);
  assert.deepEqual(plain(dueOccurrences({ ...rule, enabled: false })), []);
  assert.equal(nextOccurrence({ ...rule, frequency: 'yearly', startDate: '2024-02-29' }, '2027-02-28'), '2028-02-29');
  assert.equal(nextOccurrence({ ...rule, frequency: 'weekly' }, '2024-12-29'), '2025-01-05');
});

test('exchange API inversion, validation and offline failure preserve prior rate settings', async () => {
  const e = environment(); e.settings.finance.rates.USD = { rate: 7, date: '2026-01-01', source: 'manual' };
  let url;
  responder = async (request) => { url = request.url; return { status: 200, json: [{ base: 'CNY', quote: 'USD', rate: 0.125, date: '2026-10-21' }] }; };
  const rates = await latestRates('CNY', ['USD']); assert.equal(rates.USD.rate, 8); assert.equal(rates.USD.date, '2026-10-21');
  assert.ok(url.includes('base=CNY&quotes=USD')); assert.ok(!url.includes('note'));
  responder = async () => ({ status: 200, json: [{ base: 'CNY', quote: 'USD', rate: 0, date: '2026-10-21' }] });
  await assert.rejects(latestRates('CNY', ['USD']), /Invalid exchange/);
  assert.equal(e.settings.finance.rates.USD.rate, 7);
  responder = async () => ({ status: 503, json: {} }); await assert.rejects(latestRates('CNY', ['USD']), /failed/);
  responder = async () => ({ status: 200, json: { choices: [{ message: { content: 'OK' } }] } });
});

test('manual rate override records its own date and historical edits retain the original quote', () => {
  const e = environment(); e.settings.finance.rates.USD = { rate: 7, date: '2026-06-01', source: 'Frankfurter' };
  const quoted = priceDraft(draft(), e.settings, 'USD', 10);
  assert.equal(quoted.finance.rateDate, '2026-06-01'); assert.equal(quoted.finance.rateSource, 'Frankfurter');
  const manual = priceDraft(draft(), e.settings, 'USD', 10, 7.25);
  assert.equal(manual.finance.rateDate, '2026-07-01'); assert.equal(manual.finance.rateSource, 'manual');
  const edited = priceDraft({ ...quoted, date: '2026-08-01' }, e.settings, 'USD', 11, 7);
  assert.equal(edited.finance.rateDate, '2026-06-01');
});

test('base currency can initialize legacy entries but cannot relabel currency snapshots', async () => {
  const e = environment(); await e.store.create(draft());
  await e.store.setBaseCurrency('EUR'); assert.equal(e.settings.finance.baseCurrency, 'EUR');
  await e.store.create(priceDraft(draft({ title: 'euro' }), e.settings, 'EUR', 1));
  await assert.rejects(e.store.setBaseCurrency('USD'), /本位币/); assert.equal(e.settings.finance.baseCurrency, 'EUR');
});

test('health check reports malformed/duplicate/related/attachment faults without altering files', async () => {
  const e = environment();
  await e.app.vault.create('ledger/a.md', serialize(record('same', { '附件': ['missing.png'] })));
  await e.app.vault.create('ledger/b.md', serialize(record('same', { '财务扩展': { currency: 'CNY', baseCurrency: 'CNY', nativeAmount: 10, rate: 1, rateDate: '2026-07-01', kind: 'refund', relatedId: 'missing' } })));
  await e.app.vault.create('ledger/bad.md', '---\n记账插件: true\n账目列表: [\n---\n');
  await e.app.vault.create('ledger/readme.md', 'ordinary notes');
  const snapshot = [...e.contents.entries()];
  const issues = await e.store.healthCheck(); const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes('duplicate-id')); assert.ok(codes.includes('missing-attachment')); assert.ok(codes.includes('missing-related')); assert.ok(codes.includes('invalid-file'));
  assert.ok(!issues.some((issue) => issue.path === 'ledger/readme.md')); assert.deepEqual([...e.contents.entries()], snapshot);
});

test('completed backup restoration refuses subsequent edits without modifying files', async () => {
  const e = environment(); await e.store.commitDrafts([priceDraft(draft(), e.settings, 'CNY', 10)]);
  const backup = [...e.files.values()].find((file) => file.path.endsWith('.json'));
  const [item] = await e.store.list(); await e.store.update(item, { ...item, title: 'external edit' });
  const snapshot = [...e.contents.entries()];
  await assert.rejects(e.store.restoreCompletedBackup(backup), /变化/); assert.deepEqual([...e.contents.entries()], snapshot);
});

test('indexed reads avoid rereading unchanged files and invalidate on file events', async () => {
  const e = environment(); await e.store.create(draft());
  const file = [...e.files.values()].find((file) => file.path.endsWith('.md')); file.stat = { mtime: 1, size: 100 };
  const read = e.app.vault.read; let reads = 0; e.app.vault.read = async (file) => { reads++; return read(file); };
  const [first] = await e.store.list(); first.title = 'not persisted';
  assert.equal((await e.store.list())[0].title, 'lunch'); assert.equal(reads, 1);
  e.store.invalidate(file.path); await e.store.list(); assert.equal(reads, 2);
});

test('templates contain serializable drafts only and stable links identify records by UUID', async () => {
  const e = environment(); await e.store.create(draft()); const [item] = await e.store.list();
  item.file.cycle = item.file;
  const template = draftFromTransaction(item); assert.doesNotThrow(() => JSON.stringify(template)); assert.ok(!('file' in template)); assert.ok(!('rawProperties' in template));
  assert.equal(transactionLink('我的账库', 'a/b'), 'obsidian://personal-style-bookkeeping?vault=%E6%88%91%E7%9A%84%E8%B4%A6%E5%BA%93&id=a%2Fb');
  e.settings.currency = '$'; normalizeFinanceSettings(e.settings, true); assert.equal(e.settings.finance.baseCurrency, 'USD');
});

test('daily attachment previews include all records and survive updates', async () => {
  const e = environment('daily'); await e.store.create(draft({ title: 'A', attachments: ['a.png'] })); await e.store.create(draft({ title: 'B', attachments: ['b.png'] }));
  await e.store.syncAttachmentPreviews();
  const [item] = await e.store.list(); await e.store.update(item, { ...item, note: 'updated' });
  const body = document(e.contents.get(item.file.path)).body;
  assert.match(body, /!\[\[a.png\]\]/); assert.match(body, /!\[\[b.png\]\]/);
});

test('migration roundtrip preserves raw properties, notes, attachments and bodies with switches off', async () => {
  const e = environment();
  await e.app.vault.create('ledger/2026/07/01/source.md', serialize(record('id', { '备注': 'keep', '附件': ['a.png'], unknown: { nested: [1, 2] } }), 'ORIGINAL BODY\n'));
  Object.assign(e.settings, { enableNote: false, enableEntryAttachments: false, enableAccount: false, enableType: false });
  await e.store.migrateStorageFormat('daily');
  let [item] = await e.store.list(); assert.equal(item.note, 'keep'); assert.equal(item.rawProperties._bookkeepingBody, 'ORIGINAL BODY\n');
  await e.store.migrateStorageFormat('single');
  [item] = await e.store.list(); assert.equal(item.id, 'id'); assert.deepEqual(plain(item.rawProperties.unknown), { nested: [1, 2] }); assert.match(e.contents.get(item.file.path), /ORIGINAL BODY/);
});

test('daily shared properties/body survive a single/daily roundtrip', async () => {
  const e = environment('daily'); await e.app.vault.create('ledger/2026/07/01.md', serialize({ '记账插件': true, owner: 'me', '账目列表': [record('a'), record('b')] }, 'DAY NOTES\n'));
  await e.store.migrateStorageFormat('single'); await e.store.migrateStorageFormat('daily');
  const [item] = await e.store.list(); const doc = document(e.contents.get(item.file.path));
  assert.equal(doc.properties.owner, 'me'); assert.equal(doc.body, 'DAY NOTES\n'); assert.equal(doc.properties['账目列表'].length, 2);
});

for (const phase of ['process', 'trash', 'folder-trash']) test(`migration failure in ${phase} restores active source and keeps recovery backup`, async () => {
  const e = environment(); await e.store.create(draft()); const [original] = await e.store.list(); const content = e.contents.get(original.file.path);
  if (phase === 'process') { await e.app.vault.create('ledger/2026/07/01.md', serialize({ '记账插件': true, '账目列表': [] })); }
  e.fault.next = (op, path) => phase === 'folder-trash' ? op === 'trash' && e.files.get(path) instanceof TFolder : op === phase;
  await assert.rejects(e.store.migrateStorageFormat('daily'));
  assert.equal(e.settings.storageFormat, 'single'); assert.equal(e.contents.get(original.file.path), content); assert.equal((await e.store.list()).length, 1);
  assert.ok([...e.contents.keys()].some((path) => path.includes('_bookkeeping-recovery/') && path.endsWith('.json')));
});

test('same ID with different payload blocks migration before source removal', async () => {
  const e = environment(); await e.app.vault.create('ledger/2026/07/01/a.md', serialize(record('same')));
  await e.app.vault.create('ledger/2026/07/01.md', serialize({ '账目列表': [record('same', { '金额': 99 })] }));
  await assert.rejects(e.store.migrateStorageFormat('daily'), /同ID/); assert.equal((await e.store.list()).length, 2);
});

test('startup recovery restores interrupted migration before allowing new writes', async () => {
  const e = environment(); await e.app.vault.createFolder('ledger/_bookkeeping-recovery');
  const oldPath = 'ledger/2026/07/01/a.md', newPath = 'ledger/2026/07/01.md';
  const original = serialize(record('a')); const converted = serialize({ '账目列表': [record('a')] });
  await e.app.vault.create(newPath, converted);
  await e.app.vault.create('ledger/_bookkeeping-recovery/test.json', JSON.stringify({ version: 1, status: 'prepared', from: 'single', to: 'daily', before: { [oldPath]: original, [newPath]: null }, after: { [oldPath]: null, [newPath]: converted } }));
  assert.equal(await e.store.recoverInterruptedMigrations(), 1); assert.equal(e.contents.get(oldPath), original); assert.ok(!e.contents.has(newPath)); assert.equal((await e.store.list()).length, 1);
});

test('native-compatible support paths avoid hidden Vault files and trash empty folders recoverably', async () => {
  const e = environment();
  const create = e.app.vault.create;
  e.app.vault.create = async (path, content) => {
    assert.ok(!path.split('/').some((part) => part.startsWith('.bookkeeping-')), 'Vault cannot index hidden support files');
    return create(path, content);
  };
  const removed = [];
  const trash = e.app.fileManager.trashFile;
  e.app.fileManager.trashFile = async (file) => { if (file instanceof TFolder) removed.push(file.path); return trash(file); };
  e.app.vault.delete = async () => { throw Error('Do not permanently delete migration folders'); };
  await e.store.create(draft());
  await e.store.migrateStorageFormat('daily');
  assert.ok(removed.length > 0);
  await e.store.migrateStorageFormat('single');
  const item = (await e.store.list())[0];
  const pending = await e.store.stageRemove(item);
  assert.ok(pending.file.path.includes('/_bookkeeping-trash/'));
  await e.store.undoRemove(pending);
  assert.equal((await e.store.list()).length, 1);
});

test('legacy hidden journals are retained, copied and recovered once without reapplying stale status', async () => {
  const e = environment();
  const oldPath = 'ledger/old.md', nextPath = 'ledger/new.md';
  const original = serialize(record('a'));
  const content = JSON.stringify({ version: 1, status: 'prepared', from: 'single', to: 'daily', before: { [oldPath]: original, [nextPath]: null }, after: { [oldPath]: null, [nextPath]: original } });
  await e.app.vault.create(nextPath, original);
  const exists = e.app.vault.adapter.exists;
  e.app.vault.adapter.exists = async (path) => path === 'ledger/.bookkeeping-recovery' || exists(path);
  e.app.vault.adapter.list = async () => ({ files: ['ledger/.bookkeeping-recovery/legacy.json'], folders: [] });
  e.app.vault.adapter.read = async () => content;
  assert.equal(await e.store.recoverInterruptedMigrations(), 1);
  assert.equal(e.contents.get(oldPath), original);
  assert.equal(await e.store.recoverInterruptedMigrations(), 0);
  const backup = JSON.parse(e.contents.get('ledger/_bookkeeping-recovery/legacy.json'));
  assert.equal(backup.status, 'recovered');
});

test('startup recovery refuses external conflicts and blocks writes without deleting either side', async () => {
  const e = environment(); await e.app.vault.createFolder('ledger/_bookkeeping-recovery');
  const path = 'ledger/a.md', original = serialize(record('a')), changed = serialize(record('a', { '金额': 999 }));
  await e.app.vault.create(path, changed);
  await e.app.vault.create('ledger/_bookkeeping-recovery/test.json', JSON.stringify({ version: 1, status: 'prepared', from: 'single', to: 'daily', before: { [path]: original }, after: { [path]: null } }));
  await assert.rejects(e.store.recoverInterruptedMigrations(), /冲突/); await assert.rejects(e.store.create(draft()), /暂停写入/); assert.equal(e.contents.get(path), changed);
});

test('recovery journal cannot write outside ledger', async () => {
  const e = environment(); await e.app.vault.createFolder('ledger/_bookkeeping-recovery');
  await e.app.vault.create('ledger/_bookkeeping-recovery/test.json', JSON.stringify({ version: 1, status: 'prepared', from: 'single', to: 'daily', before: { '../outside.md': serialize(record('a')) }, after: { '../outside.md': null } }));
  await assert.rejects(e.store.recoverInterruptedMigrations(), /格式/); assert.ok(!e.contents.has('../outside.md'));
});

test('malformed daily records block migration instead of being silently discarded', async () => {
  const e = environment('daily'); const file = await e.app.vault.create('ledger/2026/07/01.md', serialize({ '账目列表': [record('a'), 'invalid'] })); const before = e.contents.get(file.path);
  await assert.rejects(e.store.migrateStorageFormat('single')); assert.equal(e.contents.get(file.path), before);
});

test('failed conversion copies and recovery data never appear as transactions', async () => {
  const e = environment(); await e.app.vault.create('ledger/export/旧版转换失败-test/a.md', serialize(record('a'))); await e.app.vault.create('ledger/_bookkeeping-recovery/a.md', serialize(record('b')));
  assert.equal((await e.store.list()).length, 0); assert.equal(await e.store.legacyFileCount(), 0);
});

test('CSV rejects excess precision before rounding', async () => {
  const e = environment(); const result = await e.store.importCsv('日期,金额\n2026-07-01,0.001'); assert.equal(result.imported, 0); assert.equal(result.failures.length, 1);
});

test('note tags remain prefix-only after save/read', async () => {
  const e = environment(); e.settings.customFields = []; const parsed = parseNoteTags('#food 正文 #notatag'); await e.store.create(draft(parsed)); assert.deepEqual(plain((await e.store.list())[0].tags), ['food']);
});

test('amount parser smoke and precision rejection', () => { assert.equal(evaluateAmount('11.4+5.1-4'), 12.5); assert.throws(() => evaluateAmount('1.001')); assert.throws(() => evaluateAmount('1/0')); });

const config = (provider = 'openai-compatible') => ({ aiProvider: provider, aiEndpoint: provider === 'gemini' ? 'https://example.test/v1beta' : 'https://example.test/v1', aiApiKey: '', aiModel: 'test-model' });
for (const provider of ['openai-compatible', 'anthropic', 'gemini']) test(`AI ${provider}: protocol structure, optional key, valid response`, () => {
  const req = analysisRequest(config(provider), 'system', 'payload'); assert.ok(!JSON.stringify(req.headers).includes('Bearer ')); assert.ok(!JSON.parse(req.body).temperature);
  const data = provider === 'anthropic' ? { content: [{ type: 'text', text: 'OK' }] } : provider === 'gemini' ? { candidates: [{ content: { parts: [{ text: 'OK' }] } }] } : { choices: [{ message: { content: 'OK' } }] };
  assert.equal(analysisText(provider, data), 'OK'); assert.throws(() => analysisText(provider, {})); assert.throws(() => analysisText(provider, { error: { message: 'secret' } }));
});

test('AI scope carries dates/currency but never account, tag, keyword, note or attachment values', () => {
  const filters = { ...plain(DEFAULT_SETTINGS.savedDashboardFilters), keyword: 'SECRET', accounts: ['SECRET'], tags: 'SECRET', crossMonth: true, dateFrom: '2026-06-01', dateTo: '2026-07-31' };
  const payload = analysisPayload([draft({ title: 'SECRET', note: 'SECRET', tags: ['SECRET'], attachments: ['SECRET'] })], '¥', () => 'negative', { month: '2026-07', filters });
  assert.ok(!JSON.stringify(payload).includes('SECRET')); assert.equal(payload.currency, '¥'); assert.equal(payload.scope.dateFrom, '2026-06-01'); assert.equal(payload.scope.missingDaysAreNotNecessarilyZero, true);
  assert.match(defaultAnalysisPrompt('fr'), /fr/);
});

test('AI test rejects successful HTTP with invalid/error JSON', async () => {
  responder = async () => ({ status: 200, json: { error: { message: 'bad key' } } }); await assert.rejects(analyze(config(), 's', 'u'), /错误/);
  responder = async () => ({ status: 200, json: {} }); await assert.rejects(analyze(config(), 's', 'u'), /未返回/);
});

test('AI model URL accepts complete endpoint and no-key local service', async () => {
  responder = async (req) => { assert.equal(req.url, 'http://localhost:11434/v1/models'); return { status: 200, json: { data: [{ id: 'local' }] } }; };
  assert.deepEqual(plain(await listModels({ ...config(), aiEndpoint: 'http://localhost:11434/v1/chat/completions' })), ['local']);
});

test('AI cancellation settles locally without reporting a late result', async () => {
  responder = async () => new Promise(() => {}); const controller = new AbortController(); const result = analyze(config(), 's', 'u', controller.signal); controller.abort(); await assert.rejects(result, /停止/);
});

test('all language selections have labels', () => { assert.equal(translate('开始分析', 'fr'), 'Lancer l’analyse'); });

test('weekly: Monday-Sunday share one file, receipts deduplicate and notes survive updates', async () => {
  const e = environment('weekly');
  await e.store.create(draft({date:'2026-11-09',title:'Monday',attachments:['receipts/a.jpg']}));
  await e.store.create(draft({date:'2026-11-15',title:'Sunday',attachments:['receipts/a.jpg']}));
  let rows = await e.store.list();
  assert.equal(rows.length,2); assert.equal(rows[0].file.path,rows[1].file.path);
  assert.equal(rows[0].file.path,'ledger/2026/11/2026-11-09~2026-11-15.md');
  let text = e.contents.get(rows[0].file.path);
  assert.equal((text.match(/!\[\[receipts\/a.jpg\]\]/g)||[]).length,1);
  assert.equal((text.match(/^## 周/gm)||[]).length,7);
  await e.app.vault.modify(rows[0].file,text+'\n## 我的复盘\n保留我的文字\n');
  const monday=rows.find(x=>x.title==='Monday');
  await e.store.update(monday,draftFromTransaction({...monday,date:'2026-07-06',amount:25}));
  rows=await e.store.list(); assert.equal(rows.length,2); assert.equal(rows.find(x=>x.id===monday.id).date,'2026-07-06');
  text=e.contents.get(rows[0].file.path); assert.ok(text.includes('保留我的文字'));
  assert.equal((text.match(/bookkeeping-weekly:start/g)||[]).length,1);
  assert.equal((text.match(/!\[\[receipts\/a.jpg\]\]/g)||[]).length,1);
  await e.store.remove(rows.find(x=>x.title==='Sunday'));
  assert.equal((await e.store.list()).length,1);
});

test('weekly: cross-week and cross-year moves preserve UUID and totals', async () => {
  const e=environment('weekly'); await e.store.create(draft({date:'2026-12-31'}));
  let [row]=await e.store.list(); const id=row.id;
  assert.equal(row.file.path,'ledger/2026/12/2026-12-28~2027-01-03.md');
  await e.store.update(row,draftFromTransaction({...row,date:'2027-01-04'}));
  [row]=await e.store.list(); assert.equal(row.id,id); assert.equal(row.amount,10);
  assert.equal(row.file.path,'ledger/2027/01/2027-01-04~2027-01-10.md');
});

for (const mode of ['single','daily']) test(`${mode}: migrate to weekly without duplicate records, then back`, async()=>{
  const e=environment(mode);
  await e.store.create(draft({date:'2026-11-09',title:'one'}));
  await e.store.create(draft({date:'2026-11-10',title:'two'}));
  const ids=(await e.store.list()).map(x=>x.id).sort();
  await e.store.migrateStorageFormat('weekly');
  let rows=await e.store.list(); assert.equal(rows.length,2);
  assert.deepEqual(rows.map(x=>x.id).sort(),ids);
  assert.equal(rows[0].file.path,rows[1].file.path);
  await e.store.migrateStorageFormat(mode);
  rows=await e.store.list(); assert.deepEqual(rows.map(x=>x.id).sort(),ids);
  assert.equal(rows.reduce((t,x)=>t+x.amount,0),20);
});

test('weekly: staged delete and undo preserve siblings and one receipt embed', async()=>{
 const e=environment('weekly');
 await e.store.create(draft({date:'2026-07-06',title:'A',attachments:['a.jpg']}));
 await e.store.create(draft({date:'2026-07-06',title:'B',attachments:['a.jpg']}));
 const [item]=await e.store.list(); const pending=await e.store.stageRemove(item);
 assert.equal((await e.store.list()).length,1);
 await e.store.undoRemove(pending);
 const rows=await e.store.list(); assert.equal(rows.length,2);
 const text=e.contents.get(rows[0].file.path); assert.equal((text.match(/!\[\[a.jpg\]\]/g)||[]).length,1);
});

test('attachments: identical bytes reuse existing receipt across filenames and dates', async()=>{
 const e=environment('weekly'); const binary=new Map();
 e.app.vault.getFiles=()=>[...e.files.values()].filter(x=>x instanceof TFile);
 e.app.vault.readBinary=async file=>binary.get(file.path);
 e.app.vault.createBinary=async(path,bytes)=>{const f=new TFile(path);f.stat={size:bytes.byteLength};e.files.set(path,f);binary.set(path,bytes);return f;};
 const bytes=Uint8Array.from([1,2,3,4]).buffer;
 const original=await e.app.vault.createBinary('记账/附件/old-name.jpg',bytes);
 const upload=name=>({name,arrayBuffer:async()=>bytes});
 const a=await e.store.saveAttachment(upload('one.png'),draft());
 const b=await e.store.saveAttachment(upload('another.jpg'),draft({date:'2026-12-01'}));
 assert.equal(a.path,original.path); assert.equal(b.path,original.path); assert.equal(binary.size,1);
 const different=await e.store.saveAttachment({name:'new.png',arrayBuffer:async()=>Uint8Array.from([9,8]).buffer},draft());
 assert.notEqual(different.path,original.path);assert.equal(binary.size,2);
});

test('personal hierarchy repairs stale settings and keeps balances', () => {
 const e=environment('weekly'); const finance=JSON.stringify(e.settings.finance);
 mod.exports.configureHierarchy(e.settings);
 const majors=e.settings.customFields.find(f=>f.id==='major').options;
 assert.ok(majors.includes('生活')); assert.ok(!majors.includes('外卖'));
 assert.deepEqual(plain(mod.exports.subcategories(e.settings,'餐饮')),['外卖配送','到店就餐','到店打包','饮品零食']);
 assert.ok(e.settings.optionFieldOrder.indexOf('custom:major')<e.settings.optionFieldOrder.indexOf('category'));
 e.settings.customFields=[]; mod.exports.configureHierarchy(e.settings);
 assert.ok(e.settings.customFields.some(f=>f.id==='major'));
 assert.equal(JSON.stringify(e.settings.finance),finance);
});
test('style defaults are generic and complete', () => {
 const settings = plain(DEFAULT_SETTINGS);
 assert.equal(settings.ledgerFolder, '记账');
 assert.equal(settings.attachmentFolder, '记账/附件');
 assert.equal(settings.storageFormat, 'weekly');
 assert.equal(settings.calendarWeekStart, 'monday');
 assert.equal(settings.filterPersistence, 'none');
 assert.equal(settings.saveFiltersOnExit, false);
 assert.equal(settings.mobileContinuousEntry, false);
 assert.equal(settings.incomeColor, '#3f7f73');
 assert.equal(settings.expenseColor, '#8e639f');
 assert.equal(settings.enableNecessity, false);
 assert.deepEqual(settings.accounts.map((account) => account.name), ['默认账户']);
 assert.ok(settings.categories.includes('配饰'));
 assert.ok(mod.exports.subcategories(DEFAULT_SETTINGS, '购物').includes('配饰'));
 assert.ok(settings.customFields.some((field) => field.id === 'major'));
 assert.ok(settings.visibleTableColumns.includes('custom:major'));
 assert.ok(settings.optionFieldOrder.indexOf('custom:major') < settings.optionFieldOrder.indexOf('category'));
 assert.deepEqual(settings.chartConfigs.map((chart) => chart.id), ['trend', 'tag-summary', 'calendar', 'category-pie', 'budget', 'account']);
 assert.equal(DEFAULT_SETTINGS.beta.enabled, false);
});

test('accounting lock hashes, verifies and scopes to the ledger folder', async () => {
 const settings = plain(DEFAULT_SETTINGS);
 settings.lockSalt = ''; settings.lockHash = ''; settings.lockEnabled = true;
 assert.equal(mod.exports.lockConfigured(settings), false);
 await mod.exports.setLockPassword(settings, '1234');
 assert.ok(settings.lockSalt); assert.ok(settings.lockHash);
 assert.equal(mod.exports.lockConfigured(settings), true);
 assert.equal(await mod.exports.verifyLockPassword(settings, '1234'), true);
 assert.equal(await mod.exports.verifyLockPassword(settings, '12345'), false);
 assert.equal(mod.exports.isLedgerPath(settings, '记账/2026/11/2026-11-09~2026-11-15.md'), true);
 assert.equal(mod.exports.isLedgerPath(settings, '其他/x.md'), false);
});

test('personal living entry saves big tag and small category in shared weekly ledger', async()=>{
 const e=environment('weekly'); mod.exports.configureHierarchy(e.settings);
 await e.store.create(draft({title:'理发',category:'理发美容',customValues:{major:'生活'},tags:['截图录入']}));
 const [row]=await e.store.list(); assert.equal(row.category,'理发美容');
 assert.equal(row.customValues.major,'生活'); assert.deepEqual(plain(row.tags),['生活']);
 await e.store.update(row,draftFromTransaction({...row,category:'外卖配送',customValues:{major:'餐饮'}}));
 const [edited]=await e.store.list(); assert.equal(edited.customValues.major,'餐饮');
 assert.deepEqual(plain(edited.tags),['餐饮']);
});
