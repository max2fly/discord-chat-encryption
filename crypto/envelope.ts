import { utf8Decode, utf8Encode } from "./encoding";

export const VERSION = 0x01;
export const CT_TEXT = 0x01;
export const CT_FILE = 0x02;
export const CT_STICKER = 0x03;

export interface StickerRef {
    id: string;         // snowflake, stored as ascii decimal to avoid BigInt
    name: string;
    formatType: number; // Discord format_type: PNG=1, APNG=2, LOTTIE=3, GIF=4
    type: number;       // Discord sticker type: STANDARD=1, GUILD=2
}

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

export function packStickerBody(stickers: StickerRef[], text: string): Uint8Array {
    // count is a u8; Discord caps stickers per message far below 255 (a handful), so this never truncates.
    const parts: Uint8Array[] = [new Uint8Array([stickers.length & 0xff])];
    for (const s of stickers) {
        const id = utf8Encode(s.id);
        const name = utf8Encode(s.name);
        const seg = new Uint8Array(2 + id.length + 1 + 1 + 2 + name.length);
        let o = 0;
        w16(seg, o, id.length); o += 2;
        seg.set(id, o); o += id.length;
        seg[o++] = s.formatType & 0xff;
        seg[o++] = s.type & 0xff;
        w16(seg, o, name.length); o += 2;
        seg.set(name, o);
        parts.push(seg);
    }
    parts.push(utf8Encode(text));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

export function unpackStickerBody(body: Uint8Array): { stickers: StickerRef[]; text: string } | null {
    try {
        if (body.length < 1) return null;
        let o = 0;
        const r16 = () => { const v = (body[o] << 8) | body[o + 1]; o += 2; return v; };
        const count = body[o++];
        const stickers: StickerRef[] = [];
        for (let i = 0; i < count; i++) {
            if (o + 2 > body.length) return null;
            const idLen = r16();
            if (o + idLen + 4 > body.length) return null; // id + formatType + type + nameLen(2)
            const id = utf8Decode(body.subarray(o, o + idLen)); o += idLen;
            const formatType = body[o++];
            const type = body[o++];
            const nameLen = r16();
            if (o + nameLen > body.length) return null;
            const name = utf8Decode(body.subarray(o, o + nameLen)); o += nameLen;
            stickers.push({ id, name, formatType, type });
        }
        return { stickers, text: utf8Decode(body.subarray(o)) };
    } catch {
        return null;
    }
}
