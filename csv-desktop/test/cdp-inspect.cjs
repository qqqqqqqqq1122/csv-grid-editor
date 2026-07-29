// Attach to the WebView2 CDP endpoint of the running desktop app and dump
// frontend diagnostics: console messages, exceptions, and key window state.
// Usage: node cdp-inspect.cjs [wsUrl]
// If wsUrl is omitted it is fetched from http://localhost:9222/json.

const http = require('http');

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let d = '';
            res.on('data', (c) => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

(async () => {
    let wsUrl = process.argv[2];
    if (!wsUrl) {
        const targets = await getJson('http://localhost:9222/json');
        const page = targets.find(t => t.type === 'page');
        if (!page) { console.error('no page target'); process.exit(1); }
        wsUrl = page.webSocketDebuggerUrl;
    }

    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((resolve) => {
        const mid = ++id;
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params }));
    });

    const events = [];
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
        if (msg.method === 'Runtime.consoleAPICalled') {
            events.push(`console.${msg.params.type}: ` + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
        } else if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails;
            events.push(`EXCEPTION: ${d.text} ${d.exception?.description || ''}`);
        } else if (msg.method === 'Log.entryAdded') {
            events.push(`log[${msg.params.entry.level}]: ${msg.params.entry.text}`);
        }
    };

    await new Promise(r => ws.onopen = r);
    await send('Runtime.enable');
    await send('Log.enable');

    const evaluate = async (expr) => {
        const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        return res.result?.result?.value ?? res.result?.exceptionDetails?.text ?? '(error)';
    };

    await new Promise(r => setTimeout(r, 3000)); // let boot finish

    const report = await evaluate(`(() => ({
        title: document.title,
        hasTauri: typeof window.__TAURI__ !== 'undefined',
        hasVscodeApi: typeof vscodeApi !== 'undefined',
        boot: window.__csvBoot ? { booted: __csvBoot.booted, meta: __csvBoot.meta, config: __csvBoot.config } : null,
        pendingOpen: sessionStorage.getItem('csv-pending-open'),
        status: document.getElementById('status')?.textContent ?? null,
        overlayVisible: (() => { const o = document.getElementById('loading-overlay'); return o ? getComputedStyle(o).display : 'gone'; })(),
        gridRows: document.querySelectorAll('.ag-row').length,
        webviewScriptLoaded: [...document.scripts].some(s => s.src.includes('webview.js')),
        agGridPresent: typeof agGrid !== 'undefined'
    }))()`);

    console.log('STATE:', JSON.stringify(report, null, 2));
    console.log('EVENTS:', events.length ? events.join('\n') : '(none)');
    ws.close();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
