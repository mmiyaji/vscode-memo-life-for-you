'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as upath from 'upath';

type SnippetEntry = {
    prefix: string | string[];
    body: string | string[];
    description?: string;
};

type SnippetFile = Record<string, SnippetEntry>;

export class MemoSnippetProvider implements vscode.CompletionItemProvider {
    private snippets: vscode.CompletionItem[] = [];
    private watcher: vscode.FileSystemWatcher | undefined;

    constructor(
        private readonly getSnippetsDir: () => string
    ) {
        this.loadSnippets();
    }

    provideCompletionItems(): vscode.CompletionItem[] {
        return this.snippets;
    }

    reload(): void {
        this.loadSnippets();
    }

    getStatus(): { dir: string; exists: boolean; fileCount: number; snippetCount: number; snippets: Array<{ prefix: string; name: string; description?: string }> } {
        const dir = this.getSnippetsDir();
        const exists = !!dir && fs.existsSync(dir);
        let fileCount = 0;
        if (exists) {
            try {
                fileCount = fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
            } catch { /* ignore */ }
        }
        return {
            dir: dir || '',
            exists,
            fileCount,
            snippetCount: this.snippets.length,
            snippets: this.snippets.map(s => ({
                prefix: typeof s.label === 'string' ? s.label : s.label.label,
                name: s.detail || '',
                description: typeof s.label === 'object' ? (s.label.description || '') : '',
            })),
        };
    }

    startWatching(): vscode.Disposable {
        const dir = this.getSnippetsDir();
        if (!dir || !fs.existsSync(dir)) {
            return { dispose: () => {} };
        }

        const pattern = new vscode.RelativePattern(dir, '**/*.json');
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

        const reload = () => this.loadSnippets();
        this.watcher.onDidCreate(reload);
        this.watcher.onDidChange(reload);
        this.watcher.onDidDelete(reload);

        return this.watcher;
    }

    dispose(): void {
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = undefined;
        }
    }

    private loadSnippets(): void {
        this.snippets = [];
        const dir = this.getSnippetsDir();
        if (!dir || !fs.existsSync(dir)) {
            return;
        }

        let files: string[];
        try {
            files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        } catch {
            return;
        }

        for (const file of files) {
            const filePath = upath.join(dir, file);
            try {
                const raw = fs.readFileSync(filePath, 'utf8');
                const parsed = JSON.parse(raw) as SnippetFile;
                for (const [name, entry] of Object.entries(parsed)) {
                    const items = this.createCompletionItems(name, entry);
                    this.snippets.push(...items);
                }
            } catch {
                // skip invalid JSON
            }
        }
    }

    private createCompletionItems(name: string, entry: SnippetEntry): vscode.CompletionItem[] {
        const body = Array.isArray(entry.body) ? entry.body.join('\n') : entry.body;
        const prefixes = Array.isArray(entry.prefix) ? entry.prefix : [entry.prefix];

        return prefixes.map(prefix => {
            const item = new vscode.CompletionItem(
                { label: prefix, description: entry.description || name },
                vscode.CompletionItemKind.Snippet
            );
            item.insertText = new vscode.SnippetString(body);
            item.detail = name;
            const preview = body.replace(/\$\{\d+:?(.*?)\}/g, '$1').replace(/\$\d+/g, '');
            const doc = new vscode.MarkdownString();
            doc.appendCodeblock(preview, 'markdown');
            if (entry.description) {
                doc.appendText('\n' + entry.description);
            }
            item.documentation = doc;
            return item;
        });
    }
}
