import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPagedByteStore } from '../dist/internal/paged-bytes.js';

const page = 65536;
const collect = store => Buffer.concat(store.parts()); // Test oracle only; production returns page views.

test('paged bytes allocate full pages only for writes and trim the final used view', () => {
    const store = createPagedByteStore(); assert.equal(store.size, 0); assert.deepEqual(store.parts(), []);
    store.write(0, new Uint8Array()); assert.equal(store.size, 0); assert.deepEqual(store.parts(), []);
    store.write(0, new Uint8Array(page).fill(7));
    assert.equal(store.size, page); assert.equal(store.parts().length, 1); assert.equal(store.parts()[0].length, page);
    store.write(page, new Uint8Array([8]));
    assert.equal(store.size, page + 1); assert.deepEqual(store.parts().map(part => part.length), [page, 1]);
    assert.ok(store.parts().every(part => part.buffer.byteLength === page));
});

test('positioned rewrites cross page boundaries, preserve high water and match a contiguous reference', () => {
    const store = createPagedByteStore(), length = page * 2 + 19;
    const original = Uint8Array.from({ length }, (_, i) => (i * 37 + 13) % 256), reference = original.slice();
    store.write(0, original);
    for (const [position, data] of [[page - 2, [1,2,3,4,5,6]], [0, [7,8,9]], [page * 2 - 1, [10,11,12]], [length - 1, [13]]]) {
        const input = new Uint8Array(data); store.write(position, input); reference.set(input, position);
        assert.equal(store.size, length); assert.deepEqual(collect(store), Buffer.from(reference));
    }
    assert.deepEqual(store.parts().map(part => part.length), [page, page, 19]);
});

test('paged writes own the selected input view before caller mutation', () => {
    const source = new Uint8Array([90,91,1,2,3,4,92]), view = source.subarray(2, 6), store = createPagedByteStore();
    store.write(0, view); source.fill(255);
    assert.equal(store.size, 4); assert.deepEqual([...collect(store)], [1,2,3,4]);
    assert.notEqual(store.parts()[0].buffer, source.buffer);
});

test('parts borrow page buffers without full-file concatenation; Blob remains valid after clearing', async () => {
    const store = createPagedByteStore(), original = new Uint8Array(page + 3).fill(17); store.write(0, original);
    const parts = store.parts(), again = store.parts();
    assert.equal(parts[0].buffer, again[0].buffer); assert.equal(parts[1].buffer, again[1].buffer);
    const blob = new Blob(parts); store.write(0, new Uint8Array([99])); assert.equal(parts[0][0], 99);
    store.clear(); store.clear(); assert.equal(store.size, 0); assert.deepEqual(store.parts(), []);
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), original);
});

test('independent exports never share storage pages, length or clear operations', () => {
    const first = createPagedByteStore(), second = createPagedByteStore();
    first.write(0, new Uint8Array([1, 2])); second.write(0, new Uint8Array([3, 4, 5]));
    assert.notEqual(first.parts()[0].buffer, second.parts()[0].buffer);
    first.write(1, new Uint8Array([6])); assert.deepEqual([...collect(first)], [1, 6]);
    assert.deepEqual([...collect(second)], [3, 4, 5]); assert.equal(second.size, 3);
    first.clear(); assert.equal(first.size, 0); assert.equal(second.size, 3);
    assert.deepEqual([...collect(second)], [3, 4, 5]); second.clear();
});

test('retained MP4/WebM adapters do not retain owned pages after success, failure, abort or dispose', () => {
    const output = execFileSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./fixtures/paged-bytes-gc.mjs', import.meta.url))],
        { encoding: 'utf8', timeout: 30000 });
    assert.match(output, /All 16 owned pages and buffers collectible/);
});
