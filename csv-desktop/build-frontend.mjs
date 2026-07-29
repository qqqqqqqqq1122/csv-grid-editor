// Builds the desktop frontend by reusing the VS Code extension's webview
// SOURCE (../src/webview/index.ts) verbatim — no copies, no edits. The bundle
// expects a handful of ambient globals (vscodeApi, IS_PREVIEW, …) which
// index.html injects at runtime via the IPCAdapter shim.
//
// Usage: node build-frontend.mjs

import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const dist = path.join(here, 'dist');
const assets = path.join(dist, 'assets');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(assets, { recursive: true });

await esbuild.build({
    entryPoints: [path.join(root, 'src', 'webview', 'index.ts')],
    bundle: true,
    outfile: path.join(assets, 'webview.js'),
    platform: 'browser',
    target: 'es2020',
    logLevel: 'info'
});

// Static assets produced by the extension's own copy-assets step.
for (const f of [
    'webview.css',
    'ag-grid-community.min.js',
    'ag-grid.css',
    'ag-theme-alpine.css',
    'codicon.css',
    'codicon.ttf'
]) {
    fs.copyFileSync(path.join(root, 'media', f), path.join(assets, f));
}

// dist/ is the Tauri frontendDist — everything the app serves, nothing else.
fs.copyFileSync(path.join(here, 'index.html'), path.join(dist, 'index.html'));
fs.copyFileSync(path.join(here, 'theme.css'), path.join(dist, 'theme.css'));

console.log('frontend dist ready in ' + dist);
