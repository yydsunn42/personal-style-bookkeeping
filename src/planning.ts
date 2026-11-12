import { DEFAULT_PLANNING } from "./types";
import type { BookkeepingSettings, Transaction, PlanningSettings, DashboardFilterState } from "./types";
import { dueOccurrences, outstanding, priceDraft } from "./finance";
import { normalizeDate, roundMoney, today } from "./utils";
import { betaEnabled } from "./beta";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const planningOptions = (settings: BookkeepingSettings): PlanningSettings => ({ ...clone(DEFAULT_PLANNING), ...settings.planning });
export function normalizePlanning(settings: BookkeepingSettings): void {
  const options = planningOptions(settings);
  for (const key of ["claimsEnabled", "forecastEnabled", "goalsEnabled", "viewsEnabled", "showDueSummary", "includeClaims", "includeLoans", "includeRecurring", "reportDetails"] as const) {
    if (typeof options[key] !== "boolean") options[key] = DEFAULT_PLANNING[key];
  }
  for (const [key, min, max] of [["dueDays", 0, 365], ["forecastDays", 1, 366], ["pageSize", 20, 500], ["embedLimit", 1, 200], ["healthLimit", 10, 500]] as const) {
    options[key] = Number.isFinite(options[key]) ? Math.min(max, Math.max(min, Math.floor(options[key]))) : DEFAULT_PLANNING[key];
  }
  if (!["off", "positive", "all"].includes(options.rollover)) options.rollover = "off";
  if (!validMonth(options.rolloverStart)) options.rolloverStart = "";
  if (!options.budgetBases || typeof options.budgetBases !== "object" || Array.isArray(options.budgetBases)) options.budgetBases = {};
  options.budgetBases = Object.fromEntries(Object.entries(options.budgetBases).filter(([month, values]) => validMonth(month) && values && typeof values === "object" && !Array.isArray(values)).map(([month, values]) => [month, Object.fromEntries(Object.entries(values).filter(([, value]) => Number.isFinite(value) && value > 0))]));
  options.goals = Array.isArray(options.goals) ? options.goals.filter((goal) => goal && typeof goal.id === "string" && typeof goal.name === "string" && Number.isFinite(goal.target) && goal.target > 0 && Number.isFinite(goal.saved) && goal.saved >= 0 && (!goal.dueDate || normalizeDate(goal.dueDate))) : [];
  options.views = Array.isArray(options.views) ? options.views.filter((view) => view && typeof view.id === "string" && typeof view.name === "string" && validMonth(view.month) && view.filters && typeof view.filters === "object") : [];
  for (const view of options.views) view.filters = normalizeViewFilters(view.filters);
  if (typeof options.reportFolder !== "string") options.reportFolder = "";
  settings.planning = options;
}
export function normalizeViewFilters(source: Partial<DashboardFilterState>): DashboardFilterState {
  const filters: DashboardFilterState = { types: [], necessities: [], categories: [], accounts: [], customFields: {}, keyword: "", amountMin: "", amountMax: "", dateFrom: "", dateTo: "", tags: "", crossMonth: source.crossMonth === true, calendarDate: "" };
  for (const key of ["types", "necessities", "categories", "accounts"] as const) filters[key] = Array.isArray(source[key]) ? source[key].filter((item) => typeof item === "string") : [];
  for (const key of ["keyword", "amountMin", "amountMax", "dateFrom", "dateTo", "tags", "calendarDate"] as const) if (typeof source[key] === "string") filters[key] = source[key];
  if (source.customFields && typeof source.customFields === "object") filters.customFields = Object.fromEntries(Object.entries(source.customFields).filter(([, values]) => Array.isArray(values)).map(([key, values]) => [key, values.filter((value) => typeof value === "string")]));
  return filters;
}
export const validMonth = (value: string): boolean => /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value ?? "");
export function addDays(date: string, days: number): string {
  if (!normalizeDate(date) || !Number.isInteger(days)) throw new Error("请选择真实存在的有效日期");
  const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10);
}
export function claimProgress(source: Transaction, items: Transaction[]): { expected: number; received: number; remaining: number; closed: boolean } {
  const claim = source.finance?.claim;
  const received = roundMoney(items.filter((item) => item.finance?.relatedId === source.id && ["refund", "reimbursement"].includes(item.finance.kind ?? "")).reduce((sum, item) => sum + item.amount, 0));
  const expected = claim?.amount ?? 0;
  return { expected, received, remaining: roundMoney(Math.max(0, expected - received)), closed: Boolean(claim?.closed) || received >= expected };
}
export interface ForecastEvent { id: string; date: string; title: string; amount: number; source: "claim" | "loan" | "recurring"; overdue: boolean; }
export function forecast(items: Transaction[], settings: BookkeepingSettings, effect: (type: string) => string, start = today(), horizon?: number): { events: ForecastEvent[]; warnings: string[] } {
  if (!betaEnabled(settings, "planning")) return { events: [], warnings: [] };
  const options = planningOptions(settings), end = addDays(start, horizon ?? options.forecastDays), events: ForecastEvent[] = [], warnings: string[] = [];
  const add = (event: Omit<ForecastEvent, "overdue">): void => { if (normalizeDate(event.date) && event.date <= end && event.amount !== 0) events.push({ ...event, overdue: event.date < start }); };
  if (options.claimsEnabled && options.includeClaims) for (const item of items) {
    if (!item.finance?.claim) continue;
    const progress = claimProgress(item, items), claim = item.finance?.claim;
    if (claim && !progress.closed && claim.dueDate) add({ id: item.id, date: claim.dueDate, title: item.title, amount: progress.remaining, source: "claim" });
  }
  if (options.includeLoans) for (const item of items) if (item.finance?.dueDate && ["borrow", "lend"].includes(item.finance.kind ?? "")) {
    const left = outstanding(item, items); add({ id: item.id, date: item.finance.dueDate, title: item.title, amount: item.finance.kind === "borrow" ? -left : left, source: "loan" });
  }
  const existing = new Set(items.map((item) => item.finance?.occurrence).filter(Boolean));
  if (options.includeRecurring) for (const rule of settings.finance.recurring) {
    try {
      const dates = dueOccurrences(rule, end, 10000);
      if (dates.length === 10000) warnings.push(rule.name);
      for (const date of dates) {
        if (existing.has(`${rule.id}:${date}`)) continue;
        const draft = priceDraft({ ...clone(rule.draft), date }, settings, rule.draft.finance?.currency ?? settings.finance.baseCurrency, rule.draft.finance?.nativeAmount ?? rule.draft.amount);
        const sign = effect(draft.type) === "positive" ? 1 : effect(draft.type) === "negative" ? -1 : 0;
        add({ id: `${rule.id}:${date}`, date, title: rule.name, amount: roundMoney(draft.amount * sign), source: "recurring" });
      }
    } catch { warnings.push(rule.name); }
  }
  return { events: events.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)), warnings };
}
export function effectiveBudgets(settings: BookkeepingSettings, items: Transaction[], month: string, effect: (type: string) => string): Record<string, { base: number; carry: number; available: number }> {
  const options = planningOptions(settings), result: Record<string, { base: number; carry: number; available: number }> = Object.create(null) as Record<string, { base: number; carry: number; available: number }>;
  if (!validMonth(month)) return result;
  if (!betaEnabled(settings, "goals") || options.rollover === "off" || !validMonth(options.rolloverStart) || options.rolloverStart > month) {
    for (const [key, base] of Object.entries(settings.monthlyBudgets)) if (Number.isFinite(base) && base > 0) result[key] = { base, carry: 0, available: base };
    return result;
  }
  const spent = new Map<string, number>();
  for (const item of items) if (effect(item.type) === "negative") for (const key of new Set(["总预算", item.category])) {
    const stamp = `${item.date.slice(0, 7)}:${key}`; spent.set(stamp, roundMoney((spent.get(stamp) ?? 0) + item.amount));
  }
  const snapshots = Object.keys(options.budgetBases).filter(validMonth).sort(), carry = new Map<string, number>();
  let current = options.rolloverStart;
  for (let step = 0; current <= month; step++) {
    if (step > 1200) throw new Error("名称或日期无效");
    const anchor = snapshots.filter((key) => key <= current).at(-1);
    const budgets = anchor ? options.budgetBases[anchor]! : settings.monthlyBudgets;
    for (const [key, base] of Object.entries(budgets)) {
      if (!Number.isFinite(base) || base <= 0) continue;
      const previous = carry.get(key) ?? 0, available = roundMoney(base + previous);
      if (current === month) result[key] = { base, carry: previous, available };
      const remaining = roundMoney(available - (spent.get(`${current}:${key}`) ?? 0));
      carry.set(key, options.rollover === "positive" ? Math.max(0, remaining) : remaining);
    }
    for (const key of carry.keys()) if (!(key in budgets)) carry.delete(key);
    const [year, number] = current.split("-").map(Number) as [number, number];
    current = `${number === 12 ? year + 1 : year}-${String(number === 12 ? 1 : number + 1).padStart(2, "0")}`;
  }
  return result;
}

export const HEALTH_LABELS: Record<string, string> = {
  "invalid-record": "账目日期或金额无效", "negative-amount": "账目金额为负数", "missing-id": "账目缺少稳定ID", "invalid-file": "账目文件无法解析",
  "duplicate-id": "多个账目使用相同ID", "duplicate-occurrence": "周期账目重复生成", "missing-related": "关联的原账目不存在", "self-related": "账目关联到自身",
  "invalid-currency": "币种快照不一致", "missing-attachment": "附件文件不存在", "over-settled": "累计到账超过原金额", "pending-recovery": "存在中断操作", "invalid-backup": "恢复备份无法解析"
};
export function healthAdvice(code: string): string {
  if (code === "missing-id") return "可预览并补齐ID，不改变金额、正文或其他字段。";
  if (["duplicate-id", "duplicate-occurrence"].includes(code)) return "请对照原文件核实；不会自动合并或删除相似账目。";
  if (code === "missing-attachment") return "请恢复附件或在编辑面板核对附件路径。";
  if (["pending-recovery", "invalid-backup"].includes(code)) return "请到恢复中心查看备份与文件状态。";
  return "请先备份，再打开原账目核对；不会自动猜测或覆盖数据。";
}
