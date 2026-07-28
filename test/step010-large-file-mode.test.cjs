// Test for the configurable large-file mode feature.
//
// Verifies two things:
//   1. package.json contributes the full setting surface the feature needs:
//      csvGridEditor.largeFileMode enum = [ask, head, tail, all],
//      csvGridEditor.headRows default = 1000, and the
//      csvGridEditor.setLargeFileMode command (Command Palette + editor
//      context menu).
//   2. The decision logic in out/largeFileMode.js (compiled from
//      src/largeFileMode.ts) maps every mode to the correct open plan:
//      ask -> interactive picker, head/tail -> preview, all -> full load,
//      small files always load in full, unknown values fall back to ask.
//
// Run after `npm run compile` (or `tsc -p ./`):  node test/step010-large-file-mode.test.cjs

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { planForLargeFile, normalizeLargeFileMode, normalizeHeadRows } = require('../out/largeFileMode.js');

const THRESHOLD = 10 * 1024 * 1024; // 10 MB, mirrors LARGE_FILE_THRESHOLD
const BIG = THRESHOLD + 1;
const SMALL = THRESHOLD - 1;

let failures = 0;
function test(name, fn) {
    try { fn(); console.log('  ✓ ' + name); }
    catch (e) { failures++; console.error('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('large file mode: package.json contributions');

test('largeFileMode enum offers ask, head, tail and all', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const prop = pkg.contributes.configuration.properties['csvGridEditor.largeFileMode'];
    assert(prop, 'csvGridEditor.largeFileMode setting is contributed');
    assert.deepStrictEqual(prop.enum, ['ask', 'head', 'tail', 'all']);
    assert.strictEqual(prop.default, 'ask');
});

test('headRows setting is contributed with default 1000', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const prop = pkg.contributes.configuration.properties['csvGridEditor.headRows'];
    assert(prop, 'csvGridEditor.headRows setting is contributed');
    assert.strictEqual(prop.default, 1000);
});

test('setLargeFileMode command is contributed (Command Palette + right-click)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const cmd = (pkg.contributes.commands || []).find(c => c.command === 'csvGridEditor.setLargeFileMode');
    assert(cmd, 'csvGridEditor.setLargeFileMode command is contributed');
    const ctx = (pkg.contributes.menus || {})['editor/context'] || [];
    assert(ctx.some(e => e.command === 'csvGridEditor.setLargeFileMode'),
        'command is also exposed in the editor right-click menu');
});

console.log('large file mode: open-plan decision logic');

test('small files always load in full regardless of mode', () => {
    for (const mode of ['ask', 'head', 'tail', 'all']) {
        assert.strictEqual(planForLargeFile(mode, SMALL, THRESHOLD), 'full', `mode ${mode}`);
    }
});

test('mode "ask" keeps the interactive picker for large files (original behavior)', () => {
    assert.strictEqual(planForLargeFile('ask', BIG, THRESHOLD), 'ask');
});

test('mode "head" opens a head preview directly, no picker', () => {
    assert.strictEqual(planForLargeFile('head', BIG, THRESHOLD), 'head');
});

test('mode "tail" opens a tail preview directly, no picker', () => {
    assert.strictEqual(planForLargeFile('tail', BIG, THRESHOLD), 'tail');
});

test('mode "all" loads the full file directly, no picker', () => {
    assert.strictEqual(planForLargeFile('all', BIG, THRESHOLD), 'full');
});

test('unknown/garbage modes (incl. legacy "prompt") fall back to ask', () => {
    for (const bad of ['nonsense', '', undefined, null, 42, 'prompt']) {
        assert.strictEqual(planForLargeFile(bad, BIG, THRESHOLD), 'ask', `value ${bad}`);
        assert.strictEqual(normalizeLargeFileMode(bad), 'ask', `value ${bad}`);
    }
});

console.log('large file mode: headRows normalization');

test('headRows accepts positive integers and floors fractions', () => {
    assert.strictEqual(normalizeHeadRows(1000, 1000), 1000);
    assert.strictEqual(normalizeHeadRows(2500.9, 1000), 2500);
    assert.strictEqual(normalizeHeadRows('500', 1000), 500);
});

test('headRows rejects zero, negatives and NaN with the fallback', () => {
    for (const bad of [0, -5, NaN, 'abc', undefined, null]) {
        assert.strictEqual(normalizeHeadRows(bad, 1000), 1000, `value ${bad}`);
    }
});

if (failures) { console.error('\n' + failures + ' test(s) failed'); process.exit(1); }
console.log('\nAll tests passed');
