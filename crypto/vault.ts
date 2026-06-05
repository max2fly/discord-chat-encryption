import { fromBase64, toBase64, utf8Decode, utf8Encode } from "./encoding";

const ITER = 600_000;

// Uint8Array isn't JSON-native (JSON.stringify turns it into {"0":..,"1":..}); tag it as base64 so the
// reviver can restore a real Uint8Array. Without this, identity/peer public keys break after a reload.
function u8Replacer(_key: string, value: any) {
    return value instanceof Uint8Array ? { __u8: toBase64(value) } : value;
}
function u8Reviver(_key: string, value: any) {
    return value && typeof value === "object" && typeof value.__u8 === "string" ? fromBase64(value.__u8) : value;
}

async function wrapKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey("raw", utf8Encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" },
        base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
    );
}

/** Returns base64( salt(16) || iv(12) || ciphertext ). */
export async function wrapVault(data: unknown, passphrase: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await wrapKey(passphrase, salt);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8Encode(JSON.stringify(data, u8Replacer))));
    const out = new Uint8Array(16 + 12 + ct.length);
    out.set(salt, 0);
    out.set(iv, 16);
    out.set(ct, 28);
    return toBase64(out);
}

export async function unwrapVault<T = unknown>(blob: string, passphrase: string): Promise<T> {
    const bytes = fromBase64(blob);
    const salt = bytes.slice(0, 16);
    const iv = bytes.slice(16, 28);
    const ct = bytes.slice(28);
    const key = await wrapKey(passphrase, salt);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return JSON.parse(utf8Decode(new Uint8Array(pt)), u8Reviver);
}
