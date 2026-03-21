'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as upath from 'upath';
import * as matter from 'gray-matter';
import * as http from 'http';
import * as https from 'https';
import * as dateFns from 'date-fns';

// ── Shared LLM infrastructure ──────────────────────────────

type AiProvider = 'ollama' | 'openai';

interface AiConfig {
    provider: AiProvider;
    endpoint: string;
    model: string;
    apiKey: string;
    tagLanguage: string;
    proxy: string;
    proxyBypass: string;
    tlsRejectUnauthorized: boolean;
    tlsCaCert: string;
}

function getAiConfig(): AiConfig {
    const config = vscode.workspace.getConfiguration('memo-life-for-you');
    return {
        provider: config.get<AiProvider>('aiProvider', 'ollama'),
        endpoint: config.get<string>('aiEndpoint', 'http://localhost:11434'),
        model: config.get<string>('aiModel', 'qwen3:1.7b'),
        apiKey: config.get<string>('aiApiKey', ''),
        tagLanguage: config.get<string>('aiTagLanguage', 'ja'),
        proxy: config.get<string>('aiProxy', ''),
        proxyBypass: config.get<string>('aiProxyBypass', ''),
        tlsRejectUnauthorized: config.get<boolean>('aiTlsRejectUnauthorized', true),
        tlsCaCert: config.get<string>('aiTlsCaCert', ''),
    };
}

/** @internal exported for testing */
export function shouldBypassProxy(hostname: string, noProxy: string): boolean {
    if (!noProxy) { return false; }
    const entries = noProxy.split(',').map(s => s.trim().toLowerCase());
    const host = hostname.toLowerCase();
    return entries.some(entry => {
        if (entry === '*') { return true; }
        if (entry.startsWith('.')) { return host.endsWith(entry) || host === entry.slice(1); }
        return host === entry || host.endsWith('.' + entry);
    });
}

function httpRequest(url: string, options: http.RequestOptions, body: string, config?: AiConfig): Promise<string> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const useProxy = config?.proxy
            && !shouldBypassProxy(parsed.hostname, config.proxyBypass);

        if (useProxy) {
            const proxyUrl = new URL(config.proxy);
            // CONNECT-style proxy: send request to proxy host, set path to full URL
            options.hostname = proxyUrl.hostname;
            options.port = proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80);
            options.path = url;
            if (!options.headers) { options.headers = {}; }
            (options.headers as Record<string, string>)['Host'] = parsed.host;
        }

        // TLS options
        if (config) {
            const tlsOptions = options as https.RequestOptions;
            if (!config.tlsRejectUnauthorized) {
                tlsOptions.rejectUnauthorized = false;
            }
            if (config.tlsCaCert) {
                try { tlsOptions.ca = fs.readFileSync(config.tlsCaCert); } catch { /* ignore */ }
            }
        }

        const protocol = useProxy ? new URL(config.proxy).protocol : parsed.protocol;
        const transport = protocol === 'https:' ? https : http;
        const requestOptions: http.RequestOptions = useProxy
            ? options
            : { ...options, hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, protocol: parsed.protocol };
        const req = transport.request(requestOptions, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('error', reject);
        req.setTimeout(300000, () => {
            req.destroy(new Error('Request timed out'));
        });
        req.write(body);
        req.end();
    });
}

