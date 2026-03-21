import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as Module from 'module';

// Stub vscode module before importing memoAi
const vscodeStub = {
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    window: {},
    env: { language: 'ja' },
    ProgressLocation: { Notification: 1 },
    Range: class {},
    ViewColumn: { Beside: 2, Active: 1 },
};

// Register vscode stub in module cache
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: unknown[]) {
    if (request === 'vscode') { return 'vscode'; }
    return originalResolve.call(this, request, ...args);
};
require.cache['vscode'] = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: vscodeStub,
} as any;

// Now import memoAi functions
const {
    shouldBypassProxy,
    parseTags,
    buildTagPrompt,
    collectRecentFiles,
} = require('../src/memoAi');

// ── shouldBypassProxy ────────────────────────────────────────

test('shouldBypassProxy returns false when noProxy is empty', () => {
    assert.equal(shouldBypassProxy('example.com', ''), false);
});

test('shouldBypassProxy matches exact hostname', () => {
    assert.equal(shouldBypassProxy('localhost', 'localhost'), true);
});

test('shouldBypassProxy matches comma-separated list', () => {
    assert.equal(shouldBypassProxy('127.0.0.1', 'localhost,127.0.0.1'), true);
});

test('shouldBypassProxy matches domain suffix with leading dot', () => {
    assert.equal(shouldBypassProxy('api.internal.local', '.local'), true);
});

test('shouldBypassProxy matches exact domain when suffix given without dot prefix', () => {
    assert.equal(shouldBypassProxy('sub.example.com', 'example.com'), true);
});

test('shouldBypassProxy does not match unrelated hostname', () => {
    assert.equal(shouldBypassProxy('external.com', 'localhost,127.0.0.1'), false);
});

test('shouldBypassProxy wildcard matches everything', () => {
    assert.equal(shouldBypassProxy('anything.example.com', '*'), true);
});

test('shouldBypassProxy is case-insensitive', () => {
    assert.equal(shouldBypassProxy('LocalHost', 'localhost'), true);
});

test('shouldBypassProxy trims whitespace in entries', () => {
    assert.equal(shouldBypassProxy('localhost', '  localhost , 127.0.0.1 '), true);
});

// ── parseTags ────────────────────────────────────────────────

test('parseTags extracts tags from JSON array', () => {
    const result = parseTags('["tag1", "tag2", "tag3"]');
    assert.deepEqual(result, ['tag1', 'tag2', 'tag3']);
});

test('parseTags extracts tags from response with surrounding text', () => {
    const result = parseTags('Here are the tags:\n["foo", "bar"]\nDone.');
    assert.deepEqual(result, ['foo', 'bar']);
});

test('parseTags returns empty array for no JSON', () => {
    const result = parseTags('no tags here');
    assert.deepEqual(result, []);
});

test('parseTags returns empty array for invalid JSON', () => {
    const result = parseTags('[invalid json]');
    assert.deepEqual(result, []);
});

test('parseTags filters out empty strings', () => {
    const result = parseTags('["tag1", "", "  ", "tag2"]');
    assert.deepEqual(result, ['tag1', 'tag2']);
});

test('parseTags filters out non-string values', () => {
    const result = parseTags('[1, "tag1", null, "tag2", true]');
    assert.deepEqual(result, ['tag1', 'tag2']);
});

test('parseTags handles Japanese tags', () => {
    const result = parseTags('["プログラミング", "メモ", "日記"]');
    assert.deepEqual(result, ['プログラミング', 'メモ', '日記']);
});

// ── buildTagPrompt ───────────────────────────────────────────

test('buildTagPrompt generates Japanese prompt when language is ja', () => {
    const prompt = buildTagPrompt('メモの内容です', 'ja', []);
    assert.match(prompt, /タグ付けアシスタント/);
    assert.match(prompt, /JSON配列/);
    assert.match(prompt, /メモの内容です/);
});

test('buildTagPrompt generates English prompt when language is en', () => {
    const prompt = buildTagPrompt('Some memo content', 'en', []);
    assert.match(prompt, /tagging assistant/);
    assert.match(prompt, /JSON array/);
    assert.match(prompt, /Some memo content/);
});

test('buildTagPrompt includes existing tags in Japanese prompt', () => {
    const prompt = buildTagPrompt('内容', 'ja', ['タグA', 'タグB']);
    assert.match(prompt, /タグA, タグB/);
    assert.match(prompt, /優先的に再利用/);
});

test('buildTagPrompt includes existing tags in English prompt', () => {
    const prompt = buildTagPrompt('content', 'en', ['tagA', 'tagB']);
    assert.match(prompt, /tagA, tagB/);
    assert.match(prompt, /Reuse them/);
});

