// Header copying.
//
// The CSV header row lives in AG Grid's column headers, not in the data cells,
// so it cannot be selected or copied like a normal row. Two paths are provided:
//
//   1. Click a column header (which still sorts, as before), then press Ctrl+C —
//      the clicked header's name is copied. A focus ring on the header shows the
//      copy target. Clicking a data cell clears the header focus, so normal cell
//      and range copying is unchanged.
//   2. The column context menu also offers "复制列名" (this column) and
//      "复制全部表头" (every visible header, tab-separated).

import { state } from '../state';
import { tsvCell } from '../utils/csv';

let focusedHeaderColId: string | null = null;

function writeClipboard(text: string): void {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => execCopy(text));
    } else {
        execCopy(text);
    }
}

function execCopy(text: string): void {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    } catch { /* ignore */ }
}

function headerText(colIndex: number): string {
    return String(state.data?.[0]?.[colIndex] ?? '');
}

function headerColIndex(colId: string | null | undefined): number {
    if (!colId || !colId.startsWith('col_')) return -1;
    const i = parseInt(colId.slice(4), 10);
    return isNaN(i) ? -1 : i;
}

// Visible data columns in display order — hidden and moved columns behave the
// same as they do for Copy/Export.
function visibleColIndexes(): number[] {
    if (!state.gridApi) return [];
    return (state.gridApi.getAllDisplayedColumns() as any[])
        .map(c => String(c.getColId()))
        .filter(id => id.startsWith('col_'))
        .map(id => parseInt(id.slice(4), 10))
        .filter(i => !isNaN(i));
}

function copyColumnName(colId: string | null | undefined): void {
    const colIndex = headerColIndex(colId);
    if (colIndex < 0) return;
    writeClipboard(tsvCell(headerText(colIndex)));
}

function copyAllHeaders(): void {
    const cols = visibleColIndexes();
    if (cols.length === 0) return;
    writeClipboard(cols.map(i => tsvCell(headerText(i))).join('\t'));
}

// ── header focus (click a header, then Ctrl+C) ────────────────────────────────

function clearHeaderFocus(): void {
    focusedHeaderColId = null;
    document.querySelectorAll('.header-copy-focus')
        .forEach(el => el.classList.remove('header-copy-focus'));
}

function focusHeader(colId: string, headerCell: HTMLElement): void {
    document.querySelectorAll('.header-copy-focus')
        .forEach(el => { if (el !== headerCell) el.classList.remove('header-copy-focus'); });
    focusedHeaderColId = colId;
    headerCell.classList.add('header-copy-focus');
}

function isTypingTarget(t: EventTarget | null): boolean {
    if (t instanceof HTMLElement) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) return true;
    }
    return false;
}

// ── menu items ────────────────────────────────────────────────────────────────

function makeItem(id: string, label: string): HTMLDivElement {
    const item = document.createElement('div');
    item.id = id;
    item.className = 'col-ctx-item';
    const icon = document.createElement('i');
    icon.className = 'codicon codicon-copy';
    const span = document.createElement('span');
    span.className = 'col-ctx-label';
    span.textContent = label;
    item.append(icon, span);
    return item;
}

export function setupHeaderCopy(): void {
    const menu = document.getElementById('col-context-menu');
    const searchItem = document.getElementById('col-ctx-search');
    if (!menu || !searchItem) return;

    // Click / focus tracking. Capture phase; never preventDefault, so AG Grid's
    // normal header sort click still runs.
    document.addEventListener('mousedown', (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        const headerCell = target.closest<HTMLElement>('.ag-header-cell[col-id]');
        if (headerCell) {
            const colId = headerCell.getAttribute('col-id');
            // Shift+click selects whole columns — keep its Ctrl+C data-copy
            // behaviour by leaving the header focus off. The '#' gutter is not
            // a data header.
            if (colId && colId.startsWith('col_') && !e.shiftKey) {
                focusHeader(colId, headerCell);
            } else {
                clearHeaderFocus();
            }
            return;
        }
        if (target.closest('.ag-cell')) clearHeaderFocus();
    }, true);

    // Ctrl+C with a focused header: copy the header name and stop the cell-copy
    // handlers from also firing. Registered before setupRangeSelect() (see
    // index.ts), whose document-capture handler would otherwise win.
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (state.isCellEditing || isTypingTarget(e.target)) return;
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c') return;
        if (!focusedHeaderColId) return;
        // A grid rebuild (insert/delete column, paging, …) replaces the header
        // cells. Drop the stale focus instead of copying the wrong column.
        const focusedCell = document.querySelector(
            `.ag-header-cell.header-copy-focus[col-id="${focusedHeaderColId}"]`);
        if (!focusedCell) { clearHeaderFocus(); return; }
        e.preventDefault();
        e.stopImmediatePropagation();
        copyColumnName(focusedHeaderColId);
    }, true);

    // Context-menu actions (menu is static; inject once).
    if (document.getElementById('col-ctx-copy-name')) return;

    const copyName = makeItem('col-ctx-copy-name', '复制列名');
    const copyAll = makeItem('col-ctx-copy-all', '复制全部表头');
    const sep = document.createElement('div');
    sep.className = 'col-ctx-separator';

    // Sits between "Select column" and "Search this column": select → copy → search.
    searchItem.before(copyName, copyAll, sep);

    copyName.addEventListener('click', () => {
        menu.classList.add('hidden');
        copyColumnName(menu.dataset.colId);
    });
    copyAll.addEventListener('click', () => {
        menu.classList.add('hidden');
        copyAllHeaders();
    });
}
