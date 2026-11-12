import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const vaultArg = process.argv.indexOf("--vault");
const vaultInput = vaultArg > -1 ? process.argv[vaultArg + 1] : process.env.BOOKKEEPING_VAULT;
if (!vaultInput) {
  console.error("用法：node scripts/audit-ledger.mjs --vault /path/to/vault");
  process.exit(1);
}
const vault = path.resolve(vaultInput);
const pluginData = JSON.parse(fs.readFileSync(path.join(vault, ".obsidian", "plugins", "personal-style-bookkeeping", "data.json"), "utf8"));
const ledgerRoot = path.join(vault, pluginData.ledgerFolder);

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const target = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === "附件" ? [] : walk(target);
  return entry.name.endsWith(".md") && entry.name !== "使用说明.md" ? [target] : [];
});

const knownCategories = new Set(pluginData.categories ?? []);
const knownIncome = new Set(pluginData.incomeCategories ?? []);
const knownAccounts = new Set((pluginData.accounts ?? []).map((account) => account.name));
const rows = [];
for (const file of walk(ledgerRoot)) {
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) continue;
  const document = parse(match[1]);
  if (document?.["记账插件"] !== true) continue;
  for (const row of document["账目列表"] ?? []) rows.push({ ...row, file });
}

const money = (value) => Number(value ?? 0);
const byType = {};
for (const row of rows) byType[row["类型"]] = (byType[row["类型"]] ?? 0) + money(row["金额"]);
const ids = rows.map((row) => row["账目ID"]);
const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
const unknownCategory = rows.filter((row) => row["类型"] === "收入" ? !knownIncome.has(row["分类"]) : !knownCategories.has(row["分类"]));
const unknownAccount = rows.filter((row) => !knownAccounts.has(row["账户"]));
const missingAttachments = rows.flatMap((row) => (row["附件"] ?? []).filter((file) => !fs.existsSync(path.join(vault, file))).map((file) => ({ id: row["账目ID"], file })));

console.log(`账本文件：${walk(ledgerRoot).length}`);
console.log(`账目：${rows.length} 笔`);
for (const [type, total] of Object.entries(byType)) console.log(`  ${type}：¥${total.toFixed(2)}`);
console.log(`合计：¥${rows.reduce((sum, row) => sum + money(row["金额"]), 0).toFixed(2)}`);
console.log(`重复 ID：${duplicates.length ? duplicates.join(", ") : "无"}`);
console.log(`缺失凭证：${missingAttachments.length ? missingAttachments.map((item) => `${item.id} → ${item.file}`).join("\n  ") : "无"}`);
console.log(`未在当前分类表中的小类：${unknownCategory.length ? [...new Set(unknownCategory.map((row) => `${row["大类"]}/${row["分类"]}`))].join("、") : "无"}`);
console.log(`未在当前账户表中的账户：${unknownAccount.length ? [...new Set(unknownAccount.map((row) => row["账户"]))].join("、") : "无"}`);
