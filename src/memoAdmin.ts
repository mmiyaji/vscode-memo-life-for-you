'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as upath from 'upath';
import * as dateFns from 'date-fns';
import * as nls from 'vscode-nls';
import { memoConfigure } from './memoConfigure';
import { getMemoDateDirectory, getMemoRelativeDirectoryLabel } from './memoPath';
import { AdminLocale, escapeHtml, MemoRecentItem, renderBarList, renderRecentFiles } from './memoAdminRender';
import { MemoIndex, FileMeta } from './memoIndex';
import { MemoSnippetProvider } from './memoSnippets';

const localize = nls.config({ messageFormat: nls.MessageFormat.file })();

type MemoStats = {
    totalFiles: number;
    yearCounts: Array<{ label: string; count: number }>;
    monthCounts: Array<{ label: string; count: number }>;
    folderCounts: Array<{ label: string; count: number }>;
    pinnedFiles: Array<{ label: string; title: string; pathLabel: string; createdAt: string; updatedAt: string; filename: string; fileSizeLabel: string; mtimeMs: number }>;
    recentFiles: Array<{ label: string; title: string; pathLabel: string; createdAt: string; updatedAt: string; filename: string; fileSizeLabel: string; mtimeMs: number }>;
    calendarData: Record<string, { count: number; files: string[] }>;
    tagCounts: Array<{ tag: string; count: number }>;
};
type MemoStatsCache = {
    key: string;
    stats: MemoStats;
    createdAt: number;
};

export class memoAdmin extends memoConfigure {
    public static readonly pendingOpenKey = 'memoAdmin.pendingOpenInNewWindow';
    private static readonly statsCacheTtlMs = 5000;
    private static currentPanel: vscode.WebviewPanel | undefined;
    private static openingPanelPromise: Promise<void> | undefined;
    private static statsCache: MemoStatsCache | undefined;
    private static memoIndex: MemoIndex | undefined;
    private static indexDisposable: vscode.Disposable | undefined;
    private static snippetProvider: MemoSnippetProvider | undefined;

    public static setSnippetProvider(provider: MemoSnippetProvider): void {
        memoAdmin.snippetProvider = provider;
    }

    public static getAllTags(): string[] {
        return memoAdmin.memoIndex?.getAllTags() ?? [];
    }

    public async initializeIndex(context: vscode.ExtensionContext): Promise<void> {
        this.readConfig();
        if (!this.memodir || !fs.existsSync(this.memodir)) {
            return;
        }
        await memoAdmin.disposeIndex();
        memoAdmin.memoIndex = await MemoIndex.create(this.memodir, this.memoListDisplayExtname);
        memoAdmin.indexDisposable = memoAdmin.memoIndex.startWatching();
        context.subscriptions.push(memoAdmin.indexDisposable);
    }

    public static async flushIndex(): Promise<void> {
        if (memoAdmin.memoIndex) {
            await memoAdmin.memoIndex.flush();
        }
    }

    public static async disposeIndex(): Promise<void> {
        if (memoAdmin.memoIndex) {
            await memoAdmin.memoIndex.flush();
            memoAdmin.memoIndex.dispose();
            memoAdmin.memoIndex = undefined;
        }
        if (memoAdmin.indexDisposable) {
            memoAdmin.indexDisposable.dispose();
            memoAdmin.indexDisposable = undefined;
        }
    }

    public async Show(context: vscode.ExtensionContext) {
        if (memoAdmin.currentPanel) {
            memoAdmin.currentPanel.reveal(vscode.ViewColumn.One);
            this.renderPanel(memoAdmin.currentPanel, context);
            return;
        }

        if (memoAdmin.openingPanelPromise) {
            await memoAdmin.openingPanelPromise;
            if (memoAdmin.currentPanel) {
                memoAdmin.currentPanel.reveal(vscode.ViewColumn.One);
                this.renderPanel(memoAdmin.currentPanel, context);
            }
            return;
        }

        this.readConfig();

        memoAdmin.openingPanelPromise = (async () => {
            await this.revealMemoRootInExplorer();

            if (memoAdmin.currentPanel) {
                return;
            }

            const panel = vscode.window.createWebviewPanel('memoAdmin', localize('extension.memoAdmin.title', 'Memo Admin'), vscode.ViewColumn.One, {
                enableScripts: true,
                retainContextWhenHidden: true
            });
            memoAdmin.currentPanel = panel;

            panel.webview.onDidReceiveMessage(async (message) => {
                switch (message.command) {
                    case 'openFolder':
                        if (!this.memodir || !fs.existsSync(this.memodir)) {
                            vscode.window.showErrorMessage(localize('memoAdmin.invalidMemoDir', 'The selected memo root does not exist'));
                            return;
                        }
                        try {
                            const target = vscode.Uri.file(this.memodir);
                            await vscode.commands.executeCommand('revealFileInOS', target);
                        } catch {
                            vscode.window.showErrorMessage(localize('memoAdmin.openFolderFailed', 'Failed to open the memo root in the file explorer'));
                        }
                        break;
                    case 'openConfig':
                        await vscode.commands.executeCommand('extension.memoConfig');
                        break;
                    case 'newMemo':
                        await vscode.commands.executeCommand('extension.memoNew');
                        break;
                    case 'searchMemo':
                        await vscode.commands.executeCommand('extension.memoGrep');
                        break;
                    case 'openRecentFile':
                        if (message.filename && fs.existsSync(message.filename)) {
                            const document = await vscode.workspace.openTextDocument(message.filename);
                            await vscode.window.showTextDocument(document, {
                                viewColumn: vscode.ViewColumn.One,
                                preview: true,
                                preserveFocus: false
                            });
                        }
                        break;
                    case 'searchTag':
                        if (message.tag && memoAdmin.memoIndex) {
                            const files = memoAdmin.memoIndex.getFilesByTag(message.tag);
                            if (files.length === 0) {
                                break;
                            }
                            const items = files.map(relativePath => ({
                                label: upath.basename(relativePath),
                                description: relativePath,
                                absolutePath: memoAdmin.memoIndex.toAbsolutePath(relativePath),
                            }));
                            const picked = await vscode.window.showQuickPick(items, {
                                placeHolder: `#${message.tag} (${files.length})`,
                                ignoreFocusOut: true,
                            });
                            if (picked && fs.existsSync(picked.absolutePath)) {
                                const doc = await vscode.workspace.openTextDocument(picked.absolutePath);
                                await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true });
                            }
                        }
                        break;
                    case 'openSettings':
                        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:mmiyaji.memo-life-for-you-admin memo-life-for-you');
                        break;
                    case 'openKeyboardShortcuts':
                        await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings');
                        break;
                case 'openLink':
                    if (message.url) {
                        await vscode.env.openExternal(vscode.Uri.parse(message.url));
                    }
                    break;
                case 'refreshAdmin':
                    this.invalidateStatsCache();
                    if (memoAdmin.memoIndex) {
                        await memoAdmin.memoIndex.sync();
                    }
                    this.renderPanel(panel, context);
                    break;
                case 'openStatsTarget':
                    if (message.targetPath && fs.existsSync(message.targetPath)) {
                        await this.ensureMemoWorkspaceFolder();
                        await vscode.commands.executeCommand('workbench.view.explorer');
                        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(message.targetPath));
                    }
                    break;
                case 'pinRecentFile':
                    if (message.filename && fs.existsSync(message.filename)) {
                        await this.updatePinnedFiles((current) => [message.filename, ...current]);
                        this.invalidateStatsCache();
                        this.renderPanel(panel, context);
                    }
                    break;
                case 'unpinRecentFile':
                    if (message.filename) {
                        await this.updatePinnedFiles((current) => current.filter((filename) => this.normalizeWorkspacePath(filename) !== this.normalizeWorkspacePath(message.filename)));
                        this.invalidateStatsCache();
                        this.renderPanel(panel, context);
                    }
                    break;
                case 'createWorkspace': {
                        if (!this.memodir || !fs.existsSync(this.memodir)) {
                            vscode.window.showErrorMessage(localize('memoAdmin.invalidMemoDir', 'The selected memo root does not exist'));
                            return;
                        }

                        const documentsDir = upath.normalize(upath.join(process.env.USERPROFILE || process.env.HOME || '', 'Documents'));
                        const selectedUri = await vscode.window.showSaveDialog({
                            defaultUri: vscode.Uri.file(upath.join(documentsDir, 'Memo Admin.code-workspace')),
                            filters: {
                                'VS Code Workspace': ['code-workspace']
                            },
                            saveLabel: localize('memoAdmin.saveWorkspaceFile', 'Save workspace file')
                        });

                        if (!selectedUri) {
                            return;
                        }

                        const workspacePath = selectedUri.fsPath.endsWith('.code-workspace')
                            ? selectedUri.fsPath
                            : `${selectedUri.fsPath}.code-workspace`;
                        this.scaffoldMemoFolders(this.memodir);

                        const workspaceContent = JSON.stringify({
                            folders: [
                                {
                                    path: this.memodir,
                                    name: 'MEMO'
                                }
                            ],
                            settings: {
                                'memo-life-for-you.memoAdminOpenOnStartup': true,
                                'memo-life-for-you.memoAdminOpenMode': 'currentWindow',
                                'memo-life-for-you.memoTemplatesDir': upath.join(this.memodir, '.templates'),
                                'memo-life-for-you.memoSnippetsDir': upath.join(this.memodir, '.snippets'),
                                'markdown.copyFiles.destination': {
                                    '*': 'assets/${isoTime/^(\\d+)-(\\d+)-(\\d+)T(\\d+):(\\d+):(\\d+).+/$1$2$3-$4$5$6/}.${fileExtName}'
                                },
                                'workbench.colorCustomizations': this.getWorkspaceColorCustomizations()
                            },
                            extensions: {
                                recommendations: [
                                    'mmiyaji.memo-life-for-you-admin',
                                    'yzhang.markdown-all-in-one',
                                    'mmiyaji.vscode-undotree'
                                ]
                            }
                        }, null, 2);

                        fs.writeFileSync(workspacePath, `${workspaceContent}\n`, 'utf8');
                        const document = await vscode.workspace.openTextDocument(workspacePath);
                        await vscode.window.showTextDocument(document, {
                            viewColumn: vscode.ViewColumn.One,
                            preview: false,
                            preserveFocus: false
                        });
                        vscode.window.showInformationMessage(localize('memoAdmin.workspaceCreated', 'Created workspace file: {0}', workspacePath));
                        break;
                    }
                    case 'saveCoreSettings':
                        if (!message.memodir || !fs.existsSync(message.memodir)) {
                            vscode.window.showErrorMessage(localize('memoAdmin.invalidMemoDir', 'The selected memo root does not exist'));
                            return;
                        }

                        if (message.memotemplate && message.memotemplate !== "" && !fs.existsSync(message.memotemplate)) {
                            vscode.window.showErrorMessage(localize('memoAdmin.invalidTemplate', 'The selected template file does not exist'));
                            return;
                        }

                        this.updateTomlConfig({
                            memodir: message.memodir ?? this.memodir,
                            memotemplate: message.memotemplate ?? this.memotemplate ?? "",
                            memoDatePathFormat: message.memoDatePathFormat ?? this.memoDatePathFormat ?? "yyyy/MM"
                        });
                        await this.revealMemoRootInExplorer();
                        this.renderPanel(panel, context);
                        vscode.window.showInformationMessage(localize('memoAdmin.saved', 'Memo settings updated'));
                        break;
                    case 'pickMemoDir': {
                        const picked = await vscode.window.showOpenDialog({
                            canSelectFiles: false,
                            canSelectFolders: true,
                            canSelectMany: false,
                            defaultUri: fs.existsSync(this.memodir) ? vscode.Uri.file(this.memodir) : undefined,
                            openLabel: localize('memoAdmin.pickMemoDir', 'Select memo root')
                        });
                        if (picked?.[0]) {
                            panel.webview.postMessage({ command: 'setMemoDir', value: picked[0].fsPath });
                        }
                        break;
                    }
                    case 'pickTemplateFile': {
                        const effectiveTemplatePath = this.memotemplate || this.ensureBuiltInTemplateFile();
                        const picked = await vscode.window.showOpenDialog({
                            canSelectFiles: true,
                            canSelectFolders: false,
                            canSelectMany: false,
                            defaultUri: effectiveTemplatePath && fs.existsSync(effectiveTemplatePath) ? vscode.Uri.file(effectiveTemplatePath) : undefined,
                            openLabel: localize('memoAdmin.pickTemplateFile', 'Select template file')
                        });
                        if (picked?.[0]) {
                            panel.webview.postMessage({ command: 'setTemplateFile', value: picked[0].fsPath });
                        }
                        break;
                    }
                    case 'calendarOpenDate': {
                        if (!message.date || !this.memodir) {
                            return;
                        }
                        const targetDate = dateFns.parseISO(message.date);
                        const dateDir = getMemoDateDirectory(this.memodir, this.memoDatePathFormat || '', targetDate);
                        const fileName = dateFns.format(targetDate, 'yyyy-MM-dd') + '.md';
                        const filePath = upath.normalize(upath.join(dateDir, fileName));

                        if (fs.existsSync(filePath)) {
                            const document = await vscode.workspace.openTextDocument(filePath);
                            await vscode.window.showTextDocument(document, {
                                viewColumn: vscode.ViewColumn.One,
                                preview: true,
                                preserveFocus: false
                            });
                        } else {
                            const answer = await vscode.window.showInformationMessage(
                                localize('memoAdmin.calendarCreateConfirm', 'No memo exists for {0}. Create one?', message.date),
                                localize('memoAdmin.calendarCreate', 'Create'),
                                localize('memoAdmin.calendarCancel', 'Cancel')
                            );
                            if (answer === localize('memoAdmin.calendarCreate', 'Create')) {
                                fs.mkdirSync(dateDir, { recursive: true });
                                const os = require('os');
                                const dateFormat = this.memoDateFormat;
                                const titlePrefix = this.memoTitlePrefix || '';
                                const content = '# ' + titlePrefix + dateFns.format(targetDate, `${dateFormat}`) + os.EOL + os.EOL;
                                fs.writeFileSync(filePath, content, 'utf8');
                                const document = await vscode.workspace.openTextDocument(filePath);
                                await vscode.window.showTextDocument(document, {
                                    viewColumn: vscode.ViewColumn.One,
                                    preview: false,
                                    preserveFocus: false
                                });
                                this.invalidateStatsCache();
                                this.renderPanel(panel, context);
                            }
                        }
                        break;
                    }
                    case 'indexRebuild':
                        if (memoAdmin.memoIndex) {
                            const result = await memoAdmin.memoIndex.rebuild();
                            vscode.window.showInformationMessage(localize('memoAdmin.indexRebuilt', 'Index rebuilt: {0} entries', result.entries));
                            this.invalidateStatsCache();
                            this.renderPanel(panel, context);
                        }
                        break;
                    case 'indexFlush':
                        if (memoAdmin.memoIndex) {
                            await memoAdmin.memoIndex.flush();
                            vscode.window.showInformationMessage(localize('memoAdmin.indexFlushed', 'Index saved to disk'));
                            this.renderPanel(panel, context);
                        }
                        break;
                    case 'indexSync':
                        if (memoAdmin.memoIndex) {
                            await memoAdmin.memoIndex.sync();
                            this.invalidateStatsCache();
                            this.renderPanel(panel, context);
                        }
                        break;
                }
            });

