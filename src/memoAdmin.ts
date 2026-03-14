'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as upath from 'upath';
import * as dateFns from 'date-fns';
import * as nls from 'vscode-nls';
import { memoConfigure } from './memoConfigure';
import { getMemoDateDirectory, getMemoRelativeDirectoryLabel } from './memoPath';

const localize = nls.config({ messageFormat: nls.MessageFormat.file })();

type MemoStats = {
    totalFiles: number;
    yearCounts: Array<{ label: string; count: number }>;
    monthCounts: Array<{ label: string; count: number }>;
    folderCounts: Array<{ label: string; count: number }>;
    recentFiles: Array<{ label: string; createdAt: string; updatedAt: string; filename: string; lineCount: number; fileSizeLabel: string; mtimeMs: number }>;
};

type AdminLocale = 'en' | 'ja';

export class memoAdmin extends memoConfigure {
    public static readonly pendingOpenKey = 'memoAdmin.pendingOpenInNewWindow';
    private static currentPanel: vscode.WebviewPanel | undefined;

    public async Show(context: vscode.ExtensionContext) {
        this.readConfig();

        await this.revealMemoRootInExplorer();

        if (memoAdmin.currentPanel) {
            memoAdmin.currentPanel.reveal(vscode.ViewColumn.One);
            this.renderPanel(memoAdmin.currentPanel, context);
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
                case 'openSettings':
                    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:satokaz.vscode-memo-life-for-you memo-life-for-you');
                    break;
                case 'openLink':
                    if (message.url) {
                        await vscode.env.openExternal(vscode.Uri.parse(message.url));
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
                    const workspaceContent = JSON.stringify({
                        folders: [
                            {
                                path: this.memodir,
                                name: 'MEMO'
                            }
                        ],
                        settings: {
                            'memo-life-for-you.memoAdminOpenOnStartup': true,
                            'memo-life-for-you.memoAdminOpenMode': 'currentWindow'
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
        const normalizedMemoDir = upath.normalize(this.memodir);

        const alreadyExists = workspaceFolders.some((folder) => upath.normalize(folder.uri.fsPath) === normalizedMemoDir);
        if (alreadyExists) {
            return;
        }

        const insertIndex = workspaceFolders.length;
        vscode.workspace.updateWorkspaceFolders(insertIndex, 0, {
            uri: memoUri,
            name: 'Memo'
        });
    }

    private collectStats(): MemoStats {
        if (!this.memodir || !fs.existsSync(this.memodir)) {
            return {
                totalFiles: 0,
                yearCounts: [],
                monthCounts: [],
                folderCounts: [],
                recentFiles: [],
            };
        }

        const files = this.readFilesRecursively(this.memodir)
            .filter((filename) => this.memoListDisplayExtname.includes(upath.extname(filename).replace(/^\./, '')));

        const yearMap = new Map<string, number>();
        const monthMap = new Map<string, number>();
        const folderMap = new Map<string, number>();

        const recentFiles = files.map((filename) => {
            const stat = fs.statSync(filename);
            const yearLabel = dateFns.format(stat.birthtime, 'yyyy');
            const monthLabel = dateFns.format(stat.birthtime, 'yyyy/MM');
            const folderLabel = getMemoRelativeDirectoryLabel(this.memodir, upath.dirname(filename));

            yearMap.set(yearLabel, (yearMap.get(yearLabel) ?? 0) + 1);
            monthMap.set(monthLabel, (monthMap.get(monthLabel) ?? 0) + 1);
            folderMap.set(folderLabel, (folderMap.get(folderLabel) ?? 0) + 1);

            return {
                label: getMemoRelativeDirectoryLabel(this.memodir, filename),
                createdAt: dateFns.format(stat.birthtime, 'yyyy-MM-dd HH:mm'),
                updatedAt: dateFns.format(stat.mtime, 'yyyy-MM-dd HH:mm'),
                filename,
                mtimeMs: stat.mtime.getTime(),
                lineCount: this.countFileLines(filename),
                fileSizeLabel: this.formatFileSize(stat.size)
            };
        })
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(0, 8);

        return {
            totalFiles: files.length,
            yearCounts: this.mapToSortedArray(yearMap),
            monthCounts: this.mapToSortedArray(monthMap).slice(0, 12),
            folderCounts: this.mapToSortedArray(folderMap).slice(0, 12),
            recentFiles,
        };
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

    private countFileLines(filename: string): number {
        const content = fs.readFileSync(filename, 'utf8');
        if (content.length === 0) {
            return 0;
        }
        return content.split(/\r\n|\r|\n/).length;
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
        const hasValidMemoDir = !!safeMemoDir && fs.existsSync(safeMemoDir);
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

        body[data-theme="blue"] {
            --accent: #3794ff;
            --accent-strong: #58a6ff;
            --button-bg: #3794ff;
            --button-hover: #58a6ff;
            --accent-soft: rgba(55, 148, 255, 0.12);
            --accent-soft-strong: rgba(55, 148, 255, 0.2);
            --accent-panel: rgba(55, 148, 255, 0.08);
            --accent-card: rgba(55, 148, 255, 0.06);
            --accent-border: rgba(55, 148, 255, 0.34);
            --mica-tint: rgba(78, 124, 186, 0.22);
            --mica-tint-soft: rgba(78, 124, 186, 0.12);
        }

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
            font-size: 12px;
            transition: transform 120ms ease;
        }

        .config-block[open] .summary-caret {
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

        .stack {
            display: grid;
            gap: 16px;
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
            cursor: pointer;
            text-decoration: underline;
            text-underline-offset: 2px;
        }

        .link-button:hover {
            color: var(--accent-strong);
            background: transparent;
            transform: none;
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
            width: 100%;
            text-align: left;
            display: grid;
            gap: 4px;
            padding: 10px 12px;
            border: 1px solid var(--border);
            border-radius: 10px;
            background: var(--surface-alt);
            color: var(--text);
        }

        .recent-item:hover {
            border-color: var(--accent);
            background: var(--accent-soft);
            transform: none;
        }

        .recent-title {
            font-weight: 600;
            overflow-wrap: anywhere;
        }

        .recent-meta {
            font-size: 12px;
            color: var(--muted);
        }

        .empty {
            color: var(--muted);
            padding: 8px 0 2px;
        }

        @media (max-width: 900px) {
            .summary,
            .grid,
            .config-grid {
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
            <div class="version">v${escapeHtml(String(extensionVersion))}</div>
        </header>

        <section class="hero">
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
            ${hasValidMemoDir ? '' : `<div class="warning">${t('memoAdmin.invalidMemoDirWarning', 'The current memo root does not exist. Update the core settings below to recover.')}</div>`}

            <details class="config-block">
                <summary>
                    <span class="summary-label">
                        <span class="summary-icon">⚙</span>
                        <span>${t('memoAdmin.coreSettings', 'Core settings')}</span>
                    </span>
                    <span class="summary-caret">▼</span>
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
                <div class="action-help">${t('memoAdmin.workspaceHelp', 'Startup file: create a .code-workspace that opens this memo folder and starts with Memo: Admin. You can associate it with VS Code.')}</div>
                <div class="config-actions">
                    <button class="secondary" data-command="createWorkspace" title="${t('memoAdmin.createWorkspaceTooltip', 'Generate a startup .code-workspace file. If you associate it with VS Code, double-clicking it can open directly into Memo: Admin mode.')}">${t('memoAdmin.createWorkspace', 'Create workspace')}</button>
                    <button class="secondary" data-command="openConfig">${t('memoAdmin.openConfig', 'Open config file')}</button>
                    <button class="secondary" data-command="openSettings">${t('memoAdmin.openAdvancedSettings', 'Advanced settings')}</button>
                    <button class="primary" data-command="saveCoreSettings">${t('memoAdmin.save', 'Save')}</button>
                </div>
            </details>
        </section>

        <section class="stack">
            <div class="grid">
                <article class="card">
                    <div class="card-header">
                        <h2 class="card-title">${t('memoAdmin.monthlyCounts', 'Monthly counts')}</h2>
                        <div class="card-caption">${t('memoAdmin.latest12', 'Latest 12')}</div>
                    </div>
                    ${renderList(stats.monthCounts, locale)}
                </article>
                <article class="card">
                    <div class="card-header">
                        <h2 class="card-title">${t('memoAdmin.yearlyCounts', 'Yearly counts')}</h2>
                        <div class="card-caption">${t('memoAdmin.byCreatedAt', 'By created date')}</div>
                    </div>
                    ${renderList(stats.yearCounts, locale)}
                </article>
                <article class="card">
                    <div class="card-header">
                        <h2 class="card-title">${t('memoAdmin.folderCounts', 'Folder counts')}</h2>
                        <div class="card-caption">${t('memoAdmin.topFolders', 'Top 12 folders')}</div>
                    </div>
                    ${renderList(stats.folderCounts, locale)}
                </article>
            </div>
            <article class="card">
                <div class="card-header">
                    <h2 class="card-title">${t('memoAdmin.recentHistory', 'Recent history')}</h2>
                    <div class="card-caption">${t('memoAdmin.latest8Updated', 'Latest 8 updates')}</div>
                </div>
                ${renderRecentFiles(stats.recentFiles, locale)}
            </article>
        </section>
        <footer class="footer">
            <div class="footer-links">
                ${repositoryUrl ? `<button class="link-button" type="button" data-link="${escapeHtml(repositoryUrl)}">${t('memoAdmin.repoLink', 'GitHub/mmiyaji')}</button>` : ''}
            </div>
            <div class="footer-note">
                ${t('memoAdmin.forkedFrom', 'forked from')} ${upstreamUrl ? `<button class="link-button" type="button" data-link="${escapeHtml(upstreamUrl)}">satokaz/vscode-memo-life-for-you</button>` : ''}
            </div>
        </footer>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
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

        document.querySelectorAll('button[data-link]').forEach((button) => {
            button.addEventListener('click', () => {
                vscode.postMessage({ command: 'openLink', url: button.dataset.link });
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
        this.readConfig();
        panel.title = this.translate(this.getDisplayLanguage(), 'extension.memoAdmin.title', 'Memo Admin');
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

function renderList(items: Array<{ label: string; count: number }>, locale: AdminLocale): string {
    if (items.length === 0) {
        return `<div class="empty">${escapeHtml(locale === 'ja' ? (JA_MESSAGES['memoAdmin.noData'] ?? '\u30c7\u30fc\u30bf\u304c\u3042\u308a\u307e\u305b\u3093') : 'No data')}</div>`;
    }

    return `<ul>${items
        .map((item) => `<li><span class="list-label">${escapeHtml(item.label)}</span><span class="list-value">${item.count}</span></li>`)
        .join('')}</ul>`;
}

function renderRecentFiles(items: Array<{ label: string; createdAt: string; updatedAt: string; filename: string; lineCount: number; fileSizeLabel: string; mtimeMs: number }>, locale: AdminLocale): string {
    if (items.length === 0) {
        return `<div class="empty">${escapeHtml(locale === 'ja' ? (JA_MESSAGES['memoAdmin.noData'] ?? '\u30c7\u30fc\u30bf\u304c\u3042\u308a\u307e\u305b\u3093') : 'No data')}</div>`;
    }

    return `<div class="recent-list">${items
        .map((item) => `<button class="recent-item" type="button" data-recent-file="${escapeHtml(item.filename)}"><span class="recent-title">${escapeHtml(item.label)}</span><span class="recent-meta">${escapeHtml((locale === 'ja' ? '\u4f5c\u6210' : 'Created') + ': ' + item.createdAt + ' / ' + (locale === 'ja' ? '\u66f4\u65b0' : 'Updated') + ': ' + item.updatedAt + ' / ' + (locale === 'ja' ? '\u884c\u6570' : 'Lines') + ': ' + item.lineCount + ' / ' + (locale === 'ja' ? '\u30b5\u30a4\u30ba' : 'Size') + ': ' + item.fileSizeLabel)}</span></button>`)
        .join('')}</div>`;
}

function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
    'memoAdmin.monthlyCounts': '\u6708\u5225\u4ef6\u6570',
    'memoAdmin.latest12': '\u76f4\u8fd1 12 \u4ef6',
    'memoAdmin.yearlyCounts': '\u5e74\u5225\u4ef6\u6570',
    'memoAdmin.byCreatedAt': '\u4f5c\u6210\u65e5\u30d9\u30fc\u30b9',
    'memoAdmin.folderCounts': '\u30d5\u30a9\u30eb\u30c0\u5225\u4ef6\u6570',
    'memoAdmin.topFolders': '\u4e0a\u4f4d 12 \u30d5\u30a9\u30eb\u30c0',
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
    'memoAdmin.repoLink': 'GitHub/mmiyaji',
    'memoAdmin.forkedFrom': 'forked from'
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
