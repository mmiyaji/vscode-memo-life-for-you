'use strict';

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as upath from 'upath';
import * as nls from 'vscode-nls';
import * as fs from 'fs';
import * as os from 'os';
import * as dateFns from 'date-fns';
import { items, memoConfigure } from './memoConfigure';
import { getMemoDateDirectory, getMemoRelativeDirectoryLabel } from './memoPath';
import { MemoIndex } from './memoIndex';

const localize = nls.config({ messageFormat: nls.MessageFormat.file })();

class MemoGrepDocumentProvider implements vscode.TextDocumentContentProvider {
    private readonly contents = new Map<string, string>();

    public provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.toString()) ?? '';
    }

    public setContent(uri: vscode.Uri, content: string): void {
        this.contents.set(uri.toString(), content);
    }
}

export class memoGrep extends memoConfigure {
    private _disposable: vscode.Disposable;
    private memoGrepChannel: vscode.OutputChannel;
    private static readonly grepDocumentScheme = 'memo-grep';
    private static grepDocumentProvider: MemoGrepDocumentProvider | undefined;
    private static grepDocumentRegistration: vscode.Disposable | undefined;

    constructor() {
        super();
        this.memoGrepChannel = vscode.window.createOutputChannel("Memo Grep");
        if (!memoGrep.grepDocumentProvider) {
            memoGrep.grepDocumentProvider = new MemoGrepDocumentProvider();
            memoGrep.grepDocumentRegistration = vscode.workspace.registerTextDocumentContentProvider(
                memoGrep.grepDocumentScheme,
                memoGrep.grepDocumentProvider
            );
        }
    }

