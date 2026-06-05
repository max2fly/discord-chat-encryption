import { fromBase64, toBase64, utf8Decode, utf8Encode } from "./encoding";
import { Identity, PublicBundle, SealedPayload, SealedWrap } from "./types";

const EC = { name: "ECDH", namedCurve: "P-256" } as const;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const WRAP_INFO = utf8Encode("chatenc:wrap:v1");

async function rawOf(key: CryptoKey): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

export async function fingerprintOf(ecdhPublicRaw: Uint8Array, ecdsaPublicRaw: Uint8Array): Promise<string> {
    const combined = new Uint8Array(ecdhPublicRaw.length + ecdsaPublicRaw.length);
    combined.set(ecdhPublicRaw, 0);
    combined.set(ecdsaPublicRaw, ecdhPublicRaw.length);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", combined)).slice(0, 16);
    return [...hash].map(b => b.toString(16).padStart(2, "0")).join("").replace(/(.{4})(?=.)/g, "$1 ");
}

export async function genIdentity(): Promise<Identity> {
    const ecdh = await crypto.subtle.generateKey(EC, true, ["deriveKey", "deriveBits"]);
    const ecdsa = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
    const ecdhPublicRaw = await rawOf(ecdh.publicKey);
    const ecdsaPublicRaw = await rawOf(ecdsa.publicKey);
    return {
        ecdhPublicRaw,
        ecdhPrivateJwk: await crypto.subtle.exportKey("jwk", ecdh.privateKey),
        ecdsaPublicRaw,
        ecdsaPrivateJwk: await crypto.subtle.exportKey("jwk", ecdsa.privateKey),
        fingerprint: await fingerprintOf(ecdhPublicRaw, ecdsaPublicRaw),
    };
}

export function publicBundle(id: Identity): PublicBundle {
    return { ecdhPublicRaw: id.ecdhPublicRaw, ecdsaPublicRaw: id.ecdsaPublicRaw, fingerprint: id.fingerprint };
}

function importEcdhPublic(raw: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", raw, EC, false, []);
}
function importEcdhPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
    return crypto.subtle.importKey("jwk", jwk, EC, false, ["deriveKey", "deriveBits"]);
}

async function kekFrom(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
    const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: WRAP_INFO },
        hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
    );
}

export async function sealTo(plaintext: string, recipients: PublicBundle[], signerEcdsaJwk?: JsonWebKey): Promise<SealedPayload> {
    const contentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, contentKey, utf8Encode(plaintext)));

    const eph = await crypto.subtle.generateKey(EC, true, ["deriveBits"]);
    const ephPublicRaw = await rawOf(eph.publicKey);
    const ckRaw = new Uint8Array(await crypto.subtle.exportKey("raw", contentKey));

    const wraps: SealedWrap[] = [];
    for (const r of recipients) {
        const kek = await kekFrom(eph.privateKey, await importEcdhPublic(r.ecdhPublicRaw));
        const wrapIv = crypto.getRandomValues(new Uint8Array(12));
        const wrap = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv }, kek, ckRaw));
        wraps.push({ fp: r.fingerprint, wrapIv, wrap });
    }

    const payload: SealedPayload = { ephPublicRaw, wraps, iv, ct };
    if (signerEcdsaJwk) payload.sig = await signBytes(canonicalBytes(payload), signerEcdsaJwk);
    return payload;
}

export async function openSealed(payload: SealedPayload, myFingerprint: string, myEcdhPrivateJwk: JsonWebKey): Promise<string> {
    const mine = payload.wraps.find(w => w.fp === myFingerprint);
    if (!mine) throw new Error("not a recipient");
    const kek = await kekFrom(await importEcdhPrivate(myEcdhPrivateJwk), await importEcdhPublic(payload.ephPublicRaw));
    const ckRaw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: mine.wrapIv }, kek, mine.wrap);
    const contentKey = await crypto.subtle.importKey("raw", ckRaw, "AES-GCM", false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: payload.iv }, contentKey, payload.ct);
    return utf8Decode(new Uint8Array(pt));
}

export async function signBytes(data: Uint8Array, ecdsaPrivateJwk: JsonWebKey): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey("jwk", ecdsaPrivateJwk, ECDSA, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data));
}

export async function verifyBytes(data: Uint8Array, sig: Uint8Array, ecdsaPublicRaw: Uint8Array): Promise<boolean> {
    const key = await crypto.subtle.importKey("raw", ecdsaPublicRaw, ECDSA, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data);
}

/** Stable bytes over which the signature is computed (everything except sig). */
function canonicalBytes(p: SealedPayload): Uint8Array {
    return utf8Encode(JSON.stringify({
        e: toBase64(p.ephPublicRaw),
        w: p.wraps.map(w => [w.fp, toBase64(w.wrapIv), toBase64(w.wrap)]),
        iv: toBase64(p.iv),
        ct: toBase64(p.ct),
    }));
}

// Compact wire framing: each binary field is base64'd ONCE and joined with delimiters that never
// occur in base64 (`| , ~`) or in a fingerprint (hex + spaces). Avoids the JSON + double-base64 of
// the old format (~30% smaller). `canonicalBytes` (signing) is intentionally left as JSON.
export function serializeSealed(p: SealedPayload): string {
    const wraps = p.wraps.map(w => `${w.fp}~${toBase64(w.wrapIv)}~${toBase64(w.wrap)}`).join(",");
    return [
        toBase64(p.ephPublicRaw),
        wraps,
        toBase64(p.iv),
        toBase64(p.ct),
        p.sig ? toBase64(p.sig) : "",
    ].join("|");
}

export function deserializeSealed(blob: string): SealedPayload {
    const [e, w, iv, ct, s] = blob.split("|");
    const wraps = w
        ? w.split(",").map(part => {
            const [fp, wrapIv, wrap] = part.split("~");
            return { fp, wrapIv: fromBase64(wrapIv), wrap: fromBase64(wrap) };
        })
        : [];
    return {
        ephPublicRaw: fromBase64(e),
        wraps,
        iv: fromBase64(iv),
        ct: fromBase64(ct),
        sig: s ? fromBase64(s) : undefined,
    };
}
