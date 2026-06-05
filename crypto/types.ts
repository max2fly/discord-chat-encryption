export type ContextType = "guild" | "groupdm" | "dm";

export interface Context {
    type: ContextType;
    id: string;
}

/** Symmetric ciphertext payload (the BracketCodec serializes this). */
export interface EncPayload {
    keyId: string;
    iv: Uint8Array;
    ct: Uint8Array;
}

/** One symmetric key entry within a context (password kept so the AES key can be re-derived). */
export interface KeyEntry {
    keyId: string;
    password: string;
    createdAt: number;
}

/** Per-context persisted record. */
export interface ContextRecord {
    currentKeyId: string | null;
    keys: KeyEntry[];
    stego: boolean;
}

export function emptyRecord(): ContextRecord {
    return { currentKeyId: null, keys: [], stego: false };
}

export interface Identity {
    ecdhPublicRaw: Uint8Array;
    ecdhPrivateJwk: JsonWebKey;
    ecdsaPublicRaw: Uint8Array;
    ecdsaPrivateJwk: JsonWebKey;
    fingerprint: string;
}

export interface PublicBundle {
    ecdhPublicRaw: Uint8Array;
    ecdsaPublicRaw: Uint8Array;
    fingerprint: string;
}

export interface SealedWrap {
    fp: string;          // recipient fingerprint this wrap is for
    wrapIv: Uint8Array;
    wrap: Uint8Array;    // AES-GCM(KEK, contentKeyRaw)
}

export interface SealedPayload {
    ephPublicRaw: Uint8Array;
    wraps: SealedWrap[];
    iv: Uint8Array;      // body iv
    ct: Uint8Array;      // body ciphertext
    sig?: Uint8Array;    // optional ECDSA signature over canonical bytes
}
