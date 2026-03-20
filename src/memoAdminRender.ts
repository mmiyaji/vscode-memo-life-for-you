'use strict';

import * as upath from 'upath';

export type AdminLocale = 'en' | 'ja';

export type MemoRecentItem = {
    label: string;
    title: string;
    pathLabel: string;
    createdAt: string;
    updatedAt: string;
    filename: string;
    fileSizeLabel: string;
    mtimeMs: number;
};

export function renderList(items: Array<{ label: string; count: number }>, noDataLabel: string): string {
    if (items.length === 0) {
        return `<div class="empty">${escapeHtml(noDataLabel)}</div>`;
    }

    return `<ul>${items
        .map((item) => `<li><span class="list-label">${escapeHtml(item.label)}</span><span class="list-value">${item.count}</span></li>`)
        .join('')}</ul>`;
}

export function renderBarList(
    items: Array<{ label: string; count: number }>,
    noDataLabel: string,
    options?: { pathResolver?: (label: string) => string }
): string {
    if (items.length === 0) {
        return `<div class="empty">${escapeHtml(noDataLabel)}</div>`;
    }

    const maxCount = Math.max(...items.map((item) => item.count), 1);
    return `<div class="bar-list">${items
        .map((item) => {
            const width = Math.max(8, Math.round((item.count / maxCount) * 100));
            const targetPath = options?.pathResolver?.(item.label);
            const rowAttrs = targetPath ? ` class="bar-row is-clickable" data-stats-target="${escapeHtml(targetPath)}"` : ' class="bar-row"';
            return `<div${rowAttrs}><span class="bar-label">${escapeHtml(item.label)}</span><span class="bar-track"><span class="bar-fill" style="width: ${width}%"></span></span><span class="bar-value">${item.count}</span></div>`;
        })
        .join('')}</div>`;
}

export function renderRecentFiles(
    items: MemoRecentItem[],
    options: {
        noDataLabel: string;
        pinnedFilenames?: string[];
        showPinToggle?: boolean;
        pinLabel?: string;
        unpinLabel?: string;
        createdLabel: string;
        updatedLabel: string;
        sizeLabel: string;
    }
): string {
    if (items.length === 0) {
        return `<div class="empty">${escapeHtml(options.noDataLabel)}</div>`;
    }

    const pinnedSet = new Set((options.pinnedFilenames ?? []).map((filename) => upath.normalizeTrim(filename)));
    return `<div class="recent-list">${items
        .map((item) => {
            const isPinned = pinnedSet.has(upath.normalizeTrim(item.filename));
            const pinButton = !options.showPinToggle
                ? ''
                : isPinned
                    ? `<button class="pin-button" type="button" data-unpin-file="${escapeHtml(item.filename)}">${escapeHtml(options.unpinLabel ?? 'Unpin')}</button>`
                    : `<button class="pin-button" type="button" data-pin-file="${escapeHtml(item.filename)}">${escapeHtml(options.pinLabel ?? 'Pin')}</button>`;
            return `<div class="recent-item"><button class="recent-open" type="button" data-recent-file="${escapeHtml(item.filename)}"><span class="recent-title">${escapeHtml(item.title)}</span>${item.title !== item.pathLabel ? `<span class="recent-path">${escapeHtml(item.pathLabel)}</span>` : ''}<span class="recent-meta">${escapeHtml(options.createdLabel + ': ' + item.createdAt + ' / ' + options.updatedLabel + ': ' + item.updatedAt + ' / ' + options.sizeLabel + ': ' + item.fileSizeLabel)}</span></button>${pinButton}</div>`;
        })
        .join('')}</div>`;
}

export function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
