export function weekBounds(date: string): { start: string; end: string } {
  const day = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day.getTime())) throw new Error("无效账目日期");
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  const start = day.toISOString().slice(0, 10);
  day.setUTCDate(day.getUTCDate() + 6);
  return { start, end: day.toISOString().slice(0, 10) };
}

export function weeklyPath(root: string, date: string): string {
  const { start, end } = weekBounds(date);
  const thursday = new Date(`${start}T00:00:00Z`); thursday.setUTCDate(thursday.getUTCDate()+3); const owner = thursday.toISOString().slice(0,10);
  return `${root}/${owner.slice(0,4)}/${owner.slice(5,7)}/${start}~${end}.md`;
}

export function weeklyBody(records: Record<string, unknown>[]): string {
  if (!records.length) return "";
  const ordered = [...records].sort((a, b) => String(a["时间"]).localeCompare(String(b["时间"])));
  const { start, end } = weekBounds(String(ordered[0]!["时间"]).slice(0, 10));
  const receipts = [...new Set(ordered.flatMap(row => Array.isArray(row["附件"]) ? row["附件"].map(String) : []))];
  const cell = (value: unknown): string => String(value ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  const lines = [`# 周账本 · ${start} ～ ${end}`, "", "> 本页每天的清单由账目数据自动更新；手写复盘请放在自动区块之外。", ""];
  for (let i = 0; i < 7; i++) {
    const day = new Date(`${start}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + i);
    const date = day.toISOString().slice(0, 10);
    lines.push(`## ${["周一", "周二", "周三", "周四", "周五", "周六", "周日"][i]} · ${date}`, "");
    const rows = ordered.filter(row => String(row["时间"]).slice(0, 10) === date);
    if (!rows.length) { lines.push("暂无账目。", ""); continue; }

    lines.push("| 内容 | 类型 | 大类 | 小类 | 账户 | 金额 | 备注 | 凭证 |", "|---|---|---|---|---|---:|---|---|");
    for (const row of rows) {
      const links = (Array.isArray(row["附件"]) ? row["附件"].map(String) : []).map(path => `[[${cell(path)}\\|凭证${receipts.indexOf(path) + 1}]]`).join("、");
      lines.push(`| <span id="bk-${cell(row["账目ID"])}"></span>${cell(row["内容"])} | ${badge(cell(row["类型"]),row["类型"] === "收入" ? "#3F7F73" : "#8E639F")} | ${badge(cell(row["大类"]??"未分类"),categoryColor(String(row["大类"]??"未分类")))} | ${badge(cell(row["分类"]),categoryColor(String(row["分类"]??"未分类")))} | ${cell(row["账户"])} | ¥${Number(row["金额"]).toFixed(2)} | ${cell(row["备注"])} | ${links} |`);
    }
    lines.push("");
  }
  return `\n<!-- bookkeeping-weekly:start -->\n${lines.join("\n")}\n<!-- bookkeeping-weekly:end -->\n`;
}

export function categoryColor(name: string): string {
 const colors = ["#8E639F","#E2A23A","#79A99B","#C68FA9","#8797B0","#B39B84","#B399D4"];
 if(name === "购物") return colors[0]!; if(name === "买菜") return colors[1]!;
 let hash=0; for(const ch of name) hash=(hash*31+ch.charCodeAt(0))>>>0;
 return colors[2+hash%5]!;
}
export function badge(text: string, color: string): string {
 const safe=text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
 return `<span class="bk-label" style="color:#171717;background:${color}20;border-color:${color}59;--bk-label-color:${color}">${safe}</span>`;
}
