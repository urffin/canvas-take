import {test} from 'node:test';
import assert from 'node:assert/strict';
import {managedBrowserResultNamespace, openNativeBrowserResultStore} from '../dist/internal/video-browser-results-native.js';

const scope = '01234567-abcd-4000-abcd-0123456789ab';

test('managed native store accepts only dedicated UUID namespaces and explicit storage mode', async () => {
    assert.equal(managedBrowserResultNamespace(scope), `canvastake-opfs-managed-v2-${scope}`);
    for (const value of ['../movie.mp4', 'canvastake-browser-video-v1', scope.toUpperCase(), '', null]) {
        assert.throws(() => managedBrowserResultNamespace(value), TypeError);
    }
    await assert.rejects(openNativeBrowserResultStore(scope, 'upgrade'), TypeError);
});

test('managed native store is safe to import in Node and reports missing browser storage', async () => {
    await assert.rejects(openNativeBrowserResultStore(scope, 'reopen'), error => error.name === 'NotSupportedError');
    for (const extension of ['js', 'd.ts']) {
        await assert.rejects(import(`@grundyjs/canvas-take/internal/video-browser-results-native.${extension}`),
            error => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
    }
});
