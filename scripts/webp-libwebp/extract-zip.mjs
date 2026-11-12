import assert from 'node:assert/strict';
import { open, mkdir, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { resolve, dirname, sep } from 'node:path';

// Small bootstrap extractor for hash-pinned official Windows tool archives only.
// No shell, symlinks, ZIP64, encryption or arbitrary untrusted archives are supported.
export async function extractZip(path, destination, exclude = () => false) {
    const file = await open(path, 'r'), base = resolve(destination), directories = new Map();
    const directory = path => {
        if (!directories.has(path)) directories.set(path, mkdir(path, { recursive: true }));
        return directories.get(path);
    };
    const read = async (position, length) => {
        const buffer = Buffer.alloc(length), result = await file.read(buffer, 0, length, position);
        assert.equal(result.bytesRead, length, 'complete ZIP entry'); return buffer;
    };
    try {
        const size = (await file.stat()).size, tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
        let end = tail.length - 22;
        while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--;
        assert.ok(end >= 0, 'ZIP directory');
        assert.equal(tail.readUInt16LE(end + 4), 0); assert.equal(tail.readUInt16LE(end + 6), 0);
        const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
        const central = await read(offset, length), entries = [];
        for (let i = 0, p = 0; i < count; i++) {
            assert.equal(central.readUInt32LE(p), 0x02014b50);
            const nameLength = central.readUInt16LE(p + 28), extra = central.readUInt16LE(p + 30), comment = central.readUInt16LE(p + 32);
            const name = central.toString('utf8', p + 46, p + 46 + nameLength), target = resolve(base, name);
            assert.ok(target.startsWith(base + sep), 'ZIP path stays inside destination');
            assert.equal(central.readUInt16LE(p + 8) & 1, 0, 'unencrypted ZIP');
            assert.notEqual(central.readUInt32LE(p + 38) >>> 16 & 0xf000, 0xa000, 'no symlink');
            if (!name.endsWith('/') && !exclude(name)) entries.push({ target, method: central.readUInt16LE(p + 10),
                compressed: central.readUInt32LE(p + 20), size: central.readUInt32LE(p + 24), offset: central.readUInt32LE(p + 42) });
            p += 46 + nameLength + extra + comment;
        }
        let next = 0;
        await Promise.all(Array.from({ length: 8 }, async () => {
            while (next < entries.length) {
                const entry = entries[next++], header = await read(entry.offset, 30);
                assert.equal(header.readUInt32LE(0), 0x04034b50);
                const payload = await read(entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), entry.compressed);
                assert.ok(entry.method === 0 || entry.method === 8, 'stored/deflated ZIP only');
                const bytes = entry.method === 8 ? inflateRawSync(payload) : payload;
                assert.equal(bytes.length, entry.size); await directory(dirname(entry.target)); await writeFile(entry.target, bytes);
            }
        }));
        return entries.length;
    } finally { await file.close(); }
}
