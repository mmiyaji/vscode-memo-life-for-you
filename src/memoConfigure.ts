'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as upath from 'upath';
import * as nls from 'vscode-nls';

const localize = nls.config({ messageFormat: nls.MessageFormat.file })();

export interface items extends vscode.QuickPickItem {
    ln: number;
    col: number;
    index: number;
    filename: string;
    isDirectory: boolean;
    birthtime: Date;
    mtime: Date;
}

/** Default name of the hidden metadata directory inside memodir */
export const MEMO_META_DIR_DEFAULT = '.memo';

/** Built-in default template content (Mustache format) */
export const BUILTIN_TEMPLATE_CONTENT = '# {{.Date}} {{.Title}}\n\n';

export class memoConfigure {
    public _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    public _waiting: boolean;
    public memopath: string;
    public memoaddr: string;
    public memodir: string;
    public memotemplate: string;
    public memoconfdir: string;
    public memoTitlePrefix: string;
    public memoDateFormat: string;
    public memoISOWeek = false;
    public memoEmoji = false;
    public memoGutterIconPath: string;
    public memoGutterIconSize: string;
    public memoWithRespectMode = false;
    public memoGrepLineBackgroundColor: string;
    public memoGrepKeywordBackgroundColor: string;
    public memoEditPreviewMarkdown: boolean;
    public memoEditOpenMarkdown: boolean;
    public memoEditOpenNewInstance: boolean;
    public memoEditDispBtime = false;
    public memoListSortOrder: string;
    public memoGrepOrder: string;
    public memoGrepViewMode: string;
    public memoGrepUseRipGrepConfigFile = false;
    public memoGrepUseRipGrepConfigFilePath: string;
    public memoTodoUserePattern: string;
    public memoNewFilenameFromClipboard: boolean;
    public memoNewFilenameFromSelection: boolean;
    public memoNewFilNameDateSuffix: string;
    public memoTemplatesDir: string;
    public memoSnippetsDir: string;
    public memoDatePathFormat: string;
    public memoAdminAppearance: string;
    public memoAdminColorTheme: string;
    public memoDisplayLanguage: string;
    public memoAdminUseGradient: boolean;
    public memoAdminAdvancedMode: boolean;
    public memoAdminOpenMode: string;
    public memoAdminOpenOnStartup: boolean;
    public memoPinnedFiles: string[];
    public memoRecentCount: number;
    public memoMetaDir: string;
    public openMarkdownPreviewUseMPE: boolean;
    public memoOpenChromeCustomizeURL: string;
    public memoTyporaExecPath: string;
    public memoListDisplayExtname: string[];

    public options: vscode.QuickPickOptions = {
        ignoreFocusOut: true,
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: ''
    };

    public cp_options = {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024
    };

    constructor() {
        this.setMemoConfDir();
        this.applyMemoConfDirSetting();
        this.updateConfiguration();
        this._waiting = false;

        vscode.workspace.onDidChangeConfiguration(() => {
            this.applyMemoConfDirSetting();
            this.updateConfiguration();
        });
    }

    public setMemoConfDir() {
        if (process.platform === "win32") {
            this.memoconfdir = process.env.APPDATA;
            if (this.memoconfdir === "") {
                this.memoconfdir = upath.normalize(upath.join(process.env.USERPROFILE, "Application Data", "memo"));
            }
            this.memoconfdir = upath.normalize(upath.join(this.memoconfdir, "memo"));
        } else {
            this.memoconfdir = upath.normalize(upath.join(process.env.HOME, ".config", "memo"));
        }
        return void 0;
    }

    private applyMemoConfDirSetting() {
        const userConfDir = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('memoconfdir');
        if (userConfDir && userConfDir.trim() !== '') {
            this.memoconfdir = upath.normalize(userConfDir.trim());
        }
    }

    public checkMemoDir() {
        if (!this.memodir) {
            vscode.window.showErrorMessage(localize('memodirCheck', 'memodir is not set. Configure it in VS Code settings.'));
            return;
        }

        try {
            fs.statSync(this.memodir);
        } catch {
            vscode.window.showErrorMessage(localize('memodirAccessCheck', 'The directory set in memodir does not exist'));
            return;
        }
    }

