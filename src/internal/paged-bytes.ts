// Owned in-memory bytes only. Format, limits, cancellation and stream lifecycle belong to the adapter.
const pageSize = 65536;

export function createPagedByteStore() {
    const pages = new Map<number, Uint8Array<ArrayBuffer>>();
    let size = 0;
    return {
        get size() { return size; },
        write(position: number, data: Uint8Array): void {
            const end = position + data.byteLength;
            for (let offset = 0; offset < data.byteLength;) {
                const absolute = position + offset, index = Math.floor(absolute / pageSize), within = absolute % pageSize;
                let page = pages.get(index);
                if (!page) { page = new Uint8Array(pageSize); pages.set(index, page); }
                const count = Math.min(pageSize - within, data.byteLength - offset);
                page.set(data.subarray(offset, offset + count), within); offset += count;
            }
            size = Math.max(size, end);
        },
        parts(): Uint8Array<ArrayBuffer>[] {
            const parts: Uint8Array<ArrayBuffer>[] = [];
            for (let offset = 0; offset < size; offset += pageSize) {
                parts.push(pages.get(offset / pageSize)!.subarray(0, Math.min(pageSize, size - offset)));
            }
            return parts;
        },
        clear(): void { pages.clear(); size = 0; }
    };
}
