import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { getWebviewContent } from './webview';
import { planForLargeFile, normalizeHeadRows } from './largeFileMode';
import { streamCsvRecords, readFirstRecords, searchColumnStream, COLUMN_SEARCH_LIMIT } from './csvStream';
import { buildIndexOffsets, readIndex, writeIndex, pruneIndexes } from './byteOffsetIndex';

const LARGE_FILE_THRESHOLD   = 10  * 1024 * 1024; // 10 MB
const CHUNKED_THRESHOLD      = 50  * 1024 * 1024; // 50 MB
const PREVIEW_ROW_COUNT      = 1000;
const PAGE_SIZE              = 500;
const FIRST_SCREEN_RECORDS   = 200;               // header + 200 data rows render instantly
const APPEND_BATCH_ROWS      = 5000;              // rows per background append message
const APPEND_BATCH_BYTES     = 4 * 1024 * 1024;   // …or ~4 MB of text, whichever comes first
const CANCELLED_PREVIEW_MODE = '__cancelled__';

interface RowPageIndex {
    offsets: number[];   // byte offset of the first byte of each page's first data row
    totalRows: number;
    headerLine: string;
}

// Uniform random-access wrapper used by Paged View. Two backing shapes:
//   - legacy pageIndex (per-PAGE offsets, built by scanning on every open)
//   - byte-offset index (per-RECORD offsets loaded from the .csvidx cache,
//     making repeat opens instant)
// The rest of the provider doesn't care which one it got — the streaming
// fallback and the index path share this interface (requirement: full
// compatibility with the existing chunk-streaming flow).
class RowPager {
    private constructor(
        public readonly headerLine: string,
        private readonly pageOffsets: number[] | null,
        private readonly rowOffsets: BigUint64Array | null,
        public readonly totalRows: number
    ) {}

    static fromPageIndex(index: RowPageIndex): RowPager {
        return new RowPager(index.headerLine, index.offsets, null, index.totalRows);
    }

    static fromRowOffsets(index: { offsets: BigUint64Array; totalRows: number; headerLine: string }): RowPager {
        return new RowPager(index.headerLine, null, index.offsets, index.totalRows);
    }

    get totalPages(): number {
        if (this.pageOffsets) return this.pageOffsets.length;
        return Math.max(1, Math.ceil(this.totalRows / PAGE_SIZE));
    }

    // Byte range [start, end) of a page's data rows (end undefined = to EOF).
    pageRange(pageNum: number): { start: number; end?: number } {
        if (this.pageOffsets) {
            return { start: this.pageOffsets[pageNum], end: this.pageOffsets[pageNum + 1] };
        }
        const offsets = this.rowOffsets!;
        const firstRec = pageNum * PAGE_SIZE + 1; // record 0 is the header
        const start = Number(offsets[Math.min(firstRec, offsets.length - 1)]);
        const endRec = firstRec + PAGE_SIZE;
        const end = endRec < offsets.length ? Number(offsets[endRec]) : undefined;
        return { start, end };
    }
}

class CsvDocument implements vscode.CustomDocument {
    public content: string;
    public pager: RowPager | null = null;

    // Fast-open streaming state (see csvStream.ts). isStreaming marks a large
    // file opened with only its first screen of records in `content`; the rest
    // is pumped to the webview in background batches. streamComplete flips when
    // the pump finishes AND `content` has been replaced by the full file text —
    // until then edits and saves are refused so a partial file is never written.
    public isStreaming: boolean = false;
    public streamComplete: boolean = false;
    public streamCancelled: boolean = false;
    // Generation counter for column-search requests; a stale search (a newer one
    // was issued, or the panel was closed) never posts results.
    public searchGen: number = 0;

    constructor(
        public readonly uri: vscode.Uri,
        content: string,
        public readonly delimiter: string,
        public readonly isPreview: boolean,
        public readonly previewMode: string,
        public readonly totalLineCount: number,
        public readonly isChunked: boolean = false
    ) {
        this.content = content;
    }

    dispose(): void {
        this.streamCancelled = true;
        this.searchGen++;
    }
}

export class CsvEditorProvider implements vscode.CustomEditorProvider<CsvDocument> {

    public static readonly viewType = 'fastOpenCsvViewer.grid';

