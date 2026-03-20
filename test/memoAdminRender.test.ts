import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { escapeHtml, renderBarList, renderRecentFiles } from '../src/memoAdminRender';

test('escapeHtml escapes reserved characters and handles nullish input', () => {
    assert.equal(escapeHtml(`<tag attr="x">Tom & 'Jerry'</tag>`), '&lt;tag attr=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/tag&gt;');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(null), '');
});

test('renderBarList returns an empty state when there are no items', () => {
    const html = renderBarList([], 'No data');

    assert.match(html, /class="empty"/);
    assert.match(html, />No data</);
});

test('renderBarList marks rows clickable and scales bar width to the max value', () => {
    const html = renderBarList(
        [
            { label: '2026/03', count: 5 },
            { label: '2026/02', count: 10 }
        ],
        'No data',
        { pathResolver: (label) => `/memo/${label}` }
    );

    assert.match(html, /class="bar-row is-clickable" data-stats-target="\/memo\/2026\/03"/);
    assert.match(html, /style="width: 50%"/);
    assert.match(html, /style="width: 100%"/);
});

test('renderRecentFiles shows pin and unpin actions and escapes user content', () => {
    const html = renderRecentFiles(
        [
            {
                label: 'first',
                title: 'Title <One>',
                pathLabel: '2026/03/first.md',
                createdAt: '2026-03-20 09:00',
                updatedAt: '2026-03-20 10:00',
                filename: 'C:/memo/2026/03/first.md',
                fileSizeLabel: '1 KB',
                mtimeMs: 1
            },
            {
                label: 'second',
                title: '2026/03/second.md',
                pathLabel: '2026/03/second.md',
                createdAt: '2026-03-20 11:00',
                updatedAt: '2026-03-20 12:00',
                filename: 'C:/memo/2026/03/second.md',
                fileSizeLabel: '2 KB',
                mtimeMs: 2
            }
        ],
        {
            noDataLabel: 'No data',
            pinnedFilenames: ['C:/memo/2026/03/second.md'],
            showPinToggle: true,
            pinLabel: 'Pin',
            unpinLabel: 'Unpin',
            createdLabel: 'Created',
            updatedLabel: 'Updated',
            sizeLabel: 'Size'
        }
    );

    assert.match(html, /Title &lt;One&gt;/);
    assert.match(html, /data-pin-file="C:\/memo\/2026\/03\/first\.md"/);
    assert.match(html, /data-unpin-file="C:\/memo\/2026\/03\/second\.md"/);
    assert.doesNotMatch(html, /<span class="recent-path">2026\/03\/second\.md<\/span>/);
});
