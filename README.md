## Revision History

- **2026-07-29 11:10:00** — Desktop v0.1.2: the sidecar's stderr now goes to `<config dir>/sidecar-stderr.log` instead of vanishing into the GUI void, so engine failures are diagnosable; verified the portable layout under paths containing spaces.
- **2026-07-29 10:55:15** — Desktop v0.1.1: fixed sidecar spawn on portable installs — Tauri's `resource_dir()` returns a `\\?\`-prefixed verbatim path whose use as the child's working directory killed the sidecar instantly, and the previous fallback pointed at the compile-time build-machine path (os error 267). `sidecar_dir()` now resolves relative to the running exe (portable `sidecar/` folder, dev `../../../sidecar`, NSIS resource dir) with the UNC prefix stripped, and a spawn failure shows a native dialog naming the expected files instead of a console-only message.
- **2026-07-29 10:22:29** — Added the **Tauri 2.0 desktop edition**: the repo is now a modular project with `csv-core/` (shared vscode-free engine: streaming parser, byte-offset index, large-file logic, `DocumentSession`, NDJSON sidecar) and `csv-desktop/` (Tauri Rust shell + Node.js sidecar + the extension's webview frontend reused verbatim via an IPCAdapter shim). The VS Code extension at the repo root is completely untouched. Windows x64 builds (NSIS installer + portable zip, .csv/.tsv file association) are produced by the `desktop-release` GitHub Actions workflow on `desktop-v*` tags. Details in [Desktop Edition (Tauri)](#desktop-edition-tauri).
- **2026-07-29 09:07:55** — v1.15.0: added the optional **Byte Offset Index** cache layer on top of the (unchanged) chunk-streaming architecture. First opens stay pure streaming with zero extra disk writes; after the same large file is opened 3× (configurable) or via the new "Accelerate Repeated Opening" command, a background-built `.csvidx` (per-row 64-bit offsets, stored only in the extension's global storage, named by path hash) gives Paged View instant repeat opens. Reuse is guarded by size + mtime + content fingerprint; LRU cap (10) and 30-day stale cleanup run in the background. Details in [Local Modification: Byte Offset Index Cache](#local-modification-byte-offset-index-cache).
- **2026-07-29 08:45:06** — v1.14.0: added **Fast Open (chunk streaming)** — large files opened in full render the header + first 200 records instantly, then the Extension Host streams the remaining records in background batches (quote-aware parser, in-memory only, zero disk cache) which the grid appends silently; and **Column Global Search** — right-click a column header → "Search this column (whole file)…" streams the entire file testing only that column, destroys the stream after 1,000 matches, and shows the matches with their source row numbers. Details in [Local Modification: Fast Open & Column Global Search](#local-modification-fast-open--column-global-search).
- **2026-07-28 21:03:56** — Renamed the extension `name` from `csv-grid-editor` to `csv-grid-editor-plus` (display name "CSV Grid Editor Plus") because the Marketplace rejected the original name as already taken; badges updated to `okok909090.csv-grid-editor-plus`.
- **2026-07-28 20:47:26** — Re-published the fork under a new identity: `publisher` changed from `RobinReiche` to `okok909090`, `repository` / `homepage` / `bugs` URLs point to `github.com/qqqqqqqqq1122/csv-grid-editor`, Marketplace badges updated to the new publisher, and a full Chinese translation (中文版) appended at the bottom of this README. Original author attribution (LICENSE, sponsor, Contact section) kept per MIT.
- **2026-07-28 20:17:58** — Renamed the `largeFileMode` value `prompt` to `ask` (the "ask every time" option, i.e. the original interactive behavior), so the four user-settable values are now `ask` / `head` / `tail` / `all` with `ask` as the default. The legacy value `prompt` is still accepted and treated as `ask`.
- **2026-07-28 20:13:24** — Added configurable large-file mode: `csvGridEditor.largeFileMode` now accepts `prompt` / `head` / `tail` / `all`, `csvGridEditor.headRows` controls the preview row count, and a new Command Palette / right-click command `CSV Grid Editor: Set Large File Mode (head / tail / all)` switches modes at any time. Details in [Local Modification: Configurable Large File Mode](#local-modification-configurable-large-file-mode) at the bottom of this file.

# CSV Grid Editor

[![Version](https://badgen.net/vs-marketplace/v/okok909090.csv-grid-editor-plus)](https://marketplace.visualstudio.com/items?itemName=okok909090.csv-grid-editor-plus)
[![Installs](https://badgen.net/vs-marketplace/i/okok909090.csv-grid-editor-plus)](https://marketplace.visualstudio.com/items?itemName=okok909090.csv-grid-editor-plus)
[![Rating](https://badgen.net/vs-marketplace/rating/okok909090.csv-grid-editor-plus)](https://marketplace.visualstudio.com/items?itemName=okok909090.csv-grid-editor-plus&ssr=false#review-details)

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

## Local Modification: Fast Open & Column Global Search

*(Local fork change, 2026-07-29, v1.14.0 — not part of upstream.)*

### Fast Open (chunk streaming)

Opening a large file (> 10 MB) in full (`all` mode, or "Open Full File" in `ask`
mode) no longer waits for the whole file to load:

1. **First screen in milliseconds** — `openCustomDocument` reads only the
   header + first 200 records (quote-aware, so quoted newlines can't shift the
   boundary) and the grid renders them immediately.
2. **Background chunk streaming** — the Extension Host then streams the rest of
   the file in ~4 MB read chunks through the same quote-aware state machine as
   the webview parser, posting batches (5,000 rows or ~4 MB, whichever first)
   with an event-loop yield between batches. Everything is in-memory: **no
   `.idx` or any other disk cache file is ever created** (asserted by test).
3. **Silent append** — the webview appends each batch to `state.data` and to AG
   Grid via `applyTransaction({ add })`, so the full dataset materialises
   without a re-parse or a scroll jump. The status bar shows `Loading… N rows`
   until `streamDone`.

Safety rails while the stream is in flight: cell editing, paste, clear-cells
and replace are disabled, `edit` messages and external-change reloads are
ignored, and `Ctrl+S` is refused with a warning — so a partially loaded file
can never be written back. When the pump finishes, the accumulated raw chunk
text becomes `document.content` (byte-identical to the file, covered by test),
editing unlocks, and save/revert behave exactly like a normal full open. Two
trade-offs: the delimiter can't be switched on streamed documents
(`state.rawCsvText` only ever holds the first screen), and column type
detection is computed from the first screen.

### Column Global Search (stream + early truncation)

Right-click a column header → **Search this column (whole file)…**, type a
keyword, and the Extension Host streams the **entire** file — including rows
the grid doesn't hold (head/tail previews, mid-stream state) — testing only
that column with a case-insensitive contains match. The moment **1,000**
matches have accumulated the loop breaks and `stream.destroy()` stops all
further disk reads. The matched rows land in the grid with their **source file
row numbers** in the `#` gutter, and a banner announces e.g. *"Column "city"
contains "york" — showing first 1,000 matches (scanned 1,042 rows)"* with
**Show all rows** restoring the untouched view. Mutations are disabled while
the result view is up (its rows alias file positions, not `state.data`
positions); a newer search or closing the panel invalidates an in-flight one
via a generation counter.

### Files changed

| File | Change |
|---|---|
| `G:\csv-grid-editor-master\csv-grid-editor-master\src\csvStream.ts` | **New.** vscode-free streaming engine: `RecordSplitter` (incremental quote-aware splitter, record boundaries tracked), `streamCsvRecords()` (async generator; destroying it destroys the read stream), `readFirstRecords()` (first N records + text cut at the exact record boundary), `searchColumnStream()` (single-column scan, early truncation at `COLUMN_SEARCH_LIMIT = 1000`). |
| `G:\csv-grid-editor-master\csv-grid-editor-master\src\csvEditorProvider.ts` | Large full opens read only the first screen (`readFirstRecords`) and mark the doc `isStreaming`; on webview `ready`, `pumpStream()` streams the remaining records as `appendRows` batches, accumulates the raw text into `document.content`, then sends `streamDone`. New `columnSearch` message handler (`runColumnSearch`, generation-guarded). Guards: `edit` ignored and save refused while streaming; file watcher skips reloads mid-stream; `dispose` cancels the pump and searches. |
| `G:\csv-grid-editor-master\csv-grid-editor-master\src\webview.ts` | New HTML: `col-ctx-search` item in the column-header context menu, `colsearch-popover` (keyword input), `colsearch-banner` (result summary + Show all / Dismiss). Reuses existing `goto-popover` / `dup-banner` styles — no CSS changes needed. |
| `G:\csv-grid-editor-master\csv-grid-editor-master\src\webview\messaging.ts` | Handles `appendRows` (push to `state.data` + `applyTransaction({add})`, suppressed from the grid while the search view is up), `streamDone` / `streamError`, `columnSearchResults`; `init` accepts `streaming: true` and sets `streamingActive` / `streamingDoc`. |
| `G:\csv-grid-editor-master\csv-grid-editor-master\src\webview\features\column-search.ts` | **New.** Context-menu wiring, search popover, result rendering (matched rows keyed by source row number), banner, and restore via `refreshGrid()`. |
| `G:\csv-grid-editor-master\csv-grid-editor-master\src\webview\state.ts` | New flags `streamingActive` / `streamingDoc` / `columnSearchActive` and the shared `isGridEditable()` predicate. |
| `G:\csv-grid-editor-master\csv-grid-editor-master\src\webview\grid\builder.ts` | `editable` is now a callback (`() => isGridEditable()`) so editability follows streaming/search state without a rebuild. |
| `G:\csv-grid-editor-master\csv-grid-editor-master\src\webview\features\delimiter.ts` / `paste.ts` / `find-replace.ts` / `range-select.ts` / `delete-row-col.ts` / `popups.ts` / `index.ts` | Mutation guards while streaming or in the search-result view; delimiter re-parse disabled for streamed docs; popover registered; feature wired up. |
| `G:\csv-grid-editor-master\csv-grid-editor-master\test\step020-csv-stream.test.cjs` | **New test.** Parser parity with the webview's `parseCsv` (quotes, embedded newlines, CRLF, unicode, a quoted field spanning the 4 MB chunk boundary), first-screen boundary exactness, search targeting/truncation/early stream destroy, the fast-open contract (first screen + pump = full file, byte-for-byte), and zero disk residue. |

### Verification

`npx tsc -p ./` compiles cleanly, `npm run bundle` rebuilds the webview bundle,
and `npm test` passes all 8 test files (6 pre-existing + `step010` + `step020`).

---

---

## Local Modification: Byte Offset Index Cache

*(Local fork change, 2026-07-29, v1.15.0 — not part of upstream.)*

An **optional** index layer on top of the chunk-streaming architecture — the
streaming, background parsing and virtual-append logic are completely
untouched, and every index consumer falls back to streaming when no valid
index exists.

### Behaviour

- **First opens: zero extra disk writes.** Opening any CSV uses the existing
  streaming flow only — no index is created on open #1 (or #2).
- **Automatic background build** once the same file has been opened
  `openThreshold` times (default **3**, persisted across sessions), or
  **manually** at any time via the command `CSV Grid Editor: Accelerate
  Repeated Opening (Build Byte Offset Index)` (Command Palette, or right-click
  in a CSV editor). Building never blocks opening, first render or input.
- **Index contents**: the byte offset of every record start (64-bit,
  quote-aware scan — embedded newlines in cells never shift offsets) plus the
  file's size, mtime and a content fingerprint (sha1 of size + first/last
  64 KB).
- **Reuse / invalidation**: an index is reused only when size **and** mtime
  match (plus fingerprint when `verifyFingerprint` is on). Any change → the
  old index is ignored and rebuilt in the background.
- **Random access**: Paged View (> 50 MB) loads its page offsets from the
  index, so repeat opens skip the full-file scan entirely. Without an index it
  uses the original scan — identical behaviour.
- **Storage**: all `.csvidx` files live in the extension's global storage
  directory (`globalStorageUri/byte-offset-index/`), named
  `sha1(absolute file path).csvidx` — **never next to your CSVs**, so no Git
  pollution and no hidden files in data directories.

### Cache management (LRU)

- At most **10** index files are kept (configurable) — least recently used are
  evicted; every use bumps the recency stamp.
- Indexes unused for **30 days** (configurable) are deleted even under the cap.
- Cleanup runs in the background on activation and after each build.

### Settings

| Setting | Default | Effect |
|---|---|---|
| `csvGridEditor.byteOffsetIndex.enabled` | `true` | Master switch for the whole index layer |
| `csvGridEditor.byteOffsetIndex.autoGenerate` | `true` | Build automatically at the repeat-open threshold |
| `csvGridEditor.byteOffsetIndex.openThreshold` | `3` | Opens of the same file before auto-build |
| `csvGridEditor.byteOffsetIndex.allowManualBuild` | `true` | Allow the manual build command |
| `csvGridEditor.byteOffsetIndex.maxEntries` | `10` | LRU cap on cached indexes |
| `csvGridEditor.byteOffsetIndex.maxAgeDays` | `30` | Delete indexes unused for this long |
| `csvGridEditor.byteOffsetIndex.autoClean` | `true` | Prune on startup and after builds |
| `csvGridEditor.byteOffsetIndex.verifyFingerprint` | `true` | Extra content check before reusing an index |

### Files changed

| File | Change |
|---|---|
| `G:\csv-grid-editor-master\csv-grid-editor-master\src\byteOffsetIndex.ts` | **New.** vscode-free index engine: byte-level quote-aware `buildIndexOffsets()` (64-bit record offsets, handles escaped quotes across 4 MB chunk boundaries), binary `writeIndex()` / validating `readIndex()` (size + mtime + fingerprint), cheap `computeFingerprint()`, and the LRU registry (`touchIndex` / `pruneIndexes`). Write-then-rename so a crash never leaves a truncated index. |
| `G:\csv-grid-editor-master\csv-grid-editor-master\src\csvEditorProvider.ts` | New `RowPager` abstraction unifies the legacy scan-built page index and the index-backed per-record offsets — Paged View code paths are otherwise unchanged. `createPager()` prefers a valid index, falls back to the existing scan. `maybeBuildIndexOnRepeatOpen()` counts opens in `globalState` and builds in the background at the threshold (deduped, best-effort). New public `buildIndexForUri()` for the manual command. |
| `G:\csv-grid-editor-master\csv-grid-editor-master\src\extension.ts` | Registers `csvGridEditor.buildByteOffsetIndex` and runs `pruneIndexes` in the background on activation. |
| `G:\csv-grid-editor-master\csv-grid-editor-master\package.json` | New command (+ editor context-menu entry) and the 8 `byteOffsetIndex.*` settings. |
| `G:\csv-grid-editor-master\csv-grid-editor-master\test\step030-byte-offset-index.test.cjs` | **New test.** Offset correctness vs the webview parser (quotes, CRLF, unicode), roundtrip reuse, staleness on size/mtime/fingerprint, garbage tolerance, LRU eviction, age cleanup, orphan handling, and proof the user's data dir never gains a file. |

### Verification

`npx tsc -p ./` compiles cleanly and `npm test` passes all 9 test files
(6 pre-existing + `step010` + `step020` + `step030`).

---

---

## Desktop Edition (Tauri)

*(Local fork addition, 2026-07-29 — a standalone desktop app for users without VS Code. The VS Code extension at the repo root is completely untouched.)*

### Architecture

```
repo root (= the VS Code extension, unchanged)
├── csv-core/         shared Node.js/TypeScript engine — the SAME logic the extension uses
│   ├── src/csvStream.ts  byteOffsetIndex.ts  largeFileMode.ts   (copied verbatim)
│   ├── src/documentSession.ts   vscode-free port of the extension's provider
│   └── src/sidecarMain.ts       NDJSON (stdin/stdout) sidecar protocol
└── csv-desktop/      Tauri 2.0 desktop shell
    ├── index.html  theme.css    frontend shell + IPCAdapter shim
    ├── build-frontend.mjs       bundles the extension's src/webview UNCHANGED
    ├── build-sidecar.mjs        bundles csv-core → sidecar/main.js + node.exe
    └── src-tauri/               Rust: window, sidecar process, file association,
                                 theme, recent files, native dialogs
```

**Core principle: no rewrites.** The CSV engine (fast-open streaming, column
search, byte-offset index + LRU) runs as a Node.js sidecar process — byte-for-byte
the same code as the extension. The AG Grid frontend is bundled from the
extension's unmodified `src/webview` source; the desktop only provides a thin
`vscodeApi` shim (`postMessage` → Tauri events → sidecar stdin, and back).

The Rust layer is intentionally minimal: it spawns `node.exe sidecar/main.js`,
bridges newline-delimited JSON between the webview and the sidecar, and adds
native desktop features — .csv/.tsv file association and double-click launch,
Follow-System / Dark / Light theme (live OS theme events, persisted choice),
Recent Files menu, native open/save dialogs, and `config.json` persistence.
Sidecar index cache and open-count bookkeeping live under
`%APPDATA%\csv-grid-editor-plus\`.

### Build & verify

```bash
cd csv-core     && npm install && npm test          # 4 test files (incl. sidecar E2E)
cd csv-desktop  && npm install && node build-frontend.mjs && node build-sidecar.mjs
cd csv-desktop/src-tauri && cargo check
cd csv-desktop  && npx tauri build                  # NSIS installer + exe
```

### Packaging

- **NSIS installer** (per-user, registers .csv/.tsv association) and a
  **portable zip** (exe + sidecar folder) are built by
  `.github/workflows/desktop-release.yml` on `desktop-v*` tags and attached to
  GitHub Releases.
- Size reality check: the bundled Node runtime dominates — installer ≈ 40 MB,
  portable ≈ 100 MB. (The 15–25 MB goal is only reachable without bundling
  Node; rejected in favour of zero-prerequisite installs.)

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

---

## 本地修改：极致秒开 + 按列全局搜索

*（本 fork 新增，2026-07-29，v1.14.0。）*

### 极致秒开（分块流式加载）

以完整模式打开大于 10 MB 的文件（`all` 模式，或 `ask` 模式下选"Open Full File"）不再需要等待全量加载：

1. **首屏毫秒级渲染**——只读取表头 + 前 200 条记录（引号感知解析，单元格内的换行不会打乱边界）立即渲染。
2. **后台分块流式加载**——Extension Host 以约 4 MB 为一块流式读取剩余内容，用与 Webview 端完全一致的引号感知状态机解析，按批（5,000 行或约 4 MB，先到先发）推送给前端，批间让出事件循环。**全程内存流，绝不生成 .idx 等任何磁盘缓存文件**（有测试断言）。
3. **静默追加**——Webview 把每批数据追加到 `state.data` 并通过 `applyTransaction({ add })` 更新 AG Grid，状态栏显示 `Loading… N rows`，全量数据零感知加载完成。

流式加载期间的安全护栏：单元格编辑、粘贴、清空单元格、替换全部禁用；`edit` 消息和外部变更重载被忽略；`Ctrl+S` 会被拒绝并提示——绝不会把未加载完的文件写回磁盘。泵送完成后，累积的原始文本成为 `document.content`（与原文件逐字节一致，有测试覆盖），编辑解锁，保存/还原与普通的完整打开完全一致。两个取舍：流式文档不能切换分隔符（`rawCsvText` 只保存首屏文本）；列类型检测基于首屏数据。

### 按列全局搜索（流式 + 早期截断）

右键列头 → **Search this column (whole file)…**，输入关键词后，Extension Host 流式扫描**整个文件**——包括网格当前没有持有的行（head/tail 预览、流式加载中途）——只检测目标列（大小写不敏感的包含匹配）。匹配累积到 **1,000** 条的瞬间立即中断循环、`stream.destroy()` 销毁文件流，不再读取后续磁盘内容。匹配行带回网格展示，`#` 行号列显示**源文件行号**，横幅提示如 *"Column "city" contains "york" — showing first 1,000 matches (scanned 1,042 rows)"*，点 **Show all rows** 恢复原视图。结果视图下所有变更操作禁用（这些行的编号是文件位置而非 `state.data` 位置）；发起新搜索或关闭面板会使进行中的搜索失效（代际计数器）。

### 改动文件

| 文件 | 改动 |
|---|---|
| `src/csvStream.ts` | 新增。无 vscode 依赖的流式引擎：`RecordSplitter`（增量引号感知切分，记录边界追踪）、`streamCsvRecords()`（异步生成器，销毁即销毁文件流）、`readFirstRecords()`（前 N 条 + 在精确记录边界截断的文本）、`searchColumnStream()`（单列扫描，1,000 条早期截断） |
| `src/csvEditorProvider.ts` | 大文件完整打开只读首屏；`ready` 后 `pumpStream()` 分批推送 `appendRows`、累积原文、结束发 `streamDone`；新增 `columnSearch` 消息处理；流式期间忽略 `edit`、拒绝保存、跳过外部重载；`dispose` 取消泵送和搜索 |
| `src/webview.ts` | 新增 HTML：列头右键菜单项、搜索弹窗、结果横幅（复用现有样式，无 CSS 改动） |
| `src/webview/messaging.ts` | 处理 `appendRows` / `streamDone` / `streamError` / `columnSearchResults`；`init` 支持 `streaming` 标记 |
| `src/webview/features/column-search.ts` | 新增。搜索 UI 接线、结果渲染（按源文件行号）、横幅与恢复 |
| `src/webview/state.ts` / `grid/builder.ts` | 新增状态标志与 `isGridEditable()`；`editable` 改为回调函数 |
| 其余 webview features | 流式/搜索期间的变更守卫；流式文档禁用分隔符切换 |
| `test/step020-csv-stream.test.cjs` | 新增测试：与 Webview 解析器逐字节一致（含跨 4 MB 块边界的引号字段）、首屏边界精确、搜索定向/截断/提前销流、秒开契约（首屏+泵送=完整文件）、零磁盘残留 |

### 验证

`npx tsc -p ./` 编译无错误，`npm run bundle` 重新打包 webview，`npm test` 全部 8 个测试文件通过。

---

## 本地修改：Byte Offset Index 字节偏移索引缓存

*（本 fork 新增，2026-07-29，v1.15.0。）*

在 chunk streaming 架构**完全不变**的前提下叠加的可选索引层——流式读取、后台解析、Virtual Append 逻辑零改动；索引不存在或失效时，所有消费方自动回退到现有流式流程。

### 行为

- **首次打开零额外磁盘写入**：打开任何 CSV 都走现有流式流程，第 1、2 次打开不生成任何索引。
- **后台静默生成**：同一文件打开次数达到阈值（默认 **3** 次，跨会话计数）后自动后台构建；也可随时手动触发——命令面板或 CSV 编辑器右键菜单里的 `CSV Grid Editor: Accelerate Repeated Opening (Build Byte Offset Index)`。构建全程异步，绝不阻塞打开、首屏渲染或用户交互。
- **索引内容**：每条记录起始位置的 64-bit 字节偏移（引号感知的字节级扫描，单元格内换行不会打乱偏移）+ 文件 size、mtime 和内容指纹（size + 首尾各 64KB 的 sha1）。
- **复用与废弃**：仅当 size **且** mtime 一致（开启 `verifyFingerprint` 时再加上指纹）才复用；任何不一致 → 自动废弃并在后台重建。
- **随机定位**：分页视图（>50MB）直接从索引加载页面偏移，重复打开**完全跳过全文件扫描**；无索引时走原有扫描，行为一致。
- **存放位置**：所有 `.csvidx` 统一放在扩展全局缓存目录（`globalStorageUri/byte-offset-index/`），以 `sha1(文件绝对路径).csvidx` 命名——**绝不写入用户源码/数据目录**，零 Git 污染、零隐藏文件。

### 缓存清理（LRU）

- 最多保留 **10** 个索引（可配置），超出时自动驱逐最久未使用的；每次访问更新最近使用时间。
- 超过 **30 天**（可配置）未使用的索引，即使未达数量上限也自动删除。
- 清理在扩展激活时和每次构建后后台异步执行。

### 设置项

| 设置 | 默认值 | 作用 |
|---|---|---|
| `csvGridEditor.byteOffsetIndex.enabled` | `true` | 索引层总开关 |
| `csvGridEditor.byteOffsetIndex.autoGenerate` | `true` | 达到重复打开阈值后自动构建 |
| `csvGridEditor.byteOffsetIndex.openThreshold` | `3` | 同一文件打开多少次后自动构建 |
| `csvGridEditor.byteOffsetIndex.allowManualBuild` | `true` | 允许手动构建命令 |
| `csvGridEditor.byteOffsetIndex.maxEntries` | `10` | LRU 缓存数量上限 |
| `csvGridEditor.byteOffsetIndex.maxAgeDays` | `30` | 超过该天数未使用自动删除 |
| `csvGridEditor.byteOffsetIndex.autoClean` | `true` | 启动时和构建后自动清理 |
| `csvGridEditor.byteOffsetIndex.verifyFingerprint` | `true` | 复用前额外校验内容指纹 |

### 改动文件

| 文件 | 改动 |
|---|---|
| `src/byteOffsetIndex.ts` | 新增。无 vscode 依赖的索引引擎：字节级引号感知 `buildIndexOffsets()`、二进制 `writeIndex()` / 校验型 `readIndex()`、廉价指纹 `computeFingerprint()`、LRU 注册表（`touchIndex` / `pruneIndexes`）；先写临时文件再 rename，崩溃不留半截索引 |
| `src/csvEditorProvider.ts` | 新增 `RowPager` 抽象统一"扫描分页索引"和"索引文件逐行偏移"两个来源，分页视图其余路径不变；`createPager()` 优先复用索引、回退现有扫描；`maybeBuildIndexOnRepeatOpen()` 在 globalState 计数并后台构建（去重、best-effort）；新增 `buildIndexForUri()` 供命令调用 |
| `src/extension.ts` | 注册 `csvGridEditor.buildByteOffsetIndex` 命令；激活时后台执行 `pruneIndexes` |
| `package.json` | 新增命令（含编辑器右键菜单入口）和 8 个 `byteOffsetIndex.*` 设置 |
| `test/step030-byte-offset-index.test.cjs` | 新增测试：偏移与 webview 解析器逐条校验（引号/CRLF/Unicode）、往返复用、size/mtime/指纹三种失效、垃圾索引容错、LRU 驱逐、过期清理、孤儿处理、用户目录零污染 |

### 验证

`npx tsc -p ./` 编译无错误，`npm test` 全部 9 个测试文件通过。

---

## 桌面版（Tauri 2.0）

*（本 fork 新增，2026-07-29 —— 面向不使用 VS Code 的用户的独立桌面应用。仓库根目录的 VS Code 插件完全未动。）*

### 架构

```
仓库根目录（= VS Code 插件，未改动）
├── csv-core/         共享 Node.js/TypeScript 引擎——与插件同源的核心逻辑
│   ├── src/csvStream.ts  byteOffsetIndex.ts  largeFileMode.ts   （原样复制）
│   ├── src/documentSession.ts   插件 provider 的 vscode-free 移植
│   └── src/sidecarMain.ts       NDJSON（stdin/stdout）sidecar 协议
└── csv-desktop/      Tauri 2.0 桌面壳
    ├── index.html  theme.css    前端外壳 + IPCAdapter shim
    ├── build-frontend.mjs       直接打包插件的 src/webview（不修改）
    ├── build-sidecar.mjs        打包 csv-core → sidecar/main.js + node.exe
    └── src-tauri/               Rust：窗口、sidecar 进程、文件关联、
                                 主题、最近文件、原生对话框
```

**核心原则：不重写。** CSV 引擎（秒开流式加载、按列搜索、字节偏移索引 + LRU）以 Node.js sidecar 子进程运行——与插件逐字节同源。AG Grid 前端由插件未修改的 `src/webview` 源码直接打包，桌面端只提供一层薄薄的 `vscodeApi` shim（`postMessage` → Tauri 事件 → sidecar stdin，反向同理）。

Rust 层刻意保持极简：spawn `node.exe sidecar/main.js`、在 webview 与 sidecar 之间桥接 NDJSON，其余只做原生桌面能力——.csv/.tsv 文件关联与双击启动、跟随系统/深色/浅色主题（监听系统主题实时切换、用户选择持久化）、最近文件菜单、原生打开/保存对话框、config.json 持久化。索引缓存与打开计数存放在 `%APPDATA%\csv-grid-editor-plus\`。

### 构建与验证

```bash
cd csv-core     && npm install && npm test          # 4 个测试文件（含 sidecar 端到端）
cd csv-desktop  && npm install && node build-frontend.mjs && node build-sidecar.mjs
cd csv-desktop/src-tauri && cargo check
cd csv-desktop  && npx tauri build                  # NSIS 安装包 + exe
```

### 打包

- **NSIS 安装包**（per-user 安装，注册 .csv/.tsv 文件关联）与**绿色便携 zip**（exe + sidecar 目录）由 `.github/workflows/desktop-release.yml` 在 `desktop-v*` 标签触发构建并发布到 GitHub Releases。
- 体积现实：捆绑的 Node 运行时占大头——安装包约 40 MB，便携版约 100 MB（15–25MB 只有不捆绑 Node 才能达到，已被否决，优先保证开箱即用）。
