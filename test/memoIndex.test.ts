import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Import writeFileSafely indirectly by testing the full MemoIndex via its exported API.
// Since MemoIndex depends on vscode, we test the core persistence logic directly here.

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'memo-index-test-'));
}

function cleanTempDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

function perfTest(name: string, fn: () => void | Promise<void>): void {
    if (process.env.CI) {
        test(name, { skip: 'Skipped on CI due to runner timing variance' }, fn);
        return;
    }
    test(name, fn);
}

// -- writeFileSafely standalone test (extracted logic) --

async function writeFileSafely(filePath: string, data: string, encoding: BufferEncoding): Promise<void> {
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const backupPath = `${filePath}.bak-write`;

    try {
        await fsp.writeFile(tempPath, data, encoding);

        await fsp.rm(backupPath, { force: true }).catch(() => undefined);
        let movedOriginal = false;
        try {
            await fsp.rename(filePath, backupPath);
            movedOriginal = true;
        } catch (error: unknown) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError?.code !== 'ENOENT') {
                throw error;
            }
        }

        try {
            await fsp.rename(tempPath, filePath);
            if (movedOriginal) {
                await fsp.rm(backupPath, { force: true }).catch(() => undefined);
            }
        } catch (error) {
            if (movedOriginal) {
                await fsp.rename(backupPath, filePath).catch(() => undefined);
            }
            throw error;
        }
    } finally {
        await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    }
}

test('writeFileSafely creates a new file', async () => {
    const dir = createTempDir();
    try {
        const filePath = path.join(dir, 'test.json');
        await writeFileSafely(filePath, '{"hello":"world"}', 'utf8');
        const content = fs.readFileSync(filePath, 'utf8');
        assert.equal(content, '{"hello":"world"}');
    } finally {
        cleanTempDir(dir);
    }
});

test('writeFileSafely overwrites an existing file atomically', async () => {
    const dir = createTempDir();
    try {
        const filePath = path.join(dir, 'test.json');
        fs.writeFileSync(filePath, '{"old":"data"}', 'utf8');
        await writeFileSafely(filePath, '{"new":"data"}', 'utf8');
        const content = fs.readFileSync(filePath, 'utf8');
        assert.equal(content, '{"new":"data"}');

        // temp and backup files should be cleaned up
        const remaining = fs.readdirSync(dir);
        assert.deepEqual(remaining, ['test.json']);
    } finally {
        cleanTempDir(dir);
    }
});

test('writeFileSafely creates parent directories', async () => {
    const dir = createTempDir();
    try {
        const filePath = path.join(dir, 'sub', 'dir', 'test.json');
        await writeFileSafely(filePath, 'data', 'utf8');
        assert.ok(fs.existsSync(filePath));
    } finally {
        cleanTempDir(dir);
    }
});

// -- Index data roundtrip test --

type FileMeta = {
    birthtime: number;
    mtime: number;
    size: number;
};

type IndexData = {
    version: 1;
    memodir: string;
    entries: Record<string, FileMeta>;
};

test('index data roundtrip through JSON', () => {
    const data: IndexData = {
        version: 1,
        memodir: '/memos',
        entries: {
            '2025/03/2025-03-17.md': { birthtime: 1742174880000, mtime: 1742177100000, size: 363 },
            '2025/03/2025-03-18.md': { birthtime: 1742265660000, mtime: 1742267940000, size: 366 },
        },
    };
    const json = JSON.stringify(data, null, 2);
    const parsed = JSON.parse(json) as IndexData;

    assert.equal(parsed.version, 1);
    assert.equal(Object.keys(parsed.entries).length, 2);
    assert.equal(parsed.entries['2025/03/2025-03-17.md'].size, 363);
});

