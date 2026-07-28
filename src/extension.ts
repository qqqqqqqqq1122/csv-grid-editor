import * as vscode from 'vscode';
import { CsvEditorProvider } from './csvEditorProvider';
import { normalizeHeadRows } from './largeFileMode';

const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024; // 10 MB — mirrors csvEditorProvider

interface ModePickItem extends vscode.QuickPickItem {
    id: 'ask' | 'head' | 'tail' | 'all';
}

// Switches the `csvGridEditor.largeFileMode` user setting from the Command
// Palette (Ctrl+Shift+P) or the editor right-click menu, then offers to reopen
// the active CSV tab so the new mode applies immediately.
async function setLargeFileMode(): Promise<void> {
    const config = vscode.workspace.getConfiguration('csvGridEditor');
    const current = config.get<string>('largeFileMode', 'ask');
    const headRows = normalizeHeadRows(config.get<number>('headRows', 1000), 1000);

    const items: ModePickItem[] = [
        { id: 'head',   label: '$(arrow-up) Head',   description: `Preview the first ${headRows.toLocaleString()} rows of large files` },
        { id: 'tail',   label: '$(arrow-down) Tail', description: `Preview the last ${headRows.toLocaleString()} rows of large files` },
        { id: 'all',    label: '$(file) All',        description: 'Always load the full file (may be slow for very large files)' },
        { id: 'ask',    label: '$(question) Ask',    description: 'Ask every time: show the open-mode picker for each large file' },
    ];
    for (const item of items) {
        if (item.id === current) item.description += '  —  $(check) current';
    }

    const choice = await vscode.window.showQuickPick(items, {
        placeHolder: `Large-file mode (current: ${current}) — applies to files larger than 10 MB`,
        ignoreFocusOut: true
    });
    if (!choice) return;

    await config.update('largeFileMode', choice.id, vscode.ConfigurationTarget.Global);

    // If a large CSV is open in the active tab, offer to reopen it with the
    // new mode so the change takes effect right away.
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab && tab.input instanceof vscode.TabInputCustom
        && tab.input.viewType === CsvEditorProvider.viewType) {
        try {
            const stat = await vscode.workspace.fs.stat(tab.input.uri);
            if (stat.size > LARGE_FILE_THRESHOLD) {
                const reopen = await vscode.window.showInformationMessage(
                    `Large-file mode set to "${choice.id}". Reopen the current file to apply it now?`,
                    'Reopen', 'Later'
                );
                if (reopen === 'Reopen') {
                    await vscode.window.tabGroups.close(tab);
                    await vscode.commands.executeCommand('vscode.openWith', tab.input.uri, CsvEditorProvider.viewType);
                    return;
                }
            }
        } catch {}
    }

    vscode.window.showInformationMessage(
        `CSV Grid Editor: large files will now open in "${choice.id}" mode. Reopen any large CSV to apply.`
    );
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(CsvEditorProvider.register(context));
    context.subscriptions.push(
        vscode.commands.registerCommand('csvGridEditor.setLargeFileMode', setLargeFileMode)
    );
}

export function deactivate() {}
