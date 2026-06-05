import { utf8Decode, utf8Encode } from "./encoding";

export const VERSION = 0x01;
export const CT_TEXT = 0x01;
export const CT_FILE = 0x02;

export function packInner(contentType: number, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(2 + body.length);
    out[0] = VERSION;
    out[1] = contentType;
    out.set(body, 2);
    return out;
}

export function unpackInner(bytes: Uint8Array): { version: number; contentType: number; body: Uint8Array } | null {
    if (bytes.length < 2) return null;
    return { version: bytes[0], contentType: bytes[1], body: bytes.subarray(2) };
}

export function frameSym(iv: Uint8Array, ct: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0);
    out.set(ct, 12);
    return out;
}

export function unframeSym(bytes: Uint8Array): { iv: Uint8Array; ct: Uint8Array } | null {
    if (bytes.length < 12 + 16) return null; // 12 iv + 16 GCM tag minimum
    return { iv: bytes.subarray(0, 12), ct: bytes.subarray(12) };
}

function w16(out: Uint8Array, o: number, n: number) {
    out[o] = (n >> 8) & 0xff;
    out[o + 1] = n & 0xff;
}

export function packFileBody(mime: string, name: string, data: Uint8Array): Uint8Array {
    const m = utf8Encode(mime),
        n = utf8Encode(name);
    const out = new Uint8Array(2 + m.length + 2 + n.length + data.length);
    let o = 0;
    w16(out, o, m.length);
    o += 2;
    out.set(m, o);
    o += m.length;
    w16(out, o, n.length);
    o += 2;
    out.set(n, o);
    o += n.length;
    out.set(data, o);
    return out;
}

export function unpackFileBody(body: Uint8Array): { mime: string; name: string; data: Uint8Array } | null {
    try {
        let o = 0;
        const r16 = () => {
            const v = (body[o] << 8) | body[o + 1];
            o += 2;
            return v;
        };
        const ml = r16();
        const mime = utf8Decode(body.subarray(o, o + ml));
        o += ml;
        const nl = r16();
        const name = utf8Decode(body.subarray(o, o + nl));
        o += nl;
        return { mime, name, data: body.subarray(o) };
    } catch {
        return null;
    }
}
