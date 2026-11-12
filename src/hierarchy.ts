import type { BookkeepingSettings } from "./types";
export const GROUPS: Record<string, string[]> = {
购物: ["厨房用品","清洁日用","学习用品","床上用品","衣物鞋袜","配饰","家用电器"],
买菜: ["肉禽","鱼虾海鲜","蛋奶豆制品","蔬菜","主食粮油","调味品","水果"],
餐饮: ["外卖配送","到店就餐","到店打包","饮品零食"],
交通: ["公共交通","打车","其他交通"],
生活: ["理发美容","洗衣修补","家政维修","其他生活服务"],
住房: ["房租","水电燃气","物业费用"],
通讯: ["话费","网络费用"],
医疗: ["看病","药品","体检"],
学习: ["书籍资料","课程培训"],
娱乐: ["休闲娱乐","会员订阅"],
人情往来: ["礼物","红包礼金"],
其他: ["其他支出"]
};
export function subcategories(settings: BookkeepingSettings, major: string): string[] {
 return GROUPS[major] ?? settings.categories;
}
export function configureHierarchy(settings: BookkeepingSettings): void {
 const record = settings as unknown as Record<string, unknown>;

 const options = Object.keys(GROUPS);
 const optionCodes = Object.fromEntries(options.map((name,i)=>[name,String(i+1)]));
 settings.customFields = settings.customFields.filter(field=>field.id!=="major");
 settings.customFields.push({id:"major",name:"大类",property:"大类",kind:"select",options,optionCodes,defaultValue:"购物",initialOptions:[...options],initialOptionCodes:{...optionCodes},initialDefaultValue:"购物",enabled:true});
 settings.categories = [...new Set(Object.values(GROUPS).flat())];
 settings.categoryCodes = Object.fromEntries(settings.categories.map((name,i)=>[name,String(i+1)]));
 settings.defaultCategory = "厨房用品";
 settings.optionFieldOrder = settings.optionFieldOrder.filter(key=>key!=="custom:major");
 settings.optionFieldOrder.splice(settings.optionFieldOrder.indexOf("category"),0,"custom:major");
 settings.tableColumnLabels.category = "小类";
 settings.tableColumnLabels["custom:major"] = "大类";
 for (const key of ["tableColumnOrder", "visibleTableColumns"] as const) {
  settings[key] = settings[key].filter(value=>value!=="custom:major");
  settings[key].splice(Math.max(0,settings[key].indexOf("category")),0,"custom:major");
 }
 record.hierarchyVersion = 4;
}
