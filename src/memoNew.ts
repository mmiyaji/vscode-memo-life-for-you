'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as upath from 'upath';
import * as randomEmoji from 'node-emoji';
import * as dateFns from 'date-fns';
import * as nls from 'vscode-nls';
import * as os from 'os';
import { items, memoConfigure, BUILTIN_TEMPLATE_CONTENT } from './memoConfigure';
import * as Mustache from 'mustache';
import { ensureMemoDateDirectory } from './memoPath';

const localize = nls.config({ messageFormat: nls.MessageFormat.file })();

export class memoNew extends memoConfigure  {

    constructor() {
        super();
    }

    /**
     * New
     */
    public async New() {
        this.updateConfiguration();

        let file: string;

        let selectString: string = "";
        // エディタが一つも無い場合は、エラーになるので対処しておく
        let editor = vscode.window.activeTextEditor;

        if(!this.memodir) {
            vscode.window.showErrorMessage(localize('memodirCheck', 'memodir is not set in config.toml'));
            return;
        }

        // memodir に設定されたディレクトりが実際に存在するかチェック
        try{
            fs.statSync(this.memodir);
        } catch(err) {
            // console.log(err);
            vscode.window.showErrorMessage(localize('memodirAccessCheck', 'The directory set in memodir does not exist'));
            return;
        }

        // vscode 上選択されているテキストを取得
        if (this.memoNewFilenameFromSelection == true) {
            selectString = editor.document.getText(editor.selection);
        }

        // vscde 上で何も選択されていない (= 0) 場合は、clipboard を参照する
        if (this.memoNewFilenameFromClipboard == true) {
            if (selectString.length == 0) {
                selectString = await vscode.env.clipboard.readText();
            }
        }
        // console.log('selectString =', selectString);

        let fileNameDateFormat: string = dateFns.format(new Date(), 'yyyy-MM-dd');
        let filNameDateSuffix: string = "";

        if (this.memoNewFilNameDateSuffix !== "") {
            filNameDateSuffix  = dateFns.format(new Date(), this.memoNewFilNameDateSuffix);
            
        }

        vscode.window.showInputBox({
            placeHolder: localize('enterFilename', 'Please Enter a Filename (default: {0}.md)', fileNameDateFormat + filNameDateSuffix),
            // prompt: "",
            value: `${selectString.substr(0,49)}`,
            ignoreFocusOut: true
        }).then(
            async (title) => {
                if (title == undefined) { // キャンセル処理: ESC を押した時に undefined になる
                    return void 0;
                }

                if (title == "") {
                    file = fileNameDateFormat + filNameDateSuffix + ".md";
                } else {
                    file = fileNameDateFormat + filNameDateSuffix + "-" + title
                    .replace(/[\s\]\[\!\"\#\$\%\&\'\(\)\*\/\:\;\<\=\>\?\@\\\^\{\|\}\~\`]/g, '-')
                    .replace(/--+/g ,'') + ".md";
                }
                const targetDir = ensureMemoDateDirectory(this.memodir, this.memoDatePathFormat);
                file = upath.normalize(upath.join(targetDir, file));

                let fileExists = false;
                try {
                    fs.statSync(file);
                    fileExists = true;
                } catch {
                    // file does not exist — will create
                }

                if (!fileExists) {
                    const selectedTemplate = await this.pickTemplate();
                    const content = this.memoTemplate(title, fileNameDateFormat, selectedTemplate);
                    fs.writeFileSync(file, content);
                }

                if (this.memoEditOpenNewInstance){
                    vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(upath.dirname(file)), true).then(() => {
                        vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(file));
                    });
                } else {
                    vscode.workspace.openTextDocument(file).then(document=>{
                            vscode.window.showTextDocument(document, {
                                viewColumn: 1,
                                preserveFocus: false, // focus を開いたエディタへ移行させるために false を設定
                                preview: true
                            }).then(document => {
                                // カーソルを目的の行に移動させて表示する為の処理
                                const editor = vscode.window.activeTextEditor;
                                const position = editor.selection.active;
                                const newPosition = position.with(editor.document.lineCount + 1 , 0);
                                // カーソルで選択 (ここでは、まだエディタ上で見えない)
                                editor.selection = new vscode.Selection(newPosition, newPosition);
                                // カーソル位置までスクロール
                                editor.revealRange(editor.selection, vscode.TextEditorRevealType.Default);
                                void this.openMarkdownPreviewIfConfigured();
                            });
                    });
                }
            }
        );
    }

