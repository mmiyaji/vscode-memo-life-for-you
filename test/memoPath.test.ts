import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    ensureMemoDateDirectory,
    getMemoDateDirectory,
    getMemoRelativeDirectoryLabel
} from '../src/memoPath';

test('getMemoDateDirectory returns root when format is empty', () => {
    const memodir = 'C:/memo/root';

    assert.equal(getMemoDateDirectory(memodir, ''), 'C:/memo/root');
    assert.equal(getMemoDateDirectory(memodir, '   '), 'C:/memo/root');
});

test('getMemoDateDirectory appends a formatted date path', () => {
    const memodir = 'C:/memo/root';
    const date = new Date('2026-03-20T09:30:00+09:00');

    assert.equal(getMemoDateDirectory(memodir, 'yyyy/MM', date), 'C:/memo/root/2026/03');
    assert.equal(getMemoDateDirectory(memodir, 'yyyy/MM/dd', date), 'C:/memo/root/2026/03/20');
});

test('ensureMemoDateDirectory creates the target directory recursively', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-path-test-'));

    try {
        const memodir = path.join(tempRoot, 'memo-root');
        const date = new Date('2026-03-20T09:30:00+09:00');
        const targetDir = ensureMemoDateDirectory(memodir, 'yyyy/MM', date);

        assert.equal(targetDir.replace(/\\/g, '/').endsWith('/memo-root/2026/03'), true);
        assert.equal(fs.existsSync(targetDir), true);
        assert.equal(fs.statSync(targetDir).isDirectory(), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('getMemoRelativeDirectoryLabel returns dot for the root and a relative path otherwise', () => {
    const memodir = 'C:/memo/root';

    assert.equal(getMemoRelativeDirectoryLabel(memodir, memodir), '.');
    assert.equal(getMemoRelativeDirectoryLabel(memodir, 'C:/memo/root/2026/03'), '2026/03');
});
