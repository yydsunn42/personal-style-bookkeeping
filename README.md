# 个人风格化记账

一个本地优先的 Obsidian 记账插件：每周账本、大类与小类联动、共享凭证、仪表盘图表，以及可选的记账锁。

> 插件 ID：`personal-style-bookkeeping`  
> 适用：Obsidian 1.13.0 及以上  
> 平台：桌面端与移动端（Touch ID 仅 macOS 桌面端）

## 特点

- **每周一篇账本**：周一至周日，按周四所属月份归档。
- **大类 → 小类联动**：标签表示大类，分类表示小类；保存时自动带上大类标签。
- **本地 Markdown**：账目保存在 vault 内的 Markdown 属性里，不依赖云服务。
- **仪表盘**：收支卡片、日历、分类圆环、标签汇总、预算和账户余额。
- **共享凭证**：同一张图片可被多笔账复用，按文件内容去重。
- **记账锁**：可只锁仪表盘和账本目录；支持密码，macOS 可选 Touch ID。
- **个人风格默认值**：周账本、字段顺序、明细列、图表布局和配色都可以在设置里调整。

仓库只包含插件代码和通用默认值，不包含任何个人账本、账户、消费记录或本机路径。

## 安装

### 手动安装

1. 下载 release 里的 `main.js`、`manifest.json`、`styles.css`。
2. 放到：

```text
<你的 vault>/.obsidian/plugins/personal-style-bookkeeping/
├── main.js
├── manifest.json
└── styles.css
```

3. 在 Obsidian「设置 → 第三方插件」里启用「个人风格化记账」。

首次打开后，账本默认保存在 `记账/` 目录；可以在设置里改成自己的目录。

## 使用

- 打开记账仪表盘，确认顶部年月，点「＋」新建账目。
- 先选大类，再选对应小类；店铺、平台、规格等信息写在备注里。
- 账户、分类、明细列和图表都可以在设置里调整。
- 记账锁默认关闭；启用后，从其他笔记进入仪表盘或账本目录时才需要验证。

## 记账锁说明

- 只锁定个人风格化记账的仪表盘和账本目录，不影响其他笔记。
- 每次从其他笔记进入账本时验证；账本内部切换不再验证；离开账本再回来重新验证。
- 可选「连续停留后重新锁定」，默认 30 分钟。
- macOS 可使用 Touch ID；首次使用会在插件目录编译一个本地助手，失败时回退到密码。
- 它只隐藏 Obsidian 界面，不加密磁盘文件；需要静态加密请配合 FileVault / BitLocker 或加密磁盘。

## 开发

```bash
npm install
npm test
npm run build
```

构建产物是根目录的 `main.js`。TypeScript 源码在 `src/`，自动检查在 `tests/`。

可选账本体检（只读）：

```bash
node scripts/audit-ledger.mjs --vault /path/to/your/vault
```

## 目录

```text
src/
├── style-profile.ts    ← 个人风格默认值（通用）
├── hierarchy.ts        ← 大类/小类结构
├── lock.ts             ← 记账锁（密码 / Touch ID）
├── dashboard-view.ts   ← 仪表盘与图表
├── transaction-store.ts← Markdown 账目读写
└── ...
scripts/audit-ledger.mjs
tests/
manifest.json
versions.json
```

## 许可与来源

本项目基于 MIT License 的开源项目 **Easy Bookkeeping 3.0.0**（作者 Bei Mohai）衍生；原始版权声明与许可全文保留在 [LICENSE](LICENSE)。

个人风格化定制部分归 Personal Style Bookkeeping contributors。

## 状态

这是个人项目，尚未提交到 Obsidian 社区插件市场。安装前请自行备份 vault。
