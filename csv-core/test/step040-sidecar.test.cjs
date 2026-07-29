// End-to-end smoke test for the csv-core sidecar (src/sidecarMain.ts).
// Spawns the sidecar as a child process and drives the real NDJSON protocol:
// open → ready → init/appendRows/streamDone → columnSearch → paged view →
// save — asserting the behaviour matches the VS Code extension's semantics.
//
// Run after `tsc -p ./` in csv-core:  node test/step040-sidecar.test.cjs

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { parseCsv } = require('../../out/webview/utils/csv.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-sidecar-test-'));
const dataDir = path.join(tmpDir, 'appdata'); // CSV_GRID_EDITOR_DATA_DIR override
const indexDir = path.join(dataDir, 'byte-offset-index');

// ── Fixtures ──
const smallCsv = path.join(tmpDir, 'small.csv');
fs.writeFileSync(smallCsv, 'a,b\n1,2\n3,4\n');

// Clean >10 MB file: no embedded newlines, so physical lines == records and
// the (line-based) legacy page index stays exact.
const BIG_ROWS = 30000;
const bigCsv = path.join(tmpDir, 'big.csv');
{
    const pad = 'p'.repeat(380); // push the file past the 10 MB large-file threshold
    const parts = ['id,name,note,pad'];
    for (let i = 0; i < BIG_ROWS; i++) {
        parts.push(`row-${i},"name, ${i}",note ${i},${pad}`);
    }
    fs.writeFileSync(bigCsv, parts.join('\n') + '\n');
}
assert(fs.statSync(bigCsv).size > 10 * 1024 * 1024, 'big.csv must exceed 10 MB');

// Small file with quoted multi-line cells for parser-correctness searches.
const multiCsv = path.join(tmpDir, 'multiline.csv');
{
    const parts = ['id,note'];
    for (let i = 0; i < 6000; i++) {
        parts.push(i === 5000 ? `m-${i},"multi\nline ${i}"` : `m-${i},plain ${i}`);
    }
    fs.writeFileSync(multiCsv, parts.join('\n') + '\n');
}

// ── Sidecar harness ──
const child = spawn(process.execPath, [path.join(__dirname, '..', 'out', 'sidecarMain.js')], {
    env: { ...process.env, CSV_GRID_EDITOR_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'inherit']
});

const received = [];
const waiters = [];
const taps = []; // persistent listeners: { type, fn } — fire on EVERY matching message
let lineBuf = '';
child.stdout.on('data', (chunk) => {
    lineBuf += chunk.toString('utf8');
    let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        for (const t of taps) if (t.type === msg.type) t.fn(msg);
        const wi = waiters.findIndex(w => w.type === msg.type);
        if (wi >= 0) waiters.splice(wi, 1)[0].resolve(msg);
        else received.push(msg);
    }
});

function send(obj) {
    child.stdin.write(JSON.stringify(obj) + '\n');
}