async function callLlm(config: AiConfig, prompt: string): Promise<string> {
    const base = config.endpoint.replace(/\/$/, '');
    const isOllama = config.provider === 'ollama';
    const url = isOllama
        ? `${base}/api/chat`
        : `${base}/chat/completions`;

    const body: Record<string, unknown> = {
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
    };

    if (isOllama) {
        body.think = false;
    } else {
        body.temperature = 0.3;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const response = await httpRequest(url, {
        method: 'POST',
        headers,
    }, JSON.stringify(body), config);

    const parsed = JSON.parse(response);
    return parsed.message?.content || parsed.choices?.[0]?.message?.content || '';
}

async function callWithProgress<T>(title: string, fn: () => Promise<T>): Promise<T | null> {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false,
    }, async () => {
        try {
            return await fn();
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Memo: AI request failed — ${message}`);
            return null;
        }
    });
}

function getActiveMarkdownEditor(): { editor: vscode.TextEditor; doc: vscode.TextDocument } | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Memo: No active editor');
        return null;
    }
    if (editor.document.languageId !== 'markdown') {
        vscode.window.showWarningMessage('Memo: This command is only available for Markdown files');
        return null;
    }
    return { editor, doc: editor.document };
}

function resolveLanguage(config: AiConfig): 'ja' | 'en' {
    if (config.tagLanguage === 'auto') {
        return vscode.env.language.startsWith('ja') ? 'ja' : 'en';
    }
    return config.tagLanguage === 'ja' ? 'ja' : 'en';
}

function isJa(config: AiConfig): boolean {
    return resolveLanguage(config) === 'ja';
}

// ── 1. Auto Tag ─────────────────────────────────────────────

/** @internal exported for testing */
export function buildTagPrompt(content: string, language: string, existingTags: string[]): string {
    const tagList = existingTags.length > 0 ? existingTags.join(', ') : '';
    const ja = language === 'ja';

    const lines = ja
        ? [
            'あなたはメモのタグ付けアシスタントです。',
            '以下のメモの内容を読んで、適切なタグを3〜7個生成してください。',
            '- タグは日本語で、短く簡潔に（1〜3語）',
        ]
        : [
            'You are a memo tagging assistant.',
            'Read the following memo and generate 3-7 appropriate tags.',
            '- Tags should be short and concise (1-3 words, lowercase)',
        ];

    if (tagList) {
        lines.push(
            ja ? `- 以下は過去に使われたタグ一覧です。内容に合うものがあれば優先的に再利用してください: [${tagList}]`
               : `- Here are previously used tags. Reuse them if they match the content: [${tagList}]`,
            ja ? '- 一覧にないタグでも、内容に合っていれば新規で追加して構いません'
               : '- You may create new tags if none of the existing ones fit',
        );
    }

    lines.push(
        ja ? '- JSON配列のみを返してください（例: ["タグ1", "タグ2", "タグ3"]）'
           : '- Return ONLY a JSON array (e.g. ["tag1", "tag2", "tag3"])',
        ja ? '- 説明や前置きは不要です' : '- No explanation or preamble',
        '', '---', content.slice(0, 3000), '---',
    );
    return lines.join('\n');
}

/** @internal exported for testing */
export function parseTags(raw: string): string[] {
    const jsonMatch = raw.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) { return []; }
    try {
        const arr = JSON.parse(jsonMatch[0]);
        if (Array.isArray(arr)) {
            return arr.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
        }
    } catch { /* ignore */ }
    return [];
}

export async function memoAutoTag(allTags?: string[]): Promise<void> {
    const ctx = getActiveMarkdownEditor();
    if (!ctx) { return; }

    const config = getAiConfig();
    const content = ctx.doc.getText();
    const prompt = buildTagPrompt(content, resolveLanguage(config), allTags || []);

    const result = await callWithProgress('Memo: Generating tags...', () => callLlm(config, prompt));
    if (!result) { return; }

    const tags = parseTags(result);
    if (tags.length === 0) {
        vscode.window.showWarningMessage('Memo: No tags could be generated');
        return;
    }

    const picked = await vscode.window.showQuickPick(
        tags.map(tag => ({ label: tag, picked: true })),
        { canPickMany: true, placeHolder: 'Select tags to apply', ignoreFocusOut: true }
    );
    if (!picked || picked.length === 0) { return; }

    const selectedTags = picked.map(p => p.label);
    const parsed = matter(content);
    const existingTags: string[] = Array.isArray(parsed.data.tags) ? parsed.data.tags : [];
    const merged = [...new Set([...existingTags, ...selectedTags])];

    parsed.data.tags = merged;
    const updated = matter.stringify(parsed.content, parsed.data);

    await ctx.editor.edit(editBuilder => {
        editBuilder.replace(new vscode.Range(ctx.doc.positionAt(0), ctx.doc.positionAt(content.length)), updated);
    });
    await ctx.doc.save();
    vscode.window.showInformationMessage(`Memo: Applied ${selectedTags.length} tags (total: ${merged.length})`);
}

// ── 2. Summarize ────────────────────────────────────────────

export async function memoSummarize(): Promise<void> {
    const ctx = getActiveMarkdownEditor();
    if (!ctx) { return; }

    const config = getAiConfig();
    const content = ctx.doc.getText();
    const ja = isJa(config);

    const prompt = [
        ja ? 'あなたはメモの要約アシスタントです。' : 'You are a memo summarization assistant.',
        ja ? '以下のメモを1〜2文で簡潔に要約してください。' : 'Summarize the following memo in 1-2 concise sentences.',
        ja ? '- 要約のテキストのみを返してください' : '- Return ONLY the summary text',
        ja ? '- 説明や前置きは不要です' : '- No explanation or preamble',
        '', '---', content.slice(0, 3000), '---',
    ].join('\n');

    const result = await callWithProgress(
        ja ? 'Memo: 要約を生成中...' : 'Memo: Generating summary...',
        () => callLlm(config, prompt)
    );
    if (!result) { return; }

    const summary = result.trim().replace(/^["']|["']$/g, '');

    const parsed = matter(content);
    parsed.data.description = summary;
    const updated = matter.stringify(parsed.content, parsed.data);

    await ctx.editor.edit(editBuilder => {
        editBuilder.replace(new vscode.Range(ctx.doc.positionAt(0), ctx.doc.positionAt(content.length)), updated);
    });
    await ctx.doc.save();
    vscode.window.showInformationMessage(`Memo: ${ja ? '要約を追加しました' : 'Summary added'}`);
}

// ── 3. Related Memos ────────────────────────────────────────

export async function memoRelated(memodir: string, listExtnames: string[]): Promise<void> {
    const ctx = getActiveMarkdownEditor();
    if (!ctx) { return; }
    if (!memodir || !fs.existsSync(memodir)) {
        vscode.window.showWarningMessage('Memo: memodir is not configured');
        return;
    }

    const config = getAiConfig();
    const ja = isJa(config);
    const currentContent = ctx.doc.getText().slice(0, 1500);

    const files = collectRecentFiles(memodir, listExtnames, 30);
    const currentPath = upath.normalize(ctx.doc.uri.fsPath);
    const candidates = files
        .filter(f => upath.normalize(f.path) !== currentPath)
        .slice(0, 20);

    if (candidates.length === 0) {
        vscode.window.showInformationMessage(ja ? 'Memo: 比較対象のメモがありません' : 'Memo: No other memos found');
        return;
    }

    const summaries = candidates.map((f, i) => {
        const firstLines = f.content.split('\n').slice(0, 5).join(' ').slice(0, 200);
        return `[${i}] ${upath.basename(f.path)}: ${firstLines}`;
    }).join('\n');

    const prompt = [
        ja ? 'あなたはメモの関連性判定アシスタントです。' : 'You are a memo relevance assistant.',
        ja ? '以下の「現在のメモ」に最も関連する過去メモの番号を、関連度の高い順に最大5件選んでください。'
           : 'Select up to 5 most relevant past memos to the "current memo", ordered by relevance.',
        ja ? '- JSON配列で番号のみ返してください（例: [3, 7, 1]）' : '- Return ONLY a JSON array of indices (e.g. [3, 7, 1])',
        ja ? '- 説明は不要です' : '- No explanation',
        '',
        ja ? '## 現在のメモ' : '## Current memo',
        currentContent,
        '',
        ja ? '## 過去のメモ一覧' : '## Past memos',
        summaries,
    ].join('\n');

    const result = await callWithProgress(
        ja ? 'Memo: 関連メモを検索中...' : 'Memo: Finding related memos...',
        () => callLlm(config, prompt)
    );
    if (!result) { return; }

    const indices = parseTags(result).map(Number).filter(n => !isNaN(n) && n >= 0 && n < candidates.length);
    if (indices.length === 0) {
        vscode.window.showInformationMessage(ja ? 'Memo: 関連メモが見つかりませんでした' : 'Memo: No related memos found');
        return;
    }

    const items = indices.map(i => ({
        label: upath.basename(candidates[i].path),
        description: candidates[i].path,
        absolutePath: candidates[i].path,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: ja ? '関連メモを選択して開く' : 'Select a related memo to open',
        ignoreFocusOut: true,
    });

    if (picked && fs.existsSync(picked.absolutePath)) {
        const doc = await vscode.workspace.openTextDocument(picked.absolutePath);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    }
}

/** @internal exported for testing */
export function collectRecentFiles(memodir: string, extnames: string[], maxFiles: number): Array<{ path: string; content: string; mtime: number }> {
    const results: Array<{ path: string; content: string; mtime: number }> = [];

    function walk(dir: string) {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
            if (ent.name.startsWith('.')) { continue; }
            const full = upath.join(dir, ent.name);
            if (ent.isDirectory()) {
                walk(full);
            } else if (extnames.some(ext => ent.name.endsWith(ext))) {
                try {
                    const stat = fs.statSync(full);
                    results.push({ path: full, content: '', mtime: stat.mtimeMs });
                } catch { /* skip */ }
            }
        }
    }

    walk(memodir);
    results.sort((a, b) => b.mtime - a.mtime);
    const top = results.slice(0, maxFiles);

    for (const f of top) {
        try { f.content = fs.readFileSync(f.path, 'utf8'); } catch { f.content = ''; }
    }
    return top;
}

// ── 4. Extract Todos ────────────────────────────────────────

export async function memoExtractTodos(): Promise<void> {
    const ctx = getActiveMarkdownEditor();
    if (!ctx) { return; }

    const config = getAiConfig();
    const content = ctx.doc.getText();
    const ja = isJa(config);

    const prompt = [
        ja ? 'あなたはメモからアクションアイテムを抽出するアシスタントです。' : 'You are an action item extraction assistant.',
        ja ? '以下のメモからやるべきこと・タスク・アクションアイテムを抽出してください。'
           : 'Extract action items, tasks, and todos from the following memo.',
        ja ? '- Markdownチェックリスト形式で返してください（例: - [ ] タスク内容）'
           : '- Return in Markdown checklist format (e.g. - [ ] task description)',
        ja ? '- タスクが見つからない場合は「なし」と返してください' : '- If no tasks found, return "None"',
        ja ? '- 前置きや説明は不要です' : '- No preamble or explanation',
        '', '---', content.slice(0, 3000), '---',
    ].join('\n');

    const result = await callWithProgress(
        ja ? 'Memo: Todoを抽出中...' : 'Memo: Extracting todos...',
        () => callLlm(config, prompt)
    );
    if (!result) { return; }

    const trimmed = result.trim();
    if (trimmed === 'なし' || trimmed.toLowerCase() === 'none') {
        vscode.window.showInformationMessage(ja ? 'Memo: タスクは見つかりませんでした' : 'Memo: No tasks found');
        return;
    }

    const action = await vscode.window.showQuickPick(
        [
            { label: ja ? 'カーソル位置に挿入' : 'Insert at cursor', value: 'insert' },
            { label: ja ? '新規メモとして作成' : 'Create as new memo', value: 'new' },
            { label: ja ? 'クリップボードにコピー' : 'Copy to clipboard', value: 'copy' },
        ],
        { placeHolder: ja ? 'Todoの出力先を選択' : 'Choose output destination', ignoreFocusOut: true }
    );
    if (!action) { return; }

    if (action.value === 'insert') {
        await ctx.editor.edit(editBuilder => {
            editBuilder.insert(ctx.editor.selection.active, '\n' + trimmed + '\n');
        });
    } else if (action.value === 'new') {
        const doc = await vscode.workspace.openTextDocument({ content: `# Todos\n\n${trimmed}\n`, language: 'markdown' });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
    } else {
        await vscode.env.clipboard.writeText(trimmed);
        vscode.window.showInformationMessage(ja ? 'Memo: クリップボードにコピーしました' : 'Memo: Copied to clipboard');
    }
}

// ── 5. Daily/Weekly Report ──────────────────────────────────

export async function memoReport(memodir: string, listExtnames: string[]): Promise<void> {
    if (!memodir || !fs.existsSync(memodir)) {
        vscode.window.showWarningMessage('Memo: memodir is not configured');
        return;
    }

    const config = getAiConfig();
    const ja = isJa(config);

    const range = await vscode.window.showQuickPick(
        [
            { label: ja ? '今日' : 'Today', value: 'today' },
            { label: ja ? '直近3日' : 'Last 3 days', value: '3days' },
            { label: ja ? '今週' : 'This week', value: 'week' },
            { label: ja ? '直近7日' : 'Last 7 days', value: '7days' },
        ],
        { placeHolder: ja ? 'レポート期間を選択' : 'Select report period', ignoreFocusOut: true }
    );
    if (!range) { return; }

    const now = new Date();
    let since: Date;
    switch (range.value) {
        case 'today': since = dateFns.startOfDay(now); break;
        case '3days': since = dateFns.subDays(dateFns.startOfDay(now), 2); break;
        case 'week': since = dateFns.startOfWeek(now, { weekStartsOn: 1 }); break;
        case '7days': since = dateFns.subDays(dateFns.startOfDay(now), 6); break;
        default: since = dateFns.startOfDay(now);
    }

    const files = collectRecentFiles(memodir, listExtnames, 100);
    const inRange = files.filter(f => f.mtime >= since.getTime());

    if (inRange.length === 0) {
        vscode.window.showInformationMessage(ja ? 'Memo: 該当期間のメモがありません' : 'Memo: No memos found in the selected period');
        return;
    }

    const memoSummaries = inRange.slice(0, 30).map(f => {
        const name = upath.basename(f.path);
        const body = f.content.slice(0, 500);
        return `## ${name}\n${body}`;
    }).join('\n\n');

    const periodLabel = ja
        ? `${dateFns.format(since, 'yyyy/MM/dd')}〜${dateFns.format(now, 'yyyy/MM/dd')}`
        : `${dateFns.format(since, 'yyyy/MM/dd')} - ${dateFns.format(now, 'yyyy/MM/dd')}`;

    const prompt = [
        ja ? 'あなたは日報・週報作成アシスタントです。' : 'You are a report generation assistant.',
        ja ? `以下は${periodLabel}のメモ一覧（${inRange.length}件）です。これらを元にレポートを作成してください。`
           : `Below are ${inRange.length} memos from ${periodLabel}. Generate a report based on them.`,
        ja ? '- Markdown形式で、セクション分けして要点をまとめてください' : '- Use Markdown format with sections summarizing key points',
        ja ? '- 完了したこと、進行中のこと、課題があれば分けてください' : '- Separate into: completed, in progress, and issues if applicable',
        ja ? '- 簡潔にまとめてください' : '- Keep it concise',
        '', '---', memoSummaries.slice(0, 6000), '---',
    ].join('\n');

    const result = await callWithProgress(
        ja ? 'Memo: レポートを生成中...' : 'Memo: Generating report...',
        () => callLlm(config, prompt)
    );
    if (!result) { return; }

    const reportTitle = ja ? `# レポート ${periodLabel}` : `# Report ${periodLabel}`;
    const doc = await vscode.workspace.openTextDocument({
        content: `${reportTitle}\n\n${result.trim()}\n`,
        language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });
}

// ── 6. Proofread ────────────────────────────────────────────

export async function memoProofread(): Promise<void> {
    const ctx = getActiveMarkdownEditor();
    if (!ctx) { return; }

    const config = getAiConfig();
    const ja = isJa(config);

    let target: string;
    const selection = ctx.editor.selection;
    if (!selection.isEmpty) {
        target = ctx.doc.getText(selection);
    } else {
        target = ctx.doc.getText();
    }

    const prompt = [
        ja ? 'あなたは文章校正アシスタントです。' : 'You are a proofreading assistant.',
        ja ? '以下のMarkdownテキストで明らかな問題（誤字脱字、文法ミス、不自然な表現）を最大5件だけ指摘してください。'
           : 'Find up to 5 clear issues (typos, grammar, awkward expressions) in the following Markdown text.',
        ja ? '- 各指摘は「問題箇所の引用 → 修正案」の形式で簡潔に' : '- Format: "quoted problem → suggestion", keep it brief',
        ja ? '- 問題がなければ「問題なし」と返してください' : '- If no issues, return "No issues found"',
        ja ? '- 細かいスタイルの好みは無視してください' : '- Ignore minor style preferences',
        '', '---', target.slice(0, 2000), '---',
    ].join('\n');

    const result = await callWithProgress(
        ja ? 'Memo: 文章を校正中...' : 'Memo: Proofreading...',
        () => callLlm(config, prompt)
    );
    if (!result) { return; }

    const doc = await vscode.workspace.openTextDocument({
        content: `# ${ja ? '校正結果' : 'Proofread Results'}\n\n${result.trim()}\n`,
        language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}

// ── 7. Suggest Template ──────────────────────────────────────

export async function memoSuggestTemplate(templatesDir: string): Promise<void> {
    const ctx = getActiveMarkdownEditor();
    if (!ctx) { return; }

    if (!templatesDir || !fs.existsSync(templatesDir)) {
        vscode.window.showWarningMessage('Memo: Templates directory not found');
        return;
    }

    let templateFiles: string[];
    try {
        templateFiles = fs.readdirSync(templatesDir)
            .filter(f => f.endsWith('.md') || f.endsWith('.txt'));
    } catch { templateFiles = []; }

    if (templateFiles.length === 0) {
        vscode.window.showInformationMessage('Memo: No templates available');
        return;
    }

    const config = getAiConfig();
    const ja = isJa(config);
    const content = ctx.doc.getText();

    const templateSummaries = templateFiles.map((name, i) => {
        const fullPath = upath.join(templatesDir, name);
        try {
            const body = fs.readFileSync(fullPath, 'utf8').slice(0, 300);
            return `[${i}] ${name}: ${body.split('\n').slice(0, 3).join(' ')}`;
        } catch { return `[${i}] ${name}`; }
    }).join('\n');

    const prompt = [
        ja ? 'あなたはメモのテンプレート選択アシスタントです。' : 'You are a template suggestion assistant.',
        ja ? '以下のメモの内容に最も適したテンプレートを1つ選んでください。'
           : 'Select the most appropriate template for the memo content below.',
        ja ? '- テンプレートの番号のみを返してください（例: 2）' : '- Return ONLY the template index number (e.g. 2)',
        ja ? '- 該当するものがなければ -1 を返してください' : '- Return -1 if none are suitable',
        '',
        ja ? '## メモの内容' : '## Memo content',
        content.slice(0, 1500),
        '',
        ja ? '## テンプレート一覧' : '## Available templates',
        templateSummaries,
    ].join('\n');

    const result = await callWithProgress(
        ja ? 'Memo: テンプレートを提案中...' : 'Memo: Suggesting template...',
        () => callLlm(config, prompt)
    );
    if (!result) { return; }

    const idx = parseInt(result.trim().replace(/[^-\d]/g, ''), 10);
    if (isNaN(idx) || idx < 0 || idx >= templateFiles.length) {
        vscode.window.showInformationMessage(ja ? 'Memo: 適切なテンプレートが見つかりませんでした' : 'Memo: No suitable template found');
        return;
    }

    const suggestedName = templateFiles[idx];
    const suggestedPath = upath.join(templatesDir, suggestedName);

    const apply = await vscode.window.showQuickPick(
        [
            { label: `$(check) ${suggestedName}`, description: ja ? '適用する' : 'Apply', value: 'apply' },
            { label: ja ? '他のテンプレートを選ぶ' : 'Choose another', value: 'pick' },
            { label: ja ? 'キャンセル' : 'Cancel', value: 'cancel' },
        ],
        { placeHolder: ja ? `提案: ${suggestedName}` : `Suggested: ${suggestedName}`, ignoreFocusOut: true }
    );
    if (!apply || apply.value === 'cancel') { return; }

    let targetPath = suggestedPath;
    if (apply.value === 'pick') {
        const picked = await vscode.window.showQuickPick(
            templateFiles.map(f => ({ label: f })),
            { placeHolder: ja ? 'テンプレートを選択' : 'Select a template', ignoreFocusOut: true }
        );
        if (!picked) { return; }
        targetPath = upath.join(templatesDir, picked.label);
    }

    try {
        const tplContent = fs.readFileSync(targetPath, 'utf8');
        await ctx.editor.edit(editBuilder => {
            editBuilder.replace(
                new vscode.Range(ctx.doc.positionAt(0), ctx.doc.positionAt(content.length)),
                tplContent
            );
        });
        vscode.window.showInformationMessage(`Memo: ${ja ? 'テンプレートを適用しました' : 'Template applied'} — ${upath.basename(targetPath)}`);
    } catch {
        vscode.window.showErrorMessage(ja ? 'Memo: テンプレートの読み込みに失敗しました' : 'Memo: Failed to read template');
    }
}

// ── 8. Generate Title ────────────────────────────────────────

export async function memoGenerateTitle(): Promise<void> {
    const ctx = getActiveMarkdownEditor();
    if (!ctx) { return; }

    const config = getAiConfig();
    const ja = isJa(config);
    const content = ctx.doc.getText();

    const prompt = [
        ja ? 'あなたはメモのタイトル生成アシスタントです。' : 'You are a memo title generation assistant.',
        ja ? '以下のメモの内容を読んで、適切なタイトル候補を3つ生成してください。'
           : 'Read the following memo and generate 3 title candidates.',
        ja ? '- JSON配列で返してください（例: ["タイトル1", "タイトル2", "タイトル3"]）'
           : '- Return ONLY a JSON array (e.g. ["Title 1", "Title 2", "Title 3"])',
        ja ? '- 簡潔で内容を反映したタイトルにしてください' : '- Make titles concise and reflective of the content',
        ja ? '- 説明は不要です' : '- No explanation',
        '', '---', content.slice(0, 3000), '---',
    ].join('\n');

    const result = await callWithProgress(
        ja ? 'Memo: タイトルを生成中...' : 'Memo: Generating titles...',
        () => callLlm(config, prompt)
    );
    if (!result) { return; }

    const titles = parseTags(result);
    if (titles.length === 0) {
        vscode.window.showWarningMessage(ja ? 'Memo: タイトルを生成できませんでした' : 'Memo: Could not generate titles');
        return;
    }

    const picked = await vscode.window.showQuickPick(
        titles.map(t => ({ label: t })),
        { placeHolder: ja ? 'タイトルを選択' : 'Select a title', ignoreFocusOut: true }
    );
    if (!picked) { return; }

    const parsed = matter(content);
    const body = parsed.content;
    const lines = body.split('\n');

    // Replace existing H1 or insert at top of body
    const h1Index = lines.findIndex(l => /^#\s/.test(l));
    if (h1Index >= 0) {
        lines[h1Index] = `# ${picked.label}`;
    } else {
        lines.unshift(`# ${picked.label}`, '');
    }

    const updated = matter.stringify(lines.join('\n'), parsed.data);
    await ctx.editor.edit(editBuilder => {
        editBuilder.replace(new vscode.Range(ctx.doc.positionAt(0), ctx.doc.positionAt(content.length)), updated);
    });
    await ctx.doc.save();
    vscode.window.showInformationMessage(`Memo: ${ja ? 'タイトルを設定しました' : 'Title set'} — ${picked.label}`);
}

// ── 9. Translate ─────────────────────────────────────────────

export async function memoTranslate(): Promise<void> {
    const ctx = getActiveMarkdownEditor();
    if (!ctx) { return; }

    const config = getAiConfig();
    const ja = isJa(config);

    const langPick = await vscode.window.showQuickPick(
        [
            { label: ja ? '自動判別 → 日本語' : 'Auto-detect → Japanese', value: 'auto2ja' },
            { label: ja ? '自動判別 → 英語' : 'Auto-detect → English', value: 'auto2en' },
            { label: ja ? '日本語 → 英語' : 'Japanese → English', value: 'ja2en' },
            { label: ja ? '英語 → 日本語' : 'English → Japanese', value: 'en2ja' },
        ],
        { placeHolder: ja ? '翻訳方向を選択' : 'Select translation direction', ignoreFocusOut: true }
    );
    if (!langPick) { return; }

    const selection = ctx.editor.selection;
    const target = !selection.isEmpty ? ctx.doc.getText(selection) : ctx.doc.getText();

    let srcLang: string;
    let dstLang: string;
    switch (langPick.value) {
        case 'ja2en': srcLang = 'Japanese'; dstLang = 'English'; break;
        case 'en2ja': srcLang = 'English'; dstLang = 'Japanese'; break;
        case 'auto2en': srcLang = 'auto-detected language'; dstLang = 'English'; break;
        default:        srcLang = 'auto-detected language'; dstLang = 'Japanese'; break;
    }

    const autoDetect = langPick.value === 'auto2ja' || langPick.value === 'auto2en';
    const prompt = [
        autoDetect
            ? `You are a professional translator. Detect the source language of the following text and translate it into ${dstLang}.`
            : `You are a professional translator from ${srcLang} to ${dstLang}.`,
        'Translate the following Markdown text while preserving all Markdown formatting (headings, links, lists, code blocks, frontmatter).',
        '- Return ONLY the translated text',
        '- Do not add explanations or notes',
        '- Keep proper nouns and technical terms as-is when appropriate',
        autoDetect ? `- If the text is already in ${dstLang}, return it unchanged` : '',
        '', '---', target.slice(0, 5000), '---',
    ].filter(Boolean).join('\n');

    const result = await callWithProgress(
        ja ? 'Memo: 翻訳中...' : 'Memo: Translating...',
        () => callLlm(config, prompt)
    );
    if (!result) { return; }

    if (!selection.isEmpty) {
        // Selection: replace in-place
        await ctx.editor.edit(editBuilder => {
            editBuilder.replace(selection, result.trim());
        });
    } else {
        // Whole file: open as new document beside
        const doc = await vscode.workspace.openTextDocument({
            content: result.trim() + '\n',
            language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    }
    vscode.window.showInformationMessage(`Memo: ${ja ? '翻訳完了' : 'Translation complete'} (${srcLang} → ${dstLang})`);
}

// ── 10. Link Suggest ─────────────────────────────────────────

export async function memoLinkSuggest(memodir: string, listExtnames: string[]): Promise<void> {
    const ctx = getActiveMarkdownEditor();
    if (!ctx) { return; }
    if (!memodir || !fs.existsSync(memodir)) {
        vscode.window.showWarningMessage('Memo: memodir is not configured');
        return;
    }

    const config = getAiConfig();
    const ja = isJa(config);
    const content = ctx.doc.getText();

    const files = collectRecentFiles(memodir, listExtnames, 50);
    const currentPath = upath.normalize(ctx.doc.uri.fsPath);
    const candidates = files.filter(f => upath.normalize(f.path) !== currentPath);

    if (candidates.length === 0) {
        vscode.window.showInformationMessage(ja ? 'Memo: リンク候補のメモがありません' : 'Memo: No memos available for linking');
        return;
    }

    const fileList = candidates.slice(0, 30).map((f, i) => {
        const name = upath.basename(f.path, upath.extname(f.path));
        const firstLine = f.content.split('\n').find(l => l.trim() && !l.startsWith('---'))?.slice(0, 100) || '';
        return `[${i}] ${name}: ${firstLine}`;
    }).join('\n');

    const prompt = [
        ja ? 'あなたはメモ間リンク提案アシスタントです。' : 'You are a memo link suggestion assistant.',
        ja ? '以下の「現在のメモ」の本文中にあるキーワードやトピックに関連する過去メモを選び、リンクを提案してください。'
           : 'Find keywords or topics in the current memo that relate to past memos, and suggest links.',
        ja ? '- 各提案は JSON 配列で返してください: [{"keyword": "本文中の語句", "memo_index": 番号, "reason": "理由"}]'
           : '- Return a JSON array: [{"keyword": "phrase in text", "memo_index": number, "reason": "brief reason"}]',
        ja ? '- 最大5件まで' : '- Maximum 5 suggestions',
        ja ? '- 関連性が低い場合は空配列 [] を返してください' : '- Return [] if no good matches',
        '',
        ja ? '## 現在のメモ' : '## Current memo',
        content.slice(0, 2000),
        '',
        ja ? '## 過去のメモ一覧' : '## Past memos',
        fileList,
    ].join('\n');

    const result = await callWithProgress(
        ja ? 'Memo: リンク候補を検索中...' : 'Memo: Suggesting links...',
        () => callLlm(config, prompt)
    );
    if (!result) { return; }

    let suggestions: Array<{ keyword: string; memo_index: number; reason: string }> = [];
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
        try { suggestions = JSON.parse(jsonMatch[0]); } catch { /* ignore */ }
    }

    if (!Array.isArray(suggestions) || suggestions.length === 0) {
        vscode.window.showInformationMessage(ja ? 'Memo: リンク候補が見つかりませんでした' : 'Memo: No link suggestions found');
        return;
    }

    const validSuggestions = suggestions.filter(
        s => s.keyword && typeof s.memo_index === 'number' && s.memo_index >= 0 && s.memo_index < candidates.length
    );

    const items = validSuggestions.map(s => {
        const target = candidates[s.memo_index];
        const targetName = upath.basename(target.path, upath.extname(target.path));
        return {
            label: `"${s.keyword}" → ${targetName}`,
            description: s.reason || '',
            picked: true,
            keyword: s.keyword,
            targetName,
            targetPath: target.path,
        };
    });

    const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: ja ? '挿入するリンクを選択' : 'Select links to insert',
        ignoreFocusOut: true,
    });
    if (!picked || picked.length === 0) { return; }

    // Build links section
    const links = picked.map(p => `- [${p.keyword}](${upath.relative(upath.dirname(ctx.doc.uri.fsPath), p.targetPath)})`);
    const section = `\n\n## ${ja ? '関連リンク' : 'Related Links'}\n\n${links.join('\n')}\n`;

    await ctx.editor.edit(editBuilder => {
        editBuilder.insert(ctx.doc.positionAt(ctx.doc.getText().length), section);
    });
    await ctx.doc.save();
    vscode.window.showInformationMessage(`Memo: ${picked.length} ${ja ? '件のリンクを追加しました' : 'links added'}`);
}

// ── 11. Q&A ──────────────────────────────────────────────────

export async function memoQA(): Promise<void> {
    const ctx = getActiveMarkdownEditor();
    if (!ctx) { return; }

    const config = getAiConfig();
    const ja = isJa(config);
    const content = ctx.doc.getText();

    const question = await vscode.window.showInputBox({
        prompt: ja ? 'このメモについて質問してください' : 'Ask a question about this memo',
        placeHolder: ja ? '例: このメモの要点は？' : 'e.g. What are the key points?',
        ignoreFocusOut: true,
    });
    if (!question) { return; }

    const prompt = [
        ja ? 'あなたはメモの内容に基づいて質問に回答するアシスタントです。' : 'You are an assistant that answers questions based on memo content.',
        ja ? '以下のメモの内容のみに基づいて、ユーザーの質問に回答してください。' : 'Answer the user question based ONLY on the memo content below.',
        ja ? '- メモに書かれていない情報は推測しないでください' : '- Do not speculate beyond what is written',
        ja ? '- 簡潔に回答してください' : '- Be concise',
        '',
        ja ? '## メモ' : '## Memo',
        content.slice(0, 3000),
        '',
        ja ? '## 質問' : '## Question',
        question,
    ].join('\n');

    const result = await callWithProgress(
        ja ? 'Memo: 回答を生成中...' : 'Memo: Generating answer...',
        () => callLlm(config, prompt)
    );
    if (!result) { return; }

    const outputDoc = await vscode.workspace.openTextDocument({
        content: `# Q&A\n\n**Q:** ${question}\n\n**A:** ${result.trim()}\n`,
        language: 'markdown',
    });
    await vscode.window.showTextDocument(outputDoc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}
