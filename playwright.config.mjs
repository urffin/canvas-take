import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './test/browser',
    timeout: 60000,
    expect: { timeout: 10000 },
    fullyParallel: true,
    workers: 2,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: 'http://127.0.0.1:3187',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } }
    ],
    webServer: {
        command: 'node test/browser/server.mjs',
        url: 'http://127.0.0.1:3187/',
        reuseExistingServer: false,
        timeout: 10000
    }
});