function waitFor(type, timeoutMs = 60000) {
    const i = received.findIndex(m => m.type === type);
    if (i >= 0) return Promise.resolve(received.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for "${type}"`)), timeoutMs);
        waiters.push({ type, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
}

async function openFile(filePath, config = {}) {
    send({ cmd: 'open', path: filePath, config });
    return waitFor('opened');
}

function webviewMsg(msg) {
    send({ cmd: 'msg', msg });
}

let failures = 0;
async function test(name, fn) {
    try { await fn(); console.log('  ✓ ' + name); }
    catch (e) { failures++; console.error('  ✗ ' + name + '\n      ' + e.message); }
}

(async () => {
    console.log('sidecar: protocol and small-file open');

    await waitFor('ready'); // protocol banner

    await test('open small file → init with all rows, no streaming', async () => {
        const meta = await openFile(smallCsv);
        assert.strictEqual(meta.streaming, false);
        assert.strictEqual(meta.isPreview, false);
        assert.strictEqual(meta.delimiter, ',');
        webviewMsg({ type: 'ready' });
        const init = await waitFor('init');
        assert.strictEqual(parseCsv(init.text, ',').length, 3);
    });

    await test('edit + save writes the file back', async () => {
        webviewMsg({ type: 'edit', text: 'a,b\n9,9\n8,8\n' });
        await waitFor('dirty');
        send({ cmd: 'save' });
        await waitFor('saved');
        assert.strictEqual(fs.readFileSync(smallCsv, 'utf8'), 'a,b\n9,9\n8,8\n');
    });

    console.log('sidecar: fast-open streaming on a >10 MB file');

    await test('streaming: first screen 201 records, appends to full file, streamDone', async () => {
        const meta = await openFile(bigCsv, { largeFileMode: 'all', byteOffsetIndex: { enabled: false } });
        assert.strictEqual(meta.streaming, true);
        assert.strictEqual(meta.isPreview, false);

        // Tap every batch BEFORE ready triggers the pump. The sidecar emits
        // all appendRows before streamDone, so after streamDone the tap's
        // totals are final — no races.
        let appended = 0;
        let lastBatch = null;
        const tap = { type: 'appendRows', fn: (m) => { appended += m.rows.length; lastBatch = m; } };
        taps.push(tap);

        webviewMsg({ type: 'ready' });
        const init = await waitFor('init');
        assert.strictEqual(init.streaming, true);
        assert.strictEqual(parseCsv(init.text, ',').length, 201, 'header + 200 first-screen rows');

        await waitFor('streamDone');
        taps.splice(taps.indexOf(tap), 1);

        assert.strictEqual(appended, BIG_ROWS - 200, 'all remaining rows streamed');
        const last = lastBatch.rows[lastBatch.rows.length - 1];
        assert.strictEqual(last[0], `row-${BIG_ROWS - 1}`);
        assert.strictEqual(last[1], `name, ${BIG_ROWS - 1}`);
    });

    await test('column search: exact match with source row number', async () => {
        webviewMsg({ type: 'columnSearch', colIndex: 0, colName: 'id', query: `row-${BIG_ROWS - 1}` });
        const r = await waitFor('columnSearchResults');
        assert.strictEqual(r.rows.length, 1);
        assert.deepStrictEqual(r.origIndexes, [BIG_ROWS], 'row-N is data row N+1 (header = record 0)');
        assert.strictEqual(r.truncated, false);
    });

    await test('column search: 1000-match truncation with early stream destroy', async () => {
        webviewMsg({ type: 'columnSearch', colIndex: 0, colName: 'id', query: 'row-' });
        const r = await waitFor('columnSearchResults');
        assert.strictEqual(r.rows.length, 1000);
        assert.strictEqual(r.truncated, true);
        assert(r.scanned <= 1002, `scanned ${r.scanned} should stop right after the 1000th match`);
    });

    await test('column search: quoted multi-line cells parse correctly', async () => {
        await openFile(multiCsv);
        webviewMsg({ type: 'columnSearch', colIndex: 1, colName: 'note', query: 'multi\nline 5000' });
        const r = await waitFor('columnSearchResults');
        assert.strictEqual(r.rows.length, 1);
        assert.deepStrictEqual(r.origIndexes, [5001]);
        assert.strictEqual(r.rows[0][1], 'multi\nline 5000');
    });

    console.log('sidecar: head preview and paged view');

    await test('head mode: preview metadata + headRows rows', async () => {
        const meta = await openFile(bigCsv, { largeFileMode: 'head', headRows: 500, byteOffsetIndex: { enabled: false } });
        assert.strictEqual(meta.isPreview, true);
        assert.strictEqual(meta.previewMode, 'head');
        // countLines counts '\n' chars + 1 — a file that ENDS with a newline
        // is therefore reported one line high (same quirk as the extension).
        assert.strictEqual(meta.totalLineCount, BIG_ROWS + 2);
        webviewMsg({ type: 'ready' });
        const init = await waitFor('init');
        assert.strictEqual(parseCsv(init.text, ',').length, 501);
    });

    await test('save refused in preview mode', async () => {
        send({ cmd: 'save' });
        const r = await waitFor('saveRefused');
        assert(/preview/i.test(r.reason));
    });

    await test('ask mode on a huge file → paged view with page navigation', async () => {
        const meta = await openFile(bigCsv, {
            largeFileMode: 'ask',
            chunkedThresholdBytes: 1 * 1024 * 1024, // test hook: pretend >50MB is >1MB
            byteOffsetIndex: { enabled: false }
        });
        assert.strictEqual(meta.isChunked, true);
        assert.strictEqual(meta.isPreview, true);

        webviewMsg({ type: 'ready' });
        await waitFor('init');
        const pd = await waitFor('pageData');
        assert.strictEqual(pd.pageNumber, 0);
        assert.strictEqual(pd.totalPages, Math.ceil(BIG_ROWS / 500));

        webviewMsg({ type: 'requestPage', pageNumber: 1 });
        const p1 = await waitFor('pageData');
        assert.strictEqual(p1.pageNumber, 1);
        const rows = parseCsv(p1.text, ',');
        assert.strictEqual(rows[1][0], 'row-500', 'page 2 starts at data row 500');
    });

    console.log('sidecar: byte offset index auto-build');

    await test('index auto-built after openThreshold opens, never on first', async () => {
        const cfg = {
            largeFileMode: 'ask',
            chunkedThresholdBytes: 1 * 1024 * 1024,
            byteOffsetIndex: { openThreshold: 2, verifyFingerprint: true }
        };
        await openFile(bigCsv, cfg); // open #1 → count 1, no build
        await new Promise(r => setTimeout(r, 500));
        assert(!fs.existsSync(indexDir) || fs.readdirSync(indexDir).filter(f => f.endsWith('.csvidx')).length === 0,
            'no index after first open');

        await openFile(bigCsv, cfg); // open #2 → threshold hit → background build
        let found = false;
        for (let i = 0; i < 40 && !found; i++) {
            await new Promise(r => setTimeout(r, 250));
            found = fs.existsSync(indexDir) && fs.readdirSync(indexDir).some(f => f.endsWith('.csvidx'));
        }
        assert(found, 'index file should appear after the threshold open');
    });

    child.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    if (failures) { console.error('\n' + failures + ' test(s) failed'); process.exit(1); }
    console.log('\nAll tests passed');
    process.exit(0);
})().catch(e => { console.error(e); child.kill(); process.exit(1); });
