// DocumentSession — the vscode-free heart of a CSV editing session, ported
// 1:1 from the VS Code extension's csvEditorProvider.ts. Every behaviour the
// extension has lives here without any vscode dependency:
//
//   - large-file open plans (head / tail / full-with-fast-open / paged)
//   - fast-open background pump (first screen + appendRows batches)
//   - column global search (stream + early truncation)
//   - paged view via RowPager (byte-offset index preferred, scan fallback)
//   - save guards (preview / mid-stream) and byte offset index maintenance
//
// Host differences are injected: messages go out through `emit`, persistence
// through `onPersist`, and all knobs come in via SessionConfig. The VS Code
// extension keeps its own provider untouched; the Tauri sidecar drives this.

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { planForLargeFile, normalizeHeadRows, LargeFileMode } from './largeFileMode';
import { streamCsvRecords, readFirstRecords, searchColumnStream, COLUMN_SEARCH_LIMIT } from './csvStream';
import { buildIndexOffsets, readIndex, writeIndex, pruneIndexes } from './byteOffsetIndex';

const LARGE_FILE_THRESHOLD   = 10 * 1024 * 1024; // 10 MB
const DEFAULT_CHUNKED_THRESHOLD = 50 * 1024 * 1024; // 50 MB
const PREVIEW_ROW_COUNT      = 1000;
const PAGE_SIZE              = 500;
const FIRST_SCREEN_RECORDS   = 200;
const APPEND_BATCH_ROWS      = 5000;
const APPEND_BATCH_BYTES     = 4 * 1024 * 1024;

export interface ByteOffsetIndexConfig {
    enabled: boolean;
    autoGenerate: boolean;
    openThreshold: number;
    maxEntries: number;
    maxAgeDays: number;
    autoClean: boolean;
    verifyFingerprint: boolean;
}

export interface SessionConfig {
    largeFileMode: LargeFileMode;
    headRows: number;
    // Directory holding .csvidx files (and the open-count bookkeeping file).
    indexDir: string;
    byteOffsetIndex: Partial<ByteOffsetIndexConfig>;
    // Test hook: override the >50 MB paged-view threshold.
    chunkedThresholdBytes?: number;
}

export interface OpenMeta {
    fileName: string;
    delimiter: string;
    isPreview: boolean;
    previewMode: string;
    totalLineCount: number;
    isChunked: boolean;
    streaming: boolean;
}

const DEFAULT_INDEX_CONFIG: ByteOffsetIndexConfig = {
    enabled: true,
    autoGenerate: true,
    openThreshold: 3,
    maxEntries: 10,
    maxAgeDays: 30,
    autoClean: true,
    verifyFingerprint: true
};

type Emit = (msg: Record<string, unknown>) => void;

interface RowPageIndex {
    offsets: number[];
    totalRows: number;
    headerLine: string;
}

// Uniform random-access wrapper for Paged View — byte-offset index when a
// valid one exists, legacy scan-built page index otherwise (identical paging).
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

export class DocumentSession {
    // Host-injected hooks.
    public onPersist: ((key: string, value: unknown) => void) | null = null;

    // Document state (mirrors CsvDocument in the extension).
    private filePath = '';
    private content = '';
    private delimiter = ',';
    private isPreview = false;
    private previewMode = 'full';
    private totalLineCount = 0;
    private isChunked = false;
    private isStreaming = false;
    private streamComplete = false;
    private streamCancelled = false;
    private searchGen = 0;
    private pager: RowPager | null = null;
    private indexCfg: ByteOffsetIndexConfig;

    constructor(
        private readonly emit: Emit,
        private readonly config: SessionConfig
    ) {
        this.indexCfg = { ...DEFAULT_INDEX_CONFIG, ...config.byteOffsetIndex };
    }

    // ── Open ──

