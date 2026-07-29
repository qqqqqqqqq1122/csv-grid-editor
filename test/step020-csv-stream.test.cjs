// Test for the Extension Host streaming CSV engine (src/csvStream.ts), which
// powers fast-open chunk streaming and column global search.
//
// Covers:
//   1. streamCsvRecords parses byte-identically to the webview's parseCsv —
//      quoted commas, embedded newlines inside quotes, escaped quotes, CRLF,
//      unicode, and a quoted field that spans the 4 MB chunk boundary.
//   2. readFirstRecords returns exactly the first N records, and its raw text
//      re-parses to the same records (the webview re-parses that text).
//   3. searchColumnStream matches only the target column, keeps source row
//      numbers, and destroys the stream early at the match limit (scanned
//      rows << file rows).
//   4. Zero disk residue: no .idx or any other file is created by parsing.
//
// Run after `tsc -p ./`:  node test/step020-csv-stream.test.cjs

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { streamCsvRecords, readFirstRecords, searchColumnStream } = require('../out/csvStream.js');
const { parseCsv } = require('../out/webview/utils/csv.js');

let failures = 0;
function test(name, fn) {
    Promise.resolve()
        .then(fn)
        .then(() => console.log('  ✓ ' + name))
        .catch(e => { failures++; console.error('  ✗ ' + name + '\n      ' + e.message); })
        .finally(() => { if (--pending === 0) finish(); });
}

let pending = 0;
function asyncTest(name, fn) { pending++; test(name, fn); }

function finish() {
    if (failures) { console.error('\n' + failures + ' test(s) failed'); process.exit(1); }
    console.log('\nAll tests passed');
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-stream-test-'));
function fixture(name, content) {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content, 'utf8');
    return p;
}

async function collect(gen) {
    const out = [];
    for await (const r of gen) out.push(r);
    return out;
}

console.log('csv stream: parsing parity with the webview parser');

asyncTest('quoted commas, embedded newlines, escaped quotes, CRLF, unicode', async () => {
    const text =
        'name,note,city\r\n' +
        '"Doe, John","line one\nline two",北京\n' +
        '"say ""hi""",plain,"a,b\nc,d"\n' +
        'simple,row,here';   // no trailing newline
    const file = fixture('parity.csv', text);
    const streamed = await collect(streamCsvRecords(file, ','));
    assert.deepStrictEqual(streamed, parseCsv(text, ','));
});

asyncTest('quoted field spanning the 4 MB chunk boundary stays one field', async () => {
    // Valid CSV: embedded commas/newlines inside the quotes, no bare quote.
    const big = 'x'.repeat(5 * 1024 * 1024) + '\nwith, commas\nand newlines';
    const text = 'a,b\n"' + big + '",2\nlast,row\n';
    const file = fixture('chunk-boundary.csv', text);
    const streamed = await collect(streamCsvRecords(file, ','));
    assert.strictEqual(streamed.length, 3, 'header + giant row + last row');
    assert.strictEqual(streamed[1][0], big, 'giant quoted field reassembled across chunks');
    assert.strictEqual(streamed[1][1], '2');
    assert.deepStrictEqual(streamed[2], ['last', 'row']);
    // And it agrees with the webview parser on the same text.
    assert.deepStrictEqual(streamed, parseCsv(text, ','));
});

asyncTest('skipRecords skips exactly the first-screen records', async () => {
    const text = 'h1,h2\n' + Array.from({ length: 10 }, (_, i) => `r${i},v${i}`).join('\n') + '\n';
    const file = fixture('skip.csv', text);
    const streamed = await collect(streamCsvRecords(file, ',', { skipRecords: 3 }));
    assert.deepStrictEqual(streamed[0], ['r2', 'v2']);
    assert.strictEqual(streamed.length, 8); // 11 records - 3 skipped
});

asyncTest('shouldStop destroys the stream early', async () => {
    const text = 'h\n' + Array.from({ length: 10000 }, (_, i) => `row${i}`).join('\n') + '\n';
    const file = fixture('stop.csv', text);
    let count = 0;
    for await (const _ of streamCsvRecords(file, ',', { shouldStop: () => count >= 5 })) {
        count++;
    }
    assert.strictEqual(count, 5);
});

console.log('csv stream: first-screen read');

asyncTest('readFirstRecords returns N records whose text re-parses to the same', async () => {
    const text = 'h1,h2\n' + Array.from({ length: 500 }, (_, i) => `"q,${i}","multi\nline ${i}"`).join('\n') + '\n';
    const file = fixture('first.csv', text);
    const { records, text: raw } = await readFirstRecords(file, 201, ',');
    assert.strictEqual(records.length, 201);
    assert.deepStrictEqual(records[0], ['h1', 'h2']);
    assert.deepStrictEqual(records[200], [`q,199`, 'multi\nline 199']);
    // The raw text handed to the webview must re-parse to exactly these records.
    assert.deepStrictEqual(parseCsv(raw, ','), records);
});

