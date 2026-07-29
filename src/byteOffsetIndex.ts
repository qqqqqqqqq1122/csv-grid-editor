// Optional Byte Offset Index layer. This is a pure ADD-ON over the existing
// chunk-streaming architecture (csvStream.ts): nothing here is required for
// opening a file, and every consumer falls back to streaming when no valid
// index exists.
//
// What it does:
//   - On REPEAT opens of the same large CSV (configurable threshold), a
//     background scan records every record's 64-bit byte offset into a binary
//     index file, enabling O(1) random access (e.g. Paged View opens without
//     re-scanning the whole file).
//   - Index files live ONLY in the extension's global storage directory
//     (context.globalStorageUri/byte-offset-index), named sha1(absolute file
//     path) — never next to the user's CSV, so no Git pollution, no hidden
//     files in data directories.
//   - Indexes are a CACHE: an LRU registry caps the count (default 10) and
//     stale entries (default 30 days) are pruned, all in the background.
//
// Validity: an index is reused only when the file's size AND mtime match the
// stored values, plus (optionally) a cheap fingerprint (sha1 of size + first
// and last 64 KB) to catch same-size same-mtime edits. Any mismatch → the
// index is treated as absent and regenerated in the background.
//
// Binary layout (little-endian):
//   8  bytes  magic "CSVIDX01"
//   4  bytes  uint32  format version (1)
//   1  byte   delimiter char code
//   3  bytes  reserved
//   8  bytes  float64 file size
//   8  bytes  float64 mtime (ms)
//   20 bytes  sha1 fingerprint
//   4  bytes  uint32 header line byte length H
//   H  bytes  header line (utf8, no trailing newline)
//   4  bytes  uint32 record count R (record 0 = header)
//   R×8 bytes uint64 record-start offsets
//
// The module is vscode-free so it can be unit-tested with plain Node
// (see test/step030-byte-offset-index.test.cjs).

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export const IDX_VERSION = 1;
export const REGISTRY_FILE = '_registry.json';

const MAGIC = Buffer.from('CSVIDX01', 'ascii');
const HEADER_FIXED = 8 + 4 + 1 + 3 + 8 + 8 + 20 + 4; // up to and incl. header length
const QUOTE = 0x22;   // "
const LF = 0x0A;      // \n
const FP_SLICE = 64 * 1024;

export interface IndexBuildResult {
    offsets: BigUint64Array; // record-start byte offsets, record 0 = header
    totalRows: number;       // data rows (records minus header)
    headerLine: string;
}

export interface CachePolicy {
    maxEntries: number;   // default 10
    maxAgeDays: number;   // default 30
}

interface RegistryEntry {
    file: string;     // absolute CSV path
    lastUsed: number; // ms epoch
}

type Registry = Record<string, RegistryEntry>; // key: index file basename

// ── Paths ──

export function indexFilePath(indexDir: string, csvPath: string): string {
    const hash = crypto.createHash('sha1').update(path.resolve(csvPath)).digest('hex');
    return path.join(indexDir, hash + '.csvidx');
}

// ── Fingerprint (cheap change detector) ──

// sha1 over size + first 64 KB + last 64 KB. Catches same-size same-mtime
// edits without hashing the whole file.
export async function computeFingerprint(filePath: string, size: number): Promise<Buffer> {
    const hash = crypto.createHash('sha1');
    const sizeBuf = Buffer.alloc(8);
    sizeBuf.writeDoubleLE(size);
    hash.update(sizeBuf);

    const handle = await fs.promises.open(filePath, 'r');
    try {
        const firstLen = Math.min(FP_SLICE, size);
        const first = Buffer.alloc(firstLen);
        await handle.read(first, 0, firstLen, 0);
        hash.update(first);
        if (size > FP_SLICE) {
            const lastLen = Math.min(FP_SLICE, size - firstLen);
            const last = Buffer.alloc(lastLen);
            await handle.read(last, 0, lastLen, size - lastLen);
            hash.update(last);
        }
    } finally {
        await handle.close();
    }
    return hash.digest();
}

// ── Index build (byte-level, quote-aware) ──

