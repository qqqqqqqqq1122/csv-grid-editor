// Pure decision logic for how large CSV files are opened, driven by the
// `csvGridEditor.largeFileMode` / `csvGridEditor.headRows` settings. Kept free
// of the `vscode` API so it can be unit-tested with plain Node
// (see test/step010-large-file-mode.test.cjs).

export type LargeFileMode = 'ask' | 'head' | 'tail' | 'all' | 'full' | 'chunked' | 'plaintext';
export type OpenPlan = 'full' | 'head' | 'tail' | 'chunked' | 'plaintext' | 'ask';

export const LARGE_FILE_MODES: LargeFileMode[] = ['ask', 'head', 'tail', 'all', 'full', 'chunked', 'plaintext'];

// Any value that is not one of the supported modes falls back to 'ask' (the
// desktop auto behavior) so a stale/typo'd setting never silently picks a
// destructive default. The legacy value 'prompt' maps to 'ask' too, and
// 'all' remains supported as an alias for 'full'.
export function normalizeLargeFileMode(value: unknown): LargeFileMode {
    if (value === 'head') return 'head';
    if (value === 'tail') return 'tail';
    if (value === 'all') return 'all';
    if (value === 'full') return 'full';
    if (value === 'chunked') return 'chunked';
    if (value === 'plaintext') return 'plaintext';
    return 'ask';
}

// Decide how to open a file of `fileSize` bytes given the configured mode.
// Files at or under the threshold always load in full — the setting only
// governs genuinely large files.
export function planForLargeFile(mode: unknown, fileSize: number, thresholdBytes: number): OpenPlan {
    if (fileSize <= thresholdBytes) return 'full';
    const m = normalizeLargeFileMode(mode);
    if (m === 'all' || m === 'full') return 'full';
    if (m === 'head') return 'head';
    if (m === 'tail') return 'tail';
    if (m === 'chunked') return 'chunked';
    if (m === 'plaintext') return 'plaintext';
    return 'ask';
}

// `csvGridEditor.headRows` must be a positive integer; anything else falls
// back to the built-in default so the preview never degenerates to 0 rows.
export function normalizeHeadRows(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.floor(n);
}
