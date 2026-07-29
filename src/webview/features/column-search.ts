import { state, getNumCols } from '../state';
import { refreshGrid } from '../grid/refresh';
import { closeAllPopups } from './popups';

// Column global search (see csvStream.ts on the Extension Host side).
// The user right-clicks a column header → "Search this column…", enters a
// keyword, and the Extension Host streams the WHOLE file (quote-aware, so
// embedded commas/newlines in cells parse correctly), collecting at most
// 1,000 matches before destroying the read stream. The matched rows are shown
// in the grid with their original file row numbers; "Show all rows" restores
// the normal view from state.data (which is untouched by the search).

let targetColIndex = -1;

function openSearchPopover(colIndex: number, anchor: DOMRect | null): void {
    targetColIndex = colIndex;
    const popover = document.getElementById('colsearch-popover') as HTMLElement | null;
    const label   = document.getElementById('colsearch-label');
    const input   = document.getElementById('colsearch-input') as HTMLInputElement | null;
    if (!popover || !input) return;

    const colName = state.data[0]?.[colIndex] ?? `Column ${colIndex + 1}`;
    if (label) label.textContent = `Search column "${colName}" (whole file)`;

    input.value = '';
    closeAllPopups('colsearch-popover');
    popover.classList.remove('hidden');
    if (anchor) {
        const pw = popover.offsetWidth || 260;
        popover.style.left = Math.max(4, Math.min(anchor.left, window.innerWidth - pw - 4)) + 'px';
        popover.style.top  = (anchor.bottom + 4) + 'px';
    }
    setTimeout(() => input.focus(), 0);
}

function submitSearch(): void {
    const input = document.getElementById('colsearch-input') as HTMLInputElement | null;
    const query = input?.value ?? '';
    document.getElementById('colsearch-popover')?.classList.add('hidden');
    if (!query || targetColIndex < 0) return;

    const colName = state.data[0]?.[targetColIndex] ?? `Column ${targetColIndex + 1}`;
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = `Searching column "${colName}" for "${query}"…`;

    vscodeApi.postMessage({
        type: 'columnSearch',
        colIndex: targetColIndex,
        colName,
        query
    });
}

export function handleColumnSearchResults(msg: any): void {
    const statusEl = document.getElementById('status');
    if (msg.error) {
        if (statusEl) statusEl.textContent = 'Column search failed: ' + msg.error;
        return;
    }

    const rows        = msg.rows as string[][];
    const origIndexes = msg.origIndexes as number[];
    const numCols     = getNumCols(state.data);

    // Swap the grid onto the match set. _origIndex carries the 1-based source
    // file row number, so the '#' gutter shows where each match lives in the
    // file. state.data is NOT touched — dismiss restores via refreshGrid().
    const rowData = rows.map((row, i) => {
        const obj: Record<string, string | number> = { _origIndex: origIndexes[i] };
        for (let c = 0; c < numCols; c++) obj['col_' + c] = row[c] ?? '';
        return obj;
    });

    state.columnSearchActive = true;
    if (state.gridApi) {
        state.gridApi.setGridOption('pinnedTopRowData', []); // frozen refs belong to the full view
        state.gridApi.setGridOption('rowData', rowData);
    }

    const limit = Number(msg.limit) || 1000;
    const banner = document.getElementById('colsearch-banner');
    const text   = document.getElementById('colsearch-banner-text');
    if (text) {
        text.textContent = msg.truncated
            ? `Column "${msg.colName}" contains "${msg.query}" — showing first ${limit.toLocaleString()} matches (scanned ${Number(msg.scanned).toLocaleString()} rows)`
            : `Column "${msg.colName}" contains "${msg.query}" — ${rows.length.toLocaleString()} matches`;
    }
    banner?.classList.remove('hidden');
    if (statusEl) {
        statusEl.textContent = msg.truncated
            ? `${rows.length.toLocaleString()} matching records (first ${limit.toLocaleString()} shown)`
            : `${rows.length.toLocaleString()} matching records`;
    }
}

export function dismissColumnSearch(): void {
    if (!state.columnSearchActive) return;
    state.columnSearchActive = false;
    document.getElementById('colsearch-banner')?.classList.add('hidden');
    refreshGrid(); // rebuilds rowData + pinnedTop from the untouched state.data
}

export function setupColumnSearch(): void {
    // "Search this column…" in the column-header context menu. The menu element
    // is shared; the right-click handler stores the target col-id on it.
    document.getElementById('col-ctx-search')?.addEventListener('click', (e) => {
        const menu = document.getElementById('col-context-menu') as HTMLElement | null;
        const colId = menu?.dataset.colId;
        const rect = menu ? new DOMRect(menu.offsetLeft, menu.offsetTop, 0, 0) : null;
        menu?.classList.add('hidden');
        if (!colId) return;
        openSearchPopover(parseInt(colId.replace('col_', ''), 10), rect);
        e.stopPropagation();
    });

    document.getElementById('colsearch-ok')?.addEventListener('click', submitSearch);
    document.getElementById('colsearch-cancel')?.addEventListener('click', () => {
        document.getElementById('colsearch-popover')?.classList.add('hidden');
    });
    document.getElementById('colsearch-input')?.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') submitSearch();
    });

    document.getElementById('colsearch-show-all')?.addEventListener('click', dismissColumnSearch);
    document.getElementById('colsearch-dismiss')?.addEventListener('click', dismissColumnSearch);
}
