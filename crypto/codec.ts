import { deserializeSealed, serializeSealed } from "./asymmetric";
import { fromBase64, toBase64, utf8Decode, utf8Encode } from "./encoding";
import { EncPayload, PublicBundle, SealedPayload } from "./types";

export interface MessageCodec {
    name: string;
    test(raw: string): boolean;
    encode(p: EncPayload): string;
    decode(raw: string): EncPayload | null;
}

/** Dev/proof format. Deliberately obvious; a covert StealthCodec replaces it later (spec §13). */
export const BracketCodec: MessageCodec = {
    name: "bracket-v2",
    test: raw => /\[ENC:v2:[^:\]]+:[^:\]]+:[^:\]]+\]/.test(raw),
    encode: p => `[ENC:v2:${p.keyId}:${toBase64(p.iv)}:${toBase64(p.ct)}]`,
    decode(raw) {
        const m = raw.match(/\[ENC:v2:([^:\]]+):([^:\]]+):([^:\]]+)\]/);
        if (!m) return null;
        try {
            return { keyId: m[1], iv: fromBase64(m[2]), ct: fromBase64(m[3]) };
        } catch {
            return null;
        }
    },
};

const codecs: MessageCodec[] = [BracketCodec];

/** Encode with the configured (first) codec. */
export function encodeMessage(p: EncPayload): string {
    return codecs[0].encode(p);
}

/** Decode by trying every registered codec (read path supports multiple formats). */
export function decodeMessage(raw: string): EncPayload | null {
    for (const c of codecs) {
        if (c.test(raw)) {
            const d = c.decode(raw);
            if (d) return d;
        }
    }
    return null;
}

export function isEncoded(raw: string): boolean {
    return codecs.some(c => c.test(raw));
}

export function encodeSealed(p: SealedPayload): string {
    return `[PGP:v1:${serializeSealed(p)}]`;
}
export function isSealedWire(raw: string): boolean {
    return /\[PGP:v1:[^\]]+\]/.test(raw);
}
export function decodeSealedWire(raw: string): SealedPayload | null {
    const m = raw.match(/\[PGP:v1:([^\]]+)\]/);
    if (!m) return null;
    try {
        return deserializeSealed(m[1]);
    } catch {
        return null;
    }
}

// TOFU handshake wire format: a self-published public-key bundle that peers auto-pin.
export function encodeKeyAnnounce(b: PublicBundle): string {
    return `[PGPKEY:v1:${toBase64(utf8Encode(JSON.stringify({
        e: toBase64(b.ecdhPublicRaw), s: toBase64(b.ecdsaPublicRaw), f: b.fingerprint,
    })))}]`;
}
export function decodeKeyAnnounce(raw: string): PublicBundle | null {
    const m = raw.match(/\[PGPKEY:v1:([^\]]+)\]/);
    if (!m) return null;
    try {
        const o = JSON.parse(utf8Decode(fromBase64(m[1])));
        return { ecdhPublicRaw: fromBase64(o.e), ecdsaPublicRaw: fromBase64(o.s), fingerprint: o.f };
    } catch { return null; }
}
export function isKeyAnnounce(raw: string): boolean { return /\[PGPKEY:v1:[^\]]+\]/.test(raw); }