    /**
     * QuickNew
     */
    public QuickNew() {
        this.updateConfiguration();

        const targetDir = ensureMemoDateDirectory(this.memodir, this.memoDatePathFormat);
        let file: string = upath.normalize(upath.join(targetDir, dateFns.format(new Date(), 'yyyy-MM-dd') + ".md"));
        let date: Date = new Date();
        let dateFormat = this.memoDateFormat;
        let titlePrefix = this.memoTitlePrefix;
        let getISOWeek = this.memoISOWeek == true ? "[Week: " + dateFns.getISOWeek(new Date()) + "/" + dateFns.getISOWeeksInYear(new Date()) + "] " : "";
        let getEmoji = this.memoEmoji == true ? randomEmoji.random().emoji : "";

        // console.log(getISOWeek);
        // console.log(getEmoji);

        fs.stat(file, async (err, files) => {
            if (err) {
                await fs.writeFile(file, "# " + dateFns.format(new Date(), `${dateFormat}`) + os.EOL + os.EOL, (err) => {
                    if (err) throw err;
                });
            }
        });

        // 選択されているテキストを取得
        // エディタが一つも無い場合は、エラーになるので対処しておく
        let editor = vscode.window.activeTextEditor;
        let selectString: String = editor ? editor.document.getText(editor.selection) : "";    

        if (this.memoEditOpenNewInstance) {
            vscode.workspace.openTextDocument(file).then(document => {
                vscode.window.showTextDocument(document, {
                    viewColumn: -1,
                    preserveFocus: false,
                }).then(async document => {
                    const editor = vscode.window.activeTextEditor;
                    const position = editor.selection.active;
                    const newPosition = position.with(editor.document.lineCount + 1 , 0);
                    editor.selection = new vscode.Selection(newPosition, newPosition);
                        vscode.window.activeTextEditor.edit(async function (edit) {
                            edit.insert(newPosition,
                                os.EOL
                                + titlePrefix 
                                + getISOWeek
                                + getEmoji
                                + dateFns.format(new Date(), `${dateFormat}`)
                                + (selectString === "" ? "" : ` ${selectString.substr(0,49)}`)
                                + os.EOL + os.EOL);
                        }).then(() => {
                            setTimeout(() => { vscode.commands.executeCommand('workbench.action.closeActiveEditor'); }, 900);
                        }).then(() => {
                            // console.log(vscode.window.activeTextEditor.document);
                            vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(upath.dirname(file)), true).then(() => {
                                vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(file));
                            });
                        });
                });
            }).then(() => {
                // vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path.dirname(file)), true).then(() => {
                //     vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(file));
                // });
            });
        } else {
            vscode.workspace.openTextDocument(file).then(document => {
                vscode.window.showTextDocument(document, {
                    viewColumn: 1,
                    preserveFocus: false,
                }).then(document => {
                    const editor = vscode.window.activeTextEditor;
                    const position = editor.selection.active;
                    const newPosition = position.with(editor.document.lineCount + 1 , 0);
                    editor.selection = new vscode.Selection(newPosition, newPosition);
                        vscode.window.activeTextEditor.edit(function (edit) {
                            edit.insert(newPosition,
                                os.EOL
                                + titlePrefix 
                                + getISOWeek
                                + getEmoji
                                + dateFns.format(new Date(), `${dateFormat}`)
                                + (selectString === "" ? "" : ` ${selectString.substr(0,49)}`)
                                + os.EOL + os.EOL);
                        }).then(() => {
                            editor.revealRange(editor.selection, vscode.TextEditorRevealType.Default);
                            void this.openMarkdownPreviewIfConfigured();
                        });
                });
            });
        }
    }

    /**
     * memoTemplate
     */
    private memoTemplate(title: string, date: string, templatePath?: string): string {
        const tpl = templatePath || this.resolveDefaultTemplatePath();
        let content: string;
        if (tpl) {
            try {
                content = fs.readFileSync(tpl).toString();
            } catch {
                content = BUILTIN_TEMPLATE_CONTENT;
            }
        } else {
            content = BUILTIN_TEMPLATE_CONTENT;
        }
        const params = {
            ".Title": title,
            ".Date": date
        };
        return Mustache.render(content, params);
    }

    /**
     * List template files from the templates directory and let user pick one.
     * Returns the selected template path, or undefined to use the default.
     */
    private async pickTemplate(): Promise<string | undefined> {
        const templatesDir = this.memoTemplatesDir
            ? upath.normalize(this.memoTemplatesDir)
            : upath.normalize(upath.join(this.memodir, this.memoMetaDir, 'templates'));
        if (!fs.existsSync(templatesDir)) {
            return undefined;
        }

        let files: string[];
        try {
            files = fs.readdirSync(templatesDir)
                .filter(f => f.endsWith('.md'))
                .sort();
        } catch {
            return undefined;
        }

        if (files.length === 0) {
            return undefined;
        }

        if (files.length === 1) {
            return upath.join(templatesDir, files[0]);
        }

        const defaultLabel = localize('memoNew.defaultTemplate', '(Default template)');
        const items: vscode.QuickPickItem[] = [
            { label: defaultLabel, description: '' },
            ...files.map(f => ({
                label: f.replace(/\.md$/, ''),
                description: f,
            })),
        ];

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: localize('memoNew.pickTemplate', 'Select a template'),
            ignoreFocusOut: true,
        });

        if (!picked || picked.label === defaultLabel) {
            return undefined;
        }

        return upath.join(templatesDir, picked.description);
    }

    private async openMarkdownPreviewIfConfigured(): Promise<void> {
        if (!this.memoEditOpenMarkdown) {
            return;
        }

        if (this.openMarkdownPreviewUseMPE && vscode.extensions.getExtension('shd101wyy.markdown-preview-enhanced')) {
            await vscode.commands.executeCommand('markdown-preview-enhanced.openPreview');
            await vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
            return;
        }

        await vscode.commands.executeCommand('markdown.showPreviewToSide');
        await vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
    }
}
