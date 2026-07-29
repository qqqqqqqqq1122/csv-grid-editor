import { state } from './state';
import { parseCsv } from './utils/csv';
import { applyZoom } from './features/zoom';
import { buildGrid } from './grid/builder';
import { refreshGrid, updateCountsDisplay } from './grid/refresh';
import { hideLoader } from './utils/loader';
import { updateDelimiterBadge } from './features/delimiter';
import { handlePageData } from './features/pagination';
import { resetDuplicatesState } from './features/duplicates';
import { frozenRowPositions, reanchorFrozenRows } from './features/freeze-rows';
import { handleColumnSearchResults } from './features/column-search';

function initWithData(text: string, delimiter: string, streaming: boolean): void {
    state.rawCsvText      = text;
    state.currentDelimiter = delimiter;
    state.data = parseCsv(text, delimiter);
    state.isAutoFitted     = false;
    state.autoFitCache     = null;
    state.autoFitCacheZoom = -1;
    state.zoomIndex        = Math.max(0, Math.min(INITIAL_ZOOM_INDEX, state.ZOOM_STEPS.length - 1));
    // Fast-open: while the Extension Host keeps pumping batches, editing and
    // delimiter re-parse stay off (rawCsvText only holds the first screen).
    state.streamingActive  = streaming;
    state.streamingDoc     = streaming;

    updateDelimiterBadge(delimiter);

    if (IS_PREVIEW) {
        const previewEl = document.getElementById('preview-text');
        if (previewEl) {
            const shownRows = state.data.length - 1;
            const totalRows = TOTAL_LINE_COUNT - 1;
            if (PREVIEW_MODE === 'head') {
                previewEl.textContent = `Showing first ${shownRows.toLocaleString()} of ${totalRows.toLocaleString()} rows (read-only preview)`;
            } else if (PREVIEW_MODE === 'tail') {
                previewEl.textContent = `Showing last ${shownRows.toLocaleString()} of ${totalRows.toLocaleString()} rows (read-only preview)`;
            }
        }
    }

    setTimeout(() => { applyZoom(); buildGrid(); hideLoader(); }, 0);
}

// Background chunk-streaming handlers (fast open). The Extension Host sends
// parsed record batches; they are appended to state.data and the grid in one
// transaction each, so the full dataset materialises without a re-parse.
function handleAppendRows(rows: string[][]): void {
    const startIdx = state.data.length;
    for (const row of rows) state.data.push(row);

    // While the column-search result view is up the grid intentionally shows
    // the match set, not state.data — the rows still accumulate in state.data
    // and appear when the user picks "Show all rows".
    if (state.gridApi && !state.columnSearchActive) {
        const add = rows.map((row, i) => {
            const obj: Record<string, string | number> = { _origIndex: startIdx + i };
            for (let c = 0; c < row.length; c++) obj['col_' + c] = row[c];
            return obj;
        });
        state.gridApi.applyTransaction({ add });
    }

    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = `Loading… ${(state.data.length - 1).toLocaleString()} rows`;
}

export function setupMessaging(): void {
    window.addEventListener('message', (event: MessageEvent) => {
        const msg = event.data;
        if (msg.type === 'init') {
            initWithData(msg.text, msg.delimiter, !!msg.streaming);
        } else if (msg.type === 'appendRows') {
            handleAppendRows(msg.rows);
        } else if (msg.type === 'streamDone') {
            state.streamingActive = false;
            updateCountsDisplay();
        } else if (msg.type === 'streamError') {
            state.streamingActive = false;
            const statusEl = document.getElementById('status');
            if (statusEl) statusEl.textContent = 'Background load failed — close and reopen the file to retry';
        } else if (msg.type === 'columnSearchResults') {
            handleColumnSearchResults(msg);
        } else if (msg.type === 'update') {
            // External file change → re-parse. Re-anchor frozen rows by position so
            // they survive the reload (best effort: positions past the new row count
            // are dropped if the external edit removed rows).
            const frozen = frozenRowPositions();
            state.data = parseCsv(msg.text, msg.delimiter);
            reanchorFrozenRows(frozen);
            // Existing dup highlights now point at stale rows.
            resetDuplicatesState();
            refreshGrid();
        } else if (msg.type === 'pageData') {
            handlePageData(msg);
        }
    });
}
