// Verification-only Windows CPython 3.13 wheel, isolated from project/global dependencies.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extractZip } from '../webp-libwebp/extract-zip.mjs';
export const pin = { version: '12.0.0', filename: 'pillow-12.0.0-cp313-cp313-win_amd64.whl',
    sha256: '4cf7fed4b4580601c4345ceb5d4cbf5a980d030fd5ad07c4d2ec589f95f09905', bytes: 7007477 };
export async function preparePillow(download = false) {
    const root = 'benchmark-results/webp-pillow'; await mkdir(root, { recursive: true }); let bytes;
    try { bytes = await readFile(root + '/pillow.whl'); } catch { if (!download) throw new Error('Run node scripts/check-webp-integration.mjs --prepare-pillow first'); }
    if (!bytes) {
        const metadata = await fetch('https://pypi.org/pypi/Pillow/12.0.0/json'); assert.ok(metadata.ok);
        const data = await metadata.json(), wheel = data.urls.find(value => value.filename === pin.filename); assert.equal(wheel?.digests.sha256, pin.sha256);
        const response = await fetch(wheel.url); assert.ok(response.ok); bytes = Buffer.from(await response.arrayBuffer());
    }
    assert.equal(bytes.length, pin.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256);
    await writeFile(root + '/pillow.whl', bytes); await extractZip(root + '/pillow.whl', root + '/site'); return pin;
}