            const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('memo-life-for-you')) {
                    this.renderPanel(panel, context);
                }
            });
            const themeListener = vscode.window.onDidChangeActiveColorTheme(() => {
                this.renderPanel(panel, context);
            });

            panel.onDidDispose(() => {
                configListener.dispose();
                themeListener.dispose();
                if (memoAdmin.currentPanel === panel) {
                    memoAdmin.currentPanel = undefined;
                }
            });

            this.renderPanel(panel, context);
        })();

        try {
            await memoAdmin.openingPanelPromise;
        } finally {
            memoAdmin.openingPanelPromise = undefined;
        }
    }

    public async ShowInNewWindow(context: vscode.ExtensionContext): Promise<void> {
        this.readConfig();

        if (!this.memodir || !fs.existsSync(this.memodir)) {
            vscode.window.showErrorMessage(localize('memoAdmin.invalidMemoDir', 'The selected memo root does not exist'));
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        if (workspaceFolders.length === 1 && upath.normalize(workspaceFolders[0].uri.fsPath) === upath.normalize(this.memodir)) {
            await this.Show(context);
            return;
        }

        await context.globalState.update(memoAdmin.pendingOpenKey, { memodir: this.memodir });
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(this.memodir), true);
    }

    private async revealMemoRootInExplorer(): Promise<void> {
        try {
            if (!this.memodir || !fs.existsSync(this.memodir)) {
                return;
            }
            await this.ensureMemoWorkspaceFolder();
            await vscode.commands.executeCommand('workbench.view.explorer');
            await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(this.getExplorerRevealPath()));
        } catch {
            return;
        }
    }

    private getExplorerRevealPath(): string {
        try {
            const todayDir = getMemoDateDirectory(this.memodir, this.memoDatePathFormat);
            if (fs.existsSync(todayDir)) {
                const todayFiles = fs.readdirSync(todayDir, { withFileTypes: true })
                    .filter((entry) => entry.isFile())
                    .map((entry) => upath.join(todayDir, entry.name))
                    .sort((a, b) => a.localeCompare(b));
                if (todayFiles.length > 0) {
                    return todayFiles[todayFiles.length - 1];
                }
                return todayDir;
            }
        } catch {
            return this.memodir;
        }

        return this.memodir;
    }

    private async ensureMemoWorkspaceFolder(): Promise<void> {
        const memoUri = vscode.Uri.file(this.memodir);
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const normalizedMemoDir = this.normalizeWorkspacePath(this.memodir);

        const alreadyExists = workspaceFolders.some((folder) => this.normalizeWorkspacePath(folder.uri.fsPath) === normalizedMemoDir);
        if (alreadyExists) {
            return;
        }

        const insertIndex = workspaceFolders.length;
        vscode.workspace.updateWorkspaceFolders(insertIndex, 0, {
            uri: memoUri,
            name: 'Memo'
        });
    }

    private normalizeWorkspacePath(pathValue: string): string {
        const normalized = upath.normalizeTrim(pathValue);
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }

    private invalidateStatsCache(): void {
        memoAdmin.statsCache = undefined;
    }

    private getSettingsTarget(): vscode.ConfigurationTarget {
        return (vscode.workspace.workspaceFolders?.length ?? 0) > 0
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
    }

    private async updatePinnedFiles(updater: (current: string[]) => string[]): Promise<void> {
        const normalizedCurrent = (this.memoPinnedFiles ?? [])
            .map((filename) => upath.normalizeTrim(filename))
            .filter(Boolean);
        const next = updater(normalizedCurrent)
            .map((filename) => upath.normalizeTrim(filename))
            .filter((filename, index, array) => !!filename && array.indexOf(filename) === index);
        await vscode.workspace.getConfiguration('memo-life-for-you').update('memoPinnedFiles', next, this.getSettingsTarget());
        this.updateConfiguration();
    }

    private scaffoldMemoFolders(memodir: string): void {
        const templatesDir = upath.join(memodir, '.templates');
        const snippetsDir = upath.join(memodir, '.snippets');
        const assetsDir = upath.join(memodir, 'assets');

        for (const dir of [templatesDir, snippetsDir, assetsDir]) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        const sampleTemplate = upath.join(templatesDir, 'default.md');
        if (!fs.existsSync(sampleTemplate)) {
            fs.writeFileSync(sampleTemplate, [
                '# {{.Date}} {{.Title}}',
                '',
                '## Summary',
                '',
                '',
                '',
                '## Notes',
                '',
                '',
                ''
            ].join('\n'), 'utf8');
        }

        const meetingTemplate = upath.join(templatesDir, 'meeting.md');
        if (!fs.existsSync(meetingTemplate)) {
            fs.writeFileSync(meetingTemplate, [
                '# {{.Date}} {{.Title}}',
                '',
                '## Attendees',
                '',
                '- ',
                '',
                '## Agenda',
                '',
                '1. ',
                '',
                '## Action Items',
                '',
                '- [ ] ',
                '',
                ''
            ].join('\n'), 'utf8');
        }

        const sampleSnippet = upath.join(snippetsDir, 'memo.json');
        if (!fs.existsSync(sampleSnippet)) {
            const snippetContent = {
                'Task list': {
                    prefix: 'task',
                    body: [
                        '## Tasks',
                        '',
                        '- [ ] ${1:task}',
                        '- [ ] ${2:task}',
                        '- [ ] ${3:task}',
                        ''
                    ],
                    description: 'Insert a task checklist'
                },
                'Code block': {
                    prefix: 'codeblock',
                    body: [
                        '```${1:language}',
                        '${2:code}',
                        '```',
                        ''
                    ],
                    description: 'Insert a fenced code block'
                },
                'Table': {
                    prefix: 'table',
                    body: [
                        '| ${1:Header1} | ${2:Header2} | ${3:Header3} |',
                        '|---|---|---|',
                        '| ${4:cell} | ${5:cell} | ${6:cell} |',
                        ''
                    ],
                    description: 'Insert a markdown table'
                }
            };
            fs.writeFileSync(sampleSnippet, JSON.stringify(snippetContent, null, 2) + '\n', 'utf8');
        }
    }

    private getWorkspaceColorCustomizations(): Record<string, string> {
        const colors = this.getWorkspaceThemeColors(this.memoAdminColorTheme || 'blue');
        return {
            'statusBar.background': colors.statusBarBackground,
            'statusBar.foreground': colors.statusBarForeground,
            'statusBar.border': colors.statusBarBorder,
            'titleBar.activeBackground': colors.titleBarBackground,
            'titleBar.activeForeground': colors.titleBarForeground
        };
    }

    private getWorkspaceThemeColors(theme: string): {
        statusBarBackground: string;
        statusBarForeground: string;
        statusBarBorder: string;
        titleBarBackground: string;
        titleBarForeground: string;
    } {
        switch (theme) {
            case 'teal':
                return {
                    statusBarBackground: '#1f5f5a',
                    statusBarForeground: '#f5fffd',
                    statusBarBorder: '#35b7ab',
                    titleBarBackground: '#194a46',
                    titleBarForeground: '#f5fffd'
                };
            case 'amber':
                return {
                    statusBarBackground: '#7a4b13',
                    statusBarForeground: '#fff8ed',
                    statusBarBorder: '#f0a53a',
                    titleBarBackground: '#5f3a0f',
                    titleBarForeground: '#fff8ed'
                };
            case 'rose':
                return {
                    statusBarBackground: '#7c3650',
                    statusBarForeground: '#fff7fa',
                    statusBarBorder: '#e76b96',
                    titleBarBackground: '#5f2940',
                    titleBarForeground: '#fff7fa'
                };
            case 'mono':
                return {
                    statusBarBackground: '#3d434a',
                    statusBarForeground: '#f5f7f9',
                    statusBarBorder: '#aeb6bf',
                    titleBarBackground: '#2f3439',
                    titleBarForeground: '#f5f7f9'
                };
            case 'forest':
                return {
                    statusBarBackground: '#355c42',
                    statusBarForeground: '#f5fff8',
                    statusBarBorder: '#7fb091',
                    titleBarBackground: '#294734',
                    titleBarForeground: '#f5fff8'
                };
            default:
                return {
                    statusBarBackground: '#23415f',
                    statusBarForeground: '#f6fbff',
                    statusBarBorder: '#58a6ff',
                    titleBarBackground: '#1b3148',
                    titleBarForeground: '#f6fbff'
                };
        }
    }

    private collectStats(): MemoStats {
        if (!this.memodir || !fs.existsSync(this.memodir)) {
            return {
                totalFiles: 0,
                yearCounts: [],
                monthCounts: [],
                folderCounts: [],
                pinnedFiles: [],
                recentFiles: [],
                calendarData: {},
                tagCounts: [],
            };
        }

        const cacheKey = JSON.stringify({
            memodir: this.normalizeWorkspacePath(this.memodir),
            extnames: this.memoListDisplayExtname,
            datePathFormat: this.memoDatePathFormat,
            pinnedFiles: this.memoPinnedFiles
        });
        const now = Date.now();
        if (memoAdmin.statsCache
            && memoAdmin.statsCache.key === cacheKey
            && (now - memoAdmin.statsCache.createdAt) < memoAdmin.statsCacheTtlMs) {
            return memoAdmin.statsCache.stats;
        }

        const yearMap = new Map<string, number>();
        const monthMap = new Map<string, number>();
        const folderMap = new Map<string, number>();
        const dayMap = new Map<string, { count: number; files: string[] }>();

        let recentCandidates: MemoRecentItem[];

        const addDayEntry = (dayLabel: string, relativePath: string) => {
            const existing = dayMap.get(dayLabel);
            if (existing) {
                existing.count++;
                existing.files.push(relativePath);
            } else {
                dayMap.set(dayLabel, { count: 1, files: [relativePath] });
            }
        };

        if (memoAdmin.memoIndex) {
            const entries = memoAdmin.memoIndex.getEntries();
            const items: MemoRecentItem[] = [];
            for (const [relativePath, meta] of entries) {
                const filename = memoAdmin.memoIndex.toAbsolutePath(relativePath);
                const birthDate = new Date(meta.birthtime);
                const yearLabel = dateFns.format(birthDate, 'yyyy');
                const monthLabel = dateFns.format(birthDate, 'yyyy/MM');
                const dayLabel = dateFns.format(birthDate, 'yyyy-MM-dd');
                const folderLabel = getMemoRelativeDirectoryLabel(this.memodir, upath.dirname(filename));

                yearMap.set(yearLabel, (yearMap.get(yearLabel) ?? 0) + 1);
                monthMap.set(monthLabel, (monthMap.get(monthLabel) ?? 0) + 1);
                addDayEntry(dayLabel, relativePath);
                folderMap.set(folderLabel, (folderMap.get(folderLabel) ?? 0) + 1);

                items.push(this.createRecentFileEntryFromMeta(filename, meta));
            }
            recentCandidates = items.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 8);
        } else {
            const files = this.readFilesRecursively(this.memodir)
                .filter((filename) => this.memoListDisplayExtname.includes(upath.extname(filename).replace(/^\./, '')));

            const items: MemoRecentItem[] = [];
            for (const filename of files) {
                try {
                    const stat = fs.statSync(filename);
                    const yearLabel = dateFns.format(stat.birthtime, 'yyyy');
                    const monthLabel = dateFns.format(stat.birthtime, 'yyyy/MM');
                    const dayLabel = dateFns.format(stat.birthtime, 'yyyy-MM-dd');
                    const relativePath = getMemoRelativeDirectoryLabel(this.memodir, filename);
                    const folderLabel = getMemoRelativeDirectoryLabel(this.memodir, upath.dirname(filename));

                    yearMap.set(yearLabel, (yearMap.get(yearLabel) ?? 0) + 1);
                    monthMap.set(monthLabel, (monthMap.get(monthLabel) ?? 0) + 1);
                    addDayEntry(dayLabel, relativePath);
                    folderMap.set(folderLabel, (folderMap.get(folderLabel) ?? 0) + 1);

                    items.push(this.createRecentFileEntry(filename, stat));
                } catch {
                    // file may have been deleted between readdir and stat
                }
            }
            recentCandidates = items.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 8);
        }

        const recentFiles = recentCandidates;
        const pinnedFiles: MemoRecentItem[] = [];
        for (const raw of (this.memoPinnedFiles ?? [])) {
            const filename = upath.normalizeTrim(raw);
            if (!filename || pinnedFiles.some((p) => this.normalizeWorkspacePath(p.filename) === this.normalizeWorkspacePath(filename))) {
                continue;
            }
            try {
                const stat = fs.statSync(filename);
                pinnedFiles.push(this.createRecentFileEntry(filename, stat));
            } catch {
                // file may have been deleted
            }
        }
        pinnedFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

        let totalFiles = 0;
        for (const count of yearMap.values()) {
            totalFiles += count;
        }

        const calendarData: Record<string, { count: number; files: string[] }> = {};
        for (const [day, entry] of dayMap) {
            calendarData[day] = entry;
        }

        let tagCounts: Array<{ tag: string; count: number }> = [];
        if (memoAdmin.memoIndex) {
            const tagIndex = memoAdmin.memoIndex.getTagIndex();
            tagCounts = Array.from(tagIndex.entries())
                .map(([tag, files]) => ({ tag, count: files.length }))
                .sort((a, b) => b.count - a.count);
        }

        const stats = {
            totalFiles,
            yearCounts: this.mapToSortedArray(yearMap),
            monthCounts: this.mapToSortedArray(monthMap).slice(0, 12),
            folderCounts: this.mapToSortedArray(folderMap).slice(0, 12),
            pinnedFiles,
            recentFiles,
            calendarData,
            tagCounts,
        };
        memoAdmin.statsCache = {
            key: cacheKey,
            stats,
            createdAt: now
        };
        return stats;
    }

    private mapToSortedArray(map: Map<string, number>): Array<{ label: string; count: number }> {
        return Array.from(map.entries())
            .sort((a, b) => (a[0] < b[0] ? 1 : -1))
            .map(([label, count]) => ({ label, count }));
    }

    private readFilesRecursively(dir: string, files: string[] = []): string[] {
        const dirents = fs.readdirSync(dir, { withFileTypes: true });
        const dirs: string[] = [];

        for (const dirent of dirents) {
            const fullpath = upath.normalize(upath.join(dir, dirent.name));
            if (dirent.isDirectory()) {
                dirs.push(fullpath);
            }
            if (dirent.isFile()) {
                files.push(fullpath);
            }
        }

        for (const childDir of dirs) {
            this.readFilesRecursively(childDir, files);
        }

        return files;
    }

    private formatFileSize(size: number): string {
        if (size < 1024) {
            return `${size} B`;
        }
        if (size < 1024 * 1024) {
            return `${(size / 1024).toFixed(1)} KB`;
        }
        return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    }

    private createRecentFileEntry(filename: string, stat: fs.Stats): MemoRecentItem {
        const pathLabel = getMemoRelativeDirectoryLabel(this.memodir, filename);
        return {
            label: pathLabel,
            title: pathLabel,
            pathLabel,
            createdAt: dateFns.format(stat.birthtime, 'yyyy-MM-dd HH:mm'),
            updatedAt: dateFns.format(stat.mtime, 'yyyy-MM-dd HH:mm'),
            filename,
            mtimeMs: stat.mtime.getTime(),
            fileSizeLabel: this.formatFileSize(stat.size)
        };
    }

    private createRecentFileEntryFromMeta(filename: string, meta: FileMeta): MemoRecentItem {
        const pathLabel = getMemoRelativeDirectoryLabel(this.memodir, filename);
        return {
            label: pathLabel,
            title: pathLabel,
            pathLabel,
            createdAt: dateFns.format(new Date(meta.birthtime), 'yyyy-MM-dd HH:mm'),
            updatedAt: dateFns.format(new Date(meta.mtime), 'yyyy-MM-dd HH:mm'),
            filename,
            mtimeMs: meta.mtime,
            fileSizeLabel: this.formatFileSize(meta.size)
        };
    }

    private getHtml(context: vscode.ExtensionContext, stats: MemoStats): string {
        const nonce = `${Date.now()}`;
        const safeMemoDir = this.memodir || '';
        const safeDatePathFormat = this.memoDatePathFormat || 'yyyy/MM';
        const effectiveTemplatePath = this.memotemplate || this.ensureBuiltInTemplateFile();
        let currentDateDirLabel = '-';

        try {
            if (safeMemoDir) {
                const currentDateDir = getMemoDateDirectory(safeMemoDir, safeDatePathFormat);
                currentDateDirLabel = getMemoRelativeDirectoryLabel(safeMemoDir, currentDateDir);
            }
        } catch {
            currentDateDirLabel = '-';
        }

        const extensionVersion = context.extension.packageJSON.version;
        const repositoryUrl = 'https://github.com/mmiyaji/vscode-memo-life-for-you';
        const upstreamUrl = 'https://github.com/satokaz/vscode-memo-life-for-you';
        const locale = this.getDisplayLanguage();
        const indexStatus = memoAdmin.memoIndex?.getStatus();
        const hasValidMemoDir = !!safeMemoDir && safeMemoDir !== '.' && fs.existsSync(safeMemoDir);
        const effectiveAppearance = this.getEffectiveAppearance();
        const appearanceLabel = this.getAppearanceLabel(this.memoAdminAppearance, locale);
        const colorThemeLabel = this.getColorThemeLabel(this.memoAdminColorTheme, locale);
        const t = (key: string, fallback: string) => this.translate(locale, key, fallback);
        const gradientClass = this.memoAdminUseGradient ? 'with-gradient' : 'without-gradient';
        const tips = this.getRandomTips(locale, 3);

        return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Memo Admin</title>
    <style>
        :root {
            color-scheme: light dark;
            --font-family: var(--vscode-font-family, "Segoe UI", "Yu Gothic UI", sans-serif);
            --font-size: var(--vscode-font-size, 13px);
            --editor-bg: var(--vscode-editor-background, #1e1e1e);
            --panel-bg: var(--vscode-sideBar-background, var(--editor-bg));
            --surface-bg: var(--vscode-editorWidget-background, #252526);
            --surface-alt: var(--vscode-sideBar-background, #2d2d30);
            --text: var(--vscode-foreground, #cccccc);
            --muted: var(--vscode-descriptionForeground, var(--vscode-input-placeholderForeground, #9da5b4));
            --border: var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
            --button-bg: #3794ff;
            --button-hover: #58a6ff;
            --button-text: var(--vscode-button-foreground, #ffffff);
            --shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
            --accent: #3794ff;
            --accent-strong: #58a6ff;
            --accent-soft: rgba(55, 148, 255, 0.12);
            --accent-soft-strong: rgba(55, 148, 255, 0.2);
            --accent-panel: rgba(55, 148, 255, 0.08);
            --accent-card: rgba(55, 148, 255, 0.06);
            --accent-border: rgba(55, 148, 255, 0.34);
            --mica-glow-a: rgba(255, 255, 255, 0.05);
            --mica-glow-b: rgba(255, 255, 255, 0.025);
        }

        body[data-appearance="light"] {
            color-scheme: light;
            --editor-bg: #f7f8fa;
            --panel-bg: #ffffff;
            --surface-bg: #ffffff;
            --surface-alt: #f3f5f8;
            --text: #1f2328;
            --muted: #5f6b7a;
            --border: rgba(31, 35, 40, 0.12);
            --shadow: 0 12px 32px rgba(15, 23, 42, 0.08);
        }

        body[data-effective-appearance="dark"] {
            color-scheme: dark;
            --editor-bg: #181a1f;
            --panel-bg: #1f232a;
            --surface-bg: rgba(32, 36, 44, 0.92);
            --surface-alt: #262b33;
            --text: #d7dce2;
            --muted: #95a1af;
            --border: rgba(255, 255, 255, 0.08);
            --shadow: 0 18px 34px rgba(0, 0, 0, 0.28);
            --mica-glow-a: rgba(255, 255, 255, 0.018);
            --mica-glow-b: rgba(255, 255, 255, 0.008);
            --mica-tint: color-mix(in srgb, var(--accent) 6%, transparent);
            --mica-tint-soft: color-mix(in srgb, var(--accent) 3%, transparent);
        }

        /* blue theme uses :root defaults */

        body[data-theme="teal"] {
            --accent: #1f8f88;
            --accent-strong: #35b7ab;
            --button-bg: #1f8f88;
            --button-hover: #35b7ab;
            --accent-soft: rgba(31, 143, 136, 0.12);
            --accent-soft-strong: rgba(31, 143, 136, 0.2);
            --accent-panel: rgba(31, 143, 136, 0.08);
            --accent-card: rgba(31, 143, 136, 0.06);
            --accent-border: rgba(31, 143, 136, 0.34);
            --mica-tint: rgba(68, 126, 121, 0.22);
            --mica-tint-soft: rgba(68, 126, 121, 0.12);
        }

        body[data-theme="amber"] {
            --accent: #c97a1a;
            --accent-strong: #f0a53a;
            --button-bg: #c97a1a;
            --button-hover: #e09a34;
            --accent-soft: rgba(201, 122, 26, 0.12);
            --accent-soft-strong: rgba(201, 122, 26, 0.2);
            --accent-panel: rgba(201, 122, 26, 0.08);
            --accent-card: rgba(201, 122, 26, 0.06);
            --accent-border: rgba(201, 122, 26, 0.34);
            --mica-tint: rgba(148, 110, 70, 0.22);
            --mica-tint-soft: rgba(148, 110, 70, 0.12);
        }

        body[data-theme="rose"] {
            --accent: #c5537c;
            --accent-strong: #e76b96;
            --button-bg: #c5537c;
            --button-hover: #de6791;
            --accent-soft: rgba(197, 83, 124, 0.12);
            --accent-soft-strong: rgba(197, 83, 124, 0.2);
            --accent-panel: rgba(197, 83, 124, 0.08);
            --accent-card: rgba(197, 83, 124, 0.06);
            --accent-border: rgba(197, 83, 124, 0.34);
            --mica-tint: rgba(140, 88, 112, 0.22);
            --mica-tint-soft: rgba(140, 88, 112, 0.12);
        }

        body[data-theme="mono"] {
            --accent: #8f98a3;
            --accent-strong: #c7cdd4;
            --button-bg: #5e6772;
            --button-hover: #737d89;
            --accent-soft: rgba(199, 205, 212, 0.08);
            --accent-soft-strong: rgba(199, 205, 212, 0.12);
            --accent-panel: rgba(199, 205, 212, 0.05);
            --accent-card: rgba(199, 205, 212, 0.04);
            --accent-border: rgba(199, 205, 212, 0.18);
            --mica-tint: rgba(170, 176, 184, 0.12);
            --mica-tint-soft: rgba(170, 176, 184, 0.06);
        }

        body[data-theme="forest"] {
            --accent: #4d8a63;
            --accent-strong: #7fb091;
            --button-bg: #4d8a63;
            --button-hover: #5d9a73;
            --accent-soft: rgba(77, 138, 99, 0.12);
            --accent-soft-strong: rgba(77, 138, 99, 0.18);
            --accent-panel: rgba(77, 138, 99, 0.08);
            --accent-card: rgba(77, 138, 99, 0.06);
            --accent-border: rgba(77, 138, 99, 0.28);
            --mica-tint: rgba(88, 118, 93, 0.2);
            --mica-tint-soft: rgba(88, 118, 93, 0.1);
        }

        html,
        body {
            min-height: 100%;
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            padding: 20px;
            min-height: 100vh;
            font-family: var(--font-family);
            font-size: var(--font-size);
            line-height: 1.5;
            color: var(--text);
            background: var(--editor-bg);
        }

        body.with-gradient {
            background-color: var(--editor-bg);
            background-image:
                radial-gradient(1200px 720px at 12% -8%, var(--mica-glow-a), transparent 58%),
                radial-gradient(900px 620px at 100% 0%, var(--mica-tint), transparent 60%),
                radial-gradient(1100px 760px at 50% 115%, var(--mica-tint-soft), transparent 62%),
                linear-gradient(180deg, color-mix(in srgb, var(--editor-bg) 88%, white 12%) 0%, color-mix(in srgb, var(--editor-bg) 94%, var(--accent) 6%) 52%, var(--editor-bg) 100%);
            background-repeat: no-repeat;
            background-size: cover;
            background-attachment: fixed;
        }

        body[data-effective-appearance="dark"].with-gradient {
            background-image:
                radial-gradient(1500px 880px at 14% -16%, var(--mica-glow-a), transparent 62%),
                radial-gradient(1100px 720px at 100% 0%, var(--mica-tint), transparent 66%),
                radial-gradient(1250px 880px at 54% 120%, var(--mica-tint-soft), transparent 68%),
                linear-gradient(180deg, color-mix(in srgb, var(--editor-bg) 98%, white 2%) 0%, color-mix(in srgb, var(--editor-bg) 99%, var(--accent) 1%) 58%, var(--editor-bg) 100%);
        }

        .wrap {
            max-width: 1120px;
            margin: 0 auto;
        }

        .header {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 16px;
            margin-bottom: 18px;
        }

        .title {
            margin: 0;
            font-size: 26px;
            font-weight: 600;
            letter-spacing: 0.02em;
        }

        .subtitle {
            margin-top: 6px;
            color: var(--muted);
        }

        .version {
            color: var(--muted);
            font-size: 12px;
            white-space: nowrap;
            padding-top: 4px;
        }

        .header-actions {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            padding-top: 4px;
        }

        .icon-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            padding: 0;
            border-radius: 999px;
            border: 1px solid var(--border);
            background: transparent;
            color: var(--muted);
            font-size: 14px;
            line-height: 1;
        }

        .icon-button:hover {
            color: var(--accent-strong);
            border-color: var(--accent-border);
            background: var(--accent-soft);
            transform: none;
        }

        .hero,
        .card {
            background: var(--surface-bg);
            border: 1px solid var(--border);
            border-radius: 14px;
            box-shadow: var(--shadow);
            backdrop-filter: blur(8px);
        }

        .hero {
            padding: 18px;
            margin-bottom: 18px;
            background: var(--surface-bg);
        }

        .toolbar {
            display: flex;
            flex-wrap: wrap;
            justify-content: space-between;
            gap: 16px;
            margin-bottom: 16px;
        }

        .toolbar-group {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            align-items: center;
        }

        .summary {
            display: grid;
            grid-template-columns: 1.3fr 0.8fr 0.8fr;
            gap: 12px;
            margin-bottom: 16px;
        }

        .metric {
            background: var(--surface-alt);
            border: 1px solid var(--accent-border);
            border-radius: 12px;
            padding: 14px;
        }

        .metric-label {
            font-size: 12px;
            color: var(--muted);
            margin-bottom: 6px;
        }

        .metric-value {
            font-size: 22px;
            font-weight: 600;
            letter-spacing: 0.02em;
        }

        .metric code {
            display: block;
            white-space: normal;
            overflow-wrap: anywhere;
            font-family: Consolas, "Courier New", monospace;
            font-size: 12px;
        }

        .hint {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            color: var(--muted);
            font-size: 12px;
        }

        .tips {
            display: grid;
            gap: 8px;
            margin-top: 14px;
            padding: 12px 14px;
            border: 1px solid var(--border);
            border-radius: 12px;
            background: var(--surface-alt);
        }

        .tips-header {
            font-size: 12px;
            font-weight: 600;
            color: var(--accent-strong);
        }

        .tips-list {
            display: grid;
            gap: 6px;
            color: var(--muted);
            font-size: 12px;
        }

        .tips-item {
            overflow-wrap: anywhere;
        }

        .warning {
            margin-top: 14px;
            padding: 10px 12px;
            border-radius: 10px;
            border: 1px solid rgba(201, 122, 26, 0.38);
            background: rgba(201, 122, 26, 0.1);
            color: var(--text);
        }

        .config-block {
            margin-top: 16px;
            border: 1px solid var(--border);
            border-radius: 12px;
            background: var(--surface-alt);
        }

        .config-block summary {
            cursor: pointer;
            list-style: none;
            padding: 12px 14px;
            font-weight: 600;
            color: var(--text);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }

        .config-block summary::-webkit-details-marker {
            display: none;
        }

        .config-block[open] summary {
            border-bottom: 1px solid var(--border);
        }

        .summary-label {
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }

        .summary-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 18px;
            height: 18px;
            border-radius: 6px;
            background: var(--accent-soft);
            color: var(--accent-strong);
            font-size: 12px;
            line-height: 1;
        }

        .summary-caret {
            color: var(--muted);
            font-size: 15px;
            line-height: 1;
            transition: transform 120ms ease;
        }

        .config-block[open] .summary-caret {
            transform: rotate(180deg);
        }

        .detail-block[open] .summary-caret {
            transform: rotate(180deg);
        }

        .config-grid {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 12px;
            padding: 14px;
        }

        .field {
            display: grid;
            gap: 6px;
        }

        .field-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 8px;
            align-items: center;
        }

        .field-label {
            font-size: 12px;
            color: var(--muted);
        }

        .field-input {
            width: 100%;
            border: 1px solid var(--border);
            border-radius: 8px;
            background: var(--surface-bg);
            color: var(--text);
            font: inherit;
            padding: 8px 10px;
        }

        .field-help {
            font-size: 11px;
            color: var(--muted);
        }

        .config-actions {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            padding: 0 14px 14px;
        }

        .action-help {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            padding: 0 14px 10px;
            font-size: 11px;
            color: var(--muted);
        }

        .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 16px;
        }

        button {
            appearance: none;
            border: 1px solid transparent;
            border-radius: 8px;
            padding: 8px 12px;
            font: inherit;
            cursor: pointer;
            transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
        }

        button:hover {
            transform: translateY(-1px);
        }

        button.primary {
            background: var(--button-bg) !important;
            color: var(--button-text);
            border-color: var(--accent-border);
            box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
        }

        button.primary:hover {
            background: var(--button-hover) !important;
        }

        button.secondary {
            background: transparent;
            color: var(--text);
            border-color: var(--accent-border);
        }

        button.secondary:hover {
            border-color: var(--accent);
            background: var(--accent-soft);
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 16px;
        }

        .grid-single {
            display: grid;
            grid-template-columns: minmax(0, 1fr);
            gap: 16px;
        }

        .stack {
            display: grid;
            gap: 16px;
        }

        .index-panel {
            padding: 12px 16px;
        }

        .index-status-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
        }

        .index-status-table td {
            padding: 5px 8px;
            border-bottom: 1px solid var(--border);
        }

        .index-label {
            color: var(--muted);
            white-space: nowrap;
            width: 140px;
        }

        .index-value {
            color: var(--text);
        }

        .index-badge {
            display: inline-block;
            padding: 1px 8px;
            border-radius: 10px;
            font-size: 12px;
            font-weight: 600;
        }

        .index-badge--ok {
            background: rgba(40, 167, 69, 0.18);
            color: #3fb950;
        }

        .index-badge--off {
            background: rgba(200, 200, 200, 0.12);
            color: var(--muted);
        }

        .index-actions {
            display: flex;
            gap: 8px;
            margin-top: 14px;
            flex-wrap: wrap;
        }

        .action-button {
            appearance: none;
            border: 1px solid var(--border);
            background: var(--surface-bg);
            color: var(--text);
            padding: 4px 14px;
            border-radius: 6px;
            font-size: 13px;
            cursor: pointer;
            transition: background 0.15s, border-color 0.15s;
        }

        .action-button:hover {
            background: var(--accent-soft);
            border-color: var(--accent);
        }

        .action-button--danger {
            border-color: rgba(248, 81, 73, 0.4);
            color: #f85149;
        }

        .action-button--danger:hover {
            background: rgba(248, 81, 73, 0.12);
            border-color: rgba(248, 81, 73, 0.6);
        }

        .tag-cloud {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            padding: 4px 0;
        }
        .tag-chip {
            appearance: none;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 3px 10px;
            border: 1px solid var(--border);
            border-radius: 12px;
            background: var(--surface-bg);
            color: var(--accent);
            font-size: 12px;
            cursor: pointer;
            transition: background 0.15s, border-color 0.15s;
        }
        .tag-chip:hover {
            background: var(--accent-soft);
            border-color: var(--accent-border);
        }
        .tag-count {
            font-size: 11px;
            color: var(--text-sub);
        }

        .snippet-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        .snippet-table th {
            text-align: left;
            padding: 6px 8px;
            border-bottom: 1px solid var(--border);
            color: var(--muted);
            font-weight: 500;
        }
        .snippet-table td {
            padding: 5px 8px;
            border-bottom: 1px solid rgba(128,128,128,0.1);
        }
        .snippet-table code {
            background: var(--accent-soft);
            padding: 1px 5px;
            border-radius: 3px;
            font-size: 11px;
        }
        .snippet-status {
            font-size: 12px;
            color: var(--muted);
            margin-bottom: 8px;
        }
        .snippet-status .ok { color: #3fb950; }
        .snippet-status .warn { color: #d29922; }
        .snippet-status .err { color: #f85149; }

        /* Welcome / Setup guide */
        .welcome-card {
            text-align: center;
            padding: 32px 24px;
        }
        .welcome-icon {
            font-size: 48px;
            margin-bottom: 12px;
        }
        .welcome-title {
            font-size: 20px;
            font-weight: 700;
            color: var(--accent-strong);
            margin: 0 0 8px;
        }
        .welcome-desc {
            color: var(--muted);
            font-size: 14px;
            margin: 0 0 24px;
            max-width: 480px;
            margin-left: auto;
            margin-right: auto;
        }
        .welcome-steps {
            display: flex;
            flex-direction: column;
            gap: 16px;
            max-width: 420px;
            margin: 0 auto 24px;
            text-align: left;
        }
        .welcome-step {
            display: flex;
            gap: 12px;
            align-items: flex-start;
        }
        .step-number {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            background: var(--accent-strong);
            color: var(--surface-bg);
            font-weight: 700;
            font-size: 14px;
            flex-shrink: 0;
        }
        .step-content {
            flex: 1;
        }
        .step-title {
            font-weight: 600;
            font-size: 14px;
            margin-bottom: 2px;
        }
        .step-desc {
            font-size: 12px;
            color: var(--muted);
        }
        .welcome-actions {
            display: flex;
            gap: 8px;
            justify-content: center;
        }

        .footer {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px 14px;
            margin-top: 18px;
            padding: 6px 2px 0;
            color: var(--muted);
            font-size: 12px;
        }

        .footer-links {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
        }

        .footer-note {
            color: var(--muted);
        }

        .link-button {
            appearance: none;
            border: none;
            background: transparent;
            color: var(--muted);
            padding: 0;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
            text-decoration: underline;
            text-underline-offset: 2px;
        }

        .link-button:hover {
            color: var(--accent-strong);
            background: transparent;
            transform: none;
        }

        .link-icon {
            width: 14px;
            height: 14px;
            flex: 0 0 auto;
            fill: currentColor;
        }

        .card {
            padding: 16px;
            background: var(--surface-bg);
            border-color: var(--accent-border);
        }

        .card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 12px;
        }

        .card-title {
            margin: 0;
            font-size: 15px;
            font-weight: 600;
            color: var(--accent-strong);
        }

        .card-caption {
            font-size: 12px;
            color: var(--muted);
        }

        .card-toggle {
            cursor: pointer;
            list-style: none;
            position: relative;
            padding-right: 24px;
        }
        .card-toggle::-webkit-details-marker { display: none; }
        .card-toggle::after {
            content: '▶';
            position: absolute;
            right: 0;
            top: 50%;
            transform: translateY(-50%);
            font-size: 10px;
            color: var(--muted);
            transition: transform 0.2s;
        }
        details.card[open] > .card-toggle::after {
            transform: translateY(-50%) rotate(90deg);
        }

        /* Calendar */
        .calendar-nav {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            margin-bottom: 12px;
        }

        .calendar-nav-btn {
            appearance: none;
            border: 1px solid var(--border);
            background: var(--surface-bg);
            color: var(--text);
            width: 28px;
            height: 28px;
            border-radius: 6px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            transition: background 0.15s;
        }

        .calendar-nav-btn:hover {
            background: var(--accent-soft);
            border-color: var(--accent);
        }

        .calendar-month-label {
            font-size: 15px;
            font-weight: 600;
            color: var(--text);
            min-width: 140px;
            text-align: center;
        }

        .calendar-small-btn {
            appearance: none;
            border: 1px solid var(--border);
            background: var(--surface-bg);
            color: var(--muted);
            padding: 2px 10px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            transition: background 0.15s;
        }

        .calendar-small-btn:hover {
            background: var(--accent-soft);
            border-color: var(--accent);
            color: var(--text);
        }

        .calendar-small-btn--active {
            background: var(--accent-soft);
            border-color: var(--accent);
            color: var(--accent-strong);
            font-weight: 600;
        }

        .calendar-grid {
            display: grid;
            grid-template-columns: repeat(7, 1fr);
            gap: 2px;
            max-width: 420px;
            margin: 0 auto;
        }

        .calendar-dow {
            text-align: center;
            font-size: 11px;
            color: var(--muted);
            padding: 4px 0;
            font-weight: 600;
        }

        .calendar-dow--sun { color: #e06060; }
        .calendar-dow--sat { color: #6090d0; }

        .calendar-cell {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 6px;
            font-size: 13px;
            color: var(--text);
            cursor: pointer;
            transition: background 0.12s, transform 0.12s, box-shadow 0.12s;
            border: 1px solid transparent;
            padding: 6px 0;
        }

        .calendar-cell:hover {
            border-color: var(--accent);
            transform: scale(1.08);
            z-index: 1;
        }

        .calendar-cell--empty {
            cursor: default;
        }

        .calendar-cell--empty:hover {
            background: transparent;
            border-color: transparent;
            transform: none;
        }

        .calendar-cell--today {
            border-color: var(--accent);
            font-weight: 700;
            box-shadow: inset 0 0 0 1px var(--accent);
        }

        .calendar-cell--sun { color: #e06060; }
        .calendar-cell--sat { color: #6090d0; }

        /* Heatmap levels */
        .calendar-cell--heat-1 { background: var(--accent-soft); font-weight: 600; }
        .calendar-cell--heat-2 { background: var(--accent-soft-strong); font-weight: 600; }
        .calendar-cell--heat-3 { background: var(--accent-border); font-weight: 600; }
        .calendar-cell--heat-4 { background: var(--accent); font-weight: 700; color: var(--button-text); }

        .calendar-cell--other-month {
            color: var(--muted);
            opacity: 0.4;
        }

        /* Tooltip */
        .calendar-tooltip {
            display: none;
            position: absolute;
            bottom: calc(100% + 6px);
            left: 50%;
            transform: translateX(-50%);
            background: var(--surface-bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 6px 10px;
            font-size: 11px;
            color: var(--text);
            white-space: nowrap;
            z-index: 10;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            pointer-events: none;
            max-width: 260px;
        }

        .calendar-tooltip-files {
            white-space: normal;
            word-break: break-all;
            color: var(--muted);
            margin-top: 2px;
            line-height: 1.4;
        }

        .calendar-cell:hover .calendar-tooltip {
            display: block;
        }

        .calendar-cell--other-month:hover .calendar-tooltip {
            display: none;
        }

        ul {
            list-style: none;
            margin: 0;
            padding: 0;
        }

        li {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 10px;
            align-items: center;
            padding: 10px 0;
            border-bottom: 1px solid var(--border);
        }

        li:last-child {
            border-bottom: none;
            padding-bottom: 0;
        }

        .list-label {
            min-width: 0;
        }

        .list-value {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 32px;
            padding: 2px 8px;
            border-radius: 999px;
            background: var(--accent-soft);
            color: var(--accent-strong);
            font-weight: 600;
        }

        .recent-list {
            display: grid;
            gap: 8px;
        }

        .recent-item {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 10px;
            align-items: start;
            padding: 10px 12px;
            border: 1px solid var(--border);
            border-radius: 10px;
            background: var(--surface-alt);
            color: var(--text);
        }

        .recent-item:hover {
            border-color: var(--accent);
        }

        .recent-open {
            width: 100%;
            text-align: left;
            display: grid;
            gap: 4px;
            border: none;
            background: transparent;
            color: inherit;
            padding: 0;
            cursor: pointer;
        }

        .recent-open:hover .recent-title,
        .recent-open:focus-visible .recent-title {
            color: var(--accent-strong);
        }

        .recent-title {
            font-weight: 600;
            overflow-wrap: anywhere;
        }

        .recent-path {
            font-size: 12px;
            color: var(--muted);
            overflow-wrap: anywhere;
        }

        .recent-meta {
            font-size: 12px;
            color: var(--muted);
        }

        .pin-button {
            align-self: center;
            min-width: 72px;
            padding: 6px 10px;
            border-radius: 999px;
            border: 1px solid var(--accent-border);
            background: var(--accent-soft);
            color: var(--accent-strong);
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
        }

        .pin-button:hover {
            background: var(--accent-soft-strong);
        }

        .empty {
            color: var(--muted);
            padding: 8px 0 2px;
        }

        .detail-block {
            border: 1px solid var(--border);
            border-radius: 12px;
            background: var(--surface-bg);
        }

        .detail-block summary {
            cursor: pointer;
            list-style: none;
            padding: 12px 14px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            color: var(--text);
            font-weight: 600;
        }

        .detail-block summary::-webkit-details-marker {
            display: none;
        }

        .detail-block[open] summary {
            border-bottom: 1px solid var(--border);
        }

        .detail-grid {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 14px;
            padding: 14px;
        }

        .mini-panel {
            display: grid;
            gap: 10px;
        }

        .mini-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }

        .mini-title {
            font-size: 13px;
            font-weight: 600;
            color: var(--accent-strong);
        }

        .mini-caption {
            font-size: 11px;
            color: var(--muted);
        }

        .bar-list {
            display: grid;
            gap: 8px;
        }

        .bar-row {
            display: grid;
            grid-template-columns: minmax(86px, 120px) minmax(0, 1fr) auto;
            align-items: center;
            gap: 10px;
        }

        .bar-row.is-clickable {
            cursor: pointer;
        }

        .bar-row.is-clickable:hover .bar-label,
        .bar-row.is-clickable:hover .bar-value {
            color: var(--accent-strong);
        }

        .bar-row.is-clickable:hover .bar-track {
            background: color-mix(in srgb, var(--surface-alt) 70%, var(--accent) 30%);
        }

        .bar-label {
            font-size: 12px;
            color: var(--muted);
        }

        .bar-track {
            position: relative;
            height: 8px;
            border-radius: 999px;
            background: var(--surface-alt);
            overflow: hidden;
        }

        .bar-fill {
            position: absolute;
            inset: 0 auto 0 0;
            border-radius: 999px;
            background: linear-gradient(90deg, var(--accent), var(--accent-strong));
        }

        .bar-value {
            min-width: 28px;
            text-align: right;
            font-size: 12px;
            color: var(--text);
            font-weight: 600;
        }

        @media (max-width: 900px) {
            .summary,
            .grid,
            .config-grid,
            .detail-grid {
                grid-template-columns: 1fr;
            }
        }

        @media (max-width: 640px) {
            body {
                padding: 14px;
            }

            .header {
                flex-direction: column;
            }

            .toolbar {
                flex-direction: column;
                align-items: stretch;
            }

            .toolbar-group {
                width: 100%;
            }
        }
    </style>
</head>
<body class="${gradientClass}" data-appearance="${escapeHtml(this.memoAdminAppearance || 'system')}" data-effective-appearance="${escapeHtml(effectiveAppearance)}" data-theme="${escapeHtml(this.memoAdminColorTheme || 'blue')}">
    <div class="wrap">
        <header class="header">
            <div>
                <h1 class="title">${t('extension.memoAdmin.title', 'Memo Admin')}</h1>
                <div class="subtitle">${t('memoAdmin.summary', 'Current memo storage and operation summary')}</div>
            </div>
            <div class="header-actions">
                ${indexStatus ? `<span class="index-badge index-badge--ok" title="${t('memoAdmin.indexActive', 'Active')}: ${indexStatus.entries} ${t('memoAdmin.indexEntries', 'Indexed files')}">&#9679; Index</span>` : `<span class="index-badge index-badge--off" title="${t('memoAdmin.indexInactive', 'Inactive')}">&#9675; Index</span>`}
                <button class="icon-button" type="button" data-command="refreshAdmin" title="${t('memoAdmin.refresh', 'Refresh')}">&#x21bb;</button>
            </div>
        </header>

        <section class="hero">
            ${hasValidMemoDir ? '' : `<div class="warning">${t('memoAdmin.invalidMemoDirWarning', 'The current memo root does not exist. Update the core settings below to recover.')}</div>`}

            <details class="config-block"${hasValidMemoDir ? '' : ' open'}>
                <summary>
                    <span class="summary-label">
                        <span class="summary-icon">&#9881;</span>
                        <span>${t('memoAdmin.coreSettings', 'Core settings')}</span>
                    </span>
                    <span class="summary-caret">&#9660;</span>
                </summary>
                <div class="config-grid">
                    <label class="field">
                        <span class="field-label">${t('memoAdmin.memoRoot', 'Memo root')}</span>
                        <div class="field-row">
                            <input class="field-input" id="memodir" type="text" value="${escapeHtml(this.memodir || '')}">
                            <button class="secondary" type="button" data-command="pickMemoDir">${t('memoAdmin.browse', 'Browse')}</button>
                        </div>
                        <span class="field-help">${t('memoAdmin.memodirHelp', 'Root folder for memo files')}</span>
                    </label>
                    <label class="field">
                        <span class="field-label">${t('memoAdmin.template', 'Template file')}</span>
                        <div class="field-row">
                            <input class="field-input" id="memotemplate" type="text" value="${escapeHtml(effectiveTemplatePath)}">
                            <button class="secondary" type="button" data-command="pickTemplateFile">${t('memoAdmin.browse', 'Browse')}</button>
                        </div>
                        <span class="field-help">${t('memoAdmin.templateHelp', 'The built-in template file is prefilled by default')}</span>
                    </label>
                    <label class="field">
                        <span class="field-label">${t('memoAdmin.datePathFormat', 'Date folder format')}</span>
                        <input class="field-input" id="memoDatePathFormat" type="text" value="${escapeHtml(this.memoDatePathFormat || 'yyyy/MM')}">
                        <span class="field-help">${t('memoAdmin.datePathHelp', 'Example: yyyy/MM or yyyy/MM/dd')}</span>
                    </label>
                </div>
                <div class="action-help">${t('memoAdmin.workspaceHelp', 'Startup file: create a .code-workspace that opens this memo folder and starts with Memo: Admin. You can associate it with VS Code.')} ${t('memoAdmin.shortcutHelp', 'Keyboard shortcut changes are managed from Keyboard Shortcuts or keybindings.json.')}</div>
                <div class="config-actions">
                    <button class="secondary" data-command="createWorkspace" title="${t('memoAdmin.createWorkspaceTooltip', 'Generate a startup .code-workspace file. If you associate it with VS Code, double-clicking it can open directly into Memo: Admin mode.')}">${t('memoAdmin.createWorkspace', 'Create workspace')}</button>
                    <button class="secondary" data-command="openConfig">${t('memoAdmin.openConfig', 'Open config file')}</button>
                    <button class="secondary" data-command="openKeyboardShortcuts">${t('memoAdmin.openKeyboardShortcuts', 'Keyboard shortcuts')}</button>
                    <button class="secondary" data-command="openSettings">${t('memoAdmin.openAdvancedSettings', 'Advanced settings')}</button>
                    <button class="primary" data-command="saveCoreSettings">${t('memoAdmin.save', 'Save')}</button>
                </div>
            </details>

            <div class="toolbar">
                <div class="toolbar-group actions">
                    <button class="primary" data-command="newMemo">${t('memoAdmin.newMemo', 'New memo')}</button>
                    <button class="primary" data-command="searchMemo">${t('memoAdmin.searchMemo', 'Search memo')}</button>
                    <button class="secondary" data-command="openFolder">${t('memoAdmin.openFolder', 'Open folder')}</button>
                </div>
            </div>

            <div class="summary">
                <div class="metric">
                    <div class="metric-label">${t('memoAdmin.memoRoot', 'Memo root')}</div>
                    <code>${escapeHtml(safeMemoDir)}</code>
                </div>
                <div class="metric">
                    <div class="metric-label">${t('memoAdmin.currentDateDir', 'Today folder')}</div>
                    <div class="metric-value">${escapeHtml(currentDateDirLabel)}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">${t('memoAdmin.totalFiles', 'Total files')}</div>
                    <div class="metric-value">${stats.totalFiles}</div>
                </div>
            </div>

            <div class="hint">
                <span>${t('memoAdmin.datePathFormat', 'Date folder format')}: <code>${escapeHtml(this.memoDatePathFormat || '(flat)')}</code></span>
                <span>${t('memoAdmin.appearance', 'Appearance')}: <code>${escapeHtml(appearanceLabel)}</code></span>
                <span>${t('memoAdmin.colorTheme', 'Color theme')}: <code>${escapeHtml(colorThemeLabel)}</code></span>
                <span>${t('memoAdmin.language', 'Language')}: <code>${escapeHtml(this.getLanguageLabel(locale))}</code></span>
                <span>${t('memoAdmin.themeHint', 'Visual settings are managed from VS Code Settings.')}</span>
            </div>
            <div class="tips">
                <div class="tips-header">${t('memoAdmin.tips', 'Tips')}</div>
                <div class="tips-list">
                    ${tips.map((tip) => `<div class="tips-item">${escapeHtml(tip)}</div>`).join('')}
                </div>
            </div>
        </section>

        ${!hasValidMemoDir ? `
        <section class="stack">
            <article class="card welcome-card">
                <div class="welcome-icon">&#128221;</div>
                <h2 class="welcome-title">${t('memoAdmin.welcomeTitle', 'Welcome to Memo Life For You!')}</h2>
                <p class="welcome-desc">${t('memoAdmin.welcomeDesc', 'Set up a memo directory to start organizing your notes. You can configure it in the settings above.')}</p>
                <div class="welcome-steps">
                    <div class="welcome-step">
                        <span class="step-number">1</span>
                        <div class="step-content">
                            <div class="step-title">${t('memoAdmin.step1Title', 'Set memo directory')}</div>
                            <div class="step-desc">${t('memoAdmin.step1Desc', 'Open the settings panel above and specify the path where your memos will be stored.')}</div>
                        </div>
                    </div>
                    <div class="welcome-step">
                        <span class="step-number">2</span>
                        <div class="step-content">
                            <div class="step-title">${t('memoAdmin.step2Title', 'Create your first memo')}</div>
                            <div class="step-desc">${t('memoAdmin.step2Desc', 'Use the "New memo" button or run "Memo: New" from the command palette.')}</div>
                        </div>
                    </div>
                    <div class="welcome-step">
                        <span class="step-number">3</span>
                        <div class="step-content">
                            <div class="step-title">${t('memoAdmin.step3Title', 'Customize templates & snippets')}</div>
                            <div class="step-desc">${t('memoAdmin.step3Desc', 'Place .md files in .templates/ and snippet JSON in .snippets/ inside your memo directory.')}</div>
                        </div>
                    </div>
                </div>
                <div class="welcome-actions">
                    <button class="primary" data-command="openSettings">${t('memoAdmin.openAdvancedSettings', 'Advanced settings')}</button>
                    <button class="secondary" data-command="createWorkspace">${t('memoAdmin.createWorkspace', 'Create workspace')}</button>
                </div>
            </article>
        </section>
        ` : `
        <section class="stack">
            <details class="card" open>
                <summary class="card-header card-toggle">
                    <h2 class="card-title">${t('memoAdmin.recentHistory', 'Recent history')}</h2>
                    <div class="card-caption">${t('memoAdmin.latest8Updated', 'Latest 8 updates')}</div>
                </summary>
                ${renderRecentFiles(stats.recentFiles, {
                    noDataLabel: t('memoAdmin.noData', 'No data'),
                    pinnedFilenames: stats.pinnedFiles.map((item) => item.filename),
                    showPinToggle: true,
                    pinLabel: t('memoAdmin.pin', 'Pin'),
                    unpinLabel: t('memoAdmin.unpin', 'Unpin'),
                    createdLabel: t('memoAdmin.created', 'Created'),
                    updatedLabel: t('memoAdmin.updated', 'Updated'),
                    sizeLabel: t('memoAdmin.size', 'Size')
                })}
            </details>
            <details class="card" open>
                <summary class="card-header card-toggle">
                    <h2 class="card-title">${t('memoAdmin.calendar', 'Calendar')}</h2>
                    <div class="card-caption">${t('memoAdmin.calendarCaption', 'Memo activity by date')}</div>
                </summary>
                <div id="calendar-container">
                    <div class="calendar-nav">
                        <button class="calendar-nav-btn" id="cal-prev" type="button" title="${t('memoAdmin.calPrev', 'Previous')}">&#9664;</button>
                        <span class="calendar-month-label" id="cal-month-label"></span>
                        <button class="calendar-nav-btn" id="cal-next" type="button" title="${t('memoAdmin.calNext', 'Next')}">&#9654;</button>
                        <button class="calendar-small-btn" id="cal-today" type="button">${t('memoAdmin.calToday', 'Today')}</button>
                        <button class="calendar-small-btn" id="cal-view-month" type="button">${t('memoAdmin.calMonth', 'Month')}</button>
                        <button class="calendar-small-btn" id="cal-view-week" type="button">${t('memoAdmin.calWeek', 'Week')}</button>
                    </div>
                    <div class="calendar-grid" id="cal-grid"></div>
                </div>
            </details>
            ${stats.tagCounts.length > 0 ? `
            <details class="card" open>
                <summary class="card-header card-toggle">
                    <h2 class="card-title">${t('memoAdmin.tags', 'Tags')}</h2>
                    <div class="card-caption">${t('memoAdmin.tagsCaption', 'Frontmatter tags across all memos')} (${stats.tagCounts.length})</div>
                </summary>
                <div class="tag-cloud">
                    ${stats.tagCounts.map(({ tag, count }) =>
                        `<button class="tag-chip" data-search-tag="${escapeHtml(tag)}" title="${count} ${count === 1 ? 'memo' : 'memos'}">#${escapeHtml(tag)} <span class="tag-count">${count}</span></button>`
                    ).join('')}
                </div>
            </details>
            ` : ''}
            ${(() => {
                const ss = memoAdmin.snippetProvider?.getStatus();
                if (!ss) { return ''; }
                return `
            <details class="card" open>
                <summary class="card-header card-toggle">
                    <h2 class="card-title">${t('memoAdmin.snippets', 'Snippets')}</h2>
                    <div class="card-caption">${t('memoAdmin.snippetsCaption', 'Custom completions for Markdown')}</div>
                </summary>
                <div class="snippet-status">
                    ${t('memoAdmin.snippetsDir', 'Directory')}: <code>${escapeHtml(ss.dir || '(not set)')}</code>
                    ${ss.exists ? `<span class="ok">&#10003;</span>` : `<span class="err">&#10007; ${t('memoAdmin.snippetsDirMissing', 'not found')}</span>`}
                    &nbsp;|&nbsp; ${t('memoAdmin.snippetsFiles', 'Files')}: ${ss.fileCount} &nbsp;|&nbsp; ${t('memoAdmin.snippetsLoaded', 'Loaded')}: ${ss.snippetCount}
                </div>
                ${ss.snippetCount > 0 ? `
                <table class="snippet-table">
                    <thead><tr>
                        <th>Prefix</th>
                        <th>${t('memoAdmin.snippetName', 'Name')}</th>
                        <th>${t('memoAdmin.snippetDesc', 'Description')}</th>
                    </tr></thead>
                    <tbody>
                        ${ss.snippets.map(s => `<tr><td><code>${escapeHtml(s.prefix)}</code></td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.description || '')}</td></tr>`).join('')}
                    </tbody>
                </table>
                ` : `<div class="empty-state">${t('memoAdmin.snippetsEmpty', 'No snippets loaded. Place VS Code snippet JSON files in the snippets directory.')}</div>`}
            </details>`;
            })()}
            ${(() => {
                const templatesDir = this.memoTemplatesDir
                    ? upath.normalize(this.memoTemplatesDir)
                    : upath.normalize(upath.join(this.memodir, '.templates'));
                const tplExists = fs.existsSync(templatesDir);
                let tplFiles: Array<{ name: string; size: number }> = [];
                if (tplExists) {
                    try {
                        tplFiles = fs.readdirSync(templatesDir)
                            .filter(f => f.endsWith('.md'))
                            .sort()
                            .map(f => {
                                try {
                                    const s = fs.statSync(upath.join(templatesDir, f));
                                    return { name: f, size: s.size };
                                } catch { return { name: f, size: 0 }; }
                            });
                    } catch { /* ignore */ }
                }
                const defaultTpl = this.memotemplate;
                return `
            <details class="card" open>
                <summary class="card-header card-toggle">
                    <h2 class="card-title">${t('memoAdmin.templates', 'Templates')}</h2>
                    <div class="card-caption">${t('memoAdmin.templatesCaption', 'Memo templates for new file creation')} (${tplFiles.length})</div>
                </summary>
                <div class="snippet-status">
                    ${t('memoAdmin.templatesDir', 'Directory')}: <code>${escapeHtml(templatesDir)}</code>
                    ${tplExists ? `<span class="ok">&#10003;</span>` : `<span class="err">&#10007; ${t('memoAdmin.templatesDirMissing', 'not found')}</span>`}
                    ${defaultTpl ? `&nbsp;|&nbsp; ${t('memoAdmin.defaultTemplate', 'Default')}: <code>${escapeHtml(upath.basename(defaultTpl))}</code>` : ''}
                </div>
                ${tplFiles.length > 0 ? `
                <table class="snippet-table">
                    <thead><tr>
                        <th>${t('memoAdmin.templateFile', 'File')}</th>
                        <th>${t('memoAdmin.templateSize', 'Size')}</th>
                    </tr></thead>
                    <tbody>
                        ${tplFiles.map(f => `<tr><td><code>${escapeHtml(f.name)}</code></td><td>${f.size > 1024 ? (f.size / 1024).toFixed(1) + ' KB' : f.size + ' B'}</td></tr>`).join('')}
                    </tbody>
                </table>
                ` : `<div class="empty-state">${t('memoAdmin.templatesEmpty', 'No templates found. Place .md files in the templates directory.')}</div>`}
            </details>`;
            })()}
            <details class="card" open>
                <summary class="card-header card-toggle">
                    <h2 class="card-title">${t('memoAdmin.pinnedMemos', 'Pinned memos')}</h2>
                    <div class="card-caption">${t('memoAdmin.pinnedCaption', 'Fixed access')} (${stats.pinnedFiles.length})</div>
                </summary>
                ${stats.pinnedFiles.length > 0 ? renderRecentFiles(stats.pinnedFiles, {
                    noDataLabel: t('memoAdmin.noData', 'No data'),
                    pinnedFilenames: stats.pinnedFiles.map((item) => item.filename),
                    showPinToggle: true,
                    pinLabel: t('memoAdmin.unpin', 'Unpin'),
                    createdLabel: t('memoAdmin.created', 'Created'),
                    updatedLabel: t('memoAdmin.updated', 'Updated'),
                    sizeLabel: t('memoAdmin.size', 'Size')
                }) : `<div class="empty-state">${t('memoAdmin.pinnedEmpty', 'No pinned memos. Use the pin button in Recent history to add.')}</div>`}
            </details>
            <details class="detail-block">
                <summary>
                    <span class="summary-label">
                        <span class="summary-icon">&#9638;</span>
                        <span>${t('memoAdmin.moreStats', 'More stats')}</span>
                    </span>
                    <span class="summary-caret">&#9660;</span>
                </summary>
                <div class="detail-grid">
                    <section class="mini-panel">
                        <div class="mini-header">
                            <div class="mini-title">${t('memoAdmin.monthlyCounts', 'Monthly counts')}</div>
                            <div class="mini-caption">${t('memoAdmin.latest12', 'Latest 12 months')}</div>
                        </div>
                        ${renderBarList(stats.monthCounts, t('memoAdmin.noData', 'No data'), { pathResolver: (label) => upath.join(this.memodir, label) })}
                    </section>
                    <section class="mini-panel">
                        <div class="mini-header">
                            <div class="mini-title">${t('memoAdmin.yearlyCounts', 'Yearly counts')}</div>
                            <div class="mini-caption">${t('memoAdmin.byCreatedAt', 'By created date')}</div>
                        </div>
                        ${renderBarList(stats.yearCounts, t('memoAdmin.noData', 'No data'), { pathResolver: (label) => upath.join(this.memodir, label) })}
                    </section>
                    <section class="mini-panel">
                        <div class="mini-header">
                            <div class="mini-title">${t('memoAdmin.folderCounts', 'Folder counts')}</div>
                            <div class="mini-caption">${t('memoAdmin.topFolders', 'Folder name desc')}</div>
                        </div>
                        ${renderBarList(stats.folderCounts.slice(0, 8), t('memoAdmin.noData', 'No data'), { pathResolver: (label) => label === '.' ? this.memodir : upath.join(this.memodir, label) })}
                    </section>
                </div>
            </details>
            <details class="detail-block">
                <summary>
                    <span class="summary-label">
                        <span class="summary-icon">&#9881;</span>
                        <span>${t('memoAdmin.indexMaintenance', 'Index maintenance')}</span>
                    </span>
                    <span class="summary-caret">&#9660;</span>
                </summary>
                <div class="index-panel">
                    <table class="index-status-table">
                        <tbody>
                            <tr><td class="index-label">${t('memoAdmin.indexStatus', 'Status')}</td><td class="index-value">${indexStatus ? `<span class="index-badge index-badge--ok">${t('memoAdmin.indexActive', 'Active')}</span>` : `<span class="index-badge index-badge--off">${t('memoAdmin.indexInactive', 'Inactive')}</span>`}</td></tr>
                            ${indexStatus ? `
                            <tr><td class="index-label">${t('memoAdmin.indexEntries', 'Indexed files')}</td><td class="index-value">${indexStatus.entries.toLocaleString()}</td></tr>
                            <tr><td class="index-label">${t('memoAdmin.indexFileSize', 'Index size')}</td><td class="index-value">${indexStatus.indexSizeBytes > 0 ? this.formatFileSize(indexStatus.indexSizeBytes) : '-'}</td></tr>
                            <tr><td class="index-label">${t('memoAdmin.indexWatcher', 'File watcher')}</td><td class="index-value">${indexStatus.watching ? '&#10003;' : '&#10007;'}</td></tr>
                            <tr><td class="index-label">${t('memoAdmin.indexPrimary', 'Primary file')}</td><td class="index-value">${indexStatus.primaryExists ? '&#10003;' : '&#10007;'}</td></tr>
                            <tr><td class="index-label">${t('memoAdmin.indexBackup', 'Backup file')}</td><td class="index-value">${indexStatus.backupExists ? '&#10003;' : '&#10007;'}</td></tr>
                            <tr><td class="index-label">${t('memoAdmin.indexDirty', 'Unsaved changes')}</td><td class="index-value">${indexStatus.dirty ? t('memoAdmin.indexYes', 'Yes') : t('memoAdmin.indexNo', 'No')}</td></tr>
                            ` : ''}
                        </tbody>
                    </table>
                    ${indexStatus ? `
                    <div class="index-actions">
                        <button class="action-button" data-command="indexSync" title="${t('memoAdmin.indexSyncTooltip', 'Check for changes on disk and update the index')}">${t('memoAdmin.indexSync', 'Sync')}</button>
                        <button class="action-button" data-command="indexFlush" title="${t('memoAdmin.indexFlushTooltip', 'Save index to disk now')}">${t('memoAdmin.indexFlush', 'Save to disk')}</button>
                        <button class="action-button action-button--danger" data-command="indexRebuild" title="${t('memoAdmin.indexRebuildTooltip', 'Delete and rebuild the index from scratch')}">${t('memoAdmin.indexRebuild', 'Rebuild')}</button>
                    </div>
                    ` : ''}
                </div>
            </details>
        </section>
        `}
        <footer class="footer">
            <div class="footer-links">
                ${repositoryUrl ? `<button class="link-button" type="button" data-link="${escapeHtml(repositoryUrl)}"><svg class="link-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"></path></svg><span>${t('memoAdmin.repoLink', 'GitHub/mmiyaji')}</span></button>` : ''}
            </div>
            <div class="footer-note">
                ${t('memoAdmin.forkedFrom', 'forked from')} ${upstreamUrl ? `<button class="link-button" type="button" data-link="${escapeHtml(upstreamUrl)}">satokaz/vscode-memo-life-for-you</button>` : ''}
            </div>
            <div class="version">v${escapeHtml(String(extensionVersion))}</div>
        </footer>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        // Calendar
        (function() {
            if (!document.getElementById('cal-grid')) { return; }
            const calData = ${JSON.stringify(stats.calendarData)};
            const dowLabels = ${locale === 'ja' ? "['日','月','火','水','木','金','土']" : "['Sun','Mon','Tue','Wed','Thu','Fri','Sat']"};
            const monthNames = ${locale === 'ja'
                ? "['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月']"
                : "['January','February','March','April','May','June','July','August','September','October','November','December']"};
            const noMemoLabel = ${locale === 'ja' ? "'メモなし'" : "'No memos'"};
            const memoCountLabel = ${locale === 'ja' ? "function(n){ return n + ' 件'; }" : "function(n){ return n + (n===1?' memo':' memos'); }"};

            const grid = document.getElementById('cal-grid');
            const monthLabel = document.getElementById('cal-month-label');
            const btnMonth = document.getElementById('cal-view-month');
            const btnWeek = document.getElementById('cal-view-week');
            const today = new Date();
            let viewYear = today.getFullYear();
            let viewMonth = today.getMonth();
            let viewMode = 'month';
            let weekOffset = 0;

            function pad(n) { return n < 10 ? '0' + n : '' + n; }
            function todayStr() { return today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate()); }

            function heatClass(count) {
                if (count === 0) return '';
                if (count === 1) return ' calendar-cell--heat-1';
                if (count === 2) return ' calendar-cell--heat-2';
                if (count <= 4) return ' calendar-cell--heat-3';
                return ' calendar-cell--heat-4';
            }

            function tooltipHtml(dateStr, entry) {
                const countStr = entry ? memoCountLabel(entry.count) : noMemoLabel;
                let filesStr = '';
                if (entry && entry.files.length > 0) {
                    const shown = entry.files.slice(0, 5);
                    filesStr = '<div class="calendar-tooltip-files">' + shown.join('<br>') + (entry.files.length > 5 ? '<br>...' : '') + '</div>';
                }
                return '<div class="calendar-tooltip"><strong>' + dateStr + '</strong> ' + countStr + filesStr + '</div>';
            }

            function cellHtml(day, dateStr, dow, isOtherMonth) {
                const entry = calData[dateStr];
                const count = entry ? entry.count : 0;
                const tStr = todayStr();
                let cls = 'calendar-cell';
                if (isOtherMonth) cls += ' calendar-cell--other-month';
                if (dateStr === tStr) cls += ' calendar-cell--today';
                cls += heatClass(isOtherMonth ? 0 : count);
                if (dow === 0) cls += ' calendar-cell--sun';
                if (dow === 6) cls += ' calendar-cell--sat';
                const tip = isOtherMonth ? '' : tooltipHtml(dateStr, entry);
                return '<div class="' + cls + '" data-date="' + dateStr + '">' + day + tip + '</div>';
            }

            function updateViewButtons() {
                btnMonth.className = 'calendar-small-btn' + (viewMode === 'month' ? ' calendar-small-btn--active' : '');
                btnWeek.className = 'calendar-small-btn' + (viewMode === 'week' ? ' calendar-small-btn--active' : '');
            }

            function renderMonth() {
                const firstDay = new Date(viewYear, viewMonth, 1);
                const lastDay = new Date(viewYear, viewMonth + 1, 0);
                const startDow = firstDay.getDay();
                const daysInMonth = lastDay.getDate();

                monthLabel.textContent = ${locale === 'ja' ? 'viewYear + "年 " + monthNames[viewMonth]' : 'monthNames[viewMonth] + " " + viewYear'};

                let html = '';
                for (let d = 0; d < 7; d++) {
                    const cls = d === 0 ? ' calendar-dow--sun' : d === 6 ? ' calendar-dow--sat' : '';
                    html += '<div class="calendar-dow' + cls + '">' + dowLabels[d] + '</div>';
                }

                const prevLast = new Date(viewYear, viewMonth, 0);
                const prevDays = prevLast.getDate();
                for (let i = startDow - 1; i >= 0; i--) {
                    const day = prevDays - i;
                    const pm = viewMonth === 0 ? 12 : viewMonth;
                    const py = viewMonth === 0 ? viewYear - 1 : viewYear;
                    const dateStr = py + '-' + pad(pm) + '-' + pad(day);
                    const dow = (startDow - i - 1 + 7) % 7;
                    html += cellHtml(day, dateStr, dow, true);
                }

                for (let day = 1; day <= daysInMonth; day++) {
                    const dateStr = viewYear + '-' + pad(viewMonth + 1) + '-' + pad(day);
                    const dow = new Date(viewYear, viewMonth, day).getDay();
                    html += cellHtml(day, dateStr, dow, false);
                }

                const totalCells = startDow + daysInMonth;
                const trailing = (7 - (totalCells % 7)) % 7;
                for (let day = 1; day <= trailing; day++) {
                    const m = viewMonth + 2 > 12 ? 1 : viewMonth + 2;
                    const y = viewMonth + 2 > 12 ? viewYear + 1 : viewYear;
                    const dateStr = y + '-' + pad(m) + '-' + pad(day);
                    const dow = (totalCells + day - 1) % 7;
                    html += cellHtml(day, dateStr, dow, true);
                }

                grid.innerHTML = html;
            }

            function renderWeek() {
                const base = new Date(today);
                base.setDate(base.getDate() + weekOffset * 7);
                const startOfWeek = new Date(base);
                startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

                const endOfWeek = new Date(startOfWeek);
                endOfWeek.setDate(endOfWeek.getDate() + 6);

                const sMonth = monthNames[startOfWeek.getMonth()];
                const eMonth = monthNames[endOfWeek.getMonth()];
                if (startOfWeek.getMonth() === endOfWeek.getMonth()) {
                    monthLabel.textContent = ${locale === 'ja'
                        ? 'startOfWeek.getFullYear() + "年 " + sMonth + " " + startOfWeek.getDate() + "–" + endOfWeek.getDate() + "日"'
                        : 'sMonth + " " + startOfWeek.getDate() + "–" + endOfWeek.getDate() + ", " + startOfWeek.getFullYear()'};
                } else {
                    monthLabel.textContent = ${locale === 'ja'
                        ? 'startOfWeek.getFullYear() + "年 " + sMonth + " " + startOfWeek.getDate() + "日–" + eMonth + " " + endOfWeek.getDate() + "日"'
                        : 'sMonth + " " + startOfWeek.getDate() + " – " + eMonth + " " + endOfWeek.getDate() + ", " + endOfWeek.getFullYear()'};
                }

                let html = '';
                for (let d = 0; d < 7; d++) {
                    const cls = d === 0 ? ' calendar-dow--sun' : d === 6 ? ' calendar-dow--sat' : '';
                    html += '<div class="calendar-dow' + cls + '">' + dowLabels[d] + '</div>';
                }

                for (let d = 0; d < 7; d++) {
                    const dt = new Date(startOfWeek);
                    dt.setDate(dt.getDate() + d);
                    const day = dt.getDate();
                    const dateStr = dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(day);
                    html += cellHtml(day, dateStr, d, false);
                }

                grid.innerHTML = html;
            }

            function render() {
                updateViewButtons();
                if (viewMode === 'week') {
                    renderWeek();
                } else {
                    renderMonth();
                }

                grid.querySelectorAll('.calendar-cell:not(.calendar-cell--other-month)').forEach(function(cell) {
                    cell.addEventListener('click', function() {
                        vscode.postMessage({ command: 'calendarOpenDate', date: cell.dataset.date });
                    });
                });
            }

            document.getElementById('cal-prev').addEventListener('click', function() {
                if (viewMode === 'week') {
                    weekOffset--;
                } else {
                    viewMonth--;
                    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
                }
                render();
            });
            document.getElementById('cal-next').addEventListener('click', function() {
                if (viewMode === 'week') {
                    weekOffset++;
                } else {
                    viewMonth++;
                    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
                }
                render();
            });
            document.getElementById('cal-today').addEventListener('click', function() {
                viewYear = today.getFullYear();
                viewMonth = today.getMonth();
                weekOffset = 0;
                render();
            });
            btnMonth.addEventListener('click', function() {
                viewMode = 'month';
                render();
            });
            btnWeek.addEventListener('click', function() {
                viewMode = 'week';
                weekOffset = 0;
                render();
            });

            render();
        })();

        document.querySelectorAll('button[data-command]').forEach((button) => {
            button.addEventListener('click', () => {
                if (button.dataset.command === 'saveCoreSettings') {
                    vscode.postMessage({
                        command: 'saveCoreSettings',
                        memodir: document.getElementById('memodir').value,
                        memotemplate: document.getElementById('memotemplate').value,
                        memoDatePathFormat: document.getElementById('memoDatePathFormat').value
                    });
                    return;
                }
                vscode.postMessage({ command: button.dataset.command });
            });
        });

        document.querySelectorAll('button[data-recent-file]').forEach((button) => {
            button.addEventListener('click', () => {
                vscode.postMessage({ command: 'openRecentFile', filename: button.dataset.recentFile });
            });
        });

        document.querySelectorAll('button[data-pin-file]').forEach((button) => {
            button.addEventListener('click', () => {
                vscode.postMessage({ command: 'pinRecentFile', filename: button.dataset.pinFile });
            });
        });

        document.querySelectorAll('button[data-unpin-file]').forEach((button) => {
            button.addEventListener('click', () => {
                vscode.postMessage({ command: 'unpinRecentFile', filename: button.dataset.unpinFile });
            });
        });

        document.querySelectorAll('button[data-search-tag]').forEach((button) => {
            button.addEventListener('click', () => {
                vscode.postMessage({ command: 'searchTag', tag: button.dataset.searchTag });
            });
        });

        document.querySelectorAll('button[data-link]').forEach((button) => {
            button.addEventListener('click', () => {
                vscode.postMessage({ command: 'openLink', url: button.dataset.link });
            });
        });

        document.querySelectorAll('[data-stats-target]').forEach((element) => {
            element.addEventListener('click', () => {
                vscode.postMessage({ command: 'openStatsTarget', targetPath: element.dataset.statsTarget });
            });
        });

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.command === 'setMemoDir') {
                document.getElementById('memodir').value = message.value;
            }
            if (message.command === 'setTemplateFile') {
                document.getElementById('memotemplate').value = message.value;
            }
        });
    </script>
</body>
</html>`;
    }

    private renderPanel(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): void {
        this.updateConfiguration();
        this.safeReadConfig();
        panel.title = this.translate(this.getDisplayLanguage(), 'extension.memoAdmin.title', 'Memo Admin');

        if (!memoAdmin.memoIndex && this.memodir && fs.existsSync(this.memodir)) {
            this.initializeIndex(context).then(() => {
                this.renderPanel(panel, context);
            }).catch(() => {
                // proceed without index
            });
        }

        try {
            panel.webview.html = this.getHtml(context, this.collectStats());
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            panel.webview.html = this.getErrorHtml(message);
        }
    }

    private getErrorHtml(message: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Memo Admin</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            font-family: var(--vscode-font-family, "Segoe UI", sans-serif);
            color: var(--vscode-foreground, #cccccc);
            background: var(--vscode-editor-background, #1e1e1e);
        }
        .panel {
            max-width: 720px;
            border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
            border-radius: 12px;
            background: var(--vscode-editorWidget-background, #252526);
            padding: 16px;
        }
        h1 {
            margin: 0 0 8px;
            font-size: 20px;
        }
        p {
            margin: 0 0 12px;
            color: var(--vscode-descriptionForeground, #9da5b4);
        }
        code {
            display: block;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            font-family: Consolas, "Courier New", monospace;
        }
    </style>
</head>
<body>
    <div class="panel">
        <h1>Memo Admin</h1>
        <p>Failed to render the admin view. Check the current memo settings.</p>
        <code>${escapeHtml(message)}</code>
    </div>
</body>
</html>`;
    }

    private getAppearanceLabel(value: string, locale: AdminLocale): string {
        switch (value) {
            case 'light':
                return this.translate(locale, 'memoAdmin.appearanceLight', 'Light');
            case 'dark':
                return this.translate(locale, 'memoAdmin.appearanceDark', 'Dark');
            default:
                return this.translate(locale, 'memoAdmin.appearanceSystem', 'System');
        }
    }

    private getEffectiveAppearance(): 'light' | 'dark' {
        if (this.memoAdminAppearance === 'light') {
            return 'light';
        }

        if (this.memoAdminAppearance === 'dark') {
            return 'dark';
        }

        return vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ? 'light' : 'dark';
    }

    private getColorThemeLabel(value: string, locale: AdminLocale): string {
        switch (value) {
            case 'teal':
                return this.translate(locale, 'memoAdmin.themeTeal', 'Teal');
            case 'amber':
                return this.translate(locale, 'memoAdmin.themeAmber', 'Amber');
            case 'rose':
                return this.translate(locale, 'memoAdmin.themeRose', 'Rose');
            case 'mono':
                return this.translate(locale, 'memoAdmin.themeMono', 'Mono');
            case 'forest':
                return this.translate(locale, 'memoAdmin.themeForest', 'Forest');
            default:
                return this.translate(locale, 'memoAdmin.themeBlue', 'Blue');
        }
    }

    private getDisplayLanguage(): AdminLocale {
        if (this.memoDisplayLanguage === 'ja') {
            return 'ja';
        }

        if (this.memoDisplayLanguage === 'en') {
            return 'en';
        }

        return vscode.env.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
    }

    private getRandomTips(locale: AdminLocale, count: number): string[] {
        const tips = locale === 'ja' ? JA_TIPS : EN_TIPS;
        const shuffled = [...tips].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, Math.min(count, shuffled.length));
    }

    private getLanguageLabel(locale: AdminLocale): string {
        return locale === 'ja' ? '\u65e5\u672c\u8a9e' : 'English';
    }

    private translate(locale: AdminLocale, key: string, fallback: string): string {
        if (locale === 'ja') {
            return JA_MESSAGES[key] ?? fallback;
        }

        return fallback;
    }
}

