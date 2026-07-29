// Pure decision logic for how large CSV files are opened, driven by the
// `csvGridEditor.largeFileMode` / `csvGridEditor.headRows` settings. Kept free
// of the `vscode` API so it can be unit-tested with plain Node
// (see test/step010-large-file-mode.test.cjs).

export type LargeFileMode = 'ask' | 'head' | 'tail' | 'all';
export type OpenPlan = 'full' | 'head' | 'tail' | 'ask';

export const LARGE_FILE_MODES: LargeFileMode[] = ['ask', 'head', 'tail', 'all'];

// Any value that is not one of the four supported modes falls back to 'ask'
// (the original interactive behavior) so a stale/typo'd setting never silently
// picks a destructive default. The legacy value 'prompt' maps to 'ask' too.
export function normalizeLargeFileMode(value: unknown): LargeFileMode {
    if (value === 'head' || value === 'tail' || value === 'all') return value;
    return 'ask';
}

// Decide how to open a file of `fileSize` bytes given the configured mode.
// Files at or under the threshold always load in full — the setting only
// governs genuinely large files.
export function planForLargeFile(mode: unknown, fileSize: number, thresholdBytes: number): OpenPlan {
    if (fileSize <= thresholdBytes) return 'full';
    const m = normalizeLargeFileMode(mode);
    if (m === 'all') return 'full';
    if (m === 'head') return 'head';
    if (m === 'tail') return 'tail';
    return 'ask';
}

// `csvGridEditor.headRows` must be a positive integer; anything else falls
// back to the built-in default so the preview never degenerates to 0 rows.
export function normalizeHeadRows(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.floor(n);
}
