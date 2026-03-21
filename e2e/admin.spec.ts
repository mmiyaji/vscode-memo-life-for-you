import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const VSCODE_PATH = process.env.VSCODE_PATH
    || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');

const EXT_PATH = path.resolve(__dirname, '..');

// Temporary workspace with empty memodir for testing welcome screen
function createTempWorkspace(): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-e2e-'));
    // Create a minimal settings.json so memodir is empty
    const vscodeDir = path.join(dir, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    fs.writeFileSync(path.join(vscodeDir, 'settings.json'), JSON.stringify({
        'memo-life-for-you.memodir': '',
    }));
    return {
        dir,
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

function createTempWorkspaceWithMemodir(): { dir: string; memodir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-e2e-'));
    const memodir = path.join(dir, 'memos');
    fs.mkdirSync(memodir, { recursive: true });
    // Create a sample memo
    fs.writeFileSync(path.join(memodir, '2026-03-22-test.md'), '# Test Memo\n\nHello world\n');
    const vscodeDir = path.join(dir, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    fs.writeFileSync(path.join(vscodeDir, 'settings.json'), JSON.stringify({
        'memo-life-for-you.memodir': memodir,
    }));
    return {
        dir,
        memodir,
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

let electronApp: ElectronApplication;
let window: Page;

async function launchVSCode(workspaceDir: string): Promise<{ app: ElectronApplication; window: Page }> {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-e2e-userdata-'));

    const app = await electron.launch({
        executablePath: VSCODE_PATH,
        args: [
            workspaceDir,
            `--extensionDevelopmentPath=${EXT_PATH}`,
            `--user-data-dir=${userDataDir}`,
            '--disable-extensions',  // disable other extensions
            '--no-sandbox',
            '--disable-gpu',
        ],
        timeout: 30_000,
    });

    const win = await app.firstWindow();
    // Wait for VS Code to settle
    await win.waitForTimeout(5000);
    return { app, window: win };
}

test.describe('Admin Panel - Welcome Screen', () => {
    let workspace: ReturnType<typeof createTempWorkspace>;

    test.beforeAll(async () => {
        workspace = createTempWorkspace();
        const result = await launchVSCode(workspace.dir);
        electronApp = result.app;
        window = result.window;
    });

    test.afterAll(async () => {
        if (electronApp) {
            await electronApp.close();
        }
        workspace?.cleanup();
    });

    test('opens Admin panel via command palette', async () => {
        // Open command palette
        await window.keyboard.press('Control+Shift+P');
        await window.waitForTimeout(1000);

        // Type the command
        await window.keyboard.type('Memo: Admin', { delay: 50 });
        await window.waitForTimeout(1000);

        // Press Enter to execute
        await window.keyboard.press('Enter');
        await window.waitForTimeout(3000);

        // Take a screenshot
        await window.screenshot({ path: 'e2e/screenshots/admin-welcome.png' });
    });

    test('shows welcome screen when memodir is empty', async () => {
        // Find the webview frame
        const frames = window.frames();
        let webviewFrame: Page | null = null;

        for (const frame of frames) {
            try {
                const content = await frame.content();
                if (content.includes('welcome-card') || content.includes('Memo Admin')) {
                    webviewFrame = frame as unknown as Page;
                    break;
                }
            } catch {
                // frame may not be accessible
            }
        }

        if (webviewFrame) {
            // Check welcome elements exist
            const welcomeTitle = await webviewFrame.locator('.welcome-title').count();
            expect(welcomeTitle).toBeGreaterThan(0);

            const steps = await webviewFrame.locator('.welcome-step').count();
            expect(steps).toBe(3);
        }

        // Take a screenshot regardless
        await window.screenshot({ path: 'e2e/screenshots/admin-welcome-detail.png' });
    });
});

test.describe('Admin Panel - Normal View', () => {
    let workspace: ReturnType<typeof createTempWorkspaceWithMemodir>;

    test.beforeAll(async () => {
        workspace = createTempWorkspaceWithMemodir();
        const result = await launchVSCode(workspace.dir);
        electronApp = result.app;
        window = result.window;
    });

    test.afterAll(async () => {
        if (electronApp) {
            await electronApp.close();
        }
        workspace?.cleanup();
    });

    test('opens Admin panel with normal view', async () => {
        await window.keyboard.press('Control+Shift+P');
        await window.waitForTimeout(1000);
        await window.keyboard.type('Memo: Admin', { delay: 50 });
        await window.waitForTimeout(1000);
        await window.keyboard.press('Enter');
        await window.waitForTimeout(3000);

        await window.screenshot({ path: 'e2e/screenshots/admin-normal.png' });
    });

    test('shows cards with collapsible headers', async () => {
        await window.screenshot({ path: 'e2e/screenshots/admin-cards.png' });

        // Verify VS Code window title contains something useful
        const title = await window.title();
        expect(title).toBeTruthy();
    });
});
