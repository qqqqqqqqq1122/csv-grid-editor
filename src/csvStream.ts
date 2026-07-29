// Streaming CSV parsing on the Extension Host side. Powers the two big-file
// features of this fork:
//
//   1. Fast open + chunk streaming — openCustomDocument reads only the first
//      screen of records (readFirstRecords), then resolveCustomEditor pumps the
//      rest to the webview in batches (streamCsvRecords). Everything runs from
//      an in-memory read stream; NO .idx or any other disk cache file is ever
//      written.
//   2. Column global search — searchColumnStream scans the whole file but only
//      keeps the target column's matches, and DESTROYS the stream the moment
//      `limit` matches have accumulated (early truncation).
//
// The record splitter is a quote-aware state machine identical to the webview's
// parseCsv (src/webview/utils/csv.ts): quoted fields may contain delimiters,
// carriage returns and newlines, "" escapes a quote, \r outside quotes is
// skipped, and fields are trimmed. Keeping the two parsers byte-compatible is
// what lets streamed rows append seamlessly onto the initially rendered rows.
//
// The module is vscode-free so it can be unit-tested with plain Node
// (see test/step020-csv-stream.test.cjs).

import * as fs from 'fs';

export const STREAM_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MB read chunks
export const COLUMN_SEARCH_LIMIT = 1000;

export interface StreamRecordsOptions {
    // Number of records to skip from the top of the file (the already-rendered
    // first screen) before yielding.
    skipRecords?: number;
    // Called with each raw decoded text chunk as it is read — lets the caller
    // accumulate the full file text for document.content without a second read.
    onChunkText?: (text: string) => void;
    // Called synchronously as each record is emitted with the absolute
    // character offset (into the concatenated chunk text) just past the
    // record's terminating newline. readFirstRecords uses this to cut its
    // returned text at an exact record boundary.
    onRecordBoundary?: (offset: number) => void;
    // Checked between records; returning true stops the stream early (used to
    // cancel the background pump when the webview panel is closed).
    shouldStop?: () => boolean;
}

// Core incremental splitter. Feed it decoded text chunks via push(); it emits
// complete records through onRecord. Quote state (inQuotes) naturally survives
// chunk boundaries, so a quoted field spanning two 4 MB chunks — or containing
// hundreds of embedded newlines — is parsed correctly.
class RecordSplitter {
    private row: string[] = [];
    private field = '';
    private inQuotes = false;

    constructor(
        private readonly delimiter: string,
        // boundaryInPush = offset just past the record's terminating newline,
        // relative to the start of the CURRENT push() text.
        private readonly onRecord: (record: string[], boundaryInPush: number) => void
    ) {}

    push(text: string): void {
        const d = this.delimiter;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (this.inQuotes) {
                if (ch === '"') {
                    if (i + 1 < text.length && text[i + 1] === '"') {
                        this.field += '"';
                        i++;
                    } else {
                        this.inQuotes = false;
                    }
                } else {
                    this.field += ch;
                }
            } else if (ch === '"') {
                this.inQuotes = true;
            } else if (ch === d) {
                this.row.push(this.field.trim());
                this.field = '';
            } else if (ch === '\r') {
                // skip (matches the webview parser)
            } else if (ch === '\n') {
                this.row.push(this.field.trim());
                this.emit(i + 1);
            } else {
                this.field += ch;
            }
        }
    }

    // Flush the trailing record after EOF (files without a final newline).
    // Boundary is 0: end() runs after every push, so the caller's accumulated
    // offset already equals the full text length.
    end(): void {
        this.row.push(this.field.trim());
        if (this.row.some(f => f !== '')) this.emit(0);
        else { this.row = []; this.field = ''; }
    }

    private emit(boundaryInPush: number): void {
        if (this.row.length > 0) this.onRecord(this.row, boundaryInPush);
        this.row = [];
        this.field = '';
    }
}