    public async Grep() {
        let items: items[] = [];
        let list: string[] = [];
        let grepLineDecoration: vscode.TextEditorDecorationType;
        let grepKeywordDecoration: vscode.TextEditorDecorationType;
        let args: string[];
        let result = "";
        let child: cp.ChildProcess;

        const rgPath = this.resolveRipgrepPath();
        this.updateConfiguration();
        const grepViewMode = this.getNormalizedGrepViewMode();

        const searchRoot = await this.pickSearchRoot();
        if (!searchRoot) {
            return;
        }

        const keyword = await vscode.window.showInputBox({
            placeHolder: localize('grepEnterKeyword', 'Please enter a keyword'),
            prompt: localize('grepEnterKeyword', 'Please enter a keyword...'),
            ignoreFocusOut: true
        });

        if (keyword === undefined || keyword === "") {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: localize('grepStart', "Start search..."),
            cancellable: true,
        }, async (progress, token) => {
            token.onCancellationRequested(() => {
                if (child) {
                    child.kill();
                }
            });

            return new Promise<void>((resolve, reject) => {
                progress.report({
                    message: localize('grepProgress', "Searching for keyword: {0}...", keyword)
                });

                if (this.memoGrepUseRipGrepConfigFile) {
                    if (this.memoGrepUseRipGrepConfigFilePath === undefined) {
                        process.env.RIPGREP_CONFIG_PATH = upath.normalize(upath.join(os.homedir(), '.ripgreprc'));
                    } else if (fs.existsSync(upath.normalize(this.memoGrepUseRipGrepConfigFilePath))) {
                        process.env.RIPGREP_CONFIG_PATH = upath.normalize(this.memoGrepUseRipGrepConfigFilePath);
                    } else {
                        vscode.window.showErrorMessage(`${this.memoGrepUseRipGrepConfigFilePath} No such file or directory`);
                        reject();
                        return;
                    }

                    args = [];
                } else {
                    process.env.RIPGREP_CONFIG_PATH = '';
                    args = ['--vimgrep', '--color', 'never', '-S'];
                    for (const extname of this.memoListDisplayExtname) {
                        args.push('-g', `*.${extname}`);
                    }
                }

                child = cp.spawn(rgPath, args.concat([keyword, searchRoot]), {
                    stdio: ['inherit'],
                    cwd: searchRoot
                });

                child.stdout?.setEncoding('utf-8');
                child.stdout?.on("data", (message) => {
                    result += message;

                    if (result.split('\n').length > 10000) {
                        child.stdout?.removeAllListeners();
                        list = result.split('\n').sort((a, b) => (a < b ? 1 : -1));
                        vscode.window.showInformationMessage(localize('grepResultMax', 'Search result exceeded 10000. Please enter a more specific search pattern and narrow down the search results'));
                        resolve();
                    }
                });

                child.stderr?.setEncoding('utf-8');
                child.stderr?.on("data", (message) => {
                    vscode.window.showErrorMessage(message.toString());
                });

                child.on("close", async (code) => {
                    if (code === 0) {
                        list = result.split('\n').sort((a, b) => (a < b ? 1 : -1));
                        resolve();
                    } else {
                        list = [];
                        vscode.window.showWarningMessage(localize('grepNoResult', 'No keywords found'));
                        reject();
                    }
                });
            });
        }).then(() => {
            list.forEach((vlist, index) => {
                if (vlist === '') {
                    return;
                }

                const filename = vlist.match((process.platform === "win32") ? /^(.*?)(?=:).(.*?)(?=:)/gm : /^(.*?)(?=:)/gm)?.toString();
                if (!filename) {
                    return;
                }

                const line = Number(vlist.replace((process.platform === "win32") ? /^(.*?)(?=:).(.*?)(?=:)/gm : /^(.*?)(?=:)/gm, "")
                    .replace(/^:/gm, "").match(/^(.*?)(?=:)/gm)?.toString());

                const col = Number(vlist.replace((process.platform === "win32") ? /^(.*?)(?=:).(.*?)(?=:)/gm : /^(.*?)(?=:)/gm, "")
                    .replace(/^:/gm, "").replace(/^(.*?)(?=:)/gm, "").replace(/^:/gm, "").match(/^(.*?)(?=:)/gm)?.toString());

                const lineResult = vlist.replace((process.platform === "win32") ? /^(.*?)(?=:).(.*?)(?=:).(.*?)(?=:).(.*?)(?=:):/gm : /^(.*?)(?=:).(.*?)(?=:).(.*?)(?=:):/gm, "").toString();

                items.push({
                    label: localize('grepResultLabel', '{0} - $(location) Ln:{1} Col:{2}', index, line, col),
                    description: `$(eye) ${lineResult}`,
                    detail: `$(calendar) ${upath.basename(filename)}`,
                    ln: line,
                    col,
                    index,
                    filename,
                    isDirectory: false,
                    birthtime: null,
                    mtime: null
                });

            });

            if (grepViewMode === 'outputChannel' || grepViewMode === 'both') {
                this.showResultsInOutputChannel(keyword, searchRoot, items.length, list);
                if (grepViewMode === 'outputChannel') {
                    return;
                }
            }

            if (grepViewMode === 'readOnlyDocument') {
                void this.showResultsInVirtualDocument(keyword, searchRoot, items);
                return;
            }

            if (grepViewMode === 'editableDocument') {
                void this.showResultsInUntitledDocument(keyword, searchRoot, items);
                return;
            }

            vscode.window.showQuickPick<items>(items, {
                ignoreFocusOut: true,
                matchOnDescription: true,
                matchOnDetail: true,
                placeHolder: `${localize('grepResult', 'grep Result: {0} ... (Number of results: {1})', keyword, items.length)} [${getMemoRelativeDirectoryLabel(this.memodir, searchRoot)}]`,
                onDidSelectItem: async (selected: items) => {
                    if (!selected) {
                        grepLineDecoration?.dispose();
                        grepKeywordDecoration?.dispose();
                        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                        return;
                    }

                    vscode.workspace.openTextDocument(selected.filename).then(document => {
                        vscode.window.showTextDocument(document, {
                            viewColumn: 1,
                            preserveFocus: true,
                            preview: true
                        }).then(() => {
                            const editor = vscode.window.activeTextEditor;
                            const position = editor.selection.active;
                            const newPosition = position.with(Number(selected.ln) - 1, Number(selected.col) - 1);
                            editor.selection = new vscode.Selection(newPosition, newPosition);

                            grepLineDecoration?.dispose();
                            grepKeywordDecoration?.dispose();

                            const startPosition = new vscode.Position(Number(selected.ln) - 1, 0);
                            grepLineDecoration = vscode.window.createTextEditorDecorationType(<vscode.DecorationRenderOptions>{
                                isWholeLine: true,
                                gutterIconPath: this.memoWithRespectMode === true ? upath.join(__filename, '..', '..', '..', 'resources', 'Q2xhdWRpYVNEM3gxNjA=.png')
                                    : (this.memoGutterIconPath ? this.memoGutterIconPath
                                    : upath.join(__filename, '..', '..', '..', 'resources', 'sun.svg')),
                                gutterIconSize: this.memoGutterIconSize ? this.memoGutterIconSize : '100% auto',
                                backgroundColor: this.memoGrepLineBackgroundColor
                            });

                            const startKeywordPosition = new vscode.Position(Number(selected.ln) - 1, Number(selected.col) - 1);
                            const endKeywordPosition = new vscode.Position(Number(selected.ln) - 1, Number(selected.col) + keyword.length - 1);
                            grepKeywordDecoration = vscode.window.createTextEditorDecorationType(<vscode.DecorationRenderOptions>{
                                isWholeLine: false,
                                backgroundColor: this.memoGrepKeywordBackgroundColor
                            });

                            editor.setDecorations(grepLineDecoration, [new vscode.Range(startPosition, startPosition)]);
                            editor.setDecorations(grepKeywordDecoration, [new vscode.Range(startKeywordPosition, endKeywordPosition)]);
                            editor.revealRange(editor.selection, vscode.TextEditorRevealType.Default);
                        });
                    });
                }
            }).then((selected) => {
                if (!selected) {
                    grepLineDecoration?.dispose();
                    grepKeywordDecoration?.dispose();
                    vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    return;
                }

                vscode.workspace.openTextDocument(selected.filename).then(document => {
                    vscode.window.showTextDocument(document, {
                        viewColumn: 1,
                        preserveFocus: true,
                        preview: true
                    }).then(() => {
                        const editor = vscode.window.activeTextEditor;
                        const position = editor.selection.active;
                        const newPosition = position.with(Number(selected.ln) - 1, Number(selected.col) - 1);
                        editor.selection = new vscode.Selection(newPosition, newPosition);
                        editor.revealRange(editor.selection, vscode.TextEditorRevealType.Default);
                    });
                }).then(() => {
                    setTimeout(() => {
                        grepLineDecoration?.dispose();
                        grepKeywordDecoration?.dispose();
                    }, 500);
                });
            });
        }, () => undefined);
    }

    private resolveRipgrepPath(): string {
        if (fs.existsSync(upath.normalize(upath.join(vscode.env.appRoot, "node_modules", "@vscode")))) {
            return upath.normalize(upath.join(vscode.env.appRoot, "node_modules", "@vscode", "ripgrep", "bin", "rg"));
        }

        if (fs.existsSync(upath.normalize(upath.join(vscode.env.appRoot, "node_modules.asar.unpacked")))) {
            if (fs.existsSync(upath.normalize(upath.join(vscode.env.appRoot, "node_modules.asar.unpacked", "@vscode")))) {
                return upath.normalize(upath.join(vscode.env.appRoot, "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", "rg"));
            }

            return upath.normalize(upath.join(vscode.env.appRoot, "node_modules.asar.unpacked", "vscode-ripgrep", "bin", "rg"));
        }

        return upath.normalize(upath.join(vscode.env.appRoot, "node_modules", "vscode-ripgrep", "bin", "rg"));
    }

    private async pickSearchRoot(): Promise<string | undefined> {
        const currentYearDir = getMemoDateDirectory(this.memodir, 'yyyy');
        const currentMonthDir = getMemoDateDirectory(this.memodir, 'yyyy/MM');
        const directoryItems = this.listDirectories(this.memodir).map((folder, index) => ({
            label: getMemoRelativeDirectoryLabel(this.memodir, folder),
            description: folder,
            detail: localize('grepScopeFolder', 'Select this folder as search scope'),
            ln: null,
            col: null,
            index,
            filename: folder,
            isDirectory: true,
            birthtime: null,
            mtime: null
        }));

        const scopeItems: items[] = [
            {
                label: localize('grepScopeAll', 'All memos'),
                description: this.memodir,
                detail: localize('grepScopeAllDetail', 'Search all memo files'),
                ln: null,
                col: null,
                index: -1,
                filename: this.memodir,
                isDirectory: true,
                birthtime: null,
                mtime: null
            },
            {
                label: localize('grepScopeYear', 'This year'),
                description: dateFns.format(new Date(), 'yyyy'),
                detail: fs.existsSync(currentYearDir) ? currentYearDir : localize('grepScopeMissing', 'Folder does not exist yet'),
                ln: null,
                col: null,
                index: -2,
                filename: currentYearDir,
                isDirectory: true,
                birthtime: null,
                mtime: null
            },
            {
                label: localize('grepScopeMonth', 'This month'),
                description: dateFns.format(new Date(), 'yyyy/MM'),
                detail: fs.existsSync(currentMonthDir) ? currentMonthDir : localize('grepScopeMissing', 'Folder does not exist yet'),
                ln: null,
                col: null,
                index: -3,
                filename: currentMonthDir,
                isDirectory: true,
                birthtime: null,
                mtime: null
            },
            {
                label: localize('grepScopeChooseFolder', 'Choose subfolder'),
                description: localize('grepScopeChooseFolderDescription', 'Pick a child folder under memodir'),
                detail: localize('grepScopeChooseFolderDetail', 'Useful for narrowing search to yyyy/MM or custom folders'),
                ln: null,
                col: null,
                index: -4,
                filename: this.memodir,
                isDirectory: true,
                birthtime: null,
                mtime: null
            }
        ];

        const selected = await vscode.window.showQuickPick<items>(scopeItems, {
            ignoreFocusOut: true,
            placeHolder: localize('grepScopePlaceholder', 'Choose the search scope')
        });

        if (!selected) {
            return undefined;
        }

        if (selected.index === -4) {
            const directory = await vscode.window.showQuickPick<items>(directoryItems, {
                ignoreFocusOut: true,
                matchOnDescription: true,
                matchOnDetail: true,
                placeHolder: localize('grepScopeChooseFolder', 'Choose subfolder')
            });
            return directory?.filename;
        }

        if (!fs.existsSync(selected.filename)) {
            vscode.window.showWarningMessage(localize('grepScopeMissing', 'Folder does not exist yet'));
            return undefined;
        }

        return selected.filename;
    }

    private listDirectories(dir: string, result: string[] = []): string[] {
        const index = MemoIndex.getInstance();
        if (index && upath.normalizeTrim(index.getMemodir()) === upath.normalizeTrim(dir)) {
            return index.getDirectories();
        }

        const dirents = fs.readdirSync(dir, { withFileTypes: true });
        for (const dirent of dirents) {
            if (!dirent.isDirectory()) {
                continue;
            }

            const fullpath = upath.normalize(upath.join(dir, dirent.name));
            result.push(fullpath);
            this.listDirectories(fullpath, result);
        }

        return result.sort((a, b) => (a > b ? 1 : -1));
    }

    private showResultsInOutputChannel(keyword: string, searchRoot: string, resultCount: number, results: string[]): void {
        this.memoGrepChannel.clear();
        this.memoGrepChannel.appendLine(localize('grepResultHeader', 'Memo: Grep'));
        this.memoGrepChannel.appendLine(localize('grepResultKeyword', 'Keyword: {0}', keyword));
        this.memoGrepChannel.appendLine(localize('grepResultScope', 'Scope: {0}', getMemoRelativeDirectoryLabel(this.memodir, searchRoot)));
        this.memoGrepChannel.appendLine(localize('grepResultCount', 'Results: {0}', resultCount));
        this.memoGrepChannel.appendLine('');

        results.forEach((result, index) => {
            if (!result) {
                return;
            }

            this.memoGrepChannel.appendLine(`${index}: ${result}`);
        });
        this.memoGrepChannel.show(true);
    }

    private getNormalizedGrepViewMode(): 'quickPick' | 'outputChannel' | 'both' | 'readOnlyDocument' | 'editableDocument' {
        switch (this.memoGrepViewMode) {
            case 'both':
                return 'both';
            case 'virtualDocument':
            case 'readOnlyDocument':
                return 'readOnlyDocument';
            case 'untitledDocument':
            case 'editableDocument':
                return 'editableDocument';
            case 'outputChannel':
                return 'outputChannel';
            default:
                return 'quickPick';
        }
    }

    private async showResultsInVirtualDocument(keyword: string, searchRoot: string, results: items[]): Promise<void> {
        if (!memoGrep.grepDocumentProvider) {
            return;
        }

        const uri = vscode.Uri.parse(`${memoGrep.grepDocumentScheme}:Memo%20Grep%20${Date.now()}.md`);
        const content = this.buildVirtualDocumentContent(keyword, searchRoot, results);
        memoGrep.grepDocumentProvider.setContent(uri, content);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, {
            preview: false,
            preserveFocus: false,
            viewColumn: vscode.ViewColumn.Active
        });
    }

    private async showResultsInUntitledDocument(keyword: string, searchRoot: string, results: items[]): Promise<void> {
        const content = this.buildVirtualDocumentContent(keyword, searchRoot, results);
        const uri = vscode.Uri.parse(`untitled:Memo Grep ${dateFns.format(new Date(), 'yyyy-MM-dd HHmmss')}.md`);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, {
            preview: false,
            preserveFocus: false,
            viewColumn: vscode.ViewColumn.Active
        });
        await editor.edit((editBuilder) => {
            editBuilder.insert(new vscode.Position(0, 0), content);
        });
    }

    private buildVirtualDocumentContent(keyword: string, searchRoot: string, results: items[]): string {
        const lines = [
            '# Memo: Grep',
            '',
            `- Keyword: ${keyword}`,
            `- Scope: ${getMemoRelativeDirectoryLabel(this.memodir, searchRoot)}`,
            `- Results: ${results.length}`,
            ''
        ];

        results.forEach((result) => {
            const relativePath = getMemoRelativeDirectoryLabel(this.memodir, result.filename);
            const fileUri = vscode.Uri.file(result.filename).with({ fragment: `L${result.ln},${result.col}` }).toString();
            const summary = result.description.replace(/^\$\((.*?)\)\s*/, '');
            lines.push(`- [${relativePath}:${result.ln}:${result.col}](${fileUri})`);
            lines.push(`  - ${summary}`);
        });

        lines.push('');
        return lines.join('\n');
    }

    dispose() {
        this._disposable?.dispose();
    }
}
