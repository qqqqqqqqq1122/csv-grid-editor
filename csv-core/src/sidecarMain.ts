// Sidecar entry point — runs csv-core as a child process of the Tauri shell
// (or standalone for tests). Protocol: newline-delimited JSON on stdin/stdout.
//
//   → stdin   {cmd:'open', path, config?}      open a CSV (creates a session)
//             {cmd:'msg', msg:{...}}           webview-protocol message
//                                              (ready / requestPage / columnSearch / edit / export / zoomChanged / colorModeChanged)
//             {cmd:'save'}                     write the document back to disk
//             {cmd:'buildIndex'}               build the byte offset index now
//             {cmd:'close'}                    dispose the current session
//             {cmd:'ping'}                     liveness probe
//
//   → stdout  {type:'opened', ...OpenMeta}     session metadata (title bar etc.)
//             webview-protocol messages        {type:'init'|'appendRows'|'streamDone'|
//                                              'streamError'|'pageData'|'columnSearchResults'|
//                                              'exportData'|'dirty'|'saved'|'saveRefused'}
//             {type:'indexBuilt'|'indexError'|'pong'|'error'}
//
// The webview-protocol messages are field-identical to what the VS Code
// extension posts, which is what lets the AG Grid frontend run unchanged.

import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { DocumentSession, SessionConfig } from './documentSession';

function send(obj: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

// App data root: %APPDATA%/csv-grid-editor-plus on Windows, ~/.config/… elsewhere.
const appDataDir = process.env.CSV_GRID_EDITOR_DATA_DIR
    || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'csv-grid-editor-plus');
const indexDir  = path.join(appDataDir, 'byte-offset-index');

// Persisted keys (zoom, colorMode) are forwarded to the host, which is the
// single writer of config.json — the sidecar never touches it directly.
function persist(key: string, value: unknown): void {
    send({ type: 'persist', key, value });
}

let session: DocumentSession | null = null;

async function handle(line: string): Promise<void> {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg.cmd !== 'string') return;

    try {
        switch (msg.cmd) {
            case 'open': {
                session?.dispose();
                const config: SessionConfig = {
                    largeFileMode: msg.config?.largeFileMode ?? 'ask',
                    headRows: msg.config?.headRows ?? 1000,
                    indexDir,
                    byteOffsetIndex: msg.config?.byteOffsetIndex ?? {},
                    chunkedThresholdBytes: msg.config?.chunkedThresholdBytes
                };
                session = new DocumentSession(send, config);
                session.onPersist = persist;
                const meta = await session.open(msg.path);
                send({ type: 'opened', ...meta });
                break;
            }
            case 'msg':
                await session?.handleMessage(msg.msg);
                break;
            case 'save':
                await session?.save();
                break;
            case 'buildIndex':
                await session?.buildIndex();
                break;
            case 'close':
                session?.dispose();
                session = null;
                break;
            case 'ping':
                send({ type: 'pong' });
                break;
        }
    } catch (err) {
        send({ type: 'error', cmd: msg.cmd, message: String(err) });
    }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
// Serialize handling per line (sessions are stateful), but don't block the
// read loop — handle() chains onto a promise queue.
let queue: Promise<void> = Promise.resolve();
rl.on('line', (line) => {
    queue = queue.then(() => handle(line)).catch(() => {});
});

send({ type: 'ready', protocol: 1 });