// Async generator over all records in a CSV file. The underlying read stream
// is destroyed as soon as the consumer stops iterating (break / return), which
// is what makes early truncation cheap — no further disk reads, no lingering
// file handle.
export async function* streamCsvRecords(
    filePath: string,
    delimiter: string,
    opts: StreamRecordsOptions = {}
): AsyncGenerator<string[]> {
    const skip = opts.skipRecords ?? 0;
    const stream = fs.createReadStream(filePath, { highWaterMark: STREAM_CHUNK_BYTES });
    const decoder = new TextDecoder('utf-8');
    let index = 0;
    let consumed = 0; // total chars pushed so far (for absolute boundaries)
    const pending: string[][] = [];

    const splitter = new RecordSplitter(delimiter, (record, boundaryInPush) => {
        if (index++ >= skip) pending.push(record);
        opts.onRecordBoundary?.(consumed + boundaryInPush);
    });

    try {
        for await (const chunk of stream) {
            const text = decoder.decode(chunk as Buffer, { stream: true });
            opts.onChunkText?.(text);
            splitter.push(text);
            consumed += text.length;
            while (pending.length > 0) {
                yield pending.shift()!;
                if (opts.shouldStop?.()) return;
            }
        }
        const tail = decoder.decode();
        if (tail) {
            opts.onChunkText?.(tail);
            splitter.push(tail);
            consumed += tail.length;
        }
        splitter.end();
        while (pending.length > 0) {
            yield pending.shift()!;
            if (opts.shouldStop?.()) return;
        }
    } finally {
        stream.destroy();
    }
}

// Reads the first `recordCount` records (header included) for the instant first
// screen. Returns both the parsed records and their raw text — the webview
// re-parses the text on its side, so both must agree (they do: same machine).
// Stops reading as soon as the records are complete, so even a 2 GB file opens
// its first screen in milliseconds.
export async function readFirstRecords(
    filePath: string,
    recordCount: number,
    delimiter: string
): Promise<{ records: string[][]; text: string }> {
    const records: string[][] = [];
    const boundaries: number[] = [];
    let text = '';
    for await (const record of streamCsvRecords(filePath, delimiter, {
        onChunkText: (t) => { text += t; },
        onRecordBoundary: (b) => { boundaries.push(b); },
        shouldStop: () => records.length >= recordCount
    })) {
        records.push(record);
    }
    // The chunk that completed the Nth record usually holds MORE records, and
    // the background pump re-sends everything after record N — so the returned
    // text must be cut at the exact boundary of record N, or the webview would
    // render those extra rows AND receive them again via appendRows.
    const boundary = boundaries[recordCount - 1];
    if (boundary !== undefined && boundary < text.length) {
        text = text.slice(0, boundary);
    }
    return { records, text };
}

export interface ColumnSearchResult {
    rows: string[][];        // matched data rows (header NOT included)
    origIndexes: number[];   // 1-based data-row position in the file per match
    truncated: boolean;      // true when the scan was cut off at `limit`
    scanned: number;         // total records read (header included) before stopping
}

// Streams the whole file but only tests ONE column for `query` (case-insensitive
// substring). The moment `limit` matches have been collected the loop breaks,
// the generator returns and the read stream is destroyed — the rest of the file
// is never read.
export async function searchColumnStream(
    filePath: string,
    delimiter: string,
    colIndex: number,
    query: string,
    limit: number = COLUMN_SEARCH_LIMIT
): Promise<ColumnSearchResult> {
    const q = query.toLowerCase();
    const rows: string[][] = [];
    const origIndexes: number[] = [];
    let scanned = 0;
    let truncated = false;

    for await (const record of streamCsvRecords(filePath, delimiter)) {
        const idx = scanned++;
        if (idx === 0) continue; // header row
        const cell = (record[colIndex] ?? '').toLowerCase();
        if (cell.includes(q)) {
            rows.push(record);
            origIndexes.push(idx); // first data row = 1, matching _origIndex
            if (rows.length >= limit) { truncated = true; break; }
        }
    }

    return { rows, origIndexes, truncated, scanned };
}