test('dual-file fallback: primary read, backup fallback, missing detection', async () => {
    const dir = createTempDir();
    try {
        const primaryPath = path.join(dir, '.memo-index.json');
        const backupPath = path.join(dir, '.memo-index.json.bak');

        const data: IndexData = {
            version: 1,
            memodir: dir,
            entries: { 'test.md': { birthtime: 1000, mtime: 2000, size: 100 } },
        };
        const json = JSON.stringify(data);

        // Both missing → missing
        assert.ok(!fs.existsSync(primaryPath));
        assert.ok(!fs.existsSync(backupPath));

        // Write primary only → ok
        await writeFileSafely(primaryPath, json, 'utf8');
        const primary = JSON.parse(fs.readFileSync(primaryPath, 'utf8')) as IndexData;
        assert.equal(primary.version, 1);
        assert.equal(Object.keys(primary.entries).length, 1);

        // Remove primary, write backup → fallback
        fs.unlinkSync(primaryPath);
        await writeFileSafely(backupPath, json, 'utf8');
        assert.ok(!fs.existsSync(primaryPath));
        const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8')) as IndexData;
        assert.equal(backup.version, 1);

        // Corrupt primary, backup valid → fallback
        fs.writeFileSync(primaryPath, 'not json', 'utf8');
        const corruptedPrimary = fs.readFileSync(primaryPath, 'utf8');
        assert.throws(() => JSON.parse(corruptedPrimary));
        const validBackup = JSON.parse(fs.readFileSync(backupPath, 'utf8')) as IndexData;
        assert.equal(validBackup.version, 1);
    } finally {
        cleanTempDir(dir);
    }
});

test('index size estimation matches expectations', () => {
    const entries: Record<string, FileMeta> = {};
    for (let i = 0; i < 355; i++) {
        const month = String((i % 12) + 1).padStart(2, '0');
        const key = `2025/${month}/2025-${month}-${String((i % 28) + 1).padStart(2, '0')}.md`;
        entries[key] = { birthtime: 1742174880000 + i, mtime: 1742177100000 + i, size: 300 + i };
    }

    const data: IndexData = { version: 1, memodir: '/memos', entries };
    const json = JSON.stringify(data, null, 2);

    // Should be roughly 30-50KB for 355 entries
    assert.ok(json.length < 60000, `Index size ${json.length} exceeds 60KB`);
    assert.ok(json.length > 10000, `Index size ${json.length} is suspiciously small`);
});

// -- Performance tests --

function generateEntries(count: number): Map<string, FileMeta> {
    const map = new Map<string, FileMeta>();
    for (let i = 0; i < count; i++) {
        const year = 2020 + Math.floor(i / 365);
        const month = String((i % 12) + 1).padStart(2, '0');
        const day = String((i % 28) + 1).padStart(2, '0');
        const key = `${year}/${month}/${year}-${month}-${day}-memo${i}.md`;
        map.set(key, { birthtime: 1742174880000 + i * 1000, mtime: 1742177100000 + i * 1000, size: 200 + (i % 500) });
    }
    return map;
}

function generateIndexData(count: number): IndexData {
    const entries: Record<string, FileMeta> = {};
    const map = generateEntries(count);
    for (const [key, meta] of map) {
        entries[key] = meta;
    }
    return { version: 1, memodir: '/memos', entries };
}

perfTest('perf: JSON.parse + Map construction for 355 entries under 5ms', () => {
    const data = generateIndexData(355);
    const json = JSON.stringify(data);

    const start = performance.now();
    const parsed = JSON.parse(json) as IndexData;
    const map = new Map(Object.entries(parsed.entries));
    const elapsed = performance.now() - start;

    assert.equal(map.size, 355);
    assert.ok(elapsed < 5, `355 entries: parse+map took ${elapsed.toFixed(2)}ms (expected <5ms)`);
});

perfTest('perf: JSON.parse + Map construction for 1000 entries under 10ms', () => {
    const data = generateIndexData(1000);
    const json = JSON.stringify(data);

    const start = performance.now();
    const parsed = JSON.parse(json) as IndexData;
    const map = new Map(Object.entries(parsed.entries));
    const elapsed = performance.now() - start;

    assert.equal(map.size, 1000);
    assert.ok(elapsed < 10, `1000 entries: parse+map took ${elapsed.toFixed(2)}ms (expected <10ms)`);
});

perfTest('perf: JSON.parse + Map construction for 5000 entries under 30ms', () => {
    const data = generateIndexData(5000);
    const json = JSON.stringify(data);

    const start = performance.now();
    const parsed = JSON.parse(json) as IndexData;
    const map = new Map(Object.entries(parsed.entries));
    const elapsed = performance.now() - start;

    assert.equal(map.size, 5000);
    assert.ok(elapsed < 30, `5000 entries: parse+map took ${elapsed.toFixed(2)}ms (expected <30ms)`);
});

