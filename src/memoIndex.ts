'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as upath from 'upath';

export type FileMeta = {
    birthtime: number;
    mtime: number;
    size: number;
};

type IndexData = {
    version: 1;
    memodir: string;
    entries: Record<string, FileMeta>;
};

type LoadResult = {
    status: 'ok' | 'backup' | 'missing' | 'invalid';
};

export class MemoIndex {
    private static instance: MemoIndex | undefined;

    private entries = new Map<string, FileMeta>();
    private dirty = false;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private savePromise: Promise<void> = Promise.resolve();
    private watcher: vscode.FileSystemWatcher | undefined;
    private readonly primaryPath: string;
    private readonly backupPath: string;

    constructor(
        private readonly memodir: string,
        private readonly extnames: Set<string>
    ) {
        this.primaryPath = upath.join(memodir, '.memo-index.json');
        this.backupPath = upath.join(memodir, '.memo-index.json.bak');
    }

    static async create(memodir: string, extnames: string[]): Promise<MemoIndex> {
        const index = new MemoIndex(memodir, new Set(extnames));
        await index.load();
        await index.sync();
        MemoIndex.instance = index;
        return index;
    }

    static getInstance(): MemoIndex | undefined {
        return MemoIndex.instance;
    }

    static clearInstance(): void {
        MemoIndex.instance = undefined;
    }

    async load(): Promise<LoadResult> {
        const readOne = async (filePath: string): Promise<Map<string, FileMeta> | undefined> => {
            try {
                const raw = await fsp.readFile(filePath, 'utf8');
                const data = JSON.parse(raw) as Partial<IndexData>;
                if (data.version !== 1 || typeof data.entries !== 'object' || data.entries === null) {
                    return undefined;
                }
                const map = new Map<string, FileMeta>();
                for (const [key, meta] of Object.entries(data.entries)) {
                    if (meta && typeof meta.birthtime === 'number' && typeof meta.mtime === 'number' && typeof meta.size === 'number') {
                        map.set(key, meta);
                    }
                }
                return map;
            } catch (error: unknown) {
                const nodeError = error as NodeJS.ErrnoException;
                if (nodeError?.code === 'ENOENT') {
                    return undefined;
                }
                return undefined;
            }
        };

        const primary = await readOne(this.primaryPath);
        if (primary) {
            this.entries = primary;
            return { status: 'ok' };
        }

        const backup = await readOne(this.backupPath);
        if (backup) {
            this.entries = backup;
            this.dirty = true;
            return { status: 'backup' };
        }

        if (!fs.existsSync(this.primaryPath) && !fs.existsSync(this.backupPath)) {
            return { status: 'missing' };
        }
        return { status: 'invalid' };
    }

    async save(): Promise<void> {
        this.savePromise = this.savePromise.then(async () => {
            const data: IndexData = {
                version: 1,
                memodir: this.memodir,
                entries: Object.fromEntries(this.entries),
            };
            const json = JSON.stringify(data, null, 2);
            await writeFileSafely(this.primaryPath, json, 'utf8');
            await writeFileSafely(this.backupPath, json, 'utf8');
            this.dirty = false;
        }).catch(() => undefined);
        return this.savePromise;
    }

    async sync(): Promise<void> {
        if (!fs.existsSync(this.memodir)) {
            return;
        }

        const filesOnDisk = new Set<string>();
        this.readFilesRecursively(this.memodir, filesOnDisk);

        let changed = false;

        for (const absolutePath of filesOnDisk) {
            const relativePath = this.toRelativePath(absolutePath);
            const existing = this.entries.get(relativePath);
            try {
                const stat = fs.statSync(absolutePath);
                if (!existing || existing.mtime !== stat.mtime.getTime() || existing.size !== stat.size) {
                    this.entries.set(relativePath, {
                        birthtime: stat.birthtime.getTime(),
                        mtime: stat.mtime.getTime(),
                        size: stat.size,
                    });
                    changed = true;
                }
            } catch {
                // file disappeared between readdir and stat
            }
        }

        const diskRelativePaths = new Set(
            Array.from(filesOnDisk).map((p) => this.toRelativePath(p))
        );
        for (const key of this.entries.keys()) {
            if (!diskRelativePaths.has(key)) {
                this.entries.delete(key);
                changed = true;
            }
        }

        if (changed) {
            this.dirty = true;
            await this.save();
        }
    }

