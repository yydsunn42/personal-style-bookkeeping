import { App, ButtonComponent, Modal, Setting, TFile } from "obsidian";
import type BookkeepingPlugin from "./main";
import type { DashboardFilterState, Transaction } from "./types";
import { errorMessageZh, roundMoney } from "./utils";
import { planningOptions } from "./planning";
import { saveSettingField } from "./settings-write";
import { betaEnabled } from "./beta";

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const escapeReportCell = (value: string): string => value.replace(/([\\`*_[\]#!])/g, "\\$1").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "&#124;").replace(/[\r\n]+/g, " ");

/** Snapshot the selection before opening: a report never silently broadens its scope. */
export class ViewsReportModal extends Modal {
  private busy = false;
  private closed = false;
  private readonly filters: DashboardFilterState;
  private readonly items: Transaction[];
  constructor(app: App, private readonly plugin: BookkeepingPlugin, private readonly month: string, filters: DashboardFilterState, items: Transaction[], private readonly apply: (month: string, filters: DashboardFilterState) => Promise<void>) {
    super(app); this.filters = copy(filters); this.items = items.map((item) => ({ ...item }));
  }
  onClose(): void { this.closed = true; this.contentEl.empty(); }
  onOpen(): void { this.closed = false; this.render(); }
  private action(parent: HTMLElement, label: string, action: () => Promise<void>): void {
    new ButtonComponent(parent).setButtonText(this.plugin.t(label)).onClick(() => { void (async () => {
      if (this.busy) return; this.busy = true;
      if (!betaEnabled(this.plugin.settings, "views")) { this.busy = false; return void this.plugin.notice("请先在设置中启用对应Beta功能"); }
      let completed = false;
      try { await action(); completed = true; } catch (error) { this.plugin.notice(errorMessageZh(error)); }
      finally { this.busy = false; if (!this.closed && completed) this.render(); }
    })(); });
  }
  private report(): string {
    const t = (text: string): string => this.plugin.t(text), currency = this.plugin.settings.finance.baseCurrency;
    const income = roundMoney(this.items.filter((item) => this.plugin.store.typeEffect(item.type) === "positive").reduce((sum, item) => sum + item.amount, 0));
    const expense = roundMoney(this.items.filter((item) => this.plugin.store.typeEffect(item.type) === "negative").reduce((sum, item) => sum + item.amount, 0));
    const lines = [`# ${this.month} ${t("月报笔记")}`, "", `${t("仅包含打开面板时的筛选结果。")}`, "", `- ${t("账目数量")}: ${this.items.length}`, `- ${t("收入")}: ${income} ${currency}`, `- ${t("支出")}: ${expense} ${currency}`, `- ${t("结余")}: ${roundMoney(income - expense)} ${currency}`, "", `\`\`\`json`, JSON.stringify({ month: this.month, filters: this.filters, ids: this.items.map((item) => item.id) }, null, 2), "\`\`\`"];
    if (planningOptions(this.plugin.settings).reportDetails) {
      lines.push("", `| ${t("日期")} | ${t("内容")} | ${t("类型")} | ${t("分类")} | ${t("金额")} (${currency}) |`, "| --- | --- | --- | --- | ---: |");
      for (const item of this.items) lines.push(`| ${escapeReportCell(item.date)} | ${escapeReportCell(item.title)} | ${escapeReportCell(this.plugin.settings.typeLabels[item.type] ?? item.type)} | ${escapeReportCell(item.category)} | ${item.amount} |`);
    }
    return lines.join("\n") + "\n";
  }
  private render(): void {
    this.modalEl.addClass("bookkeeping-modal", "bookkeeping-finance-modal"); this.setTitle(this.plugin.t("筛选与月报"));
    const body = this.contentEl; body.empty();
    if (!betaEnabled(this.plugin.settings, "views")) { body.createEl("p", { text: this.plugin.t("请先在设置中启用对应Beta功能") }); return; }
    let name = "";
    new Setting(body).setName(this.plugin.t("收藏名称")).addText((input) => input.onChange((value) => name = value));
    this.action(body, "收藏当前筛选", async () => {
      if (!name.trim()) throw new Error(this.plugin.t("名称不得为空"));
      const planning = this.plugin.settings.planning;
      await saveSettingField(this.plugin, planning, "views", [...planning.views, { id: crypto.randomUUID(), name: name.trim(), month: this.month, filters: copy(this.filters) }]);
    });
    for (const view of planningOptions(this.plugin.settings).views) {
      const row = new Setting(body).setName(view.name).setDesc(view.month); row.nameEl.addClass("bookkeeping-user-text");
      this.action(row.controlEl, "应用", async () => { await this.apply(view.month, copy(view.filters)); this.close(); });
      this.action(row.controlEl, "删除", async () => { const planning = this.plugin.settings.planning; await saveSettingField(this.plugin, planning, "views", planning.views.filter((item) => item.id !== view.id)); });
    }
    body.createEl("h3", { text: this.plugin.t("月报笔记") });
    body.createEl("p", { text: this.plugin.t("仅包含打开面板时的筛选结果。") });
    const report = this.report();
    body.createEl("pre", { text: report, cls: "bookkeeping-user-text" });
    this.action(body, "生成月报笔记", async () => {
      const folder = (planningOptions(this.plugin.settings).reportFolder || `${this.plugin.settings.ledgerFolder}/月报`).replace(/\\/g, "/").replace(/\/$/, "");
      if (!folder || folder.startsWith("/") || folder.split("/").some((part) => !part || part === "." || part === ".." || /[:*?"<>|]/.test(part))) throw new Error(this.plugin.t("文件夹路径无效"));
      let current = "";
      for (const part of folder.split("/")) { current = current ? `${current}/${part}` : part; if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current); }
      let path = `${folder}/${this.month}.md`, suffix = 2;
      while (this.app.vault.getAbstractFileByPath(path)) path = `${folder}/${this.month}-${suffix++}.md`;
      const file: TFile = await this.app.vault.create(path, report); await this.app.workspace.getLeaf(false).openFile(file);
    });
    this.plugin.applyLanguage(body);
  }
}