    public updateConfiguration() {
        const cfg = vscode.workspace.getConfiguration('memo-life-for-you');
        this.memodir = upath.normalizeTrim((cfg.get<string>('memodir') || '').trim());
        const rawTemplate = (cfg.get<string>('memotemplate') || '').trim();
        this.memotemplate = rawTemplate ? upath.normalizeTrim(rawTemplate) : '';
        this.memoDatePathFormat = (cfg.get<string>('memoDatePathFormat') || '').trim();
        this.memopath = upath.normalize(vscode.workspace.getConfiguration('memo-life-for-you').get<string>('memoPath'));
        this.memoaddr = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('serve-addr');
        this.memoTitlePrefix = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('titlePrefix');
        this.memoDateFormat = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('dateFormat');
        this.memoISOWeek = vscode.workspace.getConfiguration('memo-life-for-you').get<boolean>('insertISOWeek');
        this.memoEmoji = vscode.workspace.getConfiguration('memo-life-for-you').get<boolean>('insertEmoji');
        this.memoGutterIconPath = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('gutterIconPath');
        this.memoGutterIconSize = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('gutterIconSize');
        this.memoWithRespectMode = vscode.workspace.getConfiguration('memo-life-for-you').get<boolean>('withRespectMode');
        this.memoEditDispBtime = vscode.workspace.getConfiguration('memo-life-for-you').get<boolean>('displayFileBirthTime');
        this.memoGrepLineBackgroundColor = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('grepLineBackgroundColor');
        this.memoGrepKeywordBackgroundColor = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('grepKeywordBackgroundColor');
        this.memoEditPreviewMarkdown = vscode.workspace.getConfiguration('memo-life-for-you').get<boolean>('listMarkdownPreview');
        this.memoEditOpenMarkdown = vscode.workspace.getConfiguration('memo-life-for-you').get<boolean>('openMarkdownPreview');
        this.memoEditOpenNewInstance = vscode.workspace.getConfiguration('memo-life-for-you').get<boolean>('openNewInstance');
        this.memoListSortOrder = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('listSortOrder');
        this.memoGrepOrder = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('grepOrder');
        this.memoGrepViewMode = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('memoGrepViewMode');
        this.memoGrepUseRipGrepConfigFile = vscode.workspace.getConfiguration('memo-life-for-you').get<boolean>('memoGrepUseRipGrepConfigFile');
        this.memoGrepUseRipGrepConfigFilePath = vscode.workspace.getConfiguration('memo-life-for-you').inspect<string>('memoGrepUseRipGrepConfigFilePath').globalValue;
        this.memoTodoUserePattern = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('memoTodoUserePattern');
        this.memoNewFilenameFromClipboard = vscode.workspace.getConfiguration('memo-life-for-you').get<boolean>('memoNewFilenameFromClipboard');
        this.memoNewFilenameFromSelection = vscode.workspace.getConfiguration('memo-life-for-you').get<boolean>('memoNewFilenameFromSelection');
        this.memoNewFilNameDateSuffix = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('memoNewFilNameDateSuffix');
        this.memoTemplatesDir = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('memoTemplatesDir');
        this.memoSnippetsDir = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('memoSnippetsDir');
        this.memoAdminAppearance = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('memoAdminAppearance');
        this.memoAdminColorTheme = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('memoAdminColorTheme');
        this.memoDisplayLanguage = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('memoDisplayLanguage');
        this.memoAdminUseGradient = vscode.workspace.getConfiguration('memo-life-for-you').get<boolean>('memoAdminUseGradient');
        this.memoAdminAdvancedMode = vscode.workspace.getConfiguration('memo-life-for-you').get<boolean>('memoAdminAdvancedMode');
        this.memoAdminOpenMode = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('memoAdminOpenMode');
        this.memoAdminOpenOnStartup = vscode.workspace.getConfiguration('memo-life-for-you').get<boolean>('memoAdminOpenOnStartup');
        this.memoPinnedFiles = vscode.workspace.getConfiguration('memo-life-for-you').get<string[]>('memoPinnedFiles');
        this.memoRecentCount = vscode.workspace.getConfiguration('memo-life-for-you').get<number>('memoRecentCount', 8);
        this.memoMetaDir = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('memoMetaDir', MEMO_META_DIR_DEFAULT) || MEMO_META_DIR_DEFAULT;
        this.openMarkdownPreviewUseMPE = vscode.workspace.getConfiguration('memo-life-for-you').get<boolean>('openMarkdownPreviewUseMPE');
        this.memoOpenChromeCustomizeURL = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('openChromeCustomizeURL');
        this.memoTyporaExecPath = vscode.workspace.getConfiguration('memo-life-for-you').get<string>('TyporaExecPath');
        this.memoListDisplayExtname = vscode.workspace.getConfiguration('memo-life-for-you').get<string[]>('listDisplayExtname');
        this.memoListDisplayExtname = vscode.workspace.getConfiguration('memo-life-for-you').get<string[]>('listDisplayExtname');
    }

    /**
     * Resolve the effective default template path.
     * If memotemplate is explicitly set, use it.
     * Otherwise fall back to .memo/templates/default.md (if it exists),
     * then to BUILTIN_TEMPLATE_CONTENT.
     */
    public resolveDefaultTemplatePath(): string {
        if (this.memotemplate) {
            return this.memotemplate;
        }
        if (this.memodir) {
            const defaultPath = upath.normalize(upath.join(this.memodir, this.memoMetaDir, 'templates', 'default.md'));
            if (fs.existsSync(defaultPath)) {
                return defaultPath;
            }
        }
        return '';
    }

    public ensureBuiltInTemplateFile(): string {
        const templatePath = upath.normalize(upath.join(this.memoconfdir, 'builtin-template.md'));

        if (!fs.existsSync(templatePath) || fs.readFileSync(templatePath, 'utf8') !== BUILTIN_TEMPLATE_CONTENT) {
            fs.writeFileSync(templatePath, BUILTIN_TEMPLATE_CONTENT, 'utf8');
        }

        return templatePath;
    }

    get onDidChange() {
        return this._onDidChange.event;
    }

    update(uri) {
        if (!this._waiting) {
            this._waiting = true;
            setTimeout(() => {
                this._waiting = false;
                this._onDidChange.fire(uri);
            }, 300);
        }
    }
}
