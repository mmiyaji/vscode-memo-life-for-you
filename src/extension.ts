'use strict';

import * as vscode from 'vscode';
import * as upath from 'upath';
import * as nls from 'vscode-nls';
import { memoConfigure } from './memoConfigure';
import { memoInit }from './memoInit';
import { memoNew } from './memoNew';
import { memoEdit } from './memoEdit';
import { memoGrep } from './memoGrep';
import { memoConfig } from './memoConfigEditor';
import { memoRedate } from './memoRedate';
import { memoTodo } from './memoTodo';
import { memoServe } from './memoServe';
import { memoOpenFolder } from './memoOpenFolder';
import { memoOpenChrome } from './memoOpenChrome';
import { memoOpenTypora } from './memoOpenTypora';
import { memoAdmin } from './memoAdmin';
// import { MemoTreeProvider } from './memoTreeProvider';

// import {MDDocumentContentProvider, isMarkdownFile, getMarkdownUri, showPreview} from './MDDocumentContentProvider'

// const localize = nls.config({ messageFormat: nls.MessageFormat.file })();

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "memo-life-for-you-admin" is now active!');
    // console.log(vscode.env);
    // console.log(path.normalize(path.join(vscode.env.appRoot, "node_modules", "vscode-ripgrep", "bin", "rg")));
    // console.log('vscode.Markdown =', vscode.extensions.getExtension("Microsoft.vscode-markdown").extensionPath);

    new memoInit();
    let memoedit = new memoEdit();
    let memogrep = new memoGrep();
    let memoadmin = new memoAdmin();

    // const treeViewProvider = new MemoTreeProvider(); // constructor に list2 を引数として渡すために、このような実装になっている.
    // console.log(treeViewProvider);
    // vscode.window.registerTreeDataProvider('satokaz', treeViewProvider);

    context.subscriptions.push(vscode.commands.registerCommand("extension.memoNew", () => new memoNew().New()));
    context.subscriptions.push(vscode.commands.registerCommand("extension.memoQuick", () => new memoNew().QuickNew()));
    context.subscriptions.push(vscode.commands.registerCommand("extension.memoEdit", () => memoedit.Edit()));
    context.subscriptions.push(vscode.commands.registerCommand("extension.memoGrep", () => memogrep.Grep()));
    context.subscriptions.push(vscode.commands.registerCommand("extension.memoConfig", () => new memoConfig().Config()));
    context.subscriptions.push(vscode.commands.registerCommand("extension.memoServe", () => new memoServe().Serve()));
    context.subscriptions.push(vscode.commands.registerCommand("extension.memoReDate", () => new memoRedate().reDate()));
    context.subscriptions.push(vscode.commands.registerCommand("extension.memoTodo", () => new memoTodo().TodoGrep()));
    context.subscriptions.push(vscode.commands.registerCommand("extension.memoOpenFolder", () => new memoOpenFolder().OpenDir()));
    context.subscriptions.push(vscode.commands.registerCommand("extension.memoOpenChrome", () => new memoOpenChrome().OpenChrome()));
    context.subscriptions.push(vscode.commands.registerCommand("extension.memoOpenTypora", () => new memoOpenTypora().OpenTypora()));
    context.subscriptions.push(vscode.commands.registerCommand("extension.memoAdmin", async () => {
        memoadmin.updateConfiguration();
        if (memoadmin.memoAdminOpenMode === 'newWindow') {
            if (context.extensionMode === vscode.ExtensionMode.Development) {
                vscode.window.showInformationMessage('Memo: Admin opens in the current window while debugging because a new window does not load the extension under development.');
                await memoadmin.Show(context);
                return;
            }
            await memoadmin.ShowInNewWindow(context);
            return;
        }
        await memoadmin.Show(context);
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(() => {
        new memoConfigure().updateConfiguration();
    }));

    void restorePendingMemoAdmin(context, memoadmin);
    void openMemoAdminOnStartup(context, memoadmin);

    // vscode.commands.registerCommand('favorites.refresh', () => treeViewProvider.refresh());

    
//Markdown
// 	let provider = new MDDocumentContentProvider(context);
//     let registration = vscode.workspace.registerTextDocumentContentProvider('markdown', provider);

//     context.subscriptions.push(vscode.commands.registerCommand('extension.MemoshowPreviewToSide', uri => showPreview(uri, true)));

//     vscode.workspace.onDidSaveTextDocument(document => {
// 		if (isMarkdownFile(document)) {
// 			const uri = getMarkdownUri(document.uri);
// 			provider.update(uri);
// }
//     });
//     vscode.workspace.onDidChangeTextDocument(event => {
// 		if (isMarkdownFile(event.document)) {
// 			const uri = getMarkdownUri(event.document.uri);
// 			provider.update(uri);

// 		}
// 	});

// 	vscode.workspace.onDidChangeConfiguration(() => {
// 		vscode.workspace.textDocuments.forEach(document => {
// 			if (document.uri.scheme === 'markdown') {
// 				// update all generated md documents
// 				provider.update(document.uri);
// 			}
// 		});
// 	});
// Markdown
}

export function deactivate() {
}

async function restorePendingMemoAdmin(context: vscode.ExtensionContext, memoadmin: memoAdmin): Promise<void> {
    const pending = context.globalState.get<{ memodir?: string }>(memoAdmin.pendingOpenKey);
    if (!pending?.memodir) {
        return;
    }

    const normalizePath = (pathValue: string): string => {
        const normalized = upath.normalizeTrim(pathValue);
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    };

    const tryOpen = async () => {
        const currentRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!currentRoot || normalizePath(currentRoot) !== normalizePath(pending.memodir)) {
            return false;
        }

        await context.globalState.update(memoAdmin.pendingOpenKey, undefined);
        await memoadmin.Show(context);
        return true;
    };

    if (await tryOpen()) {
        return;
    }

    const retryDelays = [300, 800, 1500, 2500];
    for (const delay of retryDelays) {
        setTimeout(() => {
            void tryOpen();
        }, delay);
    }

    const workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void tryOpen().then((opened) => {
            if (opened) {
                workspaceListener.dispose();
            }
        });
    });
}

async function openMemoAdminOnStartup(context: vscode.ExtensionContext, memoadmin: memoAdmin): Promise<void> {
    memoadmin.updateConfiguration();
    if (!memoadmin.memoAdminOpenOnStartup) {
        return;
    }

    setTimeout(() => {
        void memoadmin.Show(context);
    }, 400);
}