    async open(filePath: string): Promise<OpenMeta> {
        this.filePath = filePath;
        const stat = await fs.promises.stat(filePath);
        const fileSize = stat.size;
        const chunkedThreshold = this.config.chunkedThresholdBytes ?? DEFAULT_CHUNKED_THRESHOLD;

        if (fileSize > LARGE_FILE_THRESHOLD) {
            const plan = planForLargeFile(this.config.largeFileMode, fileSize, LARGE_FILE_THRESHOLD);
            // Desktop has no modal picker: an unresolved 'ask' routes huge
            // files to paged view and everything else to streamed fast-open.
            const mode: string = plan === 'ask'
                ? (fileSize > chunkedThreshold ? 'chunked' : 'full')
                : plan;

            const headRows = normalizeHeadRows(this.config.headRows, PREVIEW_ROW_COUNT);

            if (mode === 'head') {
                this.content = await this.readFirstLines(filePath, headRows + 1);
                this.totalLineCount = await this.countLines(filePath);
                this.isPreview = true;
                this.previewMode = 'head';
            } else if (mode === 'tail') {
                const result = await this.readTailLines(filePath, headRows);
                this.content = result.content;
                this.totalLineCount = result.totalLineCount;
                this.isPreview = true;
                this.previewMode = 'tail';
            } else if (mode === 'chunked') {
                this.isChunked = true;
                this.isPreview = true;
                this.previewMode = 'chunked';
            } else {
                // Full load of a large file → fast open (first screen + pump).
                const delimGuess = this.detectDelimiter(filePath, await this.readFirstLines(filePath, 1));
                const first = await readFirstRecords(filePath, FIRST_SCREEN_RECORDS + 1, delimGuess);
                this.content = first.text;
                this.isStreaming = true;
                this.previewMode = 'full';
            }
        } else {
            this.content = await fs.promises.readFile(filePath, 'utf8');
        }

        this.delimiter = this.detectDelimiter(filePath, this.content);

        if (this.isChunked) {
            this.pager = await this.createPager(filePath);
        }

        if (fileSize > LARGE_FILE_THRESHOLD) {
            this.maybeBuildIndexOnRepeatOpen(filePath, this.delimiter);
        }

        return {
            fileName: path.basename(filePath),
            delimiter: this.delimiter,
            isPreview: this.isPreview,
            previewMode: this.previewMode,
            totalLineCount: this.totalLineCount,
            isChunked: this.isChunked,
            streaming: this.isStreaming
        };
    }

    // ── Webview messages (same shapes as the VS Code protocol) ──

    async handleMessage(msg: any): Promise<void> {
        if (!msg || typeof msg.type !== 'string') return;

        if (msg.type === 'ready') {
            await this.sendInitialContent();
        } else if (msg.type === 'requestPage' && this.isChunked && this.pager) {
            const totalPages = this.pager.totalPages;
            let pageNum = msg.pageNumber as number;
            if (pageNum < 0) pageNum = totalPages - 1;
            pageNum = Math.max(0, Math.min(pageNum, totalPages - 1));
            const pageText = await this.readPage(this.filePath, this.pager, pageNum);
            this.emit({ type: 'pageData', pageNumber: pageNum, totalPages, text: pageText });
        } else if (msg.type === 'columnSearch') {
            void this.runColumnSearch(msg.colIndex, msg.query, msg.colName);
        } else if (msg.type === 'edit' && !this.isPreview) {
            // Refuse edits until the background stream finishes — the webview
            // would serialize only the loaded prefix and truncate the file.
            if (this.isStreaming && !this.streamComplete) return;
            this.content = msg.text;
            this.emit({ type: 'dirty' });
        } else if (msg.type === 'export') {
            // The host (Tauri) shows the native save dialog and writes the file.
            this.emit({ type: 'exportData', text: msg.text ?? '', filename: msg.filename ?? 'export.json' });
        } else if (msg.type === 'zoomChanged') {
            this.onPersist?.('zoomIndex', msg.zoomIndex);
        } else if (msg.type === 'colorModeChanged') {
            this.onPersist?.('colorMode', msg.colorMode);
        }
    }

    private async sendInitialContent(): Promise<void> {
        if (this.isChunked && this.pager) {
            const pageText = await this.readPage(this.filePath, this.pager, 0);
            this.emit({ type: 'init', text: pageText, delimiter: this.delimiter });
            this.emit({ type: 'pageData', pageNumber: 0, totalPages: this.pager.totalPages, text: pageText });
        } else if (this.isStreaming) {
            this.emit({ type: 'init', text: this.content, delimiter: this.delimiter, streaming: true });
            void this.pumpStream();
        } else {
            this.emit({ type: 'init', text: this.content, delimiter: this.delimiter });
        }
    }

    // ── Save ──

    async save(): Promise<void> {
        if (this.isPreview) {
            this.emit({ type: 'saveRefused', reason: 'Cannot save in preview mode. Open the full file to edit.' });
            return;
        }
        if (this.isStreaming && !this.streamComplete) {
            this.emit({ type: 'saveRefused', reason: 'Still loading the file in the background — try saving again in a moment.' });
            return;
        }
        await fs.promises.writeFile(this.filePath, this.content, 'utf8');
        this.emit({ type: 'saved' });
    }

    // ── Byte offset index: manual build ──

    async buildIndex(): Promise<void> {
        if (!this.indexCfg.enabled) {
            this.emit({ type: 'indexError', message: 'Byte offset cache is disabled.' });
            return;
        }
        try {
            const stat = await fs.promises.stat(this.filePath);
            const data = await buildIndexOffsets(this.filePath, this.delimiter);
            await writeIndex(this.config.indexDir, this.filePath, this.delimiter, data, { size: stat.size, mtimeMs: stat.mtimeMs });
            this.emit({ type: 'indexBuilt', file: this.filePath });
        } catch (err) {
            this.emit({ type: 'indexError', message: String(err) });
        }
    }

    dispose(): void {
        this.streamCancelled = true;
        this.searchGen++;
    }

    // ── Fast-open background pump (ported from the extension) ──

    private async pumpStream(): Promise<void> {
        const parts: string[] = [];
        let batch: string[][] = [];
        let batchBytes = 0;

        const flush = async (): Promise<void> => {
            if (batch.length === 0) return;
            const rows = batch;
            batch = [];
            batchBytes = 0;
            this.emit({ type: 'appendRows', rows });
            await new Promise(resolve => setImmediate(resolve));
        };

        try {
            for await (const record of streamCsvRecords(this.filePath, this.delimiter, {
                skipRecords: FIRST_SCREEN_RECORDS + 1,
                onChunkText: (t) => { parts.push(t); },
                shouldStop: () => this.streamCancelled
            })) {
                batch.push(record);
                batchBytes += record.join(this.delimiter).length + 1;
                if (batch.length >= APPEND_BATCH_ROWS || batchBytes >= APPEND_BATCH_BYTES) {
                    await flush();
                    if (this.streamCancelled) return;
                }
            }
            await flush();
        } catch {
            this.emit({ type: 'streamError' });
            return;
        }

        if (this.streamCancelled) return;
        this.content = parts.join('');
        this.streamComplete = true;
        this.emit({ type: 'streamDone' });
    }

    // ── Column global search (stream + early truncation) ──

    private async runColumnSearch(colIndex: number, query: string, colName: string): Promise<void> {
        if (typeof colIndex !== 'number' || colIndex < 0 || !query) return;
        const gen = ++this.searchGen;
        try {
            const result = await searchColumnStream(
                this.filePath, this.delimiter, colIndex, query, COLUMN_SEARCH_LIMIT
            );
            if (gen !== this.searchGen) return;
            this.emit({
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
            if (gen !== this.searchGen) return;
            this.emit({ type: 'columnSearchResults', error: String(err) });
        }
    }

    // ── Paged view ──

    private async createPager(filePath: string): Promise<RowPager> {
        if (this.indexCfg.enabled) {
            try {
                const stat = await fs.promises.stat(filePath);
                const idx = await readIndex(
                    this.config.indexDir, filePath,
                    { size: stat.size, mtimeMs: stat.mtimeMs },
                    this.indexCfg.verifyFingerprint
                );
                if (idx) return RowPager.fromRowOffsets(idx);
            } catch { /* fall through to the streaming scan */ }
        }
        return RowPager.fromPageIndex(await this.buildPageIndex(filePath, PAGE_SIZE));
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

    // ── Byte offset index: repeat-open bookkeeping ──

    private openCountsPath(): string {
        return path.join(this.config.indexDir, '_open-counts.json');
    }

    private maybeBuildIndexOnRepeatOpen(filePath: string, delimiter: string): void {
        if (!this.indexCfg.enabled || !this.indexCfg.autoGenerate) return;
        const threshold = Math.max(2, this.indexCfg.openThreshold);

        let counts: Record<string, number> = {};
        try { counts = JSON.parse(fs.readFileSync(this.openCountsPath(), 'utf8')); } catch {}
        const count = (counts[filePath] ?? 0) + 1;
        counts[filePath] = count;
        const keys = Object.keys(counts);
        if (keys.length > 200) delete counts[keys[0]];
        try {
            fs.mkdirSync(this.config.indexDir, { recursive: true });
            fs.writeFileSync(this.openCountsPath(), JSON.stringify(counts));
        } catch {}

        if (count < threshold) return;
        void (async () => {
            try {
                const stat = await fs.promises.stat(filePath);
                const existing = await readIndex(
                    this.config.indexDir, filePath,
                    { size: stat.size, mtimeMs: stat.mtimeMs },
                    this.indexCfg.verifyFingerprint
                );
                if (!existing) {
                    const data = await buildIndexOffsets(filePath, delimiter);
                    await writeIndex(this.config.indexDir, filePath, delimiter, data, { size: stat.size, mtimeMs: stat.mtimeMs });
                    if (this.indexCfg.autoClean) {
                        await pruneIndexes(this.config.indexDir, {
                            maxEntries: this.indexCfg.maxEntries,
                            maxAgeDays: this.indexCfg.maxAgeDays
                        });
                    }
                }
            } catch { /* index building is strictly best-effort */ }
        })();
    }

    // ── File reading helpers (ported from the extension) ──

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
