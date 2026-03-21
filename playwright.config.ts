import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    timeout: 60_000,
    retries: 0,
    workers: 1,  // VS Code can only run one instance at a time
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        trace: 'on-first-retry',
    },
});
