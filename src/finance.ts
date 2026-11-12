import { requestUrl } from "obsidian";
import type { BookkeepingSettings, FinanceDetails, RecurringRule, Transaction, TransactionDraft } from "./types";
import { currentTime, normalizeDate, roundMoney, today } from "./utils";

export const PRINCIPAL_TYPES = ["借入本金", "借出本金", "偿还本金", "收回本金"];
export const transactionLink = (vault: string, id: string): string => `obsidian://personal-style-bookkeeping?vault=${encodeURIComponent(vault)}&id=${encodeURIComponent(id)}`;
export const currencyCode = (value: string): string => {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error("Invalid ISO currency code");
  return code;
};

export function normalizeFinanceSettings(settings: BookkeepingSettings, legacy = false): void {
  const source = settings.finance;
  const symbol = settings.currency;
  const inferred = symbol === "$" ? "USD" : symbol === "€" ? "EUR" : symbol === "£" ? "GBP" : "CNY";
  settings.finance = {
    baseCurrency: !legacy && /^[A-Z]{3}$/.test(source?.baseCurrency ?? "") ? source.baseCurrency : inferred,
    rates: source?.rates && typeof source.rates === "object" && !Array.isArray(source.rates) ? { ...source.rates } : {},
    templates: Array.isArray(source?.templates) ? source.templates : [],
    recurring: Array.isArray(source?.recurring) ? source.recurring : []
  };
}

/** Amount remains the frozen reporting amount so all existing charts share one unit. */
export function priceDraft(draft: TransactionDraft, settings: BookkeepingSettings, currency: string, nativeAmount: number, rate?: number): TransactionDraft {
  currency = currencyCode(currency);
  const baseCurrency = settings.finance.baseCurrency;
  const saved = settings.finance.rates[currency];
  const conversion = currency === baseCurrency ? 1 : rate ?? saved?.rate;
  if (!Number.isFinite(nativeAmount) || nativeAmount < 0 || !Number.isFinite(conversion) || Number(conversion) <= 0) throw new Error("Invalid amount or missing exchange rate");
  const previous = draft.finance;
  const unchanged = previous?.currency === currency && previous.baseCurrency === baseCurrency && previous.rate === conversion;
  const matchingQuote = saved?.rate === conversion ? saved : undefined;
  const finance: FinanceDetails = {
    ...previous, currency, baseCurrency, nativeAmount: roundMoney(nativeAmount), rate: Number(conversion),
    rateDate: unchanged ? previous.rateDate : currency === baseCurrency ? draft.date : matchingQuote?.date ?? draft.date,
    rateSource: unchanged ? previous.rateSource ?? "manual" : matchingQuote?.source ?? "manual"
  };
  return { ...draft, amount: roundMoney(finance.nativeAmount * finance.rate), expression: "", finance };
}

export function validateFinance(draft: TransactionDraft, settings: BookkeepingSettings): void {
  const details = draft.finance;
  if (!details) return;
  currencyCode(details.currency); currencyCode(details.baseCurrency);
  if (!normalizeDate(details.rateDate)) throw new Error("Invalid finance data");
  if (details.baseCurrency !== settings.finance.baseCurrency || !Number.isFinite(details.nativeAmount) || details.nativeAmount < 0 || !Number.isFinite(details.rate) || details.rate <= 0 || (details.currency === details.baseCurrency && details.rate !== 1) || Math.abs(roundMoney(details.nativeAmount * details.rate) - draft.amount) > 0.001) throw new Error("Currency snapshot does not match transaction amount");
  if (details.dueDate && !normalizeDate(details.dueDate)) throw new Error("Invalid due date");
  if (details.claim) {
    const claim = details.claim;
    if (!["refund", "reimbursement"].includes(claim.kind) || typeof claim.closed !== "boolean" || !Number.isFinite(claim.amount) || claim.amount <= 0 || roundMoney(claim.amount) !== claim.amount || claim.amount > draft.amount || typeof claim.dueDate !== "string" || claim.dueDate && !normalizeDate(claim.dueDate) || details.kind && details.kind !== "split" || settings.typeEffects[draft.type] !== "negative") throw new Error("Invalid finance data");
  }
  const types: Record<string, string> = { borrow: "借入本金", lend: "借出本金", repayment: "偿还本金", collection: "收回本金", refund: "退款", reimbursement: "报销到账" };
  if (details.kind && ![...Object.keys(types), "split"].includes(details.kind)) throw new Error("Invalid finance data");
  if (details.kind && draft.amount <= 0) throw new Error("Invalid finance data");
  if (details.kind && types[details.kind] && draft.type !== types[details.kind]) throw new Error("Linked transaction type cannot be changed");
  if (["borrow", "lend", "repayment", "collection"].includes(details.kind ?? "") && details.cashEffect !== (details.kind === "borrow" || details.kind === "collection" ? "positive" : "negative")) throw new Error("Invalid finance data");
  if (["repayment", "collection", "refund", "reimbursement"].includes(details.kind ?? "") && !details.relatedId) throw new Error("Invalid finance data");
}