test('buildTagPrompt does not include tag list when empty', () => {
    const prompt = buildTagPrompt('content', 'en', []);
    assert.doesNotMatch(prompt, /Reuse them/);
    assert.doesNotMatch(prompt, /previously used/);
});

test('buildTagPrompt truncates content to 3000 chars', () => {
    const longContent = 'x'.repeat(5000);
    const prompt = buildTagPrompt(longContent, 'en', []);
    const contentMatch = prompt.match(/---\n(x+)\n---/);
    assert.ok(contentMatch);
    assert.equal(contentMatch![1].length, 3000);
});

// ── collectRecentFiles ───────────────────────────────────────

function createTempMemoDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'memo-ai-test-'));
}

function cleanTempDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

test('collectRecentFiles returns empty for empty directory', () => {
    const dir = createTempMemoDir();
    try {
        const result = collectRecentFiles(dir, ['.md'], 10);
        assert.deepEqual(result, []);
    } finally {
        cleanTempDir(dir);
    }
});

test('collectRecentFiles collects .md files with content', () => {
    const dir = createTempMemoDir();
    try {
        fs.writeFileSync(path.join(dir, 'memo1.md'), '# Memo 1\nContent here');
        fs.writeFileSync(path.join(dir, 'memo2.md'), '# Memo 2\nMore content');
        fs.writeFileSync(path.join(dir, 'readme.txt'), 'not a memo');

        const result = collectRecentFiles(dir, ['.md'], 10);
        assert.equal(result.length, 2);
        assert.ok(result.every((f: any) => f.path.endsWith('.md')));
        assert.ok(result.every((f: any) => f.content.length > 0));
    } finally {
        cleanTempDir(dir);
    }
});

test('collectRecentFiles respects maxFiles limit', () => {
    const dir = createTempMemoDir();
    try {
        for (let i = 0; i < 5; i++) {
            fs.writeFileSync(path.join(dir, `memo${i}.md`), `Content ${i}`);
        }
        const result = collectRecentFiles(dir, ['.md'], 3);
        assert.equal(result.length, 3);
    } finally {
        cleanTempDir(dir);
    }
});

test('collectRecentFiles walks subdirectories', () => {
    const dir = createTempMemoDir();
    const subdir = path.join(dir, '2026', '03');
    try {
        fs.mkdirSync(subdir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'root.md'), 'root memo');
        fs.writeFileSync(path.join(subdir, 'nested.md'), 'nested memo');

        const result = collectRecentFiles(dir, ['.md'], 10);
        assert.equal(result.length, 2);
    } finally {
        cleanTempDir(dir);
    }
});

test('collectRecentFiles skips dot-prefixed directories', () => {
    const dir = createTempMemoDir();
    const hidden = path.join(dir, '.hidden');
    try {
        fs.mkdirSync(hidden);
        fs.writeFileSync(path.join(hidden, 'secret.md'), 'should not appear');
        fs.writeFileSync(path.join(dir, 'visible.md'), 'visible');

        const result = collectRecentFiles(dir, ['.md'], 10);
        assert.equal(result.length, 1);
        assert.ok(result[0].path.includes('visible.md'));
    } finally {
        cleanTempDir(dir);
    }
});

test('collectRecentFiles sorts by mtime descending', () => {
    const dir = createTempMemoDir();
    try {
        fs.writeFileSync(path.join(dir, 'old.md'), 'old');
        const past = new Date(Date.now() - 60000);
        fs.utimesSync(path.join(dir, 'old.md'), past, past);
        fs.writeFileSync(path.join(dir, 'new.md'), 'new');

        const result = collectRecentFiles(dir, ['.md'], 10);
        assert.equal(result.length, 2);
        assert.ok(result[0].path.includes('new.md'), 'newest file should be first');
        assert.ok(result[1].path.includes('old.md'), 'oldest file should be last');
    } finally {
        cleanTempDir(dir);
    }
});

test('collectRecentFiles filters by multiple extensions', () => {
    const dir = createTempMemoDir();
    try {
        fs.writeFileSync(path.join(dir, 'note.md'), 'markdown');
        fs.writeFileSync(path.join(dir, 'note.txt'), 'text');
        fs.writeFileSync(path.join(dir, 'image.png'), 'binary');

        const result = collectRecentFiles(dir, ['.md', '.txt'], 10);
        assert.equal(result.length, 2);
    } finally {
        cleanTempDir(dir);
    }
});

test('collectRecentFiles handles non-existent directory gracefully', () => {
    const result = collectRecentFiles('/nonexistent/dir/abc123', ['.md'], 10);
    assert.deepEqual(result, []);
});