const JA_MESSAGES: Record<string, string> = {
    'extension.memoAdmin.title': 'Memo: \u7ba1\u7406\u753b\u9762',
    'memoAdmin.summary': '\u73fe\u5728\u306e\u30e1\u30e2\u4fdd\u5b58\u72b6\u6cc1\u3068\u64cd\u4f5c\u30e1\u30cb\u30e5\u30fc',
    'memoAdmin.newMemo': '\u65b0\u898f\u30e1\u30e2',
    'memoAdmin.searchMemo': '\u30e1\u30e2\u691c\u7d22',
    'memoAdmin.openFolder': '\u30d5\u30a9\u30eb\u30c0\u3092\u958b\u304f',
    'memoAdmin.openConfig': '\u8a2d\u5b9a\u30d5\u30a1\u30a4\u30eb\u3092\u958b\u304f',
    'memoAdmin.openSettings': '\u8a2d\u5b9a\u3092\u958b\u304f',
    'memoAdmin.openAdvancedSettings': '\u8a73\u7d30\u8a2d\u5b9a',
    'memoAdmin.createWorkspace': '\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u3092\u4f5c\u6210',
    'memoAdmin.createWorkspaceTooltip': '\u81ea\u52d5\u8d77\u52d5\u7528\u306e .code-workspace \u3092\u751f\u6210\u3057\u307e\u3059\u3002VS Code \u306b\u95a2\u9023\u4ed8\u3051\u3059\u308b\u3068\u30c0\u30d6\u30eb\u30af\u30ea\u30c3\u30af\u3067 Memo: Admin \u30e2\u30fc\u30c9\u3067\u958b\u3051\u307e\u3059',
    'memoAdmin.workspaceHelp': '\u81ea\u52d5\u8d77\u52d5\u30d5\u30a1\u30a4\u30eb: \u3053\u306e\u30e1\u30e2\u30d5\u30a9\u30eb\u30c0\u3092\u958b\u304d Memo: Admin \u304b\u3089\u59cb\u3081\u308b .code-workspace \u3092\u4f5c\u6210\u3057\u307e\u3059\u3002VS Code \u306b\u95a2\u9023\u4ed8\u3051\u3067\u304d\u307e\u3059',
    'memoAdmin.shortcutHelp': '\u30ad\u30fc\u30dc\u30fc\u30c9\u30b7\u30e7\u30fc\u30c8\u30ab\u30c3\u30c8\u306e\u5909\u66f4\u306f\u3001\u30ad\u30fc\u30dc\u30fc\u30c9\u30b7\u30e7\u30fc\u30c8\u30ab\u30c3\u30c8\u753b\u9762\u307e\u305f\u306f keybindings.json \u304b\u3089\u884c\u3044\u307e\u3059',
    'memoAdmin.openKeyboardShortcuts': '\u30ad\u30fc\u30dc\u30fc\u30c9\u30b7\u30e7\u30fc\u30c8\u30ab\u30c3\u30c8',
    'memoAdmin.memoRoot': '\u30e1\u30e2\u4fdd\u5b58\u5148',
    'memoAdmin.tips': 'Tips',
    'memoAdmin.currentDateDir': '\u4eca\u65e5\u306e\u4fdd\u5b58\u5148\u30d5\u30a9\u30eb\u30c0',
    'memoAdmin.totalFiles': '\u7dcf\u30d5\u30a1\u30a4\u30eb\u6570',
    'memoAdmin.datePathFormat': '\u65e5\u4ed8\u30d5\u30a9\u30eb\u30c0\u5f62\u5f0f',
    'memoAdmin.appearance': '\u8868\u793a\u30e2\u30fc\u30c9',
    'memoAdmin.colorTheme': '\u30ab\u30e9\u30fc\u30c6\u30fc\u30de',
    'memoAdmin.language': '\u8a00\u8a9e',
    'memoAdmin.coreSettings': '\u57fa\u672c\u8a2d\u5b9a',
    'memoAdmin.template': '\u30c6\u30f3\u30d7\u30ec\u30fc\u30c8\u30d5\u30a1\u30a4\u30eb',
    'memoAdmin.browse': '\u53c2\u7167',
    'memoAdmin.invalidMemoDirWarning': '\u73fe\u5728\u306e\u30e1\u30e2\u4fdd\u5b58\u5148\u304c\u5b58\u5728\u3057\u307e\u305b\u3093\u3002\u4e0b\u306e\u57fa\u672c\u8a2d\u5b9a\u3092\u66f4\u65b0\u3057\u3066\u5fa9\u65e7\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
    'memoAdmin.openFolderFailed': '\u30d5\u30a1\u30a4\u30e9\u30fc\u3067\u30e1\u30e2\u4fdd\u5b58\u5148\u3092\u958b\u3051\u307e\u305b\u3093\u3067\u3057\u305f',
    'memoAdmin.memodirHelp': '\u30e1\u30e2\u30d5\u30a1\u30a4\u30eb\u306e\u30eb\u30fc\u30c8\u30d5\u30a9\u30eb\u30c0',
    'memoAdmin.templateHelp': '\u65e2\u5b9a\u3067\u306f\u5185\u8535\u30c6\u30f3\u30d7\u30ec\u30fc\u30c8\u30d5\u30a1\u30a4\u30eb\u306e\u30d1\u30b9\u3092\u8868\u793a\u3057\u307e\u3059',
    'memoAdmin.datePathHelp': '\u4f8b: yyyy/MM \u307e\u305f\u306f yyyy/MM/dd',
    'memoAdmin.save': '\u4fdd\u5b58',
    'memoAdmin.workspaceCreated': '\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u30d5\u30a1\u30a4\u30eb\u3092\u4f5c\u6210\u3057\u307e\u3057\u305f: {0}',
    'memoAdmin.saveWorkspaceFile': '\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u30d5\u30a1\u30a4\u30eb\u3092\u4fdd\u5b58',
    'memoAdmin.themeHint': '\u8868\u793a\u8a2d\u5b9a\u306f VS Code \u306e\u8a2d\u5b9a\u753b\u9762\u304b\u3089\u5909\u66f4\u3067\u304d\u307e\u3059\u3002',
    'memoAdmin.recentHistory': '\u76f4\u8fd1\u5c65\u6b74',
    'memoAdmin.latest8Updated': '\u66f4\u65b0\u304c\u65b0\u3057\u3044 8 \u4ef6',
    'memoAdmin.pinnedMemos': '\u30d4\u30f3\u7559\u3081\u30e1\u30e2',
    'memoAdmin.pinnedCaption': '\u56fa\u5b9a\u30a2\u30af\u30bb\u30b9',
    'memoAdmin.pinnedEmpty': '\u30d4\u30f3\u7559\u3081\u30e1\u30e2\u306f\u3042\u308a\u307e\u305b\u3093\u3002\u6700\u8fd1\u306e\u5c65\u6b74\u306e\u30d4\u30f3\u30dc\u30bf\u30f3\u304b\u3089\u8ffd\u52a0\u3067\u304d\u307e\u3059\u3002',
    'memoAdmin.tags': '\u30bf\u30b0',
    'memoAdmin.tagsCaption': '\u5168\u30e1\u30e2\u306e frontmatter \u30bf\u30b0',
    'memoAdmin.pin': '\u30d4\u30f3\u7559\u3081',
    'memoAdmin.unpin': '\u89e3\u9664',
    'memoAdmin.created': '\u4f5c\u6210',
    'memoAdmin.updated': '\u66f4\u65b0',
    'memoAdmin.size': '\u30b5\u30a4\u30ba',
    'memoAdmin.monthlyCounts': '\u6708\u5225\u4ef6\u6570',
    'memoAdmin.latest12': '\u76f4\u8fd1 12 \u304b\u6708',
    'memoAdmin.yearlyCounts': '\u5e74\u5225\u4ef6\u6570',
    'memoAdmin.byCreatedAt': '\u4f5c\u6210\u65e5\u30d9\u30fc\u30b9',
    'memoAdmin.folderCounts': '\u30d5\u30a9\u30eb\u30c0\u5225\u4ef6\u6570',
    'memoAdmin.topFolders': '\u30d5\u30a9\u30eb\u30c0\u540d\u964d\u9806',
    'memoAdmin.moreStats': '\u8a73\u7d30\u7d71\u8a08',
    'memoAdmin.appearanceLight': '\u30e9\u30a4\u30c8',
    'memoAdmin.appearanceDark': '\u30c0\u30fc\u30af',
    'memoAdmin.appearanceSystem': '\u30b7\u30b9\u30c6\u30e0',
    'memoAdmin.themeBlue': '\u30d6\u30eb\u30fc',
    'memoAdmin.themeTeal': '\u30c6\u30a3\u30fc\u30eb',
    'memoAdmin.themeAmber': '\u30a2\u30f3\u30d0\u30fc',
    'memoAdmin.themeRose': '\u30ed\u30fc\u30ba',
    'memoAdmin.themeMono': '\u30e2\u30ce\u30af\u30ed',
    'memoAdmin.themeForest': '\u30d5\u30a9\u30ec\u30b9\u30c8',
    'memoAdmin.noData': '\u30c7\u30fc\u30bf\u304c\u3042\u308a\u307e\u305b\u3093',
    'memoAdmin.refresh': '\u66f4\u65b0',
    'memoAdmin.repoLink': 'GitHub/mmiyaji',
    'memoAdmin.forkedFrom': 'forked from',
    'memoAdmin.indexMaintenance': '\u30a4\u30f3\u30c7\u30c3\u30af\u30b9\u30e1\u30f3\u30c6\u30ca\u30f3\u30b9',
    'memoAdmin.indexStatus': '\u30b9\u30c6\u30fc\u30bf\u30b9',
    'memoAdmin.indexActive': '\u6709\u52b9',
    'memoAdmin.indexInactive': '\u7121\u52b9',
    'memoAdmin.indexEntries': '\u30a4\u30f3\u30c7\u30c3\u30af\u30b9\u6e08\u307f\u30d5\u30a1\u30a4\u30eb',
    'memoAdmin.indexFileSize': '\u30a4\u30f3\u30c7\u30c3\u30af\u30b9\u30b5\u30a4\u30ba',
    'memoAdmin.indexWatcher': '\u30d5\u30a1\u30a4\u30eb\u76e3\u8996',
    'memoAdmin.indexPrimary': '\u30d7\u30e9\u30a4\u30de\u30ea\u30d5\u30a1\u30a4\u30eb',
    'memoAdmin.indexBackup': '\u30d0\u30c3\u30af\u30a2\u30c3\u30d7\u30d5\u30a1\u30a4\u30eb',
    'memoAdmin.indexDirty': '\u672a\u4fdd\u5b58\u306e\u5909\u66f4',
    'memoAdmin.indexYes': '\u3042\u308a',
    'memoAdmin.indexNo': '\u306a\u3057',
    'memoAdmin.indexSync': '\u540c\u671f',
    'memoAdmin.indexSyncTooltip': '\u30c7\u30a3\u30b9\u30af\u306e\u5909\u66f4\u3092\u78ba\u8a8d\u3057\u30a4\u30f3\u30c7\u30c3\u30af\u30b9\u3092\u66f4\u65b0\u3057\u307e\u3059',
    'memoAdmin.indexFlush': '\u30c7\u30a3\u30b9\u30af\u306b\u4fdd\u5b58',
    'memoAdmin.indexFlushTooltip': '\u30a4\u30f3\u30c7\u30c3\u30af\u30b9\u3092\u4eca\u3059\u3050\u30c7\u30a3\u30b9\u30af\u306b\u4fdd\u5b58\u3057\u307e\u3059',
    'memoAdmin.indexRebuild': '\u518d\u69cb\u7bc9',
    'memoAdmin.indexRebuildTooltip': '\u30a4\u30f3\u30c7\u30c3\u30af\u30b9\u3092\u524a\u9664\u3057\u3066\u6700\u521d\u304b\u3089\u4f5c\u308a\u76f4\u3057\u307e\u3059',
    'memoAdmin.calendar': '\u30ab\u30ec\u30f3\u30c0\u30fc',
    'memoAdmin.calendarCaption': '\u65e5\u5225\u30e1\u30e2\u6d3b\u52d5',
    'memoAdmin.calPrev': '\u524d\u3078',
    'memoAdmin.calNext': '\u6b21\u3078',
    'memoAdmin.calToday': '\u4eca\u65e5',
    'memoAdmin.calMonth': '\u6708',
    'memoAdmin.calWeek': '\u9031',
    'memoAdmin.snippets': '\u30b9\u30cb\u30da\u30c3\u30c8',
    'memoAdmin.snippetsCaption': 'Markdown \u7528\u30ab\u30b9\u30bf\u30e0\u88dc\u5b8c',
    'memoAdmin.snippetsDir': '\u30c7\u30a3\u30ec\u30af\u30c8\u30ea',
    'memoAdmin.snippetsDirMissing': '\u898b\u3064\u304b\u308a\u307e\u305b\u3093',
    'memoAdmin.snippetsFiles': '\u30d5\u30a1\u30a4\u30eb\u6570',
    'memoAdmin.snippetsLoaded': '\u8aad\u307f\u8fbc\u307f\u6e08\u307f',
    'memoAdmin.snippetName': '\u540d\u524d',
    'memoAdmin.snippetDesc': '\u8aac\u660e',
    'memoAdmin.snippetsEmpty': '\u30b9\u30cb\u30da\u30c3\u30c8\u304c\u3042\u308a\u307e\u305b\u3093\u3002\u30b9\u30cb\u30da\u30c3\u30c8\u30c7\u30a3\u30ec\u30af\u30c8\u30ea\u306b VS Code \u30b9\u30cb\u30da\u30c3\u30c8 JSON \u30d5\u30a1\u30a4\u30eb\u3092\u914d\u7f6e\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
    'memoAdmin.templates': '\u30c6\u30f3\u30d7\u30ec\u30fc\u30c8',
    'memoAdmin.templatesCaption': '\u65b0\u898f\u30e1\u30e2\u4f5c\u6210\u7528\u30c6\u30f3\u30d7\u30ec\u30fc\u30c8',
    'memoAdmin.templatesDir': '\u30c7\u30a3\u30ec\u30af\u30c8\u30ea',
    'memoAdmin.templatesDirMissing': '\u898b\u3064\u304b\u308a\u307e\u305b\u3093',
    'memoAdmin.defaultTemplate': '\u30c7\u30d5\u30a9\u30eb\u30c8',
    'memoAdmin.templateFile': '\u30d5\u30a1\u30a4\u30eb',
    'memoAdmin.templateSize': '\u30b5\u30a4\u30ba',
    'memoAdmin.templatesEmpty': '\u30c6\u30f3\u30d7\u30ec\u30fc\u30c8\u304c\u3042\u308a\u307e\u305b\u3093\u3002\u30c6\u30f3\u30d7\u30ec\u30fc\u30c8\u30c7\u30a3\u30ec\u30af\u30c8\u30ea\u306b .md \u30d5\u30a1\u30a4\u30eb\u3092\u914d\u7f6e\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
    'memoAdmin.welcomeTitle': 'Memo Life For You \u3078\u3088\u3046\u3053\u305d\uff01',
    'memoAdmin.welcomeDesc': '\u30e1\u30e2\u30c7\u30a3\u30ec\u30af\u30c8\u30ea\u3092\u8a2d\u5b9a\u3057\u3066\u3001\u30ce\u30fc\u30c8\u306e\u6574\u7406\u3092\u59cb\u3081\u307e\u3057\u3087\u3046\u3002\u4e0a\u306e\u8a2d\u5b9a\u30d1\u30cd\u30eb\u304b\u3089\u8a2d\u5b9a\u3067\u304d\u307e\u3059\u3002',
    'memoAdmin.step1Title': '\u30e1\u30e2\u30c7\u30a3\u30ec\u30af\u30c8\u30ea\u3092\u8a2d\u5b9a',
    'memoAdmin.step1Desc': '\u4e0a\u306e\u8a2d\u5b9a\u30d1\u30cd\u30eb\u3092\u958b\u3044\u3066\u3001\u30e1\u30e2\u306e\u4fdd\u5b58\u5148\u30d1\u30b9\u3092\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
    'memoAdmin.step2Title': '\u6700\u521d\u306e\u30e1\u30e2\u3092\u4f5c\u6210',
    'memoAdmin.step2Desc': '\u300c\u65b0\u898f\u30e1\u30e2\u300d\u30dc\u30bf\u30f3\u307e\u305f\u306f\u30b3\u30de\u30f3\u30c9\u30d1\u30ec\u30c3\u30c8\u304b\u3089\u300cMemo: New\u300d\u3092\u5b9f\u884c\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
    'memoAdmin.step3Title': '\u30c6\u30f3\u30d7\u30ec\u30fc\u30c8\u3068\u30b9\u30cb\u30da\u30c3\u30c8\u3092\u30ab\u30b9\u30bf\u30de\u30a4\u30ba',
    'memoAdmin.step3Desc': '\u30e1\u30e2\u30c7\u30a3\u30ec\u30af\u30c8\u30ea\u5185\u306e .templates/ \u306b .md \u30d5\u30a1\u30a4\u30eb\u3001.snippets/ \u306b\u30b9\u30cb\u30da\u30c3\u30c8JSON\u3092\u914d\u7f6e\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
};