console.log('csv stream: column global search with early truncation');

asyncTest('matches only the target column and reports source row numbers', async () => {
    const text =
        'name,note\n' +
        'alpha,"contains needle, with comma"\n' +
        'needle-in-wrong-col,plain\n' +
        '"multi\nline needle",x\n' +
        'beta,gamma\n';
    const file = fixture('search.csv', text);
    // Column 1 (note): only row 1 matches — row 2's "needle" is in the name
    // column and must NOT match, and the quoted comma must not shift columns.
    const r1 = await searchColumnStream(file, ',', 1, 'needle');
    assert.strictEqual(r1.rows.length, 1);
    assert.deepStrictEqual(r1.origIndexes, [1]);
    assert.strictEqual(r1.truncated, false);
    // Column 0 (name): row 2 and the embedded-newline row 3 match.
    const r0 = await searchColumnStream(file, ',', 0, 'needle');
    assert.strictEqual(r0.rows.length, 2);
    assert.deepStrictEqual(r0.origIndexes, [2, 3]);
    assert.strictEqual(r0.rows[1][0], 'multi\nline needle');
});

asyncTest('search is case-insensitive and tolerates missing cells', async () => {
    const file = fixture('case.csv', 'a,b\nNeedle,x\nshort\n');
    const r = await searchColumnStream(file, ',', 0, 'needle');
    assert.strictEqual(r.rows.length, 1);
    const rMissing = await searchColumnStream(file, ',', 5, 'needle'); // col beyond row length
    assert.strictEqual(rMissing.rows.length, 0);
});

asyncTest('stops reading after the match limit (stream destroyed early)', async () => {
    const total = 20000;
    const text = 'k\n' + Array.from({ length: total }, (_, i) => `needle-${i}`).join('\n') + '\n';
    const file = fixture('truncate.csv', text);
    const r = await searchColumnStream(file, ',', 0, 'needle', 1000);
    assert.strictEqual(r.rows.length, 1000);
    assert.strictEqual(r.truncated, true);
    assert.deepStrictEqual(r.origIndexes[999], 1000);
    // Early truncation: far fewer records scanned than the file holds.
    assert(r.scanned <= 1001 + 1, `scanned ${r.scanned} should stop right after the 1000th match`);
});

asyncTest('no limit hit → truncated is false even with exactly N matches', async () => {
    const file = fixture('exact.csv', 'k\n' + Array.from({ length: 3 }, (_, i) => `needle-${i}`).join('\n') + '\n');
    const r = await searchColumnStream(file, ',', 0, 'needle', 1000);
    assert.strictEqual(r.rows.length, 3);
    assert.strictEqual(r.truncated, false);
});

console.log('csv stream: fast-open contract (first screen + pump = full file)');

asyncTest('first-screen text + skipped pump reassemble the file with no dup or gap', async () => {
    const FIRST = 201; // header + 200 data rows, as in csvEditorProvider
    const text = 'h1,h2\n' + Array.from({ length: 500 },
        (_, i) => `"q,${i}","multi\nline ${i}"`).join('\n') + '\n';
    const file = fixture('contract.csv', text);

    // What openCustomDocument does:
    const first = await readFirstRecords(file, FIRST, ',');
    // What pumpStream does (skip the first-screen records, accumulate raw text):
    let pumpedText = '';
    const rest = await collect(streamCsvRecords(file, ',', {
        skipRecords: FIRST,
        onChunkText: (t) => { pumpedText += t; }
    }));

    // The webview sees parseCsv(first.text) then appends `rest` — together they
    // must equal parsing the whole file, no duplicated or missing rows.
    const rendered = [...parseCsv(first.text, ','), ...rest];
    assert.deepStrictEqual(rendered, parseCsv(text, ','));
    // And the pump's accumulated raw text must equal the file byte-for-byte.
    assert.strictEqual(pumpedText, text);
});

console.log('csv stream: zero disk residue');

asyncTest('parsing creates no files (.idx or otherwise)', async () => {
    const file = fixture('residue.csv', 'a\n1\n2\n');
    const before = fs.readdirSync(tmpDir).sort();
    await collect(streamCsvRecords(file, ','));
    await searchColumnStream(file, ',', 0, '1');
    const after = fs.readdirSync(tmpDir).sort();
    assert.deepStrictEqual(after, before);
    assert(!after.some(f => f.endsWith('.idx')), 'no .idx cache file may appear');
});

process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
