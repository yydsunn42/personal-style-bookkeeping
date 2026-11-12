import { MarkdownRenderChild } from "obsidian";
import type BookkeepingPlugin from "./main";
import { transactionLink } from "./finance";
import { errorMessageZh } from "./utils";
import { planningOptions } from "./planning";
import { betaEnabled } from "./beta";

/** Read-only note embeds use UUIDs, so links survive storage conversion and file moves. */
export class LedgerBlock extends MarkdownRenderChild {
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(container: HTMLElement, private readonly plugin: BookkeepingPlugin, private readonly source: string) { super(container); }
  onload(): void {
    const refresh = (): void => { clearTimeout(this.timer); this.timer = setTimeout(() => void this.render(), 150); };
    this.registerEvent(this.plugin.app.vault.on("modify", refresh));
    this.registerEvent(this.plugin.app.vault.on("create", refresh));
    this.registerEvent(this.plugin.app.vault.on("delete", refresh));
    this.registerEvent(this.plugin.app.vault.on("rename", refresh));
    this.register(() => { clearTimeout(this.timer); this.version++; });
    void this.render();
  }
  private async render(): Promise<void> {
    const version = ++this.version;
    if (!betaEnabled(this.plugin.settings, "embeds")) { this.containerEl.setText(this.plugin.t("请先在设置中启用对应Beta功能")); return; }
    try {
      const query = Object.fromEntries(this.source.split(/\r?\n/).map((line) => { const index = line.indexOf(":"); return index < 0 ? [] : [line.slice(0, index).trim(), line.slice(index + 1).trim()]; }).filter((row) => row.length === 2));
      const requested = Number(query.limit ?? planningOptions(this.plugin.settings).embedLimit);
      const limit = Number.isFinite(requested) ? Math.min(200, Math.max(1, Math.floor(requested))) : 20;
      const items = (await this.plugin.store.list()).filter((item) => (!query.month || item.date.startsWith(query.month)) && (!query.account || item.account === query.account) && (!query.currency || (item.finance?.currency ?? this.plugin.settings.finance.baseCurrency) === query.currency));
      if (version !== this.version) return;
      this.containerEl.empty();
      this.containerEl.createEl("p", { text: `${this.plugin.t("账目数量")}: ${items.length} · ${this.plugin.settings.finance.baseCurrency}` });
      const table = this.containerEl.createEl("table");
      for (const item of items.slice(0, limit)) {
        const row = table.createEl("tr");
        row.createEl("td", { text: item.date });
        row.createEl("td").createEl("a", { text: item.title, href: transactionLink(this.plugin.app.vault.getName(), item.id), cls: "bookkeeping-user-text" });
        row.createEl("td", { text: `${item.amount.toFixed(2)} ${this.plugin.settings.finance.baseCurrency}` });
      }
    } catch (error) { if (version === this.version) this.containerEl.setText(errorMessageZh(error)); }
  }
}
