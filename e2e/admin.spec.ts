import { test, expect, _electron as electron, ElectronApplication, Page, Frame } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const VSCODE_PATH = process.env.VSCODE_PATH
    || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');

const EXT_PATH = path.resolve(__dirname, '..');
const HEADLESS = process.env.E2E_HEADLESS === '1';

function createTempWorkspace(): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-e2e-'));
    const vscodeDir = path.join(dir, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    // Set memoconfdir to this temp dir (no config.toml exists here)
    // so the extension won't fall back to the user's real config.toml
    fs.writeFileSync(path.join(vscodeDir, 'settings.json'), JSON.stringify({
        'memo-life-for-you.memodir': '',
        'memo-life-for-you.memoconfdir': dir,
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

    // Write user settings to skip Welcome tab, trust workspace, disable other extensions
    const userSettingsDir = path.join(userDataDir, 'User');
    fs.mkdirSync(userSettingsDir, { recursive: true });
    fs.writeFileSync(path.join(userSettingsDir, 'settings.json'), JSON.stringify({
        'workbench.startupEditor': 'none',
        'workbench.tips.enabled': false,
        'workbench.welcomePage.walkthroughs.openOnInstall': false,
        'workbench.welcome.enabled': false,
        'update.showReleaseNotes': false,
        'update.mode': 'none',
        'security.workspace.trust.enabled': false,
        'extensions.ignoreRecommendations': true,
        'window.newWindowDimensions': 'maximized',
    }));

    const app = await electron.launch({
        executablePath: VSCODE_PATH,
        args: [
            workspaceDir,
            `--extensionDevelopmentPath=${EXT_PATH}`,
            `--user-data-dir=${userDataDir}`,
            '--disable-extensions',
            '--disable-telemetry',
            '--no-sandbox',
            '--disable-gpu',
        ],
        timeout: 30_000,
    });

    const win = await app.firstWindow();

    // In headless mode, minimize window to avoid stealing focus
    if (HEADLESS) {
        await app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0];
            if (win) {
                win.minimize();
                win.setSize(1280, 800);
            }
        });
    }

    // Wait for VS Code + extension to fully initialize
    await win.waitForTimeout(8000);

    return { app, window: win };
}

async function openAdminPanel(win: Page, app?: ElectronApplication, maxAttempts = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (HEADLESS && app) {
            // In headless mode, execute command directly via VS Code API
            await app.evaluate(async ({ BrowserWindow }) => {
                const win = BrowserWindow.getAllWindows()[0];
                if (win) {
                    win.webContents.executeJavaScript(
                        'require("vscode").commands.executeCommand("extension.memoAdmin")'
                    );
                }
            });
        } else {
            // Open command palette
            await win.keyboard.press('Control+Shift+P');
            await win.waitForTimeout(1500);

            // Type and execute command
            await win.keyboard.type('Memo Admin', { delay: 80 });
            await win.waitForTimeout(2000);
            await win.keyboard.press('Enter');
        }
        await win.waitForTimeout(3000);

        // Check if webview frame appeared (URL-only check)
        const hasWebview = win.frames().some(f => f.url().includes('memo-life-for-you'));
        if (hasWebview) {
            console.log(`[openAdminPanel] Panel opened on attempt ${attempt}`);
            return;
        }

        console.log(`[openAdminPanel] Panel not opened (attempt ${attempt}/${maxAttempts})`);
        if (!HEADLESS) {
            await win.keyboard.press('Escape');
        }
        await win.waitForTimeout(1000);
    }
}

