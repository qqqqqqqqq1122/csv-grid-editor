// Test for the optional Byte Offset Index cache layer (src/byteOffsetIndex.ts).
//
// Covers:
//   1. buildIndexOffsets records the true byte offset of every record start —
//      quote-aware (embedded newlines inside quotes don't shift offsets),
//      CRLF-safe, unicode-safe (offsets are BYTES, not chars).
//   2. writeIndex → readIndex roundtrip: reused only when size AND mtime
//      match; content fingerprint catches same-size same-mtime edits.
//   3. Offsets enable O(1) random access: slicing the file at index offsets
//      yields exactly the record the webview parser would produce.
//   4. LRU cache management: max-entries eviction, age-based cleanup, orphan
//      handling — all inside the index dir, never next to the CSV.
//
// Run after `tsc -p ./`:  node test/step030-byte-offset-index.test.cjs

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    indexFilePath, buildIndexOffsets, writeIndex, readIndex,
    pruneIndexes, touchIndex
} = require('../out/byteOffsetIndex.js');
const { parseCsv } = require('../../out/webview/utils/csv.js');

let failures = 0;
let pending = 0;
function asyncTest(name, fn) {
    pending++;
    Promise.resolve()
        .then(fn)
        .then(() => console.log('  ✓ ' + name))
        .catch(e => { failures++; console.error('  ✗ ' + name + '\n      ' + e.message); })
        .finally(() => { if (--pending === 0) finish(); });
}
function finish() {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (failures) { console.error('\n' + failures + ' test(s) failed'); process.exit(1); }
    console.log('\nAll tests passed');
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-idx-test-'));
const indexDir = path.join(tmpDir, 'index-store');
const csvDir = path.join(tmpDir, 'user-data'); // simulates the user's data dir
fs.mkdirSync(csvDir);

function writeCsv(name, content) {
    const p = path.join(csvDir, name);
    fs.writeFileSync(p, content, 'utf8');
    return p;
}

// Read the raw bytes of record i using the index offsets.
function recordBytes(filePath, offsets, i) {
    const start = Number(offsets[i]);
    const end = i + 1 < offsets.length ? Number(offsets[i + 1]) : fs.statSync(filePath).size;
    const buf = Buffer.alloc(end - start);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
}

console.log('byte offset index: build');

asyncTest('offsets point at real record starts (quotes, CRLF, unicode)', async () => {
    const text =
        'name,note\r\n' +
        '"Doe, John","line one\nline two"\n' +
        '北京,"escaped ""quote"" here"\r\n' +
        'plain,simple';
    const file = writeCsv('offsets.csv', text);
    const { offsets, totalRows, headerLine } = await buildIndexOffsets(file, ',');

    assert.strictEqual(headerLine, 'name,note');
    assert.strictEqual(totalRows, 3);
    assert.strictEqual(Number(offsets[0]), 0);

    // Each slice must re-parse (webview parser) to exactly one record.
    const expected = parseCsv(text, ',');
    assert.strictEqual(offsets.length, expected.length);
    for (let i = 0; i < offsets.length; i++) {
        const slice = recordBytes(file, offsets, i);
        const parsed = parseCsv(slice, ',');
        assert.strictEqual(parsed.length, 1, `record ${i} should be one record`);
        assert.deepStrictEqual(parsed[0], expected[i], `record ${i} content`);
    }
});

asyncTest('no trailing-newline and trailing-newline files both index cleanly', async () => {
    const a = writeCsv('noeol.csv', 'h\n1\n2');
    const ra = await buildIndexOffsets(a, ',');
    assert.strictEqual(ra.totalRows, 2);
    assert.strictEqual(Number(ra.offsets[2]), 4);

    const b = writeCsv('eol.csv', 'h\n1\n2\n');
    const rb = await buildIndexOffsets(b, ',');
    assert.strictEqual(rb.totalRows, 2);
    assert.strictEqual(rb.offsets.length, 3, 'no bogus record start at EOF');
});

console.log('byte offset index: store / validate / reuse');

asyncTest('roundtrip: reused when size and mtime match', async () => {
    const file = writeCsv('roundtrip.csv', 'a,b\n1,2\n3,4\n');
    const stat = fs.statSync(file);
    const built = await buildIndexOffsets(file, ',');
    const idxPath = await writeIndex(indexDir, file, ',', built, { size: stat.size, mtimeMs: stat.mtimeMs });

    assert.strictEqual(path.dirname(idxPath), indexDir, 'index lives in the store dir');
    assert(!fs.readdirSync(csvDir).some(f => f.includes('idx')), 'user data dir stays clean');

    const loaded = await readIndex(indexDir, file, { size: stat.size, mtimeMs: stat.mtimeMs });
    assert(loaded, 'index should be reused');
    assert.strictEqual(loaded.totalRows, 2);
    assert.strictEqual(loaded.headerLine, 'a,b');
    assert.strictEqual(loaded.delimiter, ',');
    assert.deepStrictEqual([...loaded.offsets].map(Number), [...built.offsets].map(Number));
});

asyncTest('stale on size change → null (caller falls back to streaming)', async () => {
    const file = writeCsv('size-change.csv', 'a\n1\n');
    const stat = fs.statSync(file);
    await writeIndex(indexDir, file, ',', await buildIndexOffsets(file, ','), { size: stat.size, mtimeMs: stat.mtimeMs });

    fs.appendFileSync(file, '2\n3\n');
    const stat2 = fs.statSync(file);
    const loaded = await readIndex(indexDir, file, { size: stat2.size, mtimeMs: stat2.mtimeMs });
    assert.strictEqual(loaded, null);
});

asyncTest('stale on mtime change → null', async () => {
    const file = writeCsv('mtime-change.csv', 'a\n1\n');
    const stat = fs.statSync(file);
    await writeIndex(indexDir, file, ',', await buildIndexOffsets(file, ','), { size: stat.size, mtimeMs: stat.mtimeMs });

    const past = new Date(stat.mtimeMs - 60000);
    fs.utimesSync(file, past, past);
    const loaded = await readIndex(indexDir, file, { size: stat.size, mtimeMs: past.getTime() });
    assert.strictEqual(loaded, null);
});

asyncTest('fingerprint catches same-size same-mtime edits', async () => {
    const file = writeCsv('fingerprint.csv', 'a\nfoo\n');
    const stat = fs.statSync(file);
    await writeIndex(indexDir, file, ',', await buildIndexOffsets(file, ','), { size: stat.size, mtimeMs: stat.mtimeMs });

    // Same length, same mtime, different content. utimesSync takes float
    // seconds so the fractional-millisecond mtime round-trips.
    fs.writeFileSync(file, 'a\nbar\n');
    fs.utimesSync(file, stat.atimeMs / 1000, stat.mtimeMs / 1000);
    const stat2 = fs.statSync(file);
    assert.strictEqual(stat2.size, stat.size);

    const strict = await readIndex(indexDir, file, { size: stat2.size, mtimeMs: stat2.mtimeMs }, true);
    assert.strictEqual(strict, null, 'fingerprint mismatch must invalidate');
    const lax = await readIndex(indexDir, file, { size: stat2.size, mtimeMs: stat2.mtimeMs }, false);
    assert(lax, 'with fingerprint verification off, size+mtime suffice');
});

asyncTest('missing or garbage index files read as null', async () => {
    const missing = path.join(csvDir, 'never-indexed.csv');
    fs.writeFileSync(missing, 'a\n1\n');
    assert.strictEqual(await readIndex(indexDir, missing, fs.statSync(missing)), null);

    fs.mkdirSync(indexDir, { recursive: true });
    const file = writeCsv('garbage.csv', 'a\n1\n');
    fs.writeFileSync(indexFilePath(indexDir, file), 'not an index at all');
    assert.strictEqual(await readIndex(indexDir, file, fs.statSync(file)), null);
});

console.log('byte offset index: LRU cache management');

asyncTest('evicts least-recently-used beyond maxEntries', async () => {
    const dir = path.join(tmpDir, 'lru-store');
    // 5 indexes, oldest first.
    for (let i = 0; i < 5; i++) {
        const f = writeCsv(`lru-${i}.csv`, `h${i}\n${i}\n`);
        const st = fs.statSync(f);
        await writeIndex(dir, f, ',', await buildIndexOffsets(f, ','), { size: st.size, mtimeMs: st.mtimeMs });
        await touchIndex(dir, f, 1000 + i); // ascending lastUsed
    }
    // Touch lru-0 so it becomes recently used; lru-1 is now the oldest.
    await touchIndex(dir, writeCsv('lru-0.csv', 'h0\n0\n'), 9999);

    const { removed } = await pruneIndexes(dir, { maxEntries: 3, maxAgeDays: 30 }, 10000);
    const left = fs.readdirSync(dir).filter(f => f.endsWith('.csvidx'));
    assert.strictEqual(left.length, 3);
    assert(removed.includes(path.basename(indexFilePath(dir, writeCsv('lru-1.csv', 'h1\n1\n')))), 'LRU victim = lru-1');
    assert(left.includes(path.basename(indexFilePath(dir, writeCsv('lru-0.csv', 'h0\n0\n')))), 'recently touched survives');
});

asyncTest('age-based cleanup removes stale indexes even under the cap', async () => {
    const dir = path.join(tmpDir, 'age-store');
    const old = writeCsv('old.csv', 'h\n1\n');
    const fresh = writeCsv('fresh.csv', 'h\n2\n');
    for (const f of [old, fresh]) {
        const st = fs.statSync(f);
        await writeIndex(dir, f, ',', await buildIndexOffsets(f, ','), { size: st.size, mtimeMs: st.mtimeMs });
    }
    const DAY = 24 * 60 * 60 * 1000;
    const NOW = 100 * DAY;
    await touchIndex(dir, old, 0);               // last used 100 days ago
    await touchIndex(dir, fresh, NOW - 5 * DAY); // last used 5 days ago

    const { removed } = await pruneIndexes(dir, { maxEntries: 10, maxAgeDays: 30 }, NOW);
    assert(removed.includes(path.basename(indexFilePath(dir, old))), 'stale index removed');
    const left = fs.readdirSync(dir).filter(f => f.endsWith('.csvidx'));
    assert.deepStrictEqual(left, [path.basename(indexFilePath(dir, fresh))]);
});

asyncTest('prune drops registry entries for deleted files and orphan idx files', async () => {
    const dir = path.join(tmpDir, 'orphan-store');
    const f = writeCsv('orphan.csv', 'h\n1\n');
    const st = fs.statSync(f);
    await writeIndex(dir, f, ',', await buildIndexOffsets(f, ','), { size: st.size, mtimeMs: st.mtimeMs });
    // Simulate a deleted index file with a lingering registry entry.
    fs.unlinkSync(indexFilePath(dir, f));
    // And an orphan idx file with no registry entry.
    fs.writeFileSync(path.join(dir, 'deadbeef.csvidx'), Buffer.alloc(100));

    const { removed } = await pruneIndexes(dir, { maxEntries: 10, maxAgeDays: 30 }, Date.now());
    assert(removed.includes('deadbeef.csvidx'), 'orphan idx (lastUsed=0) is pruned as stale');
    assert.strictEqual(fs.readdirSync(dir).filter(x => x.endsWith('.csvidx')).length, 0);
});

asyncTest('user data dir never gains files across the whole lifecycle', async () => {
    // Dedicated dir: other tests in this file run concurrently and share csvDir.
    const ownDir = path.join(tmpDir, 'lifecycle-data');
    fs.mkdirSync(ownDir);
    const f = path.join(ownDir, 'lifecycle.csv');
    fs.writeFileSync(f, 'a\n1\n2\n');
    const st = fs.statSync(f);
    await writeIndex(indexDir, f, ',', await buildIndexOffsets(f, ','), { size: st.size, mtimeMs: st.mtimeMs });
    await readIndex(indexDir, f, { size: st.size, mtimeMs: st.mtimeMs });
    await pruneIndexes(indexDir, { maxEntries: 10, maxAgeDays: 30 });
    assert.deepStrictEqual(fs.readdirSync(ownDir), ['lifecycle.csv']);
});
