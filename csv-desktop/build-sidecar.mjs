// Bundles the csv-core sidecar into a single CJS file and stages the Node.js
// runtime next to it. Tauri ships both as bundle resources and spawns
// `node.exe main.js` as the csv-core child process.
//
// Usage: node build-sidecar.mjs

import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const coreSrc = path.join(here, '..', 'csv-core', 'src', 'sidecarMain.ts');
const outDir = path.join(here, 'sidecar');

fs.mkdirSync(outDir, { recursive: true });

await esbuild.build({
    entryPoints: [coreSrc],
    bundle: true,
    outfile: path.join(outDir, 'main.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'info'
});

// Stage the Node runtime (build machine's own interpreter).
fs.copyFileSync(process.execPath, path.join(outDir, 'node.exe'));

console.log('sidecar ready in ' + outDir);