perfTest('perf: JSON.stringify for 5000 entries under 30ms', () => {
    const data = generateIndexData(5000);

    const start = performance.now();
    const json = JSON.stringify(data, null, 2);
    const elapsed = performance.now() - start;

    assert.ok(json.length > 0);
    assert.ok(elapsed < 30, `5000 entries: stringify took ${elapsed.toFixed(2)}ms (expected <30ms)`);
});

perfTest('perf: Map iteration + aggregation for 5000 entries under 5ms', () => {
    const entries = generateEntries(5000);
    const yearMap = new Map<string, number>();
    const monthMap = new Map<string, number>();

    const start = performance.now();
    for (const [, meta] of entries) {
        const date = new Date(meta.birthtime);
        const year = date.getFullYear().toString();
        const month = `${year}/${String(date.getMonth() + 1).padStart(2, '0')}`;
        yearMap.set(year, (yearMap.get(year) ?? 0) + 1);
        monthMap.set(month, (monthMap.get(month) ?? 0) + 1);
    }
    const elapsed = performance.now() - start;

    assert.ok(yearMap.size > 0);
    assert.ok(monthMap.size > 0);
    assert.ok(elapsed < 5, `5000 entries: aggregation took ${elapsed.toFixed(2)}ms (expected <5ms)`);
});

perfTest('perf: directory derivation from 5000 entries under 10ms', () => {
    const entries = generateEntries(5000);
    const dirs = new Set<string>();

    const start = performance.now();
    for (const relativePath of entries.keys()) {
        const dir = path.dirname(relativePath);
        if (dir && dir !== '.') {
            dirs.add(dir);
        }
    }
    const sorted = Array.from(dirs).sort();
    const elapsed = performance.now() - start;

    assert.ok(sorted.length > 0);
    assert.ok(elapsed < 10, `5000 entries: dir derivation took ${elapsed.toFixed(2)}ms (expected <10ms)`);
});

perfTest('perf: writeFileSafely for typical index size under 20ms', async () => {
    const dir = createTempDir();
    try {
        const data = generateIndexData(355);
        const json = JSON.stringify(data, null, 2);
        const filePath = path.join(dir, '.memo-index.json');

        const start = performance.now();
        await writeFileSafely(filePath, json, 'utf8');
        const elapsed = performance.now() - start;

        assert.ok(fs.existsSync(filePath));
        assert.ok(elapsed < 20, `writeFileSafely took ${elapsed.toFixed(2)}ms (expected <20ms)`);
    } finally {
        cleanTempDir(dir);
    }
});

perfTest('perf: full sync simulation — statSync 355 files vs index lookup', async () => {
    const dir = createTempDir();
    try {
        // Create 355 temp files
        const files: string[] = [];
        for (let i = 0; i < 355; i++) {
            const subdir = path.join(dir, `${2020 + Math.floor(i / 120)}`, String((i % 12) + 1).padStart(2, '0'));
            fs.mkdirSync(subdir, { recursive: true });
            const filePath = path.join(subdir, `memo-${i}.md`);
            fs.writeFileSync(filePath, `# Memo ${i}\n`, 'utf8');
            files.push(filePath);
        }

        // Measure statSync approach
        const startStat = performance.now();
        for (const file of files) {
            fs.statSync(file);
        }
        const elapsedStat = performance.now() - startStat;

        // Measure index lookup approach (Map.get)
        const entries = generateEntries(355);
        const keys = Array.from(entries.keys());
        const startIndex = performance.now();
        for (const key of keys) {
            entries.get(key);
        }
        const elapsedIndex = performance.now() - startIndex;

        // Index lookup should be at least 10x faster than statSync
        const speedup = elapsedStat / Math.max(elapsedIndex, 0.001);
        assert.ok(speedup > 10, `Index lookup speedup: ${speedup.toFixed(1)}x (expected >10x). stat=${elapsedStat.toFixed(2)}ms, index=${elapsedIndex.toFixed(4)}ms`);
    } finally {
        cleanTempDir(dir);
    }
});
