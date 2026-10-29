// Desktop-only file actions for the grid's right-click menus.
//
// This bundle is shared with the VS Code extension, where no Tauri bridge
// exists, so the items are only added when window.__TAURI__ is present. The
// native work (clipboard / Explorer reveal) lives in the desktop bootstrap
// (csv-desktop/index.html), which listens for the custom events dispatched
// here — keeping the shared webview code host-agnostic.

const COPY_PATH_EVENT = 'csv-desktop-copy-path';
const REVEAL_PATH_EVENT = 'csv-desktop-reveal-path';

function isDesktopShell(): boolean {
    return typeof window !== 'undefined' && !!(window as any).__TAURI__;
}

function makeItem(label: string, iconClass: string, itemClass: string): HTMLDivElement {
    const item = document.createElement('div');
    item.className = itemClass + ' desktop-file-action';
    const icon = document.createElement('i');
    icon.className = 'codicon ' + iconClass;
    const span = document.createElement('span');
    span.className = 'row-ctx-label';
    span.textContent = label;
    item.append(icon, span);
    return item;
}

// Appends a separator plus "复制绝对路径" and "在文件资源管理器中显示".
// Safe to call repeatedly: the column menu is static, but the row menu is
// rebuilt on every right-click.
export function appendDesktopFileActions(menu: HTMLElement, itemClass: 'row-ctx-item' | 'col-ctx-item'): void {
    if (!isDesktopShell() || menu.querySelector('.desktop-file-action')) return;

    const sep = document.createElement('div');
    sep.className = 'col-ctx-separator';
    menu.appendChild(sep);

    const copy = makeItem('复制绝对路径', 'codicon-copy', itemClass);
    copy.addEventListener('click', () => {
        menu.classList.add('hidden');
        window.dispatchEvent(new CustomEvent(COPY_PATH_EVENT));
    });
    menu.appendChild(copy);

    const reveal = makeItem('在文件资源管理器中显示', 'codicon-folder-opened', itemClass);
    reveal.addEventListener('click', () => {
        menu.classList.add('hidden');
        window.dispatchEvent(new CustomEvent(REVEAL_PATH_EVENT));
    });
    menu.appendChild(reveal);
}

export function setupDesktopFileActions(): void {
    if (!isDesktopShell()) return;
    const colMenu = document.getElementById('col-context-menu');
    if (colMenu) appendDesktopFileActions(colMenu, 'col-ctx-item');
}
