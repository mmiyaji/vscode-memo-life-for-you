'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as upath from 'upath';
import * as dateFns from 'date-fns';
import * as nls from 'vscode-nls';
import { items, memoConfigure } from './memoConfigure';
import { MemoIndex } from './memoIndex';

const localize = nls.config({ messageFormat: nls.MessageFormat.file })();

export class memoEdit extends memoConfigure {
    public memoListChannel: vscode.OutputChannel;
    constructor() {
        super();
        this.memoListChannel = vscode.window.createOutputChannel("Memo List");
    }

    /**
     * Edit
     */
    public async Edit() {
        this.updateConfiguration();
        let items: items[] = [];
        let memodir = upath.normalizeTrim(this.memodir);
        let list: string[] = [];
        let dirlist: string[] = [];
        let openMarkdownPreview: boolean = this.memoEditOpenMarkdown;
        let listMarkdownPreview: boolean = this.memoEditPreviewMarkdown;
        let openMarkdownPreviewUseMPE: boolean = this.openMarkdownPreviewUseMPE;
        let isEnabled: boolean = false; // Flag: opened Markdown Preview (Markdown Enhance Preview)
        let listDisplayExtname: string[] = this.memoListDisplayExtname;
        // console.log("memodir = ", memodir)

        this.memoListChannel.clear();

        //
        // Markdown Preview Enhanced のチェック
        //
        if (listMarkdownPreview) {
            try {
                vscode.extensions.getExtension('shd101wyy.markdown-preview-enhanced').id;
            } catch (err) {
                listMarkdownPreview = false;
            }
        }

        // listDisplayExtname が空の場合は、強制的に .md のみ対象にする
        if (listDisplayExtname.length == 0 ) {
            listDisplayExtname = ["md"];
        }

        const index_ = MemoIndex.getInstance();
        if (index_ && upath.normalizeTrim(index_.getMemodir()) === memodir) {
            // インデックスからファイル一覧を取得（readdir + statSync ゼロ回）
            let idx = 0;
            for (const [relativePath, meta] of index_.getEntries()) {
                const filename = index_.toAbsolutePath(relativePath);
                const birthtime = new Date(meta.birthtime);
                const mtime = new Date(meta.mtime);
                const statBirthtime = this.memoEditDispBtime ? dateFns.format(birthtime, 'MMM dd HH:mm, yyyy ') : "";
                const statMtime = this.memoEditDispBtime ? dateFns.format(mtime, 'MMM dd HH:mm, yyyy ') : "";

                items.push({
                    "label": `$(calendar) ` + relativePath,
                    "description": "",
                    "detail": this.memoEditDispBtime ? localize('editBirthTime', '$(heart) Create Time: {0} $(clock) Modified Time: {1} ', statBirthtime, statMtime) : "",
                    "ln": null,
                    "col": null,
                    "index": idx++,
                    "filename": filename,
                    "isDirectory": false,
                    "birthtime": birthtime,
                    "mtime": mtime
                });

                this.memoListChannel.appendLine('file://' + filename);
                this.memoListChannel.appendLine('');
            }
        } else {
            // フォールバック: インデックス未初期化時は従来方式
            try {
                list = readdirRecursively(memodir);
            } catch(err) {
                console.log('err =', err);
            }

            list = list.filter((v) => {
                    for (const value of listDisplayExtname){
                        if (upath.extname(v).match("." + value)) {
                            return v;
                        }
                    }
            }).map((v) => {
                return (v.split(upath.sep).splice(memodir.split(upath.sep).length, v.split(upath.sep).length).join(upath.sep));
            });

            for (let index = 0; index < list.length; index++) {
                if (list[index] == '') {
                    break;
                }

                let filename: string = upath.normalize(upath.join(memodir, list[index]));
                let fileStat: fs.Stats = fs.statSync(filename);
                let statBirthtime = this.memoEditDispBtime ? dateFns.format(fileStat.birthtime, 'MMM dd HH:mm, yyyy ') : "";
                let statMtime = this.memoEditDispBtime ? dateFns.format(fileStat.mtime, 'MMM dd HH:mm, yyyy ') : "";

                items.push({
                    "label": `$(calendar) ` + list[index],
                    "description": "",
                    "detail": this.memoEditDispBtime ? localize('editBirthTime', '$(heart) Create Time: {0} $(clock) Modified Time: {1} ', statBirthtime, statMtime) : "",
                    "ln": null,
                    "col": null,
                    "index": index,
                    "filename": upath.normalize(upath.join(memodir, list[index])),
                    "isDirectory": false,
                    "birthtime": fileStat.birthtime,
                    "mtime": fileStat.mtime
                });

                this.memoListChannel.appendLine('file://' + upath.normalize(upath.join(memodir, list[index])));
                this.memoListChannel.appendLine('');
            }
        }

        // "memobox.listSortOrder" で sort 対象の項目を指定
        // sort 結果は常に新しいものが上位にくる降順
        switch (this.memoListSortOrder) {
            case "filename":
                // console.log('filename');
                items = items.sort(function(a, b) {
                    return (a.filename < b.filename ? 1 : -1);
                });
                break;
            case "birthtime":
                // console.log('birthtime');
                items = items.sort(function(a, b) {
                    return (a.birthtime.getTime() < b.birthtime.getTime() ? 1 : -1);
                });
                break;
            case "mtime":
                // console.log('mtime');
                items = items.sort(function(a, b) {
                    return (a.mtime.getTime() < b.mtime.getTime() ? 1 : -1);
                });
                break;
        }

        // console.log("items =", items)

        vscode.window.showQuickPick<items>(items, {
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
            placeHolder: localize('enterSelectOrFilename', 'Please select or enter a filename...(All items: {0}) ...Today\'s: {1}', items.length, dateFns.format(new Date(), 'MMM dd HH:mm, yyyy ')),
            onDidSelectItem: async (selected:items) => {
                if (selected == undefined || selected == null) {
                    return void 0;
                }

                // console.log(selected.label);
                // console.log(isEnabled);

                if (listMarkdownPreview) {
                    if (isEnabled) {
                        vscode.commands.executeCommand('workbench.action.focusPreviousGroup').then(async () =>{
                            // Markdown-enhance
                            return vscode.commands.executeCommand('markdown-preview-enhanced.syncPreview');
                            // Original
                            // await vscode.commands.executeCommand('markdown.refreshPreview');
                        });
                        isEnabled = false;
                    }
                }

                if (listMarkdownPreview) {
                    // 選択時に markdown preview を開く場合。要 Markdown Preview Enhance 拡張機能
                    await vscode.workspace.openTextDocument(selected.filename).then(async document => {
                        await vscode.window.showTextDocument(document, {
                            viewColumn: 1,
                            preserveFocus: true,
                            preview: true
                        })
                    }).then(async() => {
                        await vscode.commands.executeCommand('markdown-preview-enhanced.openPreview').then(async () => {
                        // await vscode.commands.executeCommand('markdown.showPreviewToSide').then(async () => {
                            // markdown preview を open すると focus が移動するので、focus を quickopen に戻す作業 1 回目
                            vscode.commands.executeCommand('workbench.action.focusQuickOpen');
                        });
                        // さらにもう一度実行して focus を維持する (なんでだろ? bug?)
                        await vscode.commands.executeCommand('workbench.action.focusQuickOpen');
                    });
                    // もう一回! (bug?)
                    await vscode.commands.executeCommand('workbench.action.focusQuickOpen');
                    isEnabled = true;
                } else {
                    // 選択時に markdown preview を開かない設定の場合
                    await vscode.workspace.openTextDocument(selected.filename).then(async document =>{
                        vscode.window.showTextDocument(document, {
                            viewColumn: 1,
                            preserveFocus: true,
                            preview: true
                        })
                    })
                }
            }
        }).then(async function (selected) {   // When selected with the mouse
            if (selected == undefined || selected == null) {
                if (listMarkdownPreview) {
                    //キャンセルした時の close 処理
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor').then(() => {
                            vscode.commands.executeCommand('workbench.action.focusPreviousGroup').then(() => {
                                // vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                            });
                    });
                }
                // Markdown preview を閉じる
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                return void 0;
            }

            await vscode.workspace.openTextDocument(upath.normalize(selected.filename)).then(async document => {
                await vscode.window.showTextDocument(document, {
                        viewColumn: 1,
                        preserveFocus: true,
                        preview: true
                }).then(async editor => {
                    if (listMarkdownPreview) {
                        if (openMarkdownPreview) {
                            if (openMarkdownPreviewUseMPE) {
                                // vscode.window.showTextDocument(document, vscode.ViewColumn.One, false).then(editor => {
                                // Markdown-Enhance
                                // await vscode.commands.executeCommand('markdown.showPreviewToSide').then(() =>{
                                await vscode.commands.executeCommand('markdown-preview-enhanced.openPreview').then(() =>{
                                    vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
                                });
                            // });
                            } else {
                                // MPE preview を close してから built-in preview を開く
                                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                                await vscode.commands.executeCommand('markdown.showPreviewToSide').then(() => {
                                    vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
                                });
                            }
                        } else {
                            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                        }
                    } else if (openMarkdownPreview) {
                        if (openMarkdownPreviewUseMPE) {
                            await vscode.commands.executeCommand('markdown-preview-enhanced.openPreview').then(() =>{
                                vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
                            });
                        } else {
                            await vscode.commands.executeCommand('markdown.showPreviewToSide').then(() => {
                                vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
                            });
                        }
                    }
                });
            });
        });
    }
}

// memodir 配下のファイルとディレクトリ一覧を取得
// https://blog.araya.dev/posts/2019-05-09/node-recursive-readdir.html
const readdirRecursively = (dir, files = []) => {
    const dirents = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = [];
    for (const dirent of dirents) {
      if (dirent.isDirectory()) dirs.push(upath.normalize(upath.join(`${dir}`, `${dirent.name}`)));
      if (dirent.isFile()) files.push(upath.normalize(upath.join(`${dir}`, `${dirent.name}`)));
    }
    for (const d of dirs) {
      files = readdirRecursively(d, files);
    }
    return files;
};
  