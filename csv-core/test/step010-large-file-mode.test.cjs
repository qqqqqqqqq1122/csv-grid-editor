// Test for csv-core's large-file mode decision logic (copy of the root
// extension's step010, minus the package.json contribution assertions which
// belong to the VS Code extension, not to csv-core).
//
// Run after `tsc -p ./` in csv-core:  node test/step010-large-file-mode.test.cjs

const assert = require('assert');
const { planForLargeFile, normalizeLargeFileMode, normalizeHeadRows } = require('../out/largeFileMode.js');

const THRESHOLD = 10 * 1024 * 1024; // 10 MB
const BIG = THRESHOLD + 1;
const SMALL = THRESHOLD - 1;

let failures = 0;
function test(name, fn) {
    try { fn(); console.log('  ✓ ' + name); }
    catch (e) { failures++; console.error('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('csv-core: large file mode decision logic');

test('small files always load in full regardless of mode', () => {
    for (const mode of ['ask', 'head', 'tail', 'all']) {
        assert.strictEqual(planForLargeFile(mode, SMALL, THRESHOLD), 'full', `mode ${mode}`);
    }
});

test('mode "ask" keeps the interactive picker for large files', () => {
    assert.strictEqual(planForLargeFile('ask', BIG, THRESHOLD), 'ask');
});

test('mode "head"/"tail"/"all" map to their open plans', () => {
    assert.strictEqual(planForLargeFile('head', BIG, THRESHOLD), 'head');
    assert.strictEqual(planForLargeFile('tail', BIG, THRESHOLD), 'tail');
    assert.strictEqual(planForLargeFile('all', BIG, THRESHOLD), 'full');
});

test('unknown/garbage modes (incl. legacy "prompt") fall back to ask', () => {
    for (const bad of ['nonsense', '', undefined, null, 42, 'prompt']) {
        assert.strictEqual(planForLargeFile(bad, BIG, THRESHOLD), 'ask', `value ${bad}`);
        assert.strictEqual(normalizeLargeFileMode(bad), 'ask', `value ${bad}`);
    }
});

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
