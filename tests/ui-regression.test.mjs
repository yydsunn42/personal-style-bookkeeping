import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { webcrypto } from 'node:crypto';

const window = new Window();
const { document, HTMLElement } = window;
const plain = (value) => JSON.parse(JSON.stringify(value));
function createEl(tag, options = {}) {
  const child = document.createElement(tag);
  if (options.cls) child.className = Array.isArray(options.cls) ? options.cls.join(' ') : options.cls;
  if (options.text !== undefined) child.textContent = options.text;
  if (options.type) child.type = options.type;
  if (options.value !== undefined) child.value = options.value;
  for (const [key, value] of Object.entries(options.attr ?? {})) child.setAttribute(key, value);
  this.appendChild(child); return child;
}
Object.assign(HTMLElement.prototype, {
  createEl, createDiv(options) { return createEl.call(this, 'div', options); }, createSpan(options) { return createEl.call(this, 'span', options); },
  empty() { this.replaceChildren(); }, setText(text) { this.textContent = text; }, addClass(...names) { this.classList.add(...names); },
  removeClass(...names) { this.classList.remove(...names); }, toggleClass(name, force) { this.classList.toggle(name, force); }, setCssStyles(styles) { Object.assign(this.style, styles); }
});
class Modal {
  constructor(app) { this.app = app; this.modalEl = document.body.createDiv(); this.contentEl = this.modalEl.createDiv(); }
  setTitle(title) { this.title = title; }
  open() { this.onOpen?.(); }
  close() { this.onClose?.(); this.modalEl.remove(); }
}
class TextComponent {
  constructor(parent, tag = 'input') { this.inputEl = parent.createEl(tag); }
  setValue(value) { this.inputEl.value = value; return this; }
  getValue() { return this.inputEl.value; }
  setPlaceholder(value) { this.inputEl.placeholder = value; return this; }
  setDisabled(value) { this.inputEl.disabled = value; return this; }
  onChange(callback) { this.inputEl.addEventListener('input', () => callback(this.inputEl.value)); return this; }
}
class DropdownComponent {
  constructor(parent) { this.selectEl = parent.createEl('select'); }
  addOptions(options) { for (const [value, label] of Object.entries(options)) this.selectEl.createEl('option', { text: label, attr: { value } }); return this; }
  addOption(value, label) { return this.addOptions({ [value]: label }); }
  setValue(value) { this.selectEl.value = value; return this; }
  getValue() { return this.selectEl.value; }
  setDisabled(value) { this.selectEl.disabled = value; return this; }
  onChange(callback) { this.selectEl.addEventListener('change', () => callback(this.selectEl.value)); return this; }
}
class Setting {
  constructor(parent) { this.settingEl = parent.createDiv({ cls: 'setting-item' }); const info = this.settingEl.createDiv({ cls: 'setting-item-info' }); this.nameEl = info.createDiv({ cls: 'setting-item-name' }); this.descEl = info.createDiv({ cls: 'setting-item-description' }); this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' }); }
  setName(value) { this.nameEl.setText(value); return this; }
  setDesc(value) { this.descEl.setText(value); return this; }
  setHeading() { return this; }
  addColorPicker(callback) { callback({ setValue() { return this; }, onChange() { return this; } }); return this; }
  addText(callback) { callback(new TextComponent(this.controlEl)); return this; }
  addTextArea(callback) { callback(new TextComponent(this.controlEl, 'textarea')); return this; }
  addDropdown(callback) { callback(new DropdownComponent(this.controlEl)); return this; }
  addButton(callback) { callback(new ButtonComponent(this.controlEl)); return this; }
  addToggle(callback) { const input = this.controlEl.createEl('input', { type: 'checkbox' }); callback({ setValue(value) { input.checked = value; return this; }, onChange(action) { input.addEventListener('change', () => action(input.checked)); return this; } }); return this; }
}
class ButtonComponent {
  constructor(parent) { this.buttonEl = parent.createEl('button'); }
  setButtonText(text) { this.buttonEl.textContent = text; return this; }
  setIcon() { return this; } setCta() { return this; } setDestructive() { return this; }
  setTooltip(text) { this.buttonEl.title = text; return this; }
  setDisabled(value) { this.buttonEl.disabled = value; return this; }
  onClick(callback) { this.buttonEl.addEventListener('click', callback); return this; }
}
let responder = async () => ({ status: 200, json: { choices: [{ message: { content: 'OK' } }] } });
class Component { load() {} unload() {} }
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = document.body.createDiv(); } update() { this.display(); } }
class Menu {
  constructor() { this.titles = []; Menu.latest = this; }
  addItem(callback) { const item = { setTitle: (title) => { this.titles.push(title); return item; }, setIcon: () => item, onClick: () => item }; callback(item); return this; }
  addSeparator() { return this; } showAtMouseEvent() {}
}
const markdownCalls = [];
const MarkdownRenderer = { async render(app, source, target, path, component) {
  markdownCalls.push({ app, source, target, path, component });
  for (const block of source.split(/\n\s*\n/)) {
    const heading = block.match(/^## (.+)$/);
    if (heading) target.createEl('h2', { text: heading[1] });
    else target.createEl('p', { text: block });
  }
} };
const obsidian = new Proxy({ Modal, Component, PluginSettingTab, Menu, MarkdownRenderer, ButtonComponent, Setting, TextComponent, DropdownComponent, setIcon() {}, Platform: { isMobile: false }, normalizePath: (path) => path, requestUrl: (req) => responder(req) }, { get: (target, key) => target[key] ?? class {} });
const require = createRequire(import.meta.url);
const viewsBundle = await build({ stdin: { contents: `export * from './src/views-report-modal';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'] });
const viewsModule = { exports: {} };
runInNewContext(viewsBundle.outputFiles[0].text, { module: viewsModule, exports: viewsModule.exports, require: (name) => name === 'obsidian' ? obsidian : require(name), crypto: webcrypto, console });
const { ViewsReportModal, escapeReportCell } = viewsModule.exports;
const built = await build({ stdin: { contents: `export {FinanceModal} from './src/finance-modal'; export {TransactionModal} from './src/transaction-modal'; export {PeriodStatsModal, AiAnalysisModal} from './src/main'; export {DashboardView} from './src/dashboard-view'; export {DEFAULT_SETTINGS} from './src/types'; export {TransactionStore} from './src/transaction-store'; export {translate, I18nController} from './src/locales'; export {repairTranslationCoverage} from './src/locales/repairs';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian', 'electron'], loader: { '.png': 'dataurl', '.jpg': 'dataurl' }, define: { __PLUGIN_VERSION__: '"test"' }, plugins: [{ name: 'expose-private-modals-for-testing', setup(build) { build.onLoad({ filter: /[\\/]src[\\/]main\.ts$/ }, async ({ path }) => ({ contents: (await readFile(path, 'utf8')) + '\nexport {PeriodStatsModal, AiAnalysisModal};', loader: 'ts' })); } }] });
const mod = { exports: {} };
runInNewContext(built.outputFiles[0].text, { module: mod, exports: mod.exports, require: (name) => name === 'obsidian' ? obsidian : require(name), window, document, HTMLElement, Element: window.Element, Node: window.Node, Text: window.Text, MutationObserver: window.MutationObserver, NodeFilter: window.NodeFilter, URL, AbortController, crypto: webcrypto, setTimeout, clearTimeout, console });
const { PeriodStatsModal, AiAnalysisModal, DashboardView, DEFAULT_SETTINGS, TransactionStore, translate, I18nController, repairTranslationCoverage } = mod.exports;
const { FinanceModal, TransactionModal } = mod.exports;
const budgetBundle = await build({ stdin: { contents: `export {BudgetEditorModal} from './src/dashboard-view';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'], plugins: [{ name: 'expose-budget-editor', setup(build) { build.onLoad({ filter: /[\\/]src[\\/]dashboard-view\.ts$/ }, async ({ path }) => ({ contents: (await readFile(path, 'utf8')) + '\nexport {BudgetEditorModal};', loader: 'ts' })); } }] });
const budgetModule = { exports: {} };
runInNewContext(budgetBundle.outputFiles[0].text, { module: budgetModule, exports: budgetModule.exports, require: (name) => name === 'obsidian' ? obsidian : require(name), window, document, crypto: webcrypto, console });
const { BudgetEditorModal } = budgetModule.exports;
const settingsBundle = await build({ stdin: { contents: `export {BookkeepingSettingTab} from './src/settings-tab'; export * from './src/beta';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'], loader: { '.png': 'dataurl', '.jpg': 'dataurl' }, define: { __PLUGIN_VERSION__: '"test"' } });
const settingsModule = { exports: {} };
runInNewContext(settingsBundle.outputFiles[0].text, { module: settingsModule, exports: settingsModule.exports, require: (name) => name === 'obsidian' ? obsidian : require(name), window, document, HTMLElement, console });
const { BookkeepingSettingTab, normalizeBeta, betaEnabled } = settingsModule.exports;
const tick = () => new Promise((resolve) => setImmediate(resolve));
function plugin(items = []) {
  const settings = plain(DEFAULT_SETTINGS); settings.annualChartConfigs = [];
  settings.beta.enabled = true; for (const key of Object.keys(settings.beta.features)) settings.beta.features[key] = true;
  return { settings, store: { list: async () => items, typeEffect: (type) => settings.typeEffects[type] }, t: (text) => translate(text, settings.language), applySemanticColors() {}, notice() {}, saveSettingsQuietly() { return this.saveSettings(); } };
}
function transaction(id, date, amount = 10, type = '支出') { return { id, date, time: '12:00', title: id, amount, type, necessity: '必需', category: '餐饮', account: 'A', targetAccount: '', tags: [], attachments: [], note: '', expression: '', customValues: {} }; }

test('saved views copy complete cross-month filters and reports never overwrite existing notes', async () => {
  const p = plugin(); p.saveSettings = async () => {}; p.applyLanguage = () => {};
  const filters = { ...p.settings.savedDashboardFilters, types: ['支出'], customFields: { purpose: ['test'] }, dateFrom: '2026-06-01', dateTo: '2026-07-31', crossMonth: true };
  const entries = [transaction('a', '2026-06-01'), transaction('b', '2026-07-01')], files = new Map([['记账/月报/2026-07.md', { existing: true }]]);
  let opened, applied;
  const app = { vault: { getAbstractFileByPath: (path) => files.get(path), createFolder: async (path) => files.set(path, {}), create: async (path, content) => { assert.ok(!files.has(path)); const file = { path, content }; files.set(path, file); return file; } }, workspace: { getLeaf: () => ({ openFile: async (file) => opened = file }) } };
  p.settings.ledgerFolder = '记账';
  const modal = new ViewsReportModal(app, p, '2026-07', filters, entries, async (month, next) => applied = { month, filters: next }); modal.onOpen();
  filters.types.push('收入'); entries.push(transaction('c', '2026-07-02'));
  const input = modal.contentEl.querySelector('input'); input.value = 'Summer'; input.dispatchEvent(new window.Event('input'));
  [...modal.contentEl.querySelectorAll('button')].find((button) => button.textContent === '收藏当前筛选').click(); await tick(); await tick();
  assert.equal(p.settings.planning.views.length, 1); assert.deepEqual(plain(p.settings.planning.views[0].filters.types), ['支出']);
  [...modal.contentEl.querySelectorAll('button')].find((button) => button.textContent === '生成月报笔记').click(); await tick(); await tick();
  assert.equal(opened.path, '记账/月报/2026-07-2.md'); assert.match(opened.content, /账目数量: 2/); assert.match(opened.content, /2026-06-01/); assert.doesNotMatch(opened.content, /"c"/);
  [...modal.contentEl.querySelectorAll('button')].find((button) => button.textContent === '应用').click(); await tick(); assert.equal(applied.filters.crossMonth, true); assert.equal(applied.month, '2026-07');
  assert.ok(escapeReportCell('<img>|**x**\n').includes('&lt;img&gt;&#124;')); modal.close();
});

test('planning pages combine pending tasks and forecast while switches retain stored data', async () => {
  const item = transaction('claim', '2026-07-01', 100); item.finance = { currency: 'CNY', baseCurrency: 'CNY', nativeAmount: 100, rate: 1, rateDate: item.date, claim: { kind: 'refund', amount: 80, dueDate: '2026-07-10', closed: false } };
  const p = plugin([item]); p.settings.language = 'en';
  const modal = new FinanceModal({}, p, 'planning'); modal.onOpen(); await tick();
  assert.match(modal.contentEl.textContent, /Cash-flow forecast/); assert.match(modal.contentEl.textContent, /Pending refund/); assert.match(modal.contentEl.textContent, /claim/);
  p.settings.planning.claimsEnabled = false; p.settings.planning.forecastEnabled = false; await modal.render();
  assert.doesNotMatch(modal.contentEl.textContent, /Pending refund/); assert.ok(item.finance.claim); modal.close();
});
test('adding a pending task preserves the original amount, expression and note', async () => {
  const item = transaction('legacy', '2026-07-01', 10); item.expression = '2*5'; item.note = 'Keep this';
  const p = plugin([item]); let updated;
  p.store.update = async (_source, draft) => { updated = draft; }; p.refreshDashboards = async () => {};
  const modal = new FinanceModal({}, p, 'transaction', item); modal.onOpen(); await tick();
  [...modal.contentEl.querySelectorAll('button')].find((button) => button.textContent === '保存待办').click(); await tick(); await tick();
  assert.equal(updated.expression, '2*5'); assert.equal(updated.note, 'Keep this'); assert.equal(updated.amount, 10); assert.equal(updated.finance.claim.amount, 10); modal.close();
});
test('savings goal progress saves settings only and keeps user text out of translation', async () => {
  const p = plugin(); let saves = 0; p.saveSettings = async () => { saves++; }; p.refreshDashboards = async () => {};
  p.settings.planning.goals.push({ id: 'g', name: '储蓄目标', target: 100, saved: 10, dueDate: '' });
  p.settings.language = 'en'; const modal = new FinanceModal({}, p, 'goals'); modal.onOpen(); await tick();
  const card = modal.contentEl.querySelector('.bookkeeping-planning-card'); assert.match(card.textContent, /储蓄目标/);
  const input = card.querySelector('input'); input.value = '40'; input.dispatchEvent(new window.Event('input'));
  [...card.querySelectorAll('button')].find((button) => button.textContent === 'Save').click(); await tick(); await tick();
  assert.equal(p.settings.planning.goals[0].saved, 40); assert.equal(saves, 1); modal.close();
});
test('currency manager starts offline and persists user-entered foreign-to-base rates', async () => {
  const p = plugin(); let saves = 0; p.saveSettings = async () => { saves++; }; p.refreshDashboards = async () => {};
  const modal = new FinanceModal({}, p, 'currencies'); modal.onOpen(); await tick();
  const inputs = modal.contentEl.querySelectorAll('input'); assert.equal(inputs[2].value, '');
  inputs[2].value = '7.25'; inputs[2].dispatchEvent(new window.Event('input'));
  [...modal.contentEl.querySelectorAll('button')].find((button) => button.textContent === '保存汇率').click();
  await tick(); await tick(); assert.equal(p.settings.finance.rates.USD.rate, 7.25); assert.equal(p.settings.finance.rates.USD.source, 'manual'); assert.equal(saves, 1); modal.close();
});

test('foreign entry editor displays native amounts and saves a frozen base-currency snapshot', async () => {
  const settings = plain(DEFAULT_SETTINGS); settings.finance.rates.USD = { rate: 7, date: '2026-07-01', source: 'manual' };
  const source = transaction('a', '2026-07-01', 70); source.finance = { currency: 'USD', baseCurrency: 'CNY', nativeAmount: 10, rate: 7, rateDate: '2026-07-01' };
  let saved;
  const modal = new TransactionModal({}, { update: async (_source, draft) => { saved = draft; } }, settings, source, false, '2026-07', async () => {});
  modal.onOpen(); assert.equal(modal.draft.expression, '10');
  modal.draft.expression = '11'; await modal.submit(); assert.equal(saved.amount, 77); assert.equal(saved.finance.nativeAmount, 11); assert.equal(saved.finance.rate, 7); modal.close();
});

test('template save captures serializable draft without silently creating an entry', async () => {
  const p = plugin(); p.saveSettings = async () => {}; p.refreshDashboards = async () => {};
  const modal = new FinanceModal({}, p, 'templates'); modal.onOpen(); await tick();
  const inputs = modal.contentEl.querySelectorAll('input');
  for (const [index, value] of [[0, 'Coffee'], [1, 'Morning coffee'], [2, '12']]) { inputs[index].value = value; inputs[index].dispatchEvent(new window.Event('input')); }
  [...modal.contentEl.querySelectorAll('button')].find((button) => button.textContent === '保存模板').click(); await tick(); await tick();
  assert.equal(p.settings.finance.templates.length, 1); assert.equal(p.settings.finance.templates[0].draft.amount, 12); assert.doesNotThrow(() => JSON.stringify(p.settings.finance.templates)); modal.close();
});

test('finance user names and descriptions are not translated with interface labels', async () => {
  const p = plugin(); p.settings.language = 'en';
  p.settings.finance.templates = [{ id: 'template', name: '收入', draft: { ...transaction('entry', '2026-07-01'), title: '支出' } }];
  const modal = new FinanceModal({}, p, 'templates'); modal.onOpen(); await tick();
  const i18n = new I18nController(() => 'en'); i18n.start(); await tick();
  const protectedText = [...modal.contentEl.querySelectorAll('.bookkeeping-user-text')].map((el) => el.textContent);
  assert.ok(protectedText.includes('收入'));
  assert.ok(protectedText.some((text) => text.startsWith('支出 ·')));
  assert.ok(modal.modalEl.classList.contains('bookkeeping-finance-modal'));
  i18n.stop(); modal.close();
});

test('failed recurring toggle restores its previous state and reports the error', async () => {
  const p = plugin(); const notices = []; p.notice = (text) => notices.push(text);
  p.saveSettings = async () => { throw new Error('save failed'); };
  const rule = { id: 'r', name: 'rule', startDate: '2099-01-01', nextDate: '2099-01-01', enabled: true, frequency: 'monthly', draft: transaction('entry', '2099-01-01') };
  p.settings.finance.recurring = [rule];
  const modal = new FinanceModal({}, p, 'recurring'); modal.onOpen(); await tick();
  const toggle = modal.contentEl.querySelector('input[type="checkbox"]'); toggle.checked = false; toggle.dispatchEvent(new window.Event('change'));
  await tick(); await tick(); assert.equal(rule.enabled, true); assert.equal(notices.length, 1); modal.close();
});

test('currency editor updates the rate direction label when switching currencies', async () => {
  const settings = plain(DEFAULT_SETTINGS); settings.finance.rates.USD = { rate: 7, date: '2026-07-01', source: 'manual' };
  settings.beta.enabled = true; settings.beta.features.currencies = true;
  const modal = new TransactionModal({}, {}, settings, null, false, '2026-07', async () => {});
  modal.onOpen(); const select = modal.contentEl.querySelector('select');
  select.value = 'USD'; select.dispatchEvent(new window.Event('change'));
  assert.ok(modal.contentEl.textContent.includes('1 USD → CNY'));
  modal.close();
});

test('year change retains month selection and does not revert year', async () => {
  const p = plugin([transaction('a', '2025-07-01'), transaction('b', '2026-07-01')]);
  const modal = new PeriodStatsModal({}, p, '2026-07'); await modal.load();
  const year = modal.contentEl.querySelector('[aria-label="统计年份"]'), month = modal.contentEl.querySelector('[aria-label="统计月份"]');
  year.value = '2025'; year.dispatchEvent(new window.Event('change')); assert.equal(month.value, '07');
  month.value = '09'; month.dispatchEvent(new window.Event('change')); assert.equal(modal.year, '2025'); assert.equal(modal.month, '2025-09');
  modal.close();
});

test('week picker selects a mid-month week and honors Sunday start', async () => {
  const p = plugin([transaction('a', '2026-07-15')]); p.settings.calendarWeekStart = 'sunday';
  const modal = new PeriodStatsModal({}, p, '2026-07'); await modal.load();
  const mode = modal.contentEl.querySelector('[aria-label="统计周期"]'), date = modal.contentEl.querySelector('input[type=date]');
  mode.value = 'week'; mode.dispatchEvent(new window.Event('change')); assert.equal(date.hidden, false);
  date.value = '2026-07-15'; date.dispatchEvent(new window.Event('change'));
  const range = modal.currentRange(); assert.equal(range.start, '2026-07-12'); assert.equal(range.end, '2026-07-18');
  date.value = '2027-01-01'; date.dispatchEvent(new window.Event('change')); assert.equal(modal.year, '2027'); assert.equal(modal.month, '2027-01');
  modal.close();
});

test('quarter and leap-month boundaries remain correct', () => {
  const modal = new PeriodStatsModal({}, plugin(), '2024-02'); modal.period = 'month'; assert.equal(modal.currentRange().end, '2024-02-29');
  modal.period = 'quarter'; assert.equal(modal.currentRange().start, '2024-01-01'); assert.equal(modal.currentRange().end, '2024-03-31');
  modal.month = '2024-12'; assert.equal(modal.currentRange().end, '2024-12-31'); modal.close();
});

test('account balance pie retains historical transactions despite current-month filters', () => {
  const settings = plain(DEFAULT_SETTINGS); settings.accounts = [{ name: 'A', initialBalance: 0 }];
  const store = new TransactionStore({}, () => settings);
  const view = Object.create(DashboardView.prototype); view.plugin = { store, settings }; view.month = '2026-07'; view.filters = { accounts: [] };
  view.balanceTransactions = [transaction('income', '2026-06-01', 100, '收入'), transaction('expense', '2026-07-01', 10)];
  assert.deepEqual(plain(view.pieEntries('accountBalance', view.balanceTransactions.slice(1))), [['A', 90]]);
});

test('filters and all-selection IDs operate on records, not daily file paths', () => {
  const view = Object.create(DashboardView.prototype); view.plugin = plugin(); view.filters = plain(DEFAULT_SETTINGS.savedDashboardFilters);
  Object.assign(view.filters, { crossMonth: true, dateFrom: '2026-06-30', dateTo: '2026-07-02', keyword: 'lunch' });
  const items = [transaction('lunch A', '2026-06-30'), transaction('lunch B', '2026-07-01'), transaction('dinner', '2026-07-01'), transaction('lunch C', '2026-07-03')];
  items.forEach((item) => { item.file = { path: 'same-daily-file.md' }; });
  assert.deepEqual(plain(view.applyFilters(items).map((item) => item.id)), ['lunch A', 'lunch B']);
});

test('AI preview and sent snapshot match; double-click sends once; response is protected from translation', async () => {
  const items = [transaction('included', '2026-07-01', 10), transaction('excluded', '2026-07-02', 999)];
  const p = plugin(items); Object.assign(p.settings, { aiEndpoint: 'http://localhost:11434/v1', aiModel: 'local' });
  const modal = new AiAnalysisModal({}, p, ['included']); modal.onOpen(); await tick();
  const preview = JSON.parse(modal.contentEl.querySelector('pre').textContent); assert.equal(preview.expense, 10);
  items[0].amount = 50; let calls = 0, sent;
  responder = async (req) => { calls++; sent = JSON.parse(req.body); await tick(); return { status: 200, json: { choices: [{ message: { content: '收入' } }] } }; };
  await Promise.all([modal.run(), modal.run()]); assert.equal(calls, 1); assert.equal(JSON.parse(sent.messages[1].content).expense, 10);
  assert.ok(modal.contentEl.querySelector('.bookkeeping-ai-analysis-text').closest('.bookkeeping-user-text'));
  const i18n = new I18nController(() => 'en'); i18n.start(); await tick(); assert.equal(modal.contentEl.querySelector('.bookkeeping-ai-analysis-text').textContent, '收入'); i18n.stop(); modal.close();
});

test('translation supports separate Obsidian settings documents and their dynamic content', async () => {
  const popup = new Window(); const root = popup.document.createElement('div'); root.className = 'bookkeeping-settings'; popup.document.body.appendChild(root);
  const label = popup.document.createElement('span'); label.textContent = '收入'; root.appendChild(label);
  let language = 'en'; const i18n = new I18nController(() => language); i18n.start(); i18n.refresh(root);
  assert.equal(label.textContent, 'Income');
  const dynamic = popup.document.createElement('span'); dynamic.textContent = '支出'; root.appendChild(dynamic);
  await tick(); assert.equal(dynamic.textContent, 'Expense');
  language = 'ar'; i18n.refresh(); assert.equal(root.dir, 'rtl');
  language = 'zh-CN'; i18n.refresh(); assert.equal(label.textContent, '收入'); assert.equal(dynamic.textContent, '支出');
  i18n.stop(); await popup.happyDOM.close();
});

test('empty AI selection cannot trigger a request', async () => {
  const p = plugin(); const modal = new AiAnalysisModal({}, p, []); modal.onOpen(); await tick(); let calls = 0; responder = async () => { calls++; return {}; }; await modal.run(); assert.equal(calls, 0); assert.equal(modal.start.buttonEl.disabled, true); modal.close();
});

test('repair translation matrix and dynamic progress cover every non-source language', () => {
  assert.equal(repairTranslationCoverage(), true);
  for (const language of ['en', 'zh-TW', 'fr', 'ru', 'es', 'ar', 'ja', 'ko', 'de', 'pt', 'fa']) {
    assert.notEqual(translate('正在转换 1/10（10%）', language), '正在转换 1/10（10%）');
    assert.notEqual(translate('API地址无效', language), 'API地址无效');
  }
});

test('finance page static labels and settings manager action have English translations', async () => {
  const source = await readFile('src/finance-modal.ts', 'utf8') + await readFile('src/views-report-modal.ts', 'utf8');
  const labels = [...source.matchAll(/(?:this|this\.plugin)\.t\("([^"]+)"\)|this\.field\([^,]+,\s*"([^"]+)"/g)].map((match) => match[1] ?? match[2]);
  labels.push('管理', '管理借贷、周期记账、模板、汇率、健康检查与恢复。');
  for (const label of labels) assert.doesNotMatch(translate(label, 'en'), /[\u3400-\u9fff]/, label);
});

test('failed goal saves preserve inputs and roll back memory before retry', async () => {
  const p = plugin(); p.refreshDashboards = async () => {};
  let fail = true; p.saveSettings = async () => { if (fail) throw new Error('disk full'); };
  const modal = new FinanceModal({}, p, 'goals'); modal.onOpen(); await tick();
  const fill = (label, value) => { const input = modal.contentEl.querySelector(`[aria-label="${label}"]`); input.value = value; input.dispatchEvent(new window.Event('input')); return input; };
  const name = fill('名称', '旅行'); fill('目标金额', '1000');
  const save = [...modal.contentEl.querySelectorAll('button')].find((button) => button.textContent === '保存目标');
  save.click(); await tick(); await tick();
  assert.equal(p.settings.planning.goals.length, 0); assert.equal(name.isConnected, true); assert.equal(name.value, '旅行');
  fail = false; save.click(); await tick(); await tick();
  assert.equal(p.settings.planning.goals.length, 1); assert.equal(p.settings.planning.goals[0].name, '旅行'); modal.close();
});

test('daily removal refuses ambiguous duplicate IDs', () => {
  const store = new TransactionStore({}, () => plain(DEFAULT_SETTINGS));
  const records = [{ '账目ID': 'duplicate' }, { '账目ID': 'duplicate' }];
  assert.throws(() => store.withoutRecord(records, { id: 'duplicate' }), /刷新/);
  assert.equal(records.length, 2);
});

test('failed filter favorite save rolls back and preserves the name for retry', async () => {
  const p = plugin(); p.applyLanguage = () => {}; let fail = true;
  p.saveSettings = async () => { if (fail) throw new Error('disk full'); };
  const modal = new ViewsReportModal({}, p, '2026-07', p.settings.savedDashboardFilters, [], async () => {}); modal.onOpen();
  const input = modal.contentEl.querySelector('input'); input.value = '跨月报销'; input.dispatchEvent(new window.Event('input'));
  const save = [...modal.contentEl.querySelectorAll('button')].find((button) => button.textContent === '收藏当前筛选');
  save.click(); await tick(); await tick(); assert.equal(p.settings.planning.views.length, 0); assert.equal(input.isConnected, true);
  fail = false; save.click(); await tick(); await tick(); assert.equal(p.settings.planning.views.length, 1); modal.close();
});

test('null recovery backups remain viewable without crashing the recovery page', async () => {
  const p = plugin(); const file = { path: `${p.settings.ledgerFolder}/_bookkeeping-recovery/null.json`, name: 'null.json', extension: 'json' };
  const app = { vault: { getFiles: () => [file], read: async () => 'null' } };
  const modal = new FinanceModal(app, p, 'recovery'); modal.onOpen(); await tick();
  assert.match(modal.contentEl.textContent, /null.json/);
  assert.doesNotMatch(modal.contentEl.textContent, /恢复此备份/); modal.close();
});

test('budget editor rejects malformed amounts and rolls back failed historical saves', async () => {
  const p = plugin(); p.refreshDashboards = async () => {}; let fail = true, saves = 0;
  p.saveSettings = async () => { saves++; if (fail) throw new Error('disk full'); };
  p.settings.monthlyBudgets = { '餐饮': 200 };
  Object.assign(p.settings.planning, { rollover: 'positive', rolloverStart: '2026-06', budgetBases: { '2026-06': { '餐饮': 200 } } });
  const modal = new BudgetEditorModal({}, p, async () => {}, '2026-07'); modal.onOpen();
  const area = modal.contentEl.querySelector('textarea');
  const save = [...modal.contentEl.querySelectorAll('button')].find((button) => button.textContent === '保存预算');
  const fill = (value) => { area.value = value; area.dispatchEvent(new window.Event('input')); };
  for (const invalid of ['餐饮=100=200', '餐饮=0.001', '餐饮=Infinity', '餐饮=0']) {
    fill(invalid); save.click(); await tick(); assert.equal(saves, 0);
  }
  fill('餐饮=100'); save.click(); await tick(); await tick();
  assert.equal(p.settings.planning.budgetBases['2026-07'], undefined); assert.equal(area.isConnected, true);
  fail = false; save.click(); await tick(); await tick();
  assert.equal(p.settings.planning.budgetBases['2026-07']['餐饮'], 100);
  assert.equal(p.settings.monthlyBudgets['餐饮'], 200); assert.equal(p.settings.planning.budgetBases['2026-06']['餐饮'], 200);
  assert.equal(modal.modalEl.isConnected, false);
});

test('all beta features default off and require both switches', () => {
  const beta = plain(DEFAULT_SETTINGS.beta);
  assert.equal(beta.enabled, false); assert.ok(Object.values(beta.features).every((value) => value === false));
  assert.deepEqual(plain(normalizeBeta(undefined)), beta);
  const settings = { beta }; beta.features.ai = true;
  assert.equal(betaEnabled(settings, 'ai'), false); beta.enabled = true;
  assert.equal(betaEnabled(settings, 'ai'), true); assert.equal(betaEnabled(settings, 'loans'), false);
});

test('basic settings follow 2.0.11 categories and beta settings stay at the end', () => {
  const p = plugin(); p.settings.beta = plain(DEFAULT_SETTINGS.beta); p.applyLanguage = () => {}; p.pluginLogoUrl = () => '';
  const tab = new BookkeepingSettingTab({}, p); tab.display();
  assert.deepEqual([...tab.containerEl.querySelectorAll('.bookkeeping-settings-section-header .setting-item-name')].map((el) => el.textContent), ['通用', '录入', '账目明细', '界面与格式', '数据与文件', '记账锁', '快捷键', 'Beta功能']);
  const names = [...tab.containerEl.querySelectorAll('.setting-item-name')].map((el) => el.textContent);
  assert.equal(names[1], '插件语言');
  for (const hidden of ['API协议', '管理借贷、周期记账、模板、汇率、健康检查与恢复。', '每页账目数量', '月报文件夹', '账目存储方式']) assert.ok(!names.includes(hidden), hidden);
  p.settings.beta.enabled = true; p.settings.beta.features.ai = true; tab.display();
  assert.ok(tab.containerEl.querySelector('.bookkeeping-beta-options').textContent.includes('API协议'));
  tab.containerEl.remove();
});

test('dashboard hides beta menus by default and exposes only opted-in features', () => {
  const p = plugin(); p.settings.beta = plain(DEFAULT_SETTINGS.beta);
  const view = Object.create(DashboardView.prototype); Object.assign(view, { plugin: p, filters: plain(p.settings.savedDashboardFilters), month: '2026-07', exportIds: [], balanceTransactions: [] });
  view.openDashboardMenu({});
  for (const title of ['AI分析当前筛选账目', '账本管理', '筛选与月报']) assert.ok(!Menu.latest.titles.includes(title));
  assert.equal(view.headerActionMeta('period').label, '年度统计');
  p.settings.beta.enabled = true; p.settings.beta.features.ai = true;
  view.openDashboardMenu({}); assert.ok(Menu.latest.titles.includes('AI分析当前筛选账目')); assert.ok(!Menu.latest.titles.includes('账本管理'));
});

test('AI uses Markdown renderer and preview/source switching preserves paragraphs', async () => {
  const p = plugin([transaction('one', '2026-07-01')]); Object.assign(p.settings, { aiEndpoint: 'http://localhost:11434/v1', aiModel: 'local' });
  const source = '## 收支概况\n\n第一段。\n\n第二段。';
  responder = async () => ({ status: 200, json: { choices: [{ message: { content: source } }] } });
  const modal = new AiAnalysisModal({}, p, ['one']); modal.onOpen(); await tick(); await modal.run();
  const rendered = modal.contentEl.querySelector('.bookkeeping-ai-analysis-text'), raw = modal.contentEl.querySelector('.bookkeeping-ai-analysis-source');
  assert.equal(markdownCalls.at(-1).source, source); assert.equal(rendered.querySelectorAll('p').length, 2); assert.equal(raw.textContent, source);
  [...modal.contentEl.querySelectorAll('button')].find((button) => button.textContent === '原文').click(); assert.equal(raw.hidden, false); assert.equal(rendered.hidden, true);
  [...modal.contentEl.querySelectorAll('button')].find((button) => button.textContent === '预览').click(); assert.equal(raw.hidden, true); assert.equal(rendered.hidden, false); modal.close();
});

test('individual beta tools do not require unrelated switches or expose unrelated actions', async () => {
  const item = transaction('one', '2026-07-01');
  const p = plugin([item]); p.settings.beta = plain(DEFAULT_SETTINGS.beta); p.settings.beta.enabled = true; p.settings.beta.features.planning = true;
  let modal = new FinanceModal({}, p, 'transaction', item); modal.onOpen(); await tick();
  assert.ok(modal.contentEl.textContent.includes('保存待办'));
  for (const hidden of ['保存为模板', '拆分明细', '保存关联账目']) assert.ok(!modal.contentEl.textContent.includes(hidden)); modal.close();
  p.settings.beta.features.planning = false; p.settings.beta.features.loans = true;
  item.finance = { kind: 'borrow' };
  modal = new FinanceModal({}, p, 'transaction', item); modal.onOpen(); await tick();
  assert.ok(modal.contentEl.textContent.includes('保存关联账目')); assert.ok(!modal.contentEl.textContent.includes('保存待办')); modal.close();
});

test('stable annual view hides extended period controls', async () => {
  const p = plugin([transaction('one', '2026-07-01')]); p.settings.beta = plain(DEFAULT_SETTINGS.beta);
  const modal = new PeriodStatsModal({}, p, '2026-07'); await modal.load();
  assert.equal(modal.contentEl.querySelector('[aria-label="统计周期"]').hidden, true);
  assert.equal(modal.contentEl.querySelector('[aria-label="统计月份"]').hidden, true);
  assert.equal(modal.period, 'year'); modal.close();
});

after(async () => { await window.happyDOM.close(); });