/** Requests reveal currency codes only. Returned quote = 1 foreign unit in base units. */
export async function latestRates(base: string, currencies: string[]): Promise<Record<string, { rate: number; date: string; source: string }>> {
  base = currencyCode(base);
  const quotes = [...new Set(currencies.map(currencyCode))].filter((code) => code !== base);
  if (!quotes.length) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = await Promise.race([
    requestUrl({ url: `https://api.frankfurter.dev/v2/rates?base=${base}&quotes=${quotes.join(",")}`, throw: false }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Exchange rate request timed out")), 30000); })
  ]).finally(() => clearTimeout(timer));
  if (response.status !== 200 || !Array.isArray(response.json)) throw new Error("Exchange rate request failed");
  const rates: Record<string, { rate: number; date: string; source: string }> = {};
  for (const row of response.json as Array<Record<string, unknown>>) {
    const quote = String(row.quote ?? "").toUpperCase();
    if (String(row.base).toUpperCase() !== base || !quotes.includes(quote) || typeof row.rate !== "number" || !Number.isFinite(row.rate) || row.rate <= 0 || !normalizeDate(row.date)) throw new Error("Invalid exchange rate response");
    rates[quote] = { rate: 1 / row.rate, date: String(row.date), source: "Frankfurter" };
  }
  if (quotes.some((code) => !rates[code])) throw new Error("Exchange rate response is incomplete");
  return rates;
}

export function blankDraft(settings: BookkeepingSettings): TransactionDraft {
  return { date: today(), time: currentTime(), type: settings.defaultType, necessity: settings.defaultNecessity, category: settings.defaultCategory, account: settings.defaultAccount, targetAccount: "", title: "", amount: 0, expression: "", note: "", tags: [], attachments: [], customValues: {} };
}

export function draftFromTransaction(source: Transaction): TransactionDraft {
  const { file: _file, id: _id, rawProperties: _raw, legacy: _legacy, ...draft } = source;
  return JSON.parse(JSON.stringify(draft)) as TransactionDraft;
}

/** Use the original anchor day, not the previous clipped day (Jan31 -> Feb28 -> Mar31). */
export function nextOccurrence(rule: RecurringRule, current: string): string {
  if (!normalizeDate(current) || !normalizeDate(rule.startDate) || !["daily", "weekly", "monthly", "yearly"].includes(rule.frequency)) throw new Error("Invalid recurrence date");
  const [year, month, day] = current.split("-").map(Number) as [number, number, number];
  const anchor = Number(rule.startDate.slice(8, 10));
  let date: Date;
  if (rule.frequency === "daily" || rule.frequency === "weekly") date = new Date(Date.UTC(year, month - 1, day + (rule.frequency === "daily" ? 1 : 7)));
  else {
    const nextYear = year + (rule.frequency === "yearly" ? 1 : 0);
    const nextMonth = month - 1 + (rule.frequency === "monthly" ? 1 : 0);
    date = new Date(Date.UTC(nextYear, nextMonth, Math.min(anchor, new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate())));
  }
  return date.toISOString().slice(0, 10);
}

export function dueOccurrences(rule: RecurringRule, until = today(), limit = 120): string[] {
  const result: string[] = [];
  if (!rule.enabled) return result;
  if (!normalizeDate(until) || !normalizeDate(rule.nextDate) || !normalizeDate(rule.startDate) || rule.nextDate < rule.startDate || !["daily", "weekly", "monthly", "yearly"].includes(rule.frequency) || rule.endDate && (!normalizeDate(rule.endDate) || rule.endDate < rule.startDate) || !Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error("Invalid recurrence date");
  let date = rule.nextDate;
  while (date <= until && (!rule.endDate || date <= rule.endDate) && result.length < limit) { result.push(date); date = nextOccurrence(rule, date); }
  return result;
}

export function outstanding(source: Transaction, transactions: Transaction[]): number {
  return roundMoney(Math.max(0, source.amount - transactions.filter((item) => item.finance?.relatedId === source.id && ["repayment", "collection", "refund", "reimbursement"].includes(item.finance?.kind ?? "")).reduce((sum, item) => sum + item.amount, 0)));
}

export function splitDrafts(source: Transaction, parts: Array<{ title: string; category: string; amount: number }>, settings: BookkeepingSettings): TransactionDraft[] {
  if (source.finance?.relatedId || source.finance?.kind || source.finance?.claim || source.type === "转账") throw new Error("Linked transactions cannot be split");
  if (parts.length < 2 || parts.some((part) => !part.title.trim() || !Number.isFinite(part.amount) || part.amount <= 0) || roundMoney(parts.reduce((sum, part) => sum + part.amount, 0)) !== source.amount) throw new Error("Split amounts must equal the original amount");
  const group = crypto.randomUUID();
  const totalNative = source.finance?.nativeAmount ?? source.amount;
  let assigned = 0;
  return parts.map((part, index) => {
    const nativeAmount = index === parts.length - 1 ? roundMoney(totalNative - assigned) : roundMoney(totalNative * part.amount / source.amount);
    assigned = roundMoney(assigned + nativeAmount);
    // Allocate rounding explicitly: each child carries its effective rate and exact base amount.
    const currency = source.finance?.currency ?? settings.finance.baseCurrency;
    if (nativeAmount <= 0) throw new Error("Split is smaller than currency precision");
    return { ...draftFromTransaction(source), title: part.title.trim(), category: part.category, amount: roundMoney(part.amount), expression: "", attachments: [...source.attachments], finance: { ...source.finance, occurrence: index === 0 ? source.finance?.occurrence : undefined, currency, baseCurrency: settings.finance.baseCurrency, nativeAmount, rate: part.amount / nativeAmount, rateDate: source.finance?.rateDate ?? source.date, kind: "split", splitId: group } };
  });
}
