// Static verification for the desktop frontend (Step 3).
//
// The webview bundle is built from the VS Code extension's UNMODIFIED webview
// source, and index.html must supply everything that bundle touches:
//   1. Every literal getElementById('…') in the bundle must exist in index.html
//      (a small whitelist covers ids the bundle creates dynamically itself).
//   2. Every var(--vscode-*) used by webview.css must be defined in theme.css
//      for BOTH palettes.
//   3. The IPCAdapter shim must bridge both directions (sidecar-in out,
//      sidecar-out in) and define vscodeApi.
//
// Run after `node build-frontend.mjs`:  node test/step010-frontend-assets.test.cjs

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const here = __dirname;
const desktop = path.join(here, '..');
const indexHtml = fs.readFileSync(path.join(desktop, 'index.html'), 'utf8');
const themeCss = fs.readFileSync(path.join(desktop, 'theme.css'), 'utf8');
const bundle = fs.readFileSync(path.join(desktop, 'dist', 'assets', 'webview.js'), 'utf8');
const webviewCss = fs.readFileSync(path.join(desktop, 'dist', 'assets', 'webview.css'), 'utf8');

// Ids the bundle creates dynamically at runtime (not expected in index.html).
const DYNAMIC_IDS = new Set([
    'preview-text', // created by the bootstrap for preview documents
    '_row-flash',   // created by the bundle (row highlight element)
]);

let failures = 0;
function test(name, fn) {
    try { fn(); console.log('  ✓ ' + name); }
    catch (e) { failures++; console.error('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('desktop frontend: asset completeness');

test('all static assets are built/copied', () => {
    for (const f of ['webview.js', 'webview.css', 'ag-grid-community.min.js',
                     'ag-grid.css', 'ag-theme-alpine.css', 'codicon.css', 'codicon.ttf']) {
        assert(fs.existsSync(path.join(desktop, 'dist', 'assets', f)), f + ' missing from assets/');
    }
});

test('every literal getElementById in the bundle exists in index.html', () => {
    const ids = new Set();
    for (const m of bundle.matchAll(/getElementById\((?:"([^"]+)"|'([^']+)')\)/g)) {
        ids.add(m[1] ?? m[2]);
    }
    assert(ids.size > 40, `sanity: expected 40+ ids, found ${ids.size}`);
    const missing = [...ids].filter(id =>
        !DYNAMIC_IDS.has(id) && !indexHtml.includes(`id="${id}"`));
    assert.deepStrictEqual(missing, [], 'ids missing from index.html: ' + missing.join(', '));
});

test('every var(--vscode-*) used by webview.css is defined in both palettes', () => {
    const used = new Set();
    for (const m of webviewCss.matchAll(/var\((--vscode-[a-zA-Z-]+)/g)) used.add(m[1]);
    assert(used.size > 30, `sanity: expected 30+ variables, found ${used.size}`);
    // Extract the actual rule blocks (the header comment mentions the class
    // names too, so a naive split would match the comment).
    const block = (cls) => {
        const m = themeCss.match(new RegExp('body\\.' + cls + '\\s*\\{([\\s\\S]*?)\\n\\}'));
        return m ? m[1] : '';
    };
    const darkBlock = block('vscode-dark');
    const lightBlock = block('vscode-light');
    assert(darkBlock.length > 100 && lightBlock.length > 100, 'palette blocks found');
    const missingDark = [...used].filter(v => !darkBlock.includes(v + ':'));
    const missingLight = [...used].filter(v => !lightBlock.includes(v + ':'));
    assert.deepStrictEqual(missingDark, [], 'missing in dark palette: ' + missingDark.join(', '));
    assert.deepStrictEqual(missingLight, [], 'missing in light palette: ' + missingLight.join(', '));
});

console.log('desktop frontend: IPC adapter');

test('shim defines vscodeApi and bridges both directions', () => {
    assert(indexHtml.includes('const vscodeApi ='), 'vscodeApi shim missing');
    assert(indexHtml.includes("'sidecar-in'"), 'outbound bridge missing');
    assert(indexHtml.includes("'sidecar-out'"), 'inbound bridge missing');
    assert(indexHtml.includes("new MessageEvent('message'"), 'webview message dispatch missing');
    assert(indexHtml.includes('__CSV_MOCK_TAURI__'), 'mock hook for off-Tauri testing missing');
});

test('bootstrap injects every ambient global the bundle expects', () => {
    for (const g of ['IS_PREVIEW', 'PREVIEW_MODE', 'TOTAL_LINE_COUNT', 'DELIMITER',
                     'FILENAME', 'IS_CHUNKED', 'INITIAL_ZOOM_INDEX', 'INITIAL_COLOR_MODE']) {
        assert(indexHtml.includes('const ' + g + ' ='), g + ' not injected by bootstrap');
    }
});

test('host commands wired: open, save, export, config, theme', () => {
    assert(indexHtml.includes("cmd: 'open'"), 'open command missing');
    assert(indexHtml.includes("cmd: 'save'"), 'save command missing');
    assert(indexHtml.includes("save_export_file"), 'export invoke missing');
    assert(indexHtml.includes("get_config"), 'get_config invoke missing');
    assert(indexHtml.includes("'theme-changed'"), 'theme-changed listener missing');
    assert(indexHtml.includes("'open-file'"), 'open-file listener missing');
});

test('open-file before first boot triggers openPending (menu-open regression)', () => {
    // Regression: previously the listener only reloaded when already booted,
    // so opening a file via File → Open on a freshly launched (fileless) app
    // silently did nothing and the UI stayed empty.
    const m = indexHtml.match(/listen\('open-file'[\s\S]{0,400}?\}\)/);
    assert(m, 'open-file listener found');
    assert(m[0].match(/openPending\(/), 'listener must call openPending() when not booted');
});

if (failures) { console.error('\n' + failures + ' test(s) failed'); process.exit(1); }
console.log('\nAll tests passed');
