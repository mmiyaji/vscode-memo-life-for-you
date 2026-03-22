'use strict';

import * as vscode from 'vscode';
import { memoConfigure } from './memoConfigure';

export class memoConfig extends memoConfigure {

    constructor() {
        super();
    }

    /**
     * Config — opens VS Code settings filtered to memobox
     */
    public Config() {
        vscode.commands.executeCommand('workbench.action.openSettings', 'memobox');
    }
}
