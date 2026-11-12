import type { BookkeepingSettings } from "./types";

export const BETA_LABELS = {
  storage: "账目Markdown存储", ai: "AI账本分析", loans: "借贷管理", recurring: "周期记账",
  templates: "记账模板", currencies: "多币种与汇率", settlements: "账目关联操作",
  planning: "待办与预测", goals: "预算与目标", views: "筛选与月报", health: "账本健康检查",
  embeds: "笔记账目嵌入", statistics: "扩展周期统计", customization: "高级显示设置"
} as const;
export type BetaFeature = keyof typeof BETA_LABELS;
export interface BetaSettings { enabled: boolean; features: Record<BetaFeature, boolean> }
export const DEFAULT_BETA: BetaSettings = { enabled: false, features: Object.fromEntries(Object.keys(BETA_LABELS).map((key) => [key, false])) as Record<BetaFeature, boolean> };
export function normalizeBeta(value: unknown): BetaSettings {
  const source = value && typeof value === "object" ? value as Partial<BetaSettings> : {};
  return { enabled: source.enabled === true, features: Object.fromEntries(Object.keys(BETA_LABELS).map((key) => [key, source.features?.[key as BetaFeature] === true])) as Record<BetaFeature, boolean> };
}
export const betaEnabled = (settings: Pick<BookkeepingSettings, "beta">, feature: BetaFeature): boolean => settings.beta?.enabled === true && settings.beta.features?.[feature] === true;
const financePages = { loans: "loans", recurring: "recurring", templates: "templates", currencies: "currencies", transaction: "settlements", planning: "planning", goals: "goals", health: "health", recovery: "health" } as const;
export const transactionActionsEnabled = (settings: Pick<BookkeepingSettings, "beta">, kind?: string): boolean => betaEnabled(settings, "settlements") || betaEnabled(settings, "planning") || betaEnabled(settings, "templates") || betaEnabled(settings, "embeds") || (["borrow", "lend"].includes(kind ?? "") && betaEnabled(settings, "loans"));
export const financePageEnabled = (settings: Pick<BookkeepingSettings, "beta">, page: string): boolean => page === "transaction" ? transactionActionsEnabled(settings) || betaEnabled(settings, "loans") : page in financePages && betaEnabled(settings, financePages[page as keyof typeof financePages]);
export const hasFinanceFeatures = (settings: Pick<BookkeepingSettings, "beta">): boolean => Object.keys(financePages).filter((page) => page !== "transaction").some((page) => financePageEnabled(settings, page));
