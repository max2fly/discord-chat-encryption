import { EncPayload } from "./types";
import { toBase64, utf8Decode, utf8Encode } from "./encoding";

const PBKDF2_ITERATIONS = 600_000;
const SALT_NAMESPACE = "chatenc:v1:";

async function deterministicSalt(contextKey: string): Promise<ArrayBuffer> {
    return crypto.subtle.digest("SHA-256", utf8Encode(SALT_NAMESPACE + contextKey));
}

export async function deriveSymKey(password: string, contextKey: string): Promise<CryptoKey> {
    const salt = await deterministicSalt(contextKey);
    const base = await crypto.subtle.importKey("raw", utf8Encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
        base,
        { name: "AES-GCM", length: 256 },
        true, // extractable so we can fingerprint it for keyId
        ["encrypt", "decrypt"],
    );
}

export async function computeKeyId(key: CryptoKey): Promise<string> {
    const raw = await crypto.subtle.exportKey("raw", key);
    const hash = await crypto.subtle.digest("SHA-256", raw);
    return toBase64(new Uint8Array(hash)).slice(0, 11);
}

export async function encryptSym(plaintext: string, key: CryptoKey, keyId: string, contextKey: string): Promise<EncPayload> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: utf8Encode(contextKey) },
        key,
        utf8Encode(plaintext),
    );
    return { keyId, iv, ct: new Uint8Array(ct) };
}

export async function decryptSym(payload: EncPayload, key: CryptoKey, contextKey: string): Promise<string> {
    const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: payload.iv, additionalData: utf8Encode(contextKey) },
        key,
        payload.ct,
    );
    return utf8Decode(new Uint8Array(pt));
}

const MENTION_RE = /<@!?\d+>|<@&\d+>|<#\d+>/g;

/** Pull Discord mentions out so they survive encryption as plaintext (pings still notify). */
export function splitMentions(content: string): { text: string; mentions: string[] } {
    const mentions = content.match(MENTION_RE) ?? [];
    const text = content.replace(MENTION_RE, "").replace(/ +$/, "");
    return { text, mentions };
}
