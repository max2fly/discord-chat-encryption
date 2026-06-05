import { utf8Decode, utf8Encode } from "./encoding";

export const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
export interface PngChunk {
    type: string;
    data: Uint8Array;
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(buf: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

export function adler32(buf: Uint8Array): number {
    let a = 1,
        b = 0;
    for (let i = 0; i < buf.length; i++) {
        a = (a + buf[i]) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
}

/** zlib stream using only stored (uncompressed) DEFLATE blocks — no compression library. */
export function zlibStored(data: Uint8Array): Uint8Array {
    const out: number[] = [0x78, 0x01];
    let i = 0;
    do {
        const len = Math.min(0xffff, data.length - i);
        out.push(i + len >= data.length ? 1 : 0); // BFINAL, BTYPE=00
        out.push(len & 0xff, (len >> 8) & 0xff);
        out.push(~len & 0xff, (~len >> 8) & 0xff);
        for (let j = 0; j < len; j++) out.push(data[i + j]);
        i += len;
    } while (i < data.length);
    const ad = adler32(data);
    out.push((ad >>> 24) & 0xff, (ad >>> 16) & 0xff, (ad >>> 8) & 0xff, ad & 0xff);
    return new Uint8Array(out);
}

export function makeChunk(type: string, data: Uint8Array): Uint8Array {
    // Allocate + .set() — never spread. Spreading a large Uint8Array as call args
    // (`new Uint8Array([...data])` / `arr.push(...data)`) passes every byte as an
    // argument and overflows the engine's argument limit ("Maximum call stack size
    // exceeded") for payloads bigger than ~100 KB. Attachments are multi-MB.
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length); // length, big-endian
    out.set(utf8Encode(type), 4); // 4-byte chunk type
    out.set(data, 8); // payload
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); // CRC over type+data
    return out;
}

export function assemblePng(chunks: PngChunk[]): Uint8Array {
    const built = chunks.map(c => makeChunk(c.type, c.data));
    let total = PNG_SIG.length;
    for (const b of built) total += b.length;
    const out = new Uint8Array(total);
    out.set(PNG_SIG, 0);
    let o = PNG_SIG.length;
    for (const b of built) {
        out.set(b, o);
        o += b.length;
    }
    return out;
}

export function readChunks(png: Uint8Array): PngChunk[] {
    const chunks: PngChunk[] = [];
    let o = 8;
    const r32 = (p: number) =>
        ((png[p] << 24) | (png[p + 1] << 16) | (png[p + 2] << 8) | png[p + 3]) >>> 0;
    while (o + 8 <= png.length) {
        const len = r32(o);
        const type = utf8Decode(png.subarray(o + 4, o + 8));
        const data = png.subarray(o + 8, o + 8 + len);
        chunks.push({ type, data });
        o += 12 + len;
        if (type === "IEND") break;
    }
    return chunks;
}