// Scans raw bytes (no decoding) tracking quote state, so a newline inside a
// quoted field never becomes a record boundary. All supported delimiters are
// single-byte ASCII, and UTF-8 continuation bytes are always ≥ 0x80, so byte
// scanning cannot false-match inside multibyte characters.
export async function buildIndexOffsets(
    filePath: string,
    delimiter: string,
    shouldStop?: () => boolean
): Promise<IndexBuildResult> {
    const delim = delimiter.charCodeAt(0);
    void delim; // offsets don't depend on the delimiter; quote rules do not either
    const offsets: bigint[] = [0n]; // record 0 starts at byte 0
    let inQuotes = false;
    let pendingQuote = false; // '"' seen as the last byte of a chunk while inQuotes
    let base = 0;             // absolute byte offset of the current chunk

    const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    try {
        for await (const chunk of stream) {
            if (shouldStop?.()) throw new Error('cancelled');
            const buf = chunk as Buffer;
            for (let i = 0; i < buf.length; i++) {
                const b = buf[i];
                if (pendingQuote) {
                    // Previous chunk ended on '"' inside quotes: a following '"'
                    // is the escaped pair, anything else closed the quote.
                    pendingQuote = false;
                    if (b === QUOTE) continue;
                    inQuotes = false;
                }
                if (inQuotes) {
                    if (b === QUOTE) {
                        if (i + 1 < buf.length) {
                            if (buf[i + 1] === QUOTE) i++; // escaped quote
                            else inQuotes = false;
                        } else {
                            pendingQuote = true;
                        }
                    }
                } else if (b === QUOTE) {
                    inQuotes = true;
                } else if (b === LF) {
                    offsets.push(BigInt(base + i + 1));
                }
            }
            base += buf.length;
        }
    } finally {
        stream.destroy();
    }

    // A trailing newline leaves a bogus record start at EOF.
    if (offsets.length > 1 && offsets[offsets.length - 1] === BigInt(base)) offsets.pop();
    if (base === 0) offsets.pop(); // empty file: no records at all

    // Read the header line text (needed to serve pages).
    let headerLine = '';
    if (offsets.length > 0) {
        const end = offsets.length > 1 ? Number(offsets[1]) : base;
        const headerBuf = Buffer.alloc(Math.max(0, end));
        const handle = await fs.promises.open(filePath, 'r');
        try { await handle.read(headerBuf, 0, headerBuf.length, 0); } finally { await handle.close(); }
        headerLine = headerBuf.toString('utf8').split('\n')[0].replace(/\r$/, '');
    }

    return {
        offsets: BigUint64Array.from(offsets),
        totalRows: Math.max(0, offsets.length - 1),
        headerLine
    };
}

// ── Write / read ──

export async function writeIndex(
    indexDir: string,
    csvPath: string,
    delimiter: string,
    data: IndexBuildResult,
    stat: { size: number; mtimeMs: number }
): Promise<string> {
    await fs.promises.mkdir(indexDir, { recursive: true });
    const fingerprint = await computeFingerprint(csvPath, stat.size);
    const headerBuf = Buffer.from(data.headerLine, 'utf8');

    const head = Buffer.alloc(HEADER_FIXED);
    MAGIC.copy(head, 0);
    head.writeUInt32LE(IDX_VERSION, 8);
    head.writeUInt8(delimiter.charCodeAt(0) & 0xff, 12);
    head.writeDoubleLE(stat.size, 16);
    head.writeDoubleLE(stat.mtimeMs, 24);
    fingerprint.copy(head, 32);
    head.writeUInt32LE(headerBuf.length, 52);

    const tail = Buffer.alloc(4);
    tail.writeUInt32LE(data.offsets.length, 0);
    const body = Buffer.from(data.offsets.buffer, data.offsets.byteOffset, data.offsets.byteLength);

    // Write-then-rename so a crash mid-write never leaves a truncated index.
    const target = indexFilePath(indexDir, csvPath);
    const tmp = target + '.tmp';
    await fs.promises.writeFile(tmp, Buffer.concat([head, headerBuf, tail, body]));
    await fs.promises.rename(tmp, target);
    await touchIndex(indexDir, csvPath);
    return target;
}

