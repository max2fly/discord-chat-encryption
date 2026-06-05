import { deserializeSealed, fingerprintOf, openSealedBytes, sealToBytes, serializeSealed } from "./asymmetric";
import { packBundle, unpackBundle } from "./codec";
import { CT_FILE, CT_TEXT, frameSym, packInner, unframeSym, unpackFileBody, unpackInner } from "./envelope";
import { utf8Decode, utf8Encode } from "./encoding";
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

/** Build the sealed-box (PGP/ECDH) wire bytes: seal packInner(contentType, body) to recipients →
 *  serialize. Shares one inner-envelope decode path with the symmetric wire, so sealed DM text AND
 *  files come back through the same interpretInner branch in trialDecode. */
export async function buildSealedWire(
    contentType: number,
    body: Uint8Array,
    recipients: PublicBundle[],
    signerEcdsaJwk: JsonWebKey,
): Promise<Uint8Array> {
    return utf8Encode(serializeSealed(await sealToBytes(packInner(contentType, body), recipients, signerEcdsaJwk)));
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
            const plain = await openSealedBytes(sealed, opts.identity.fingerprint, opts.identity.ecdhPrivateJwk);
            const inner = unpackInner(plain);
            if (inner) {
                const r = interpretInner(inner.contentType, inner.body);
                if (r) return r;
            }
        } catch {
            /* not a sealed msg for us / wrong key */
        }
    }
    const b = unpackBundle(bytes);
    if (b && b.fingerprint && (await fingerprintOf(b.ecdhPublicRaw, b.ecdsaPublicRaw)) === b.fingerprint) {
        return { kind: "keyannounce", bundle: b };
    }
    return null;
}