    // The most recently registered provider — lets the command in extension.ts
    // reach instance services (manual index build).
    public static current: CsvEditorProvider | null = null;

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<CsvDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    private readonly _webviews = new Map<string, vscode.WebviewPanel>();

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        CsvEditorProvider.current = new CsvEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(
            CsvEditorProvider.viewType,
            CsvEditorProvider.current,
            { webviewOptions: { retainContextWhenHidden: true } }
        );
    }

    private readonly indexDir: string;
    private readonly indexBuildsInFlight = new Set<string>();

    constructor(private readonly context: vscode.ExtensionContext) {
        // All .csvidx cache files live under global storage — never next to
        // the user's CSVs (no Git pollution, no hidden files in data dirs).
        this.indexDir = path.join(context.globalStorageUri.fsPath, 'byte-offset-index');
    }

    // ── Document lifecycle ──

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<CsvDocument> {
        const stat = await vscode.workspace.fs.stat(uri);
        const fileSize = stat.size;

        let content: string = '';
        let isPreview = false;
        let previewMode = 'full';
        let totalLineCount = 0;
        let isChunked = false;
        let isStreaming = false;

        if (fileSize > LARGE_FILE_THRESHOLD) {
            const config = vscode.workspace.getConfiguration('csvGridEditor');
            const largeFileMode = config.get<string>('largeFileMode', 'ask');
            const headRows = normalizeHeadRows(config.get<number>('headRows', PREVIEW_ROW_COUNT), PREVIEW_ROW_COUNT);
            const plan = planForLargeFile(largeFileMode, fileSize, LARGE_FILE_THRESHOLD);
            const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);

            if (plan === 'ask') {
                const quickPickItems: (vscode.QuickPickItem & { id: string })[] = [
                    { label: '$(file) Open Full File',      description: 'Load all data into the grid (may be slow)', detail: `Full file size: ${sizeMB} MB`, id: 'full' },
                    { label: '$(arrow-up) Show Head',       description: `Preview the first ${headRows.toLocaleString()} rows`,                         id: 'head' },
                    { label: '$(arrow-down) Show Tail',     description: `Preview the last ${headRows.toLocaleString()} rows`,                          id: 'tail' },
                    { label: '$(code) Open as Plain Text',  description: 'Fast raw text view without grid features',                                              id: 'plaintext' },
                ];

                if (fileSize > CHUNKED_THRESHOLD) {
                    quickPickItems.splice(1, 0, {
                        label: '$(layers) Paged View',
                        description: `Browse ${PAGE_SIZE}-row pages (efficient for large files)`,
                        detail: `File size: ${sizeMB} MB`,
                        id: 'chunked'
                    });
                }

                const choice = await vscode.window.showQuickPick(quickPickItems, {
                    placeHolder: `This file is large (${sizeMB} MB). How would you like to open it?`,
                    ignoreFocusOut: true
                });

                if (!choice) {
                    // Don't throw — VSCode would log the rejection as a hard error. And don't
                    // dispose the webview from resolveCustomEditor either — VSCode is still
                    // wiring it up at that point and trips an "OverlayWebview has been disposed"
                    // race. Instead, return a sentinel doc and close the matching tab via the
                    // tabGroups API on the next tick; that lets VSCode manage the webview
                    // lifecycle correctly. The resolver returns early for the sentinel.
                    queueMicrotask(() => {
                        try {
                            const tab = vscode.window.tabGroups.all
                                .flatMap(group => group.tabs)
                                .find(t =>
                                    t.input instanceof vscode.TabInputCustom &&
                                    t.input.viewType === CsvEditorProvider.viewType &&
                                    t.input.uri.toString() === uri.toString()
                                );
                            if (tab) {
                                void vscode.window.tabGroups.close(tab);
                            }
                        } catch {}
                    });
                    return new CsvDocument(uri, '', ',', true, CANCELLED_PREVIEW_MODE, 0, false);
                }

                previewMode = choice.id;
            } else {
                // Configured mode (head / tail / all) — open directly, no picker.
                previewMode = plan;
            }

            const filePath = uri.fsPath;

            if (previewMode === 'plaintext') {
                content = await fs.promises.readFile(filePath, 'utf8');
                isPreview = true;
            } else if (previewMode === 'head') {
                content = await this.readFirstLines(filePath, headRows + 1);
                totalLineCount = await this.countLines(filePath);
                isPreview = true;
            } else if (previewMode === 'tail') {
                const result = await this.readTailLines(filePath, headRows);
                content = result.content;
                totalLineCount = result.totalLineCount;
                isPreview = true;
            } else if (previewMode === 'chunked') {
                isChunked = true;
                isPreview = true;
                // content stays empty — pages are served on demand
            } else {
                // Full load of a large file → fast open. Read ONLY the header
                // plus the first FIRST_SCREEN_RECORDS data records (quote-aware,
                // so quoted newlines can't shift the boundary) and hand that to
                // the webview for an instant first render; resolveCustomEditor
                // then streams the remaining records in background batches.
                const delimGuess = this.detectDelimiter(uri.fsPath, await this.readFirstLines(filePath, 1));
                const first = await readFirstRecords(filePath, FIRST_SCREEN_RECORDS + 1, delimGuess);
                content = first.text;
                isStreaming = true;
            }
        } else {
            const raw = await vscode.workspace.fs.readFile(uri);
            content = new TextDecoder().decode(raw);
        }

        const delimiter = this.detectDelimiter(uri.fsPath, content);
        const doc = new CsvDocument(uri, content, delimiter, isPreview, previewMode, totalLineCount, isChunked);
        doc.isStreaming = isStreaming;

        if (isChunked) {
            // Paged View: reuse the byte-offset index when valid (instant —
            // no full scan), otherwise fall back to the existing scan-based
            // page index. Identical paging behaviour either way.
            doc.pager = await this.createPager(uri.fsPath);
        }

        // Repeat-open bookkeeping: only after the same file has been opened
        // `openThreshold` times does a background index build kick in. The
        // first opens stay pure chunk-streaming with zero extra disk writes.
        if (fileSize > LARGE_FILE_THRESHOLD) {
            this.maybeBuildIndexOnRepeatOpen(uri.fsPath, delimiter);
        }

        return doc;
    }

    async resolveCustomEditor(
        document: CsvDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        if (document.previewMode === CANCELLED_PREVIEW_MODE) {
            // Cancellation sentinel — openCustomDocument has already scheduled the tab
            // close. Don't touch the webview or VSCode raises an OverlayWebview race.
            return;
        }

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        };

        this._webviews.set(document.uri.toString(), webviewPanel);
        webviewPanel.onDidDispose(() => this._webviews.delete(document.uri.toString()));

        const fileName  = path.basename(document.uri.fsPath);
        const zoomIndex = this.context.globalState.get<number>('csvGridEditor.zoomIndex', 4);
        const colorMode = this.context.globalState.get<boolean>('csvGridEditor.colorMode', false);

        webviewPanel.webview.html = getWebviewContent(
            webviewPanel.webview,
            this.context.extensionUri,
            document.delimiter,
            document.isPreview,
            document.previewMode,
            document.totalLineCount,
            fileName,
            document.isChunked,
            process.platform === 'darwin',
            zoomIndex,
            colorMode
        );

        // F3: File System Watcher — auto-reload on external changes (non-preview only)
        let watcher: vscode.FileSystemWatcher | undefined;
        if (!document.isPreview) {
            watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(path.dirname(document.uri.fsPath)), path.basename(document.uri.fsPath))
            );
            watcher.onDidChange(async () => {
                try {
                    // A reload mid-stream would race the background pump — the
                    // webview holds only a prefix of the file. Skipping is safe:
                    // the pump is reading the current on-disk bytes anyway.
                    if (document.isStreaming && !document.streamComplete) return;
                    const raw = await vscode.workspace.fs.readFile(document.uri);
                    const text = new TextDecoder().decode(raw);
                    // Ignore our own writes. saveCustomDocument writes document.content
                    // verbatim, so a watcher event whose content equals what we already
                    // hold is the echo of our own save, not an external edit. Reloading
                    // on it would re-parse the CSV into fresh arrays and wipe in-memory
                    // view state (frozen rows, in particular). Only genuinely external
                    // changes differ from document.content.
                    if (text === document.content) return;
                    document.content = text;
                    webviewPanel.webview.postMessage({
                        type: 'update',
                        text: document.content,
                        delimiter: document.delimiter
                    });
                } catch {}
            });
            webviewPanel.onDidDispose(() => watcher?.dispose());
        }

        webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'ready') {
                if (document.isChunked && document.pager) {
                    const pageText = await this.readPage(document.uri.fsPath, document.pager, 0);
                    webviewPanel.webview.postMessage({
                        type: 'init',
                        text: pageText,
                        delimiter: document.delimiter
                    });
                    webviewPanel.webview.postMessage({
                        type: 'pageData',
                        pageNumber: 0,
                        totalPages: document.pager.totalPages,
                        text: pageText
                    });
                } else if (document.isStreaming) {
                    // Fast open: the document only holds the first screen of
                    // records. Render it immediately, then pump the rest.
                    webviewPanel.webview.postMessage({
                        type: 'init',
                        text: document.content,
                        delimiter: document.delimiter,
                        streaming: true
                    });
                    void this.pumpStream(document, webviewPanel);
                } else {
                    webviewPanel.webview.postMessage({
                        type: 'init',
                        text: document.content,
                        delimiter: document.delimiter
                    });
                }
            } else if (msg.type === 'zoomChanged') {
                this.context.globalState.update('csvGridEditor.zoomIndex', msg.zoomIndex);

            } else if (msg.type === 'colorModeChanged') {
                this.context.globalState.update('csvGridEditor.colorMode', msg.colorMode);

            } else if (msg.type === 'edit' && !document.isPreview) {
                // Ignore edits until the background stream has finished — the
                // webview would serialize only the loaded prefix and truncate
                // the file on save. Cell editing is disabled webview-side too.
                if (document.isStreaming && !document.streamComplete) return;
                document.content = msg.text;
                this._onDidChangeCustomDocument.fire({ document });

            // Column global search (stream + early truncation, see csvStream.ts).
            // The webview sends the target column and keyword; the whole file is
            // scanned via a quote-aware record stream that is destroyed the
            // moment COLUMN_SEARCH_LIMIT matches have accumulated.
            } else if (msg.type === 'columnSearch') {
                void this.runColumnSearch(document, webviewPanel, msg.colIndex, msg.query, msg.colName);

            // F4: Export handler — the webview sends the converted text plus a
            // suggested filename; the extension picks dialog filters from its
            // extension (.json / .jsonl / .md).
            } else if (msg.type === 'export') {
                const filename   = msg.filename ?? 'export.json';
                const defaultUri = vscode.Uri.file(
                    path.join(path.dirname(document.uri.fsPath), filename)
                );
                const ext = path.extname(filename).toLowerCase();
                const filters: Record<string, string[]> =
                    ext === '.jsonl' ? { 'JSON Lines': ['jsonl', 'ndjson'] } :
                    ext === '.md'    ? { 'Markdown':   ['md'] } :
                                       { 'JSON':       ['json'] };
                filters['All files'] = ['*'];
                const saveUri = await vscode.window.showSaveDialog({ defaultUri, filters });
                if (saveUri) {
                    await vscode.workspace.fs.writeFile(saveUri, new TextEncoder().encode(msg.text ?? ''));
                    vscode.window.showInformationMessage(`Exported to ${path.basename(saveUri.fsPath)}`);
                }

            // F7: Chunked paging
            } else if (msg.type === 'requestPage' && document.isChunked && document.pager) {
                const totalPages = document.pager.totalPages;
                let pageNum = msg.pageNumber as number;
                if (pageNum < 0) pageNum = totalPages - 1;
                pageNum = Math.max(0, Math.min(pageNum, totalPages - 1));
                const pageText = await this.readPage(document.uri.fsPath, document.pager, pageNum);
                webviewPanel.webview.postMessage({
                    type: 'pageData',
                    pageNumber: pageNum,
                    totalPages,
                    text: pageText
                });
            }
        });
    }

    // ── Save / Revert / Backup ──

    async saveCustomDocument(document: CsvDocument, _cancellation: vscode.CancellationToken): Promise<void> {
        if (document.isPreview) {
            vscode.window.showWarningMessage('Cannot save in preview mode. Open the full file to edit.');
            return;
        }
        if (document.isStreaming && !document.streamComplete) {
            vscode.window.showWarningMessage('Still loading the file in the background — try saving again in a moment.');
            return;
        }
        await vscode.workspace.fs.writeFile(document.uri, new TextEncoder().encode(document.content));
    }

    async saveCustomDocumentAs(document: CsvDocument, destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> {
        await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(document.content));
    }

    async revertCustomDocument(document: CsvDocument, _cancellation: vscode.CancellationToken): Promise<void> {
        const raw = await vscode.workspace.fs.readFile(document.uri);
        document.content = new TextDecoder().decode(raw);

        const panel = this._webviews.get(document.uri.toString());
        if (panel) {
            panel.webview.postMessage({
                type: 'update',
                text: document.content,
                delimiter: document.delimiter
            });
        }
    }

    async backupCustomDocument(document: CsvDocument, context: vscode.CustomDocumentBackupContext, _cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        await vscode.workspace.fs.writeFile(context.destination, new TextEncoder().encode(document.content));
        return {
            id: context.destination.toString(),
            delete: async () => {
                try { await vscode.workspace.fs.delete(context.destination); } catch {}
            }
        };
    }

    // ── Fast-open background pump ──

    // Streams the records AFTER the already-rendered first screen to the
    // webview in batches. The webview appends them to AG Grid silently, so the
    // user perceives an instant open with the rest of the data flowing in.
    // While pumping, the raw chunk text is accumulated into document.content,
    // so once streamComplete flips the document holds the full file verbatim
    // and save/revert behave exactly like a normal full open.
    private async pumpStream(document: CsvDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        const filePath = document.uri.fsPath;
        // The pump re-reads the file from byte 0 (skipping the first-screen
        // RECORDS, not bytes), so the raw chunks accumulate the complete file
        // text on their own — the first-screen text must NOT be prepended here.
        const parts: string[] = [];
        let batch: string[][] = [];
        let batchBytes = 0;

        const flush = async (): Promise<void> => {
            if (batch.length === 0) return;
            const rows = batch;
            batch = [];
            batchBytes = 0;
            try {
                await webviewPanel.webview.postMessage({ type: 'appendRows', rows });
            } catch { document.streamCancelled = true; }
            // Yield the event loop between batches so the extension host stays
            // responsive for other extensions and UI messages.
            await new Promise(resolve => setImmediate(resolve));
        };

        try {
            for await (const record of streamCsvRecords(filePath, document.delimiter, {
                skipRecords: FIRST_SCREEN_RECORDS + 1,
                onChunkText: (t) => { parts.push(t); },
                shouldStop: () => document.streamCancelled
            })) {
                batch.push(record);
                batchBytes += record.join(document.delimiter).length + 1;
                if (batch.length >= APPEND_BATCH_ROWS || batchBytes >= APPEND_BATCH_BYTES) {
                    await flush();
                    if (document.streamCancelled) return;
                }
            }
            await flush();
        } catch {
            // A failed pump must not wedge the document in a half-loaded state.
            try { await webviewPanel.webview.postMessage({ type: 'streamError' }); } catch {}
            return;
        }

        if (document.streamCancelled) return;

        document.content = parts.join('');
        document.streamComplete = true;
        try {
            await webviewPanel.webview.postMessage({ type: 'streamDone' });
        } catch {}
    }

    // ── Column global search (stream + early truncation) ──

    private async runColumnSearch(
        document: CsvDocument,
        webviewPanel: vscode.WebviewPanel,
        colIndex: number,
        query: string,
        colName: string
    ): Promise<void> {
        if (typeof colIndex !== 'number' || colIndex < 0 || !query) return;
        const gen = ++document.searchGen; // invalidate any previous in-flight search
        try {
            const result = await searchColumnStream(
                document.uri.fsPath, document.delimiter, colIndex, query, COLUMN_SEARCH_LIMIT
            );
            if (gen !== document.searchGen) return; // superseded or panel closed
            await webviewPanel.webview.postMessage({
                type: 'columnSearchResults',
                colIndex,
                colName,
                query,
                rows: result.rows,
                origIndexes: result.origIndexes,
                truncated: result.truncated,
                scanned: result.scanned,
                limit: COLUMN_SEARCH_LIMIT
            });
        } catch (err) {
            if (gen !== document.searchGen) return;
            try {
                await webviewPanel.webview.postMessage({
                    type: 'columnSearchResults',
                    error: String(err)
                });
            } catch {}
        }
    }

    // ── File reading helpers ──

    private async readFirstLines(filePath: string, lineCount: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const lines: string[] = [];
            const input = fs.createReadStream(filePath);
            const rl = readline.createInterface({ input, crlfDelay: Infinity });
            let done = false;

            rl.on('line', (line) => {
                lines.push(line);
                if (lines.length >= lineCount) {
                    done = true;
                    rl.close();
                    input.destroy();
                    resolve(lines.join('\n'));
                }
            });

            rl.on('close', () => { if (!done) resolve(lines.join('\n')); });
            rl.on('error', (err) => { if (!done) reject(err); });
        });
    }

    private async countLines(filePath: string): Promise<number> {
        return new Promise((resolve, reject) => {
            let count = 0;
            const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
            stream.on('data', (chunk: string | Buffer) => {
                const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
                for (let i = 0; i < buf.length; i++) {
                    if (buf[i] === 0x0A) count++;
                }
            });
            stream.on('end', () => resolve(count > 0 ? count + 1 : 1));
            stream.on('error', reject);
        });
    }

    private async readTailLines(filePath: string, rowCount: number): Promise<{ content: string; totalLineCount: number }> {
        return new Promise((resolve, reject) => {
            const allLines: string[] = [];
            const input = fs.createReadStream(filePath);
            const rl = readline.createInterface({ input, crlfDelay: Infinity });

            rl.on('line', (line) => allLines.push(line));

            rl.on('close', () => {
                const header = allLines[0] || '';
                const tail = allLines.slice(-rowCount);
                resolve({
                    content: [header, ...tail].join('\n'),
                    totalLineCount: allLines.length
                });
            });
            rl.on('error', reject);
        });
    }

    // ── F7: Chunked / Paged Mode ──

    private async buildPageIndex(filePath: string, pageSize: number): Promise<RowPageIndex> {
        return new Promise((resolve, reject) => {
            const offsets: number[] = [];
            let byteOffset = 0;
            let lineIndex = 0;
            let headerLine = '';
            let dataRowIndex = 0;

            const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
            let partial = '';

            stream.on('data', (chunk: string | Buffer) => {
                const text = partial + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
                const lines = text.split('\n');
                partial = lines.pop() ?? '';

                for (const line of lines) {
                    const lineBytes = Buffer.byteLength(line + '\n', 'utf8');
                    if (lineIndex === 0) {
                        headerLine = line;
                    } else {
                        if (dataRowIndex % pageSize === 0) {
                            offsets.push(byteOffset);
                        }
                        dataRowIndex++;
                    }
                    byteOffset += lineBytes;
                    lineIndex++;
                }
            });

            stream.on('end', () => {
                if (partial.trim()) {
                    if (lineIndex > 0) {
                        if (dataRowIndex % pageSize === 0) {
                            offsets.push(byteOffset);
                        }
                    }
                }
                if (offsets.length === 0) offsets.push(0);
                resolve({ offsets, totalRows: dataRowIndex, headerLine });
            });

            stream.on('error', reject);
        });
    }

    private async readPage(filePath: string, pager: RowPager, pageNum: number): Promise<string> {
        const { start: startOffset, end: endOffset } = pager.pageRange(pageNum);

        return new Promise((resolve, reject) => {
            const streamOpts: { start: number; end?: number; encoding: BufferEncoding } = {
                start: startOffset,
                encoding: 'utf8'
            };
            if (endOffset !== undefined) {
                streamOpts.end = endOffset - 1;
            }

            const stream = fs.createReadStream(filePath, streamOpts);
            let raw = '';
            stream.on('data', (chunk: string | Buffer) => { raw += typeof chunk === 'string' ? chunk : chunk.toString('utf8'); });
            stream.on('end', () => {
                const lines = raw.split('\n').filter(l => l.trim() !== '');
                resolve([pager.headerLine, ...lines].join('\n'));
            });
            stream.on('error', reject);
        });
    }

    // ── Byte Offset Index (optional cache layer, see byteOffsetIndex.ts) ──

    // Paged View pager: byte-offset index when a valid one exists, legacy
    // scan-built page index otherwise. Same paging either way.
    private async createPager(filePath: string): Promise<RowPager> {
        const cfg = vscode.workspace.getConfiguration('csvGridEditor');
        if (cfg.get<boolean>('byteOffsetIndex.enabled', true)) {
            try {
                const stat = await fs.promises.stat(filePath);
                const idx = await readIndex(
                    this.indexDir, filePath,
                    { size: stat.size, mtimeMs: stat.mtimeMs },
                    cfg.get<boolean>('byteOffsetIndex.verifyFingerprint', true)
                );
                if (idx) return RowPager.fromRowOffsets(idx);
            } catch { /* fall through to the streaming scan */ }
        }
        return RowPager.fromPageIndex(await this.buildPageIndex(filePath, PAGE_SIZE));
    }

    // Counts opens per file (persisted in globalState) and, once the same file
    // hits the configured threshold, builds its byte-offset index in the
    // background. Never blocks opening; never writes anything on first opens.
    private maybeBuildIndexOnRepeatOpen(filePath: string, delimiter: string): void {
        const cfg = vscode.workspace.getConfiguration('csvGridEditor');
        if (!cfg.get<boolean>('byteOffsetIndex.enabled', true)) return;
        if (!cfg.get<boolean>('byteOffsetIndex.autoGenerate', true)) return;
        const threshold = Math.max(2, cfg.get<number>('byteOffsetIndex.openThreshold', 3));

        const counts = this.context.globalState.get<Record<string, number>>('csvGridEditor.openCounts', {});
        const count = (counts[filePath] ?? 0) + 1;
        counts[filePath] = count;
        const keys = Object.keys(counts);
        if (keys.length > 200) delete counts[keys[0]]; // keep the map bounded
        void this.context.globalState.update('csvGridEditor.openCounts', counts);

        if (count < threshold) return;
        if (this.indexBuildsInFlight.has(filePath)) return;
        this.indexBuildsInFlight.add(filePath);
        void (async () => {
            try {
                const stat = await fs.promises.stat(filePath);
                // A still-valid index may already exist from an earlier build.
                const existing = await readIndex(
                    this.indexDir, filePath,
                    { size: stat.size, mtimeMs: stat.mtimeMs },
                    cfg.get<boolean>('byteOffsetIndex.verifyFingerprint', true)
                );
                if (!existing) {
                    const data = await buildIndexOffsets(filePath, delimiter);
                    await writeIndex(this.indexDir, filePath, delimiter, data, { size: stat.size, mtimeMs: stat.mtimeMs });
                    if (cfg.get<boolean>('byteOffsetIndex.autoClean', true)) {
                        await pruneIndexes(this.indexDir, {
                            maxEntries: cfg.get<number>('byteOffsetIndex.maxEntries', 10),
                            maxAgeDays: cfg.get<number>('byteOffsetIndex.maxAgeDays', 30)
                        });
                    }
                }
            } catch { /* index building is strictly best-effort */ }
            finally { this.indexBuildsInFlight.delete(filePath); }
        })();
    }

    // Manual "Accelerate Repeated Opening": builds (or rebuilds) the index for
    // the given file right away, regardless of the open-count threshold.
    public async buildIndexForUri(uri: vscode.Uri): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('csvGridEditor');
        if (!cfg.get<boolean>('byteOffsetIndex.enabled', true)) {
            vscode.window.showInformationMessage('Byte offset cache is disabled (csvGridEditor.byteOffsetIndex.enabled).');
            return;
        }
        if (!cfg.get<boolean>('byteOffsetIndex.allowManualBuild', true)) {
            vscode.window.showWarningMessage('Manual index building is disabled (csvGridEditor.byteOffsetIndex.allowManualBuild).');
            return;
        }
        const filePath = uri.fsPath;
        try {
            const stat = await fs.promises.stat(filePath);
            const delimiter = this.detectDelimiter(filePath, await this.readFirstLines(filePath, 1));
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Building byte offset index…', cancellable: false },
                async () => {
                    const data = await buildIndexOffsets(filePath, delimiter);
                    await writeIndex(this.indexDir, filePath, delimiter, data, { size: stat.size, mtimeMs: stat.mtimeMs });
                }
            );
            vscode.window.showInformationMessage('Byte offset index ready — repeated opens of this file will be faster.');
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to build byte offset index: ${String(err)}`);
        }
    }

    // ── Delimiter detection ──

    private detectDelimiter(fileName: string, content: string): string {
        if (fileName.endsWith('.tsv')) return '\t';
        const firstLine = content.split('\n')[0] || '';
        const semicolons = (firstLine.match(/;/g) || []).length;
        const commas     = (firstLine.match(/,/g) || []).length;
        const tabs       = (firstLine.match(/\t/g) || []).length;
        if (tabs > commas && tabs > semicolons) return '\t';
        if (semicolons > commas) return ';';
        return ',';
    }
}
