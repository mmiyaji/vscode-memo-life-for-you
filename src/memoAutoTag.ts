'use strict';

import * as vscode from 'vscode';
import * as matter from 'gray-matter';
import * as http from 'http';
import * as https from 'https';

type AiProvider = 'ollama' | 'openai';

interface AiConfig {
    provider: AiProvider;
    endpoint: string;
    model: string;
    apiKey: string;
    tagLanguage: string;
}

function getAiConfig(): AiConfig {
    const config = vscode.workspace.getConfiguration('memo-life-for-you');
    return {
        provider: config.get<AiProvider>('aiProvider', 'ollama'),
        endpoint: config.get<string>('aiEndpoint', 'http://localhost:11434'),
        model: config.get<string>('aiModel', 'qwen3:1.7b'),
        apiKey: config.get<string>('aiApiKey', ''),
        tagLanguage: config.get<string>('aiTagLanguage', 'ja'),
    };
}

function buildPrompt(content: string, language: string, existingTags: string[]): string {
    const tagList = existingTags.length > 0
        ? existingTags.join(', ')
        : '';

    if (language === 'ja') {
        const lines = [
            'あなたはメモのタグ付けアシスタントです。',
            '以下のメモの内容を読んで、適切なタグを3〜7個生成してください。',
            '- タグは日本語で、短く簡潔に（1〜3語）',
        ];
        if (tagList) {
            lines.push(
                `- 以下は過去に使われたタグ一覧です。内容に合うものがあれば優先的に再利用してください: [${tagList}]`,
                '- 一覧にないタグでも、内容に合っていれば新規で追加して構いません',
            );
        }
        lines.push(
            '- JSON配列のみを返してください（例: ["タグ1", "タグ2", "タグ3"]）',
            '- 説明や前置きは不要です',
            '',
            '---',
            content.slice(0, 3000),
            '---',
        );
        return lines.join('\n');
    }

    const lines = [
        'You are a memo tagging assistant.',
        'Read the following memo and generate 3-7 appropriate tags.',
        '- Tags should be short and concise (1-3 words, lowercase)',
    ];
    if (tagList) {
        lines.push(
            `- Here are previously used tags. Reuse them if they match the content: [${tagList}]`,
            '- You may create new tags if none of the existing ones fit',
        );
    }
    lines.push(
        '- Return ONLY a JSON array (e.g. ["tag1", "tag2", "tag3"])',
        '- No explanation or preamble',
        '',
        '---',
        content.slice(0, 3000),
        '---',
    );
    return lines.join('\n');
}

function httpRequest(url: string, options: http.RequestOptions, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const transport = parsed.protocol === 'https:' ? https : http;
        const req = transport.request(parsed, options, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('error', reject);
        req.setTimeout(60000, () => {
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
    }, JSON.stringify(body));

    const parsed = JSON.parse(response);
    return parsed.message?.content || parsed.choices?.[0]?.message?.content || '';
}

function parseTags(raw: string): string[] {
    const jsonMatch = raw.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
        return [];
    }
    try {
        const arr = JSON.parse(jsonMatch[0]);
        if (Array.isArray(arr)) {
            return arr.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
        }
    } catch { /* ignore */ }
    return [];
}

export async function memoAutoTag(allTags?: string[]): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Memo: No active editor');
        return;
    }

    const doc = editor.document;
    if (doc.languageId !== 'markdown') {
        vscode.window.showWarningMessage('Memo: Auto Tag is only available for Markdown files');
        return;
    }

    const config = getAiConfig();
    const content = doc.getText();
    const prompt = buildPrompt(content, config.tagLanguage, allTags || []);

    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Memo: Generating tags...',
        cancellable: false,
    }, async () => {
        try {
            return await callLlm(config, prompt);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Memo: AI request failed — ${message}`);
            return null;
        }
    });

    if (!result) {
        return;
    }

    const tags = parseTags(result);
    if (tags.length === 0) {
        vscode.window.showWarningMessage('Memo: No tags could be generated from the response');
        return;
    }

    const picked = await vscode.window.showQuickPick(
        tags.map(tag => ({ label: tag, picked: true })),
        {
            canPickMany: true,
            placeHolder: 'Select tags to apply',
            ignoreFocusOut: true,
        }
    );

    if (!picked || picked.length === 0) {
        return;
    }

    const selectedTags = picked.map(p => p.label);
    const parsed = matter(content);
    const existingTags: string[] = Array.isArray(parsed.data.tags) ? parsed.data.tags : [];
    const merged = [...new Set([...existingTags, ...selectedTags])];

    parsed.data.tags = merged;
    const updated = matter.stringify(parsed.content, parsed.data);

    await editor.edit(editBuilder => {
        const fullRange = new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(content.length)
        );
        editBuilder.replace(fullRange, updated);
    });

    await doc.save();

    vscode.window.showInformationMessage(`Memo: Applied ${selectedTags.length} tags (total: ${merged.length})`);
}