    update(relativePath: string, meta: FileMeta): void {
        this.entries.set(relativePath, meta);
        this.dirty = true;
        this.scheduleSave();
    }

    remove(relativePath: string): void {
        if (this.entries.delete(relativePath)) {
            this.dirty = true;
            this.scheduleSave();
        }
    }

    async flush(): Promise<void> {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
        if (this.dirty) {
            await this.save();
        }
    }

    startWatching(): vscode.Disposable {
        const pattern = new vscode.RelativePattern(this.memodir, '**/*');
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

        const handleCreateOrChange = (uri: vscode.Uri) => {
            const absolutePath = upath.normalize(uri.fsPath);
            if (!this.isAllowedExtension(absolutePath)) {
                return;
            }
            try {
                const stat = fs.statSync(absolutePath);
                const relativePath = this.toRelativePath(absolutePath);
                this.update(relativePath, {
                    birthtime: stat.birthtime.getTime(),
                    mtime: stat.mtime.getTime(),
                    size: stat.size,
                });
            } catch {
                // file may have been deleted immediately
            }
        };

        this.watcher.onDidCreate(handleCreateOrChange);
        this.watcher.onDidChange(handleCreateOrChange);
        this.watcher.onDidDelete((uri) => {
            const absolutePath = upath.normalize(uri.fsPath);
            if (!this.isAllowedExtension(absolutePath)) {
                return;
            }
            this.remove(this.toRelativePath(absolutePath));
        });

        return this.watcher;
    }

    dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = undefined;
        }
        if (MemoIndex.instance === this) {
            MemoIndex.instance = undefined;
        }
    }

    getMemodir(): string {
        return this.memodir;
    }

    getDirectories(): string[] {
        const dirs = new Set<string>();
        for (const relativePath of this.entries.keys()) {
            const dir = upath.dirname(relativePath);
            if (dir && dir !== '.') {
                dirs.add(upath.join(this.memodir, dir));
            }
        }
        return Array.from(dirs).sort();
    }

    getEntries(): Map<string, FileMeta> {
        return this.entries;
    }

    getFileCount(): number {
        return this.entries.size;
    }

    toAbsolutePath(relativePath: string): string {
        return upath.join(this.memodir, relativePath);
    }

    getStatus(): { entries: number; dirty: boolean; watching: boolean; primaryExists: boolean; backupExists: boolean; indexSizeBytes: number } {
        let indexSizeBytes = 0;
        try {
            indexSizeBytes = fs.statSync(this.primaryPath).size;
        } catch {
            // file may not exist
        }
        return {
            entries: this.entries.size,
            dirty: this.dirty,
            watching: !!this.watcher,
            primaryExists: fs.existsSync(this.primaryPath),
            backupExists: fs.existsSync(this.backupPath),
            indexSizeBytes,
        };
    }

    async rebuild(): Promise<{ entries: number }> {
        this.entries.clear();
        this.dirty = false;
        try {
            fs.unlinkSync(this.primaryPath);
        } catch { /* ignore */ }
        try {
            fs.unlinkSync(this.backupPath);
        } catch { /* ignore */ }
        await this.sync();
        return { entries: this.entries.size };
    }

    private scheduleSave(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            void this.save();
        }, 1000);
    }

    private toRelativePath(absolutePath: string): string {
        return upath.relative(upath.normalize(this.memodir), upath.normalize(absolutePath));
    }

    private isAllowedExtension(filePath: string): boolean {
        const ext = upath.extname(filePath).replace(/^\./, '');
        return this.extnames.has(ext);
    }

    private readFilesRecursively(dir: string, result: Set<string>): void {
        let dirents: fs.Dirent[];
        try {
            dirents = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const dirent of dirents) {
            const fullpath = upath.normalize(upath.join(dir, dirent.name));
            if (dirent.isDirectory()) {
                this.readFilesRecursively(fullpath, result);
            } else if (dirent.isFile() && this.isAllowedExtension(dirent.name)) {
                result.add(fullpath);
            }
        }
    }
}

async function writeFileSafely(filePath: string, data: string, encoding: BufferEncoding): Promise<void> {
    const dir = upath.dirname(filePath);
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
