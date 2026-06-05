import { deserializeSealed, fingerprintOf, openSealed } from "./asymmetric";
import { packBundle, unpackBundle } from "./codec";
import { CT_FILE, CT_TEXT, frameSym, packInner, unframeSym, unpackFileBody, unpackInner } from "./envelope";
import { utf8Decode } from "./encoding";
import { decryptSymBytes, encryptSymBytes } from "./symmetric";
import { PublicBundle } from "./types";

export interface SymCandidate {
    key: CryptoKey;
    contextKey: string;
}
export interface TrialOpts {
    symKeys: SymCandidate[];
    identity?: { fingerprint: string; ecdhPrivateJwk: JsonWebKey } | null;
}
export type TrialResult =
    | { kind: "text"; text: string }
    | { kind: "file"; mime: string; name: string; data: Uint8Array }
    | { kind: "keyannounce"; bundle: PublicBundle }
    | null;

/** Build the symmetric wire bytes: encrypt packInner(contentType, body) → frame [iv][ct]. */
export async function buildSymWire(
    contentType: number,
    body: Uint8Array,
    key: CryptoKey,
    contextKey: string,
): Promise<Uint8Array> {
    const { iv, ct } = await encryptSymBytes(packInner(contentType, body), key, contextKey);
    return frameSym(iv, ct);
}

export async function buildKeyAnnounceWire(bundle: PublicBundle): Promise<Uint8Array> {
    return packBundle(bundle);
}

function interpretInner(contentType: number, body: Uint8Array): TrialResult {
    if (contentType === CT_TEXT) return { kind: "text", text: utf8Decode(body) };
    if (contentType === CT_FILE) {
        const f = unpackFileBody(body);
        return f ? { kind: "file", mime: f.mime, name: f.name, data: f.data } : null;
    }
    return null;
}

/** Try, in order: symmetric (GCM tag selects key) → sealed DM → self-consistent key-announce. */
export async function trialDecode(bytes: Uint8Array, opts: TrialOpts): Promise<TrialResult> {
    const framed = unframeSym(bytes);
    if (framed) {
        for (const c of opts.symKeys) {
            try {
                const inner = unpackInner(await decryptSymBytes(framed.iv, framed.ct, c.key, c.contextKey));
                if (inner) {
                    const r = interpretInner(inner.contentType, inner.body);
                    if (r) return r;
                }
            } catch {
                /* wrong key → tag fails → next */
            }
        }
    }
    if (opts.identity) {
        try {
            const sealed = deserializeSealed(utf8Decode(bytes));
            const text = await openSealed(sealed, opts.identity.fingerprint, opts.identity.ecdhPrivateJwk);
            return { kind: "text", text };
        } catch {
            /* not a sealed msg for us */
        }
    }
    const b = unpackBundle(bytes);
    if (b && b.fingerprint && (await fingerprintOf(b.ecdhPublicRaw, b.ecdsaPublicRaw)) === b.fingerprint) {
        return { kind: "keyannounce", bundle: b };
    }
    return null;
}
