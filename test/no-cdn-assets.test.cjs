// Regression guard for issue #23 (grid stuck on "Loading…" with no internet):
// AG Grid and every other webview asset must be bundled locally and loaded via
// asWebviewUri, never from a CDN, so the editor works fully offline. A CDN
// <link>/<script> or a remote host in the CSP silently breaks air-gapped,
// firewalled and GFW-blocked users. This reads the webview template source and
// fails if a remote asset reference creeps back in.
//
// Run after `tsc -p ./`:  node test/no-cdn-assets.test.cjs

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview.ts'), 'utf8');

let failures = 0;
function test(name, fn) {
    try { fn(); console.log('  ✓ ' + name); }
    catch (e) { failures++; console.error('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('webview assets are bundled locally (offline-safe, issue #23)');

test('no jsdelivr CDN reference', () => {
    assert.ok(!/jsdelivr/i.test(src), 'found a jsdelivr reference');
});

test('no remote http(s) asset URL anywhere', () => {
    const m = src.match(/https?:\/\/[^\s"'`]+/);
    assert.ok(!m, 'found remote URL: ' + (m && m[0]));
});

test('AG Grid script is loaded from local media', () => {
    assert.ok(src.includes("'media', 'ag-grid-community.min.js'"), 'missing local ag-grid script URI');
});

test('AG Grid stylesheets are loaded from local media', () => {
    assert.ok(src.includes("'media', 'ag-grid.css'"), 'missing local ag-grid.css URI');
    assert.ok(src.includes("'media', 'ag-theme-alpine.css'"), 'missing local ag-theme-alpine.css URI');
});

test('CSP allows data: fonts for the bundled Alpine icon font', () => {
    const csp = src.split('\n').find(l => l.includes('Content-Security-Policy')) || '';
    assert.ok(/font-src[^;]*\bdata:/.test(csp), 'CSP font-src must allow data: (Alpine icon font is an inline woff)');
});

console.log('');
if (failures) {
    console.error(failures + ' check(s) failed');
    process.exit(1);
}
console.log('All tests passed');
