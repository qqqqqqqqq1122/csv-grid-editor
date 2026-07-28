## Revision History

- **2026-07-28 20:47:26** — Re-published the fork under a new identity: `publisher` changed from `RobinReiche` to `okok909090`, `repository` / `homepage` / `bugs` URLs point to `github.com/qqqqqqqqq1122/csv-grid-editor`, Marketplace badges updated to the new publisher, and a full Chinese translation (中文版) appended at the bottom of this README. Original author attribution (LICENSE, sponsor, Contact section) kept per MIT.
- **2026-07-28 20:17:58** — Renamed the `largeFileMode` value `prompt` to `ask` (the "ask every time" option, i.e. the original interactive behavior), so the four user-settable values are now `ask` / `head` / `tail` / `all` with `ask` as the default. The legacy value `prompt` is still accepted and treated as `ask`.
- **2026-07-28 20:13:24** — Added configurable large-file mode: `csvGridEditor.largeFileMode` now accepts `prompt` / `head` / `tail` / `all`, `csvGridEditor.headRows` controls the preview row count, and a new Command Palette / right-click command `CSV Grid Editor: Set Large File Mode (head / tail / all)` switches modes at any time. Details in [Local Modification: Configurable Large File Mode](#local-modification-configurable-large-file-mode) at the bottom of this file.

# CSV Grid Editor

[![Version](https://badgen.net/vs-marketplace/v/okok909090.csv-grid-editor)](https://marketplace.visualstudio.com/items?itemName=okok909090.csv-grid-editor)
[![Installs](https://badgen.net/vs-marketplace/i/okok909090.csv-grid-editor)](https://marketplace.visualstudio.com/items?itemName=okok909090.csv-grid-editor)
[![Rating](https://badgen.net/vs-marketplace/rating/okok909090.csv-grid-editor)](https://marketplace.visualstudio.com/items?itemName=okok909090.csv-grid-editor&ssr=false#review-details)

A fast, feature-rich CSV/TSV editor for Visual Studio Code. Opens CSV files in a sortable, filterable, editable grid — right inside your editor, no external tools needed.

![CSV Grid Editor: open, view and edit CSV and TSV files in a grid inside VS Code](https://raw.githubusercontent.com/Robin-Reiche/csv-grid-editor/master/images/social-preview.png)

![CSV Grid Editor in action: opening a CSV as a grid and exploring it with the column profile panel](https://raw.githubusercontent.com/Robin-Reiche/csv-grid-editor/master/images/demo.gif)

---

## Contents

- [Why CSV Grid Editor](#why-csv-grid-editor)
- [Who it is for](#who-it-is-for)
- [Quick start](#quick-start)
- [Features](#features)
- [How it compares](#how-it-compares)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [FAQ](#faq)

---

## Why CSV Grid Editor

- Read messy CSVs without counting commas, every column lines up in a real grid
- Edit and save right in VS Code, no need to launch Excel or a separate app
- Copy any range straight into Excel or Google Sheets as tab-separated values
- Understand a column at a glance with built-in stats like median, null percent and distinct counts
- Stay fast on big files with head, tail and paged views for 50 MB and beyond

## Who it is for

- Data analysts eyeballing exports and query results
- Developers editing fixtures, seed data and test CSVs
- Anyone who opens a CSV and does not want to launch a spreadsheet app

## Quick start

1. Install **CSV Grid Editor** from the Marketplace
2. Open any `.csv` or `.tsv` file, it opens as a grid automatically
3. Double-click a cell to edit, then save with `Ctrl+S`

For files larger than 10 MB you get a quick menu to open the full file, preview the head or tail, browse in pages or open as plain text.

---

## Features

![CSV file shown as an editable grid in Visual Studio Code with column type badges and sort and filter controls](https://raw.githubusercontent.com/Robin-Reiche/csv-grid-editor/master/images/grid-view.png)

### Grid & Display
- **Interactive Grid** - Powered by AG Grid with alternating row colors and grid lines
- **Column Type Detection** - Each column header shows a type badge (Integer, Float, Text, Boolean, Date, DateTime, Time) inferred from the column's values. The type updates automatically whenever the data changes, whether from cell edits, find and replace or undo and redo.
- **Sort & Filter** - Click any column header to sort. Use the filter icon to search within a column. Active filters show in the toolbar with a one-click clear button.
- **Auto-Fit Columns** - Fit all columns to their content with one click. Double-click a resize handle to auto-fit a single column.
- **Column Resize** - Drag column borders to adjust width manually
- **Zoom** - Scale the whole grid from 60% to 200% with the toolbar buttons or keyboard shortcuts. The zoom level shows in the toolbar.
- **Theme Integration** - Automatically adapts to your VS Code color theme (dark or light)

![CSV Grid Editor toolbar with auto-fit, zoom, find and replace, export and column profile buttons](https://raw.githubusercontent.com/Robin-Reiche/csv-grid-editor/master/images/toolbar.png)

### Editing
- **Inline Editing** - Double-click any cell to edit its value inline. Changes are tracked and saved back to the file. Press `Enter` to commit and jump to the cell below in the same column, the same as Excel and Google Sheets, so you can type down a column quickly.
- **Insert & Delete rows and columns** - Right-click a row to insert above or below or to delete it, and right-click a column header to insert left or right or to delete. Select several rows (drag or `Shift`+click the `#` gutter) or several columns (`Shift`+click the headers) first to insert or delete that many at once, anchored to the selection edge, just like a spreadsheet.
- **Undo / Redo** - Full multi-step undo and redo stack (`Ctrl+Z` / `Ctrl+Y`)
- **Save / Save As** - Uses VS Code's native save mechanism and supports Save As to a new location

### Find & Replace
- **Find & Replace bar** (`Ctrl+F` / `Ctrl+H` / toolbar icon) - Always shows find and replace together in one bar
- **Search** - Matches are highlighted across all visible cells. A counter shows the current position (for example `3 / 47`).
- **Case-Sensitive Toggle** - Enable exact case matching with the `Aa` button
- **Navigation** - Jump between matches with the toolbar buttons, `Enter` (next) or `Shift+Enter` (previous)
- **Replace** - Replace the current match or all matches at once. Only the matched substring is replaced, leaving the rest of the cell value intact, and it integrates with the undo stack.

### Copy & Export
- **Cell Copy** - Click a cell to focus it, then `Ctrl+C` copies its full value to the clipboard
- **Range Selection** - Excel-style selection directly in the grid:
  - Click and drag to select a rectangular cell range
  - Click and drag the row-number (`#`) column to select whole rows
  - `Shift`+click a column header to select a whole column or a run of adjacent columns
  - Right-click a column header → **Select column** to select a whole column
  - `Shift+click` and `Shift`+arrow keys extend the selection, `Ctrl+A` selects everything
  - `Ctrl+C` copies the selection as tab-separated values (TSV) that paste straight into Excel or Google Sheets
  - Right-click → **Copy with header** to include the column headers in the copy
  - `Delete` / `Backspace` clears every cell in the selection
  - The status bar shows the selection size plus live `Count / Sum / Avg / Min / Max`
- **Export as JSON** - Convert the current filtered and sorted view to a JSON array of objects via the native VS Code save dialog. Column headers become the keys and numbers and booleans come out typed, while values that would lose information (IDs with leading zeros, very large numbers) stay strings. Columns you have hidden in the column chooser are left out, the same as copy.
- **Export as JSON Lines** - The same view as JSON Lines (NDJSON), one object per line, handy for streaming tools and data pipelines
- **Export as Markdown table** - The same view as a GitHub-flavored Markdown table, ready to paste into a README, issue or pull request

### Delimiter
- **Auto-Detection** - Automatically detects commas, semicolons and tabs on open. `.tsv` files always use tab.
- **Manual Override** - Click the delimiter badge in the toolbar to change the delimiter on the fly (comma `,`, semicolon `;`, tab, pipe `|`). The grid re-parses the file immediately.

### Column Freeze
- **Freeze / Unfreeze** - Right-click any column header to pin it to the left side of the grid, right-click again to unfreeze. `Shift`+click several headers first to **Freeze N columns** at once. Frozen columns show a 📌 marker before the column name.

### Row Freeze
- **Freeze / Unfreeze** - Right-click any row and choose **Freeze row** to pin it to the top of the grid as an always-visible reference while you scroll, sort and filter. Select several rows first (drag or `Shift`+click the `#` gutter) and choose **Freeze N rows** to pin them all at once, handy for multi-line headers. Freezing is additive and the rows stay in the order you froze them. Right-click a pinned row to **Unfreeze** just that one, or **Unfreeze all rows**. A 📌 marker on each pinned row shows its original row number, and pinned rows stay visible regardless of any active filter.

### Rename Columns
- **Rename** - Right-click a column header → **Rename column** to rename it. The new name is written to the CSV header row and is fully undoable.

### Show / Hide Columns
- **Column chooser** - Click the checklist icon in the toolbar to open a searchable list of all columns with checkboxes. Type to filter the list by column name, then uncheck a column to hide it or re-check to show it. The tri-state **Select all** checkbox at the top shows or hides every column at once. Under an active search it scopes to the matches and relabels to **Select all matches**, so you can uncheck it to hide everything, then search and re-check the few you want. Hidden columns are excluded from copy and export, so the output matches exactly what you see.

### Sort & Filter

![Browsing and sorting a CSV file in the CSV Grid Editor grid](https://raw.githubusercontent.com/Robin-Reiche/csv-grid-editor/master/images/demo-2.gif)

![Per-column filter panel open in CSV Grid Editor with active filters shown in the toolbar](https://raw.githubusercontent.com/Robin-Reiche/csv-grid-editor/master/images/filter-view.png)

Click any column header to sort ascending or descending. Use the filter icon in the column header to open a per-column filter panel, where you can search the values and tick or untick them with a tri-state **Select all** checkbox that relabels to **Select all matches** under an active search. Active filters are shown in the toolbar, click the **Filters** badge to clear them all at once.

### Column Profile
- Click the graph icon in the toolbar to open the **Column Profile** panel
- Shows an **overview table** across all columns: type, fill rate, null %, distinct value count and min/max summary
- Click any row in the overview table to jump to its detail card
- Each column gets a **detail card** with statistics based on its detected type:
  - **Integer / Float** - min, max, mean, median, standard deviation, unique count
  - **String** - min, max and average length, top 5 most frequent values with frequency bars
  - **Boolean** - true/false count and percentage, with a visual bar chart
  - **Date / DateTime** - earliest date, latest date, range in days
  - All types show total rows, unique count, null count and fill %
- **Dockable** - Dock the panel to the right (default), left or bottom of the grid
- **Resizable** - Drag the panel border to adjust its size
- **Zoom-aware** - Panel text and spacing scale with the grid's zoom level (60 to 200%)
- **Live Updates** - The panel re-renders automatically as the data changes, including cell edits, inserts, deletes, paste and undo

![Column Profile panel showing min, max, mean, median, null percent and distinct counts for a CSV column](https://raw.githubusercontent.com/Robin-Reiche/csv-grid-editor/master/images/column-profile.png)

### Theme Integration

The extension automatically adapts to your VS Code color theme, no configuration required.

| Dark Theme | Light Theme |
|:---:|:---:|
| ![CSV Grid Editor showing a CSV file in a dark VS Code theme](https://raw.githubusercontent.com/Robin-Reiche/csv-grid-editor/master/images/grid-view.png) | ![CSV Grid Editor showing a CSV file in a light VS Code theme](https://raw.githubusercontent.com/Robin-Reiche/csv-grid-editor/master/images/theme-light.png) |

### Large File Support
Opening a file larger than **10 MB** shows a Quick Pick with these options:

| Option | Description |
|--------|-------------|
| Open Full File | Load all data into the grid (may be slow for very large files) |
| Show Head | Preview the first 1,000 rows |
| Show Tail | Preview the last 1,000 rows |
| Open as Plain Text | Fast read-only raw text view |
| Paged View | Browse in 500-row pages *(only shown for files > 50 MB)* |

- **Head / Tail previews** show a banner with the total row count and how many rows are displayed
- **Paged View** - A pagination bar (first / previous / next / last) lets you navigate pages efficiently without loading the entire file into memory. Editing is disabled in this mode.
- **Plain Text View** - Displays the raw file content in a monospace editor-style view without any grid features

### Auto-Reload
When a file is open in full (non-preview) mode, the editor watches the file on disk and **automatically reloads** the grid when the file is modified externally.

---

## Supported File Types

| Extension | Default Delimiter |
|-----------|-------------------|
| `.csv` | Auto-detected (`,` `;` `\t`) |
| `.tsv` | Tab |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Ctrl+Shift+Z` | Redo (alternative) |
| `Ctrl+C` | Copy focused cell or selected range (TSV) |
| `Ctrl+A` | Select all cells |
| `Shift`+arrows | Extend the selection |
| `Delete` / `Backspace` | Clear the selected cells |
| `Ctrl++` / `Ctrl+=` | Zoom in |
| `Ctrl+-` | Zoom out |
| `Ctrl+F` / `Ctrl+H` | Open Find & Replace bar |
| `Enter` | Next match *(in Find bar)* |
| `Shift+Enter` | Previous match *(in Find bar)* |
| `Esc` | Close the open menu, dropdown, popup or Find bar |

> On macOS, `Ctrl` is replaced by `⌘`.

---

## How it compares

A quick honest look at the common ways people open CSV files in VS Code.

| Capability | Plain text view | Rainbow CSV | Edit csv | CSV Grid Editor |
|---|:---:|:---:|:---:|:---:|
| Opens as an interactive grid | no | no | yes | yes |
| Edit cells inline and save back | no | no | yes | yes |
| Sort and filter from the column header | no | query only | sort only | yes |
| Column profiling (median, null %, distinct) | no | no | basic stats | yes |
| Freeze rows and columns | no | header only | yes | yes |
| Large files (head, tail, paged 50 MB+) | raw text | workaround | no | yes |
| Excel-style range copy as TSV | no | no | not documented | yes |

> Checked June 2026 from each extension's Marketplace page, README and changelog. Rainbow CSV and Edit csv are both excellent tools, this table just shows where CSV Grid Editor puts its focus.

---

## FAQ

### How do I open a CSV file in VS Code?
Install CSV Grid Editor and open any `.csv` or `.tsv` file. It opens straight into the grid, no command or setup needed. If another editor is set as the default, right-click the file and choose **Open With** then **CSV Grid Editor**.

### How do I edit a CSV file in VS Code without Excel?
Double-click any cell to edit it inline, then save with `Ctrl+S`. Changes are written back to the file and you can undo with `Ctrl+Z`. You never have to leave the editor or open a spreadsheet app.

### Can I copy and paste between this grid and Excel or Google Sheets?
Yes. Select a range with click and drag, press `Ctrl+C`, and the cells are copied as tab-separated values that paste cleanly into Excel or Google Sheets. Right-click then **Copy with header** to include the column names.

### Does it work with semicolon, tab or pipe delimited files?
Yes. The delimiter is auto-detected on open (comma, semicolon, tab), and `.tsv` files always use tab. You can also switch the delimiter by hand from the toolbar to comma, semicolon, tab or pipe.

### Will it handle large CSV files?
Yes. Files over 10 MB show a quick menu to open the full file, preview just the head or tail, browse in pages or open as plain text. Paged view lets you move through very large files without loading everything into memory.

---

## ❤️ Support This Project

If CSV Grid Editor saves you time, you can support its continued development, completely optional and always appreciated:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Robin-Reiche)
[![Ko-fi](https://img.shields.io/badge/Buy%20me%20a%20coffee-Ko--fi-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/robinreiche)

---

## Contact

**Robin Reiche**

[![LinkedIn](https://img.shields.io/badge/LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/robin-reiche/)
[![Email](https://img.shields.io/badge/Email-EA4335?style=for-the-badge&logo=gmail&logoColor=white)](mailto:robin.reiche.dev@gmail.com)

---

## License

[MIT](LICENSE)

---

## Local Modification: Configurable Large File Mode

*(Local fork change, 2026-07-28 — not part of upstream v1.13.1.)*

Large CSV/TSV files (> 10 MB) no longer have to go through the interactive
open-mode picker every time. Two user settings control the behavior, and a
command switches the mode on the fly.

### Settings (User settings.json)

```json
"csvGridEditor.largeFileMode": "head",
"csvGridEditor.headRows": 1000
```

| Setting | Values | Default | Effect |
|---|---|---|---|
| `csvGridEditor.largeFileMode` | `ask`, `head`, `tail`, `all` | `ask` | `ask` = original behavior (picker on every large file); `head` = preview first N rows directly; `tail` = preview last N rows directly; `all` = load the full file directly |
| `csvGridEditor.headRows` | positive integer | `1000` | Number of rows used by `head`/`tail` previews (also shown in the picker labels) |

### Switching modes at any time

- **Command Palette** (`Ctrl+Shift+P`): `CSV Grid Editor: Set Large File Mode (head / tail / all)` — a quick pick lists Head / Tail / All / Ask (the current mode is check-marked). Choosing one writes the setting globally (`ConfigurationTarget.Global`).
- **Right-click**: the same command appears in the editor context menu when a `.csv` or `.tsv` file is active.
- After switching, if the active tab is a large file open in the grid, the command offers to **reopen it immediately** with the new mode; otherwise it applies the next time a large file is opened.

### Files changed

| File | Change |
|---|---|
| `G:\csv-grid-editor-master\csv-grid-editor-master\package.json` | `contributes.configuration`: `largeFileMode` enum extended from `["prompt", "head"]` to `["ask", "head", "tail", "all"]` (default `ask`, the original picker behavior) with `enumDescriptions`; `headRows` gained `minimum: 1` and an updated description. Added `contributes.commands` entry `csvGridEditor.setLargeFileMode` and a `contributes.menus.editor/context` entry (visible for `.csv`/`.tsv` resources) so it is reachable via both `Ctrl+Shift+P` and right-click. |
| `G:\csv-grid-editor-master\csv-grid-editor-master\src\largeFileMode.ts` | **New file.** Pure, vscode-free decision logic: `normalizeLargeFileMode()` (unknown values, incl. the legacy `prompt`, fall back to `ask`), `planForLargeFile(mode, fileSize, threshold)` (small files always `full`; `all` → `full`; `head`/`tail` → previews; `ask` → picker), `normalizeHeadRows()` (clamps to a positive integer, else default). |
| `G:\csv-grid-editor-master\csv-grid-editor-master\src\csvEditorProvider.ts` | `openCustomDocument()` now reads `csvGridEditor.largeFileMode` / `csvGridEditor.headRows` via `vscode.workspace.getConfiguration` and calls `planForLargeFile()`. Non-`ask` plans skip the QuickPick entirely and set `previewMode` directly; the existing head/tail/full loading branches are reused unchanged, with the hardcoded `PREVIEW_ROW_COUNT` replaced by the configured `headRows` (also in the picker labels). The picker/cancel path for `ask` mode is byte-for-byte the original logic. |
| `G:\csv-grid-editor-master\csv-grid-editor-master\src\extension.ts` | Registers the `csvGridEditor.setLargeFileMode` command: shows a QuickPick of the four modes (current one marked), updates `csvGridEditor.largeFileMode` in Global config, and — when the active tab is a large file open in `csvViewer.grid` — offers to close and reopen it via `vscode.openWith` so the new mode applies immediately. |
| `G:\csv-grid-editor-master\csv-grid-editor-master\test\step010-large-file-mode.test.cjs` | **New test.** Asserts the package.json contributions (enum values, `headRows` default, command + context-menu registration) and unit-tests `planForLargeFile` / `normalizeLargeFileMode` / `normalizeHeadRows` from the compiled `out/largeFileMode.js`. Picked up automatically by `test/run-all.cjs`. |

### Verification

`npx tsc -p ./` compiles cleanly and `npm test` passes all 7 test files
(6 pre-existing + `step010-large-file-mode.test.cjs`), confirming both the
manifest contributions and the head/tail/all/ask decision logic.

---

# CSV Grid Editor（中文版）

> 本项目 fork 自 [Robin-Reiche/csv-grid-editor](https://github.com/Robin-Reiche/csv-grid-editor)（MIT 许可证），由 okok909090 维护。本 fork 新增了「可配置大文件打开模式」，详见文末[本地修改说明](#本地修改可配置大文件打开模式)。

一个功能丰富的 CSV/TSV 编辑器：在 VS Code 内以可排序、可筛选、可编辑的网格打开 CSV 文件，无需任何外部工具。

## 目录

- [为什么选择它](#为什么选择它)
- [快速上手](#快速上手)
- [功能一览](#功能一览)
- [支持的文件类型](#支持的文件类型)
- [快捷键](#快捷键)
- [常见问题](#常见问题)
- [本地修改：可配置大文件打开模式](#本地修改可配置大文件打开模式)

## 为什么选择它

- 不用再数逗号——每一列都在真正的网格里对齐显示
- 直接在 VS Code 里编辑保存，不用启动 Excel 或其他软件
- 框选任意区域即可复制为制表符分隔文本，直接粘贴进 Excel / Google Sheets
- 内置列统计（中位数、空值率、去重计数），一眼看懂每一列
- 大文件有 head / tail / 分页视图，50 MB 以上也保持流畅

## 快速上手

1. 安装本扩展（VSIX 或 Marketplace）
2. 打开任意 `.csv` 或 `.tsv` 文件，会自动以网格形式打开
3. 双击单元格编辑，`Ctrl+S` 保存

大于 10 MB 的文件默认会弹出菜单：完整打开 / 预览头部 / 预览尾部 / 分页浏览 / 纯文本打开（此行为可通过设置更改，见文末）。

## 功能一览

### 网格与显示
- **交互式网格**：基于 AG Grid，隔行变色、带网格线
- **列类型检测**：每个列头显示类型徽章（整数、浮点、文本、布尔、日期、日期时间、时间），数据变动时自动更新
- **排序与筛选**：点击列头排序；列头筛选图标可按值筛选
- **自动列宽**：一键适配所有列；双击列边界适配单列
- **缩放**：整个网格 60%–200% 缩放
- **主题适配**：自动跟随 VS Code 深色/浅色主题

### 编辑
- **单元格内编辑**：双击编辑；按 `Enter` 提交并跳到同列下一行（同 Excel）
- **插入/删除行列**：右键行或列头操作；可先选中多行/多列批量插入删除
- **撤销/重做**：完整多步撤销栈（`Ctrl+Z` / `Ctrl+Y`）
- **保存/另存为**：使用 VS Code 原生保存机制

### 查找与替换
- `Ctrl+F` / `Ctrl+H` 打开查找替换栏，匹配高亮并显示 `3 / 47` 计数
- `Aa` 切换大小写敏感；`Enter` / `Shift+Enter` 跳转匹配
- 支持替换当前或全部，且并入撤销栈

### 复制与导出
- **Excel 式框选**：拖拽选区、拖行号选整行、`Shift`+点击列头选整列
- `Ctrl+C` 复制为 TSV，可直接粘贴进 Excel / Google Sheets；右键可复制带表头
- 状态栏实时显示选区的 Count / Sum / Avg / Min / Max
- **导出 JSON / JSON Lines / Markdown 表格**：按当前筛选排序后的视图导出

### 分隔符
- 打开时自动检测逗号、分号、制表符；`.tsv` 固定用制表符
- 工具栏分隔符徽章可手动切换（`,` `;` `\t` `|`），网格立即重新解析

### 冻结行/列、重命名、显示隐藏列
- 右键列头冻结/解冻列；`Shift`+多选可批量冻结
- 右键行可冻结行（多行表头很好用），冻结行在滚动、排序、筛选时保持可见
- 右键列头可重命名列（写回 CSV 表头，可撤销）
- 工具栏勾选列表可搜索并显示/隐藏列；隐藏的列不参与复制和导出

### 列分析（Column Profile）
- 工具栏图表图标打开分析面板：全列总览表（类型、填充率、空值率、去重数、min/max）
- 每列详情卡按类型给出统计：数值（均值/中位数/标准差）、文本（长度/top5 高频值）、布尔、日期
- 面板可停靠右/左/下，可拖宽，随网格缩放，数据变化实时刷新

### 大文件支持
打开大于 **10 MB** 的文件时可选：完整打开、预览前 N 行、预览后 N 行、纯文本打开；大于 50 MB 还有 500 行一页的**分页视图**（只读）。head/tail 预览会显示横幅注明总行数与当前显示行数。

### 自动重载
以完整（非预览）模式打开时，文件被外部修改会自动重新加载网格。

## 支持的文件类型

| 扩展名 | 默认分隔符 |
|--------|-----------|
| `.csv` | 自动检测（`,` `;` `\t`） |
| `.tsv` | 制表符 |

## 快捷键

| 快捷键 | 作用 |
|----------|--------|
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Ctrl+C` | 复制选中单元格或选区（TSV） |
| `Ctrl+A` | 全选 |
| `Shift`+方向键 | 扩展选区 |
| `Delete` / `Backspace` | 清空选中单元格 |
| `Ctrl++` / `Ctrl+-` | 放大 / 缩小 |
| `Ctrl+F` / `Ctrl+H` | 查找替换栏 |
| `Enter` / `Shift+Enter` | 下一个 / 上一个匹配 |
| `Esc` | 关闭菜单/弹窗/查找栏 |

> macOS 上 `Ctrl` 对应 `⌘`。

## 常见问题

### 如何在 VS Code 里打开 CSV？
安装后打开任意 `.csv` / `.tsv` 即自动进入网格视图。若被其他编辑器占用默认，右键文件 → **打开方式** → **CSV Grid Editor**。

### 不用 Excel 能编辑 CSV 吗？
双击单元格直接改，`Ctrl+S` 写回文件，`Ctrl+Z` 可撤销。

### 能和 Excel / Google Sheets 互相复制粘贴吗？
可以。框选后 `Ctrl+C` 复制为制表符分隔文本，可直接粘贴；右键可复制带表头。

### 分号/制表符/竖线分隔的文件支持吗？
支持。打开时自动检测，也可在工具栏手动切换。

### 大文件能打开吗？
可以。超过 10 MB 可选完整打开、head/tail 预览、分页浏览或纯文本；超过 50 MB 的分页视图不会把整个文件读入内存。

---

## 本地修改：可配置大文件打开模式

*（本 fork 新增，2026-07-28，不属于上游 v1.13.1。）*

大于 10 MB 的 CSV/TSV 文件不再必须每次弹窗询问。两个用户设置控制行为，另有一条命令可随时切换。

### 设置项（用户 settings.json）

```json
"csvGridEditor.largeFileMode": "head",
"csvGridEditor.headRows": 1000
```

| 设置 | 可选值 | 默认值 | 效果 |
|---|---|---|---|
| `csvGridEditor.largeFileMode` | `ask`、`head`、`tail`、`all` | `ask` | `ask` = 原始行为（每次弹窗询问）；`head` = 直接预览前 N 行；`tail` = 直接预览后 N 行；`all` = 直接完整加载 |
| `csvGridEditor.headRows` | 正整数 | `1000` | head/tail 预览的行数（弹窗选项文案里也用它） |

### 随时切换模式

- **命令面板**（`Ctrl+Shift+P`）：`CSV Grid Editor: Set Large File Mode (head / tail / all)` — 列出 Head / Tail / All / Ask 四项（当前项打勾），选择后写入全局设置。
- **右键菜单**：编辑器中打开 `.csv` / `.tsv` 时，右键菜单里也有这条命令。
- 切换后若当前标签页正开着大文件，会询问是否立即以新模式重新打开；否则下次打开大文件时生效。

### 改动文件

| 文件 | 改动 |
|---|---|
| `package.json` | `largeFileMode` 枚举扩展为 `["ask", "head", "tail", "all"]`（默认 `ask`）并附说明；`headRows` 加 `minimum: 1`；新增 `csvGridEditor.setLargeFileMode` 命令及编辑器右键菜单入口 |
| `src/largeFileMode.ts` | 新增。纯逻辑：`normalizeLargeFileMode()`（非法值回落 `ask`）、`planForLargeFile()`、`normalizeHeadRows()` |
| `src/csvEditorProvider.ts` | 打开大文件时读取上述配置；非 `ask` 模式跳过弹窗直接打开；预览行数改用 `headRows` |
| `src/extension.ts` | 注册切换模式命令：快速选择四项、写入全局配置、可选择立即重开当前大文件 |
| `test/step010-large-file-mode.test.cjs` | 新增测试：校验 package.json 贡献项与决策逻辑 |

### 验证

`npx tsc -p ./` 编译无错误，`npm test` 全部 7 个测试文件通过。

---

## 许可证

[MIT](LICENSE) — 原作者 Robin Reiche 的版权声明保留于 LICENSE 文件中。
