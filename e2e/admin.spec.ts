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
    fs.writeFileSync(path.join(vscodeDir, 'settings.json'), JSON.stringify({
        'memobox.memodir': '',
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
    // Create multiple test files for richer testing
    fs.writeFileSync(path.join(memodir, '2026-03-22-test.md'), '# Test Memo\n\nHello world\n');
    fs.writeFileSync(path.join(memodir, '2026-03-21-second.md'), '# Second Memo\n\nAnother note\n');
    fs.writeFileSync(path.join(memodir, '2026-03-20-tagged.md'), '---\ntags: [test, demo]\n---\n# Tagged Memo\n\nWith tags\n');
    const vscodeDir = path.join(dir, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    fs.writeFileSync(path.join(vscodeDir, 'settings.json'), JSON.stringify({
        'memobox.memodir': memodir,
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
        const hasWebview = win.frames().some(f => f.url().includes('memobox'));
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
    // VS Code webviews: our extension's frame URL contains memobox
    // The actual content is in a child frame (fake.html) of the index.html container
    // We poll until the content is actually rendered (body has child elements)
    for (let attempt = 0; attempt < retries; attempt++) {
        for (const frame of win.frames()) {
            try {
                if (!frame.url().includes('memobox')) continue;

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

// ─── Welcome Screen tests ───────────────────────────────────────────

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

    test('setup input shows recommended path', async () => {
        const frame = await findWebviewFrame(window);
        expect(frame, 'Webview frame should be found').toBeTruthy();
        if (!frame) return;

        // Navigate back to step 1
        await frame.evaluate(() => document.getElementById('carouselPrev')!.click());
        await window.waitForTimeout(500);

        // The setup input should exist with a non-empty recommended path
        const setupInput = frame.locator('#setupMemoDirInput');
        const inputValue = await setupInput.inputValue();
        expect(inputValue.length).toBeGreaterThan(0);
        // Should contain 'memobox' as the default folder name
        expect(inputValue).toContain('memobox');

        // "Use this folder" button should exist
        const useBtn = frame.locator('#setupUseRecommended');
        expect(await useBtn.count()).toBe(1);

        // "Browse" button should exist in the setup row
        const browseBtn = frame.locator('.setup-path-row [data-command="pickMemoDir"]');
        expect(await browseBtn.count()).toBe(1);

        await window.screenshot({ path: 'e2e/screenshots/admin-welcome-setup-input.png' });
    });

    test('skip button dismisses overlay', async () => {
        const frame = await findWebviewFrame(window);
        expect(frame, 'Webview frame should be found').toBeTruthy();
        if (!frame) return;

        // Overlay should be visible before skip
        expect(await frame.locator('.welcome-overlay').count()).toBe(1);

        // Click skip
        await frame.evaluate(() => document.getElementById('carouselSkip')!.click());
        await window.waitForTimeout(1000);

        // Overlay should be removed
        const overlayAfter = await frame.locator('.welcome-overlay').count();
        expect(overlayAfter).toBe(0);

        await window.screenshot({ path: 'e2e/screenshots/admin-welcome-skipped.png' });
    });
});

// ─── Normal View tests ──────────────────────────────────────────────

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

        // Should NOT show welcome overlay
        const welcomeOverlay = await frame.locator('.welcome-overlay').count();
        expect(welcomeOverlay).toBe(0);

        // Should show normal dashboard cards
        const toggleCount = await frame.locator('.card-toggle').count();
        expect(toggleCount).toBeGreaterThan(0);
    });

    test('memo files are listed in recent files', async () => {
        const frame = await findWebviewFrame(window);
        expect(frame, 'Webview frame should be found').toBeTruthy();
        if (!frame) return;

        // Scroll to top
        await frame.evaluate(() => window.scrollTo(0, 0));
        await window.waitForTimeout(300);

        // Recent files section should contain our test memos
        const recentList = frame.locator('.recent-list');
        const recentCount = await recentList.count();
        expect(recentCount).toBeGreaterThan(0);

        // Check that at least one of our test files appears
        const recentHtml = await frame.evaluate(() => {
            const el = document.querySelector('.recent-list');
            return el ? el.innerHTML : '';
        });
        expect(recentHtml).toContain('test');

        await window.screenshot({ path: 'e2e/screenshots/admin-recent-files.png' });
    });

    test('cards are collapsible', async () => {
        const frame = await findWebviewFrame(window);
        expect(frame, 'Webview frame should be found').toBeTruthy();
        if (!frame) return;

        // Scroll to top
        await frame.evaluate(() => window.scrollTo(0, 0));
        await window.waitForTimeout(300);

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

        // Click again to re-open
        await firstToggle.click();
        await window.waitForTimeout(500);
        const openAfterReopen = await frame.locator('details.card[open]').count();
        expect(openAfterReopen).toBe(detailsCount);
    });

    test('pin and unpin a file', async () => {
        const frame = await findWebviewFrame(window);
        expect(frame, 'Webview frame should be found').toBeTruthy();
        if (!frame) return;

        // Scroll to top
        await frame.evaluate(() => window.scrollTo(0, 0));
        await window.waitForTimeout(300);

        // Find a pin button in recent files
        const pinButtons = frame.locator('button[data-pin-file]');
        const pinCount = await pinButtons.count();
        expect(pinCount).toBeGreaterThan(0);

        // Get the filename of the first pinnable file
        const filename = await pinButtons.first().getAttribute('data-pin-file');
        expect(filename).toBeTruthy();

        // Click pin
        await frame.evaluate((f) => {
            const btn = document.querySelector(`button[data-pin-file="${f}"]`) as HTMLButtonElement;
            if (btn) btn.click();
        }, filename!);
        await window.waitForTimeout(2000);

        await window.screenshot({ path: 'e2e/screenshots/admin-pinned.png' });

        // After re-render, an unpin button for that file should exist
        const unpinButtons = frame.locator('button[data-unpin-file]');
        const unpinCount = await unpinButtons.count();
        expect(unpinCount).toBeGreaterThan(0);

        // Unpin it
        await frame.evaluate((f) => {
            const btn = document.querySelector(`button[data-unpin-file="${f}"]`) as HTMLButtonElement;
            if (btn) btn.click();
        }, filename!);
        await window.waitForTimeout(2000);

        await window.screenshot({ path: 'e2e/screenshots/admin-unpinned.png' });
    });

    test('body has correct data-appearance attribute', async () => {
        const frame = await findWebviewFrame(window);
        expect(frame, 'Webview frame should be found').toBeTruthy();
        if (!frame) return;

        // Body should have data-appearance (system, light, or dark)
        const appearance = await frame.evaluate(() => {
            return document.body.getAttribute('data-appearance');
        });
        expect(appearance).toBeTruthy();
        expect(['system', 'light', 'dark']).toContain(appearance);

        // Body should have data-effective-appearance (light or dark)
        const effective = await frame.evaluate(() => {
            return document.body.getAttribute('data-effective-appearance');
        });
        expect(effective).toBeTruthy();
        expect(['light', 'dark']).toContain(effective);

        // Body should have data-theme
        const theme = await frame.evaluate(() => {
            return document.body.getAttribute('data-theme');
        });
        expect(theme).toBeTruthy();

        await window.screenshot({ path: 'e2e/screenshots/admin-theme-attributes.png' });
    });

    test('memodir is shown in core settings', async () => {
        const frame = await findWebviewFrame(window);
        expect(frame, 'Webview frame should be found').toBeTruthy();
        if (!frame) return;

        // The memodir input should have the workspace memodir value
        const memodirValue = await frame.evaluate(() => {
            const input = document.getElementById('memodir') as HTMLInputElement;
            return input ? input.value : '';
        });
        expect(memodirValue).toBeTruthy();
        expect(memodirValue).toContain('memos');

        await window.screenshot({ path: 'e2e/screenshots/admin-core-settings.png' });
    });
});

// ─── Setup Flow tests ───────────────────────────────────────────────

test.describe('Admin Panel - Setup Flow', () => {
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

    test('use recommended folder sets memodir and advances to step 2', async () => {
        await openAdminPanel(window, electronApp);
        const frame = await findWebviewFrame(window);
        expect(frame, 'Webview frame should be found').toBeTruthy();
        if (!frame) return;

        await window.screenshot({ path: 'e2e/screenshots/admin-setup-before.png' });

        // Verify we're on step 1
        const activeSlide = await frame.locator('.carousel-slide.active').getAttribute('data-slide');
        expect(activeSlide).toBe('0');

        // Customize the path to use our temp dir so we don't pollute the real filesystem
        const customDir = path.join(workspace.dir, 'my-memos').replace(/\\/g, '/');
        await frame.evaluate((dir) => {
            (document.getElementById('setupMemoDirInput') as HTMLInputElement).value = dir;
        }, customDir);

        await window.screenshot({ path: 'e2e/screenshots/admin-setup-custom-path.png' });

        // Click "Use this folder"
        await frame.evaluate(() => document.getElementById('setupUseRecommended')!.click());
        await window.waitForTimeout(3000);

        await window.screenshot({ path: 'e2e/screenshots/admin-setup-after-use.png' });

        // Should auto-advance to step 2
        const step2Active = await frame.locator('.carousel-slide.active').getAttribute('data-slide');
        expect(step2Active).toBe('1');

        // The memodir should have been created
        expect(fs.existsSync(customDir)).toBe(true);

        // .vscode-memobox folder should have been scaffolded
        const metaDir = path.join(customDir, '.vscode-memobox');
        expect(fs.existsSync(metaDir)).toBe(true);
        expect(fs.existsSync(path.join(metaDir, 'templates'))).toBe(true);
        expect(fs.existsSync(path.join(metaDir, 'snippets'))).toBe(true);

        await window.screenshot({ path: 'e2e/screenshots/admin-setup-step2-after-folder.png' });
    });
});
