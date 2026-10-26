// Build the packed package with the site's pinned Next/React versions.
// Keep the isolated output for browser verification with `npm start` there.
import { mkdtemp, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw Error('Use npm run test:next');
const workspace = await mkdtemp(join(tmpdir(), 'canvastake-next-'));
console.log(`Next integration workspace: ${workspace}`);
const run = (args, cwd, capture = false) => execFileSync(process.execPath, [npm, ...args], {
    cwd, encoding: 'utf8', timeout: 600000, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }
});
const [packed] = JSON.parse(run(['pack', '--json', '--pack-destination', workspace], root, true));
await cp(join(root, 'test/fixtures/next'), workspace, { recursive: true });
await writeFile(join(workspace, 'package.json'), JSON.stringify({ private: true, type: 'module',
    scripts: { build: 'next build', start: 'next start' }, dependencies: {
        next: '16.3.0', react: '19.2.8', 'react-dom': '19.2.8',
        '@grundyjs/canvas-take': `file:${resolve(workspace, packed.filename)}`
    }
}, null, 2));
run(['install', '--no-audit', '--no-fund'], workspace);
run(['run', 'build'], workspace);
console.log(`Next integration build passed. Browser check: npm start --prefix "${workspace}"`);