export async function readIndex(
    indexDir: string,
    csvPath: string,
    stat: { size: number; mtimeMs: number },
    verifyFingerprint: boolean = true
): Promise<(IndexBuildResult & { delimiter: string }) | null> {
    let buf: Buffer;
    try {
        buf = await fs.promises.readFile(indexFilePath(indexDir, csvPath));
    } catch {
        return null; // no index
    }
    try {
        if (buf.length < HEADER_FIXED + 4) return null;
        if (!buf.subarray(0, 8).equals(MAGIC)) return null;
        if (buf.readUInt32LE(8) !== IDX_VERSION) return null;
        const delimiter = String.fromCharCode(buf.readUInt8(12));
        const fileSize = buf.readDoubleLE(16);
        const mtimeMs = buf.readDoubleLE(24);
        const fingerprint = buf.subarray(32, 52);
        const headerLen = buf.readUInt32LE(52);
        const off = HEADER_FIXED + headerLen;
        if (buf.length < off + 4) return null;
        const headerLine = buf.subarray(HEADER_FIXED, off).toString('utf8');
        const count = buf.readUInt32LE(off);
        const bodyStart = off + 4;
        if (buf.length < bodyStart + count * 8) return null;

        if (fileSize !== stat.size) return null;
        if (Math.round(mtimeMs) !== Math.round(stat.mtimeMs)) return null;
        if (verifyFingerprint) {
            const current = await computeFingerprint(csvPath, stat.size);
            if (!current.equals(fingerprint)) return null;
        }

        // The Buffer from readFile may be pool-backed; copy to guarantee an
        // 8-byte-aligned standalone ArrayBuffer for the BigUint64Array view.
        const aligned = Buffer.alloc(count * 8);
        buf.copy(aligned, 0, bodyStart, bodyStart + count * 8);
        const offsets = new BigUint64Array(aligned.buffer, 0, count);

        await touchIndex(indexDir, csvPath); // LRU
        return { offsets, totalRows: Math.max(0, count - 1), headerLine, delimiter };
    } catch {
        return null; // any parse/IO problem → behave as if no index exists
    }
}

// ── LRU registry ──

async function loadRegistry(indexDir: string): Promise<Registry> {
    try {
        const raw = await fs.promises.readFile(path.join(indexDir, REGISTRY_FILE), 'utf8');
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed as Registry : {};
    } catch {
        return {};
    }
}

async function saveRegistry(indexDir: string, registry: Registry): Promise<void> {
    await fs.promises.mkdir(indexDir, { recursive: true });
    await fs.promises.writeFile(path.join(indexDir, REGISTRY_FILE), JSON.stringify(registry));
}

export async function touchIndex(indexDir: string, csvPath: string, now: number = Date.now()): Promise<void> {
    try {
        const registry = await loadRegistry(indexDir);
        registry[path.basename(indexFilePath(indexDir, csvPath))] = {
            file: path.resolve(csvPath),
            lastUsed: now
        };
        await saveRegistry(indexDir, registry);
    } catch { /* LRU bookkeeping must never break anything */ }
}

// Deletes stale and least-recently-used index files. Best-effort: individual
// failures are swallowed — a stubborn file just survives to the next prune.
export async function pruneIndexes(
    indexDir: string,
    policy: CachePolicy,
    now: number = Date.now()
): Promise<{ removed: string[] }> {
    const removed: string[] = [];
    const registry = await loadRegistry(indexDir);
    const maxAgeMs = policy.maxAgeDays * 24 * 60 * 60 * 1000;

    // Drop registry entries whose index file vanished, and index files that
    // have no registry entry (orphans, e.g. registry was deleted).
    let diskFiles: string[] = [];
    try {
        diskFiles = (await fs.promises.readdir(indexDir)).filter(f => f.endsWith('.csvidx'));
    } catch { return { removed }; }
    for (const key of Object.keys(registry)) {
        if (!diskFiles.includes(key)) delete registry[key];
    }
    for (const f of diskFiles) {
        if (!registry[f]) registry[f] = { file: '', lastUsed: 0 };
    }

    const kill = async (name: string): Promise<void> => {
        try { await fs.promises.unlink(path.join(indexDir, name)); } catch {}
        delete registry[name];
        removed.push(name);
    };

    // Age-based cleanup first.
    for (const [name, entry] of Object.entries(registry)) {
        if (now - entry.lastUsed > maxAgeMs) await kill(name);
    }

    // Then LRU cap.
    const survivors = Object.entries(registry).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (survivors.length > policy.maxEntries) {
        const [name] = survivors.shift()!;
        await kill(name);
    }

    await saveRegistry(indexDir, registry);
    return { removed };
}