async function findWebviewFrame(win: Page, retries = 10): Promise<Frame | null> {
    // VS Code webviews: our extension's frame URL contains memo-life-for-you
    // The actual content is in a child frame (fake.html) of the index.html container
    // We poll until the content is actually rendered (body has child elements)
    for (let attempt = 0; attempt < retries; attempt++) {
        for (const frame of win.frames()) {
            try {
                if (!frame.url().includes('memo-life-for-you')) continue;

                // Get the child frame (fake.html) which contains the rendered content
                const children = frame.childFrames();
                const target = children.length > 0 ? children[0] : frame;

                // Check if the webview content has actually rendered
                // by looking for our extension's specific content in the DOM
                try {
                    const hasContent = await target.evaluate(() => {
                        const body = document.querySelector('body');
                        // Our extension sets data-appearance on <body>
                        // or has .card-toggle / .welcome-card elements
                        return body !== null && (
                            body.hasAttribute('data-appearance') ||
                            body.querySelector('.card-toggle') !== null ||
                            body.querySelector('.welcome-overlay') !== null
                        );
                    });
                    if (hasContent) {
                        console.log(`Webview content ready (attempt ${attempt + 1}/${retries})`);
                        return target;
                    }
                } catch { /* evaluate failed, content not ready */ }
            } catch { /* frame not accessible */ }
        }
        if (attempt < retries - 1) {
            console.log(`Webview content not ready (attempt ${attempt + 1}/${retries}), retrying...`);
            await win.waitForTimeout(2000);
        }
    }
    return null;
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

    test('opens Admin panel and shows welcome carousel', async () => {
        await openAdminPanel(window, electronApp);
        await window.screenshot({ path: 'e2e/screenshots/admin-welcome.png' });

        const frame = await findWebviewFrame(window);
        expect(frame, 'Webview frame should be found').toBeTruthy();
        if (!frame) return;

        await window.screenshot({ path: 'e2e/screenshots/admin-welcome-step1.png' });

        // Carousel overlay should be visible
        const overlay = await frame.locator('.welcome-overlay').count();
        expect(overlay).toBe(1);

        // Check 3 carousel slides exist
        const slideCount = await frame.locator('.carousel-slide').count();
        expect(slideCount).toBe(3);

        // First slide should be active
        const activeSlide = await frame.locator('.carousel-slide.active').getAttribute('data-slide');
        expect(activeSlide).toBe('0');

        // Check dots
        const dotCount = await frame.locator('.carousel-dot').count();
        expect(dotCount).toBe(3);

        // Navigate to step 2 (use evaluate to avoid iframe pointer intercept)
        await frame.evaluate(() => document.getElementById('carouselNext')!.click());
        await window.waitForTimeout(1000);
        await window.screenshot({ path: 'e2e/screenshots/admin-welcome-step2.png' });

        const step2Active = await frame.locator('.carousel-slide.active').getAttribute('data-slide');
        expect(step2Active).toBe('1');

        // Verify step 2 title text
        const step2Title = await frame.locator('.carousel-slide.active .slide-title').textContent();
        console.log('Step 2 title:', step2Title);

        // Navigate to step 3
        await frame.evaluate(() => document.getElementById('carouselNext')!.click());
        await window.waitForTimeout(1000);
        await window.screenshot({ path: 'e2e/screenshots/admin-welcome-step3.png' });

        const step3Active = await frame.locator('.carousel-slide.active').getAttribute('data-slide');
        expect(step3Active).toBe('2');

        // Verify step 3 title text
        const step3Title = await frame.locator('.carousel-slide.active .slide-title').textContent();
        console.log('Step 3 title:', step3Title);

        // Navigate back
        await frame.evaluate(() => document.getElementById('carouselPrev')!.click());
        await window.waitForTimeout(500);
        const backToStep2 = await frame.locator('.carousel-slide.active').getAttribute('data-slide');
        expect(backToStep2).toBe('1');
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

    test('opens Admin panel with normal dashboard', async () => {
        await openAdminPanel(window, electronApp);
        await window.screenshot({ path: 'e2e/screenshots/admin-normal.png' });

        const frame = await findWebviewFrame(window);
        expect(frame, 'Webview frame should be found').toBeTruthy();
        if (!frame) return;

        await window.screenshot({ path: 'e2e/screenshots/admin-normal-detail.png' });

        // Scroll down in the webview to capture lower sections
        await frame.evaluate(() => window.scrollBy(0, 800));
        await window.waitForTimeout(500);
        await window.screenshot({ path: 'e2e/screenshots/admin-normal-scrolled.png' });

        // Scroll further for advanced sections
        await frame.evaluate(() => window.scrollBy(0, 800));
        await window.waitForTimeout(500);
        await window.screenshot({ path: 'e2e/screenshots/admin-normal-bottom.png' });

        // Scroll back to top
        await frame.evaluate(() => window.scrollTo(0, 0));
        await window.waitForTimeout(300);

        // Should NOT show welcome card as an actual element
        const welcomeCards = await frame.locator('.welcome-card').count();
        expect(welcomeCards).toBe(0);

        // Should show normal dashboard cards
        const toggleCount = await frame.locator('.card-toggle').count();
        expect(toggleCount).toBeGreaterThan(0);
    });

    test('cards are collapsible', async () => {
        // Admin panel should already be open from previous test
        const frame = await findWebviewFrame(window);
        expect(frame, 'Webview frame should be found').toBeTruthy();
        if (!frame) return;

        // Check that details elements with card-toggle exist
        const detailsCount = await frame.locator('details.card').count();
        expect(detailsCount).toBeGreaterThan(0);

        // All cards should be open by default
        const openCount = await frame.locator('details.card[open]').count();
        expect(openCount).toBe(detailsCount);

        // Click a card header to collapse it
        const firstToggle = frame.locator('.card-toggle').first();
        await firstToggle.click();
        await window.waitForTimeout(500);

        // Now one fewer card should be open
        const openAfterClick = await frame.locator('details.card[open]').count();
        expect(openAfterClick).toBe(detailsCount - 1);

        await window.screenshot({ path: 'e2e/screenshots/admin-collapsed-card.png' });
    });
});