const JA_TIPS: string[] = [
    '\u300c\u65b0\u898f\u30e1\u30e2\u300d\u304b\u3089\u4f5c\u6210\u3059\u308b\u3068\u3001\u4e0a\u306e\u65e5\u4ed8\u30d5\u30a9\u30eb\u30c0\u5f62\u5f0f\u306b\u5f93\u3063\u3066\u81ea\u52d5\u6574\u7406\u3055\u308c\u307e\u3059',
    '\u76f4\u8fd1\u5c65\u6b74\u306f\u6700\u7d42\u66f4\u65b0\u65e5\u6642\u9806\u3067\u4e26\u3073\u307e\u3059',
    '\u300c\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u3092\u4f5c\u6210\u300d\u3067 Memo: Admin \u81ea\u52d5\u8d77\u52d5\u7528\u30d5\u30a1\u30a4\u30eb\u3092\u4f5c\u308c\u307e\u3059',
    '\u691c\u7d22\u306f\u30e1\u30e2\u5168\u4f53\u3060\u3051\u3067\u306a\u304f\u5e74\u3001\u6708\u3001\u30b5\u30d6\u30d5\u30a9\u30eb\u30c0\u3067\u7d5e\u308a\u8fbc\u3081\u307e\u3059',
    '\u30ab\u30e9\u30fc\u30c6\u30fc\u30de\u306f VS Code \u8a2d\u5b9a\u304b\u3089\u3044\u3064\u3067\u3082\u5207\u308a\u66ff\u3048\u3067\u304d\u307e\u3059'
];

const EN_TIPS: string[] = [
    'New memo uses the current date-folder format and files are organized automatically.',
    'Recent history is sorted by the latest updated memo.',
    'Create workspace generates a startup file that can open directly into Memo: Admin.',
    'Search can be narrowed by all memos, year, month, or subfolder.',
    'The admin color theme can be changed any time from VS Code settings.'
];
