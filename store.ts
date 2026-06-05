import * as DataStore from "@api/DataStore";
import { UserStore } from "@webpack/common";

import { genIdentity } from "./crypto/asymmetric";
import { contextKey } from "./crypto/context";
import { addOrRotateKey, getKeyEntry } from "./crypto/keyring";
import { computeKeyId, deriveSymKey } from "./crypto/symmetric";
import { Context, ContextRecord, emptyRecord, Identity, KeyEntry, PublicBundle } from "./crypto/types";
import { unwrapVault, wrapVault } from "./crypto/vault";
import { settings } from "./settings";

const VAULT_KEY = "chatenc:vault:v2";

type RecordMap = Record<string, ContextRecord>;

export interface PinnedPeer { userId: string; bundle: PublicBundle; pinnedAt: number; verified: boolean; }

interface SecretState {
    records: RecordMap;
    identity: Identity | null;
    peers: Record<string, PinnedPeer>;
    channelAutoEncrypt: Record<string, boolean>; // per-channel auto-encrypt, keyed by Discord channelId
    forgottenAt: Record<string, number>; // userId -> time a peer key was forgotten; ignore older handshakes
}

let state: SecretState = { records: {}, identity: null, peers: {}, channelAutoEncrypt: {}, forgottenAt: {} };
let masterPass: string | null = null; // session-only; null when vault is plaintext
let vaultExists = false; // whether a persisted vault is present (for onboarding vs unlock UX)
let loaded = false; // becomes true once loadStore() has run — guards against clobbering the vault before load
const keyCache = new Map<string, CryptoKey>(); // keyId -> derived AES key (memory only)
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach(l => l());
}

/** True when the vault is encrypted but not yet unlocked this session (no master passphrase). */
export function isVaultLocked(): boolean {
    return settings.store.vaultEncrypted && !masterPass;
}

/** Whether a persisted vault already exists (→ "unlock") vs. first-run (→ "create"). */
export function hasVault(): boolean {
    return vaultExists;
}

async function persist() {
    // Never write before the saved vault has been loaded — otherwise a write triggered during startup
    // (e.g. pinPeer from a key-announce that renders before loadStore finishes) overwrites the vault
    // with the empty initial state, wiping the identity. This was the "key resets on rebuild" bug.
    if (!loaded) return;
    if (settings.store.vaultEncrypted) {
        // Locked: skip persisting rather than throwing. UI write paths gate on isVaultLocked()
        // and reopen the setup/unlock modal, so this is only reached on non-UI writes while locked.
        if (!masterPass) return;
        await DataStore.set(VAULT_KEY, { enc: await wrapVault(state, masterPass) });
    } else {
        await DataStore.set(VAULT_KEY, { plain: state });
    }
    vaultExists = true;
    notify();
}

/** Returns "ok" | "locked" (needs passphrase) | "fresh" (no vault yet). */
export async function loadStore(passphrase?: string): Promise<"ok" | "locked" | "fresh"> {
    const stored = await DataStore.get<{ enc?: string; plain?: SecretState; }>(VAULT_KEY);
    if (!stored) { vaultExists = false; loaded = true; return "fresh"; }
    vaultExists = true;
    if (stored.plain) { state = stored.plain; loaded = true; notify(); return "ok"; }
    if (stored.enc) {
        if (!passphrase) return "locked"; // still encrypted & not unlocked — NOT loaded; persist() stays disabled
        state = await unwrapVault<SecretState>(stored.enc, passphrase); // throws on wrong pass
        masterPass = passphrase;
        loaded = true;
        notify(); // re-render accessories that rendered before the vault loaded → they re-decrypt now
        return "ok";
    }
    vaultExists = false;
    loaded = true;
    return "fresh";
}

/** Generate the identity on first use (after unlock / for a fresh vault). */
export async function ensureIdentity(passphrase?: string): Promise<Identity> {
    if (passphrase) masterPass = passphrase;
    // One-time cleanup: an older bug recorded your own key-announce as a peer under your own id.
    const self = getSelfId();
    if (self && state.peers[self]) {
        delete state.peers[self];
        await persist();
    }
    if (!state.identity) {
        state.identity = await genIdentity();
        await persist();
    }
    notify(); // identity is now available — let accessories re-attempt decryption
    return state.identity;
}

export function getIdentity(): Identity | null {
    return state.identity;
}

export function getPeer(userId: string): PinnedPeer | undefined {
    return state.peers[userId];
}

export function getPeers(): PinnedPeer[] {
    const self = getSelfId();
    return Object.values(state.peers).filter(p => p.userId !== self); // never list yourself as a peer
}

export async function setPeerVerified(userId: string, verified: boolean): Promise<void> {
    const peer = state.peers[userId];
    if (!peer) return;
    peer.verified = verified;
    await persist();
}

/** Drop the current identity and generate a fresh one (breaks existing pinned relationships). */
export async function regenerateIdentity(): Promise<Identity> {
    state.identity = null;
    return ensureIdentity();
}

/**
 * TOFU: record a peer's public key on FIRST sight and trust that recorded key thereafter.
 * Returns "pinned" (newly recorded) | "unchanged" (same key) | "changed" (a DIFFERENT key appeared).
 *
 * On "changed" we deliberately do NOT overwrite the stored key. The handshake is an ordinary,
 * editable Discord message, so silently re-trusting a new key would be a MITM (edit the message →
 * swap the key). Accepting a legitimately-changed key is an explicit user action — forgetPeer()
 * (then the next handshake records the new key fresh).
 */
export async function pinPeer(userId: string, bundle: PublicBundle): Promise<"pinned" | "unchanged" | "changed"> {
    const existing = state.peers[userId];
    if (existing) {
        return existing.bundle.fingerprint === bundle.fingerprint ? "unchanged" : "changed";
    }
    state.peers[userId] = { userId, bundle, pinnedAt: Date.now(), verified: false };
    await persist();
    return "pinned";
}

/** Forget a recorded peer key so the next handshake records a fresh one (deliberate TOFU reset). */
export async function forgetPeer(userId: string): Promise<void> {
    state.forgottenAt = state.forgottenAt ?? {};
    state.forgottenAt[userId] = Date.now(); // ignore handshakes older than now so forgetting actually sticks
    delete state.peers[userId];
    await persist();
}

/** When a peer's key was last forgotten (0 = never). Handshakes older than this are ignored. */
export function getForgottenAt(userId: string): number {
    return state.forgottenAt?.[userId] ?? 0;
}

/**
 * Explicitly (re-)record a peer's key from a key-announce — even an old/forgotten one. Overwrites any
 * existing key and clears the "forgotten" mark. A deliberate user action (and a manual MITM-accept), used
 * to recover from accidental erasure without asking the peer to re-share. Verify the fingerprint first.
 */
export async function forcePinPeer(userId: string, bundle: PublicBundle): Promise<void> {
    if (state.forgottenAt) delete state.forgottenAt[userId];
    state.peers[userId] = { userId, bundle, pinnedAt: Date.now(), verified: false };
    await persist();
}

export async function setMasterPass(passphrase: string) {
    masterPass = passphrase;
    await persist(); // re-writes the vault encrypted under the new passphrase
}

export function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

export function getSelfId(): string {
    return UserStore.getCurrentUser()?.id ?? "";
}

export function getRecord(ck: string): ContextRecord {
    return state.records[ck] ?? emptyRecord();
}

async function keyFor(entry: KeyEntry, ck: string): Promise<CryptoKey> {
    let k = keyCache.get(entry.keyId);
    if (!k) {
        k = await deriveSymKey(entry.password, ck); // lazy: only when first needed
        keyCache.set(entry.keyId, k);
    }
    return k;
}

/** Set (or rotate to) a password for a context. Derives the key, computes keyId, persists. */
export async function setPassword(ctx: Context, password: string) {
    const ck = contextKey(ctx);
    const key = await deriveSymKey(password, ck);
    const keyId = await computeKeyId(key);
    keyCache.set(keyId, key);
    state.records[ck] = addOrRotateKey(getRecord(ck), { keyId, password, createdAt: Date.now() });
    await persist();
}

export async function getCurrentKey(ctx: Context): Promise<{ key: CryptoKey; keyId: string; } | null> {
    const ck = contextKey(ctx);
    const rec = getRecord(ck);
    if (!rec.currentKeyId) return null;
    const entry = getKeyEntry(rec, rec.currentKeyId);
    if (!entry) return null;
    return { key: await keyFor(entry, ck), keyId: entry.keyId };
}

export async function getKeyById(ctx: Context, keyId: string): Promise<CryptoKey | null> {
    const ck = contextKey(ctx);
    const entry = getKeyEntry(getRecord(ck), keyId);
    return entry ? keyFor(entry, ck) : null;
}

/** Current key entry's raw password for a context (used by the attachment passphrase path), or null. */
export function getCurrentPassword(ctx: Context): string | null {
    const ck = contextKey(ctx);
    const rec = getRecord(ck);
    if (!rec.currentKeyId) return null;
    const entry = getKeyEntry(rec, rec.currentKeyId);
    return entry?.password ?? null;
}

/** Per-channel auto-encrypt (keyed by Discord channelId) — a server can have plaintext + encrypted channels. */
export function getChannelAutoEncrypt(channelId: string): boolean {
    return state.channelAutoEncrypt?.[channelId] ?? false;
}

export async function setChannelAutoEncrypt(channelId: string, on: boolean) {
    state.channelAutoEncrypt = state.channelAutoEncrypt ?? {};
    state.channelAutoEncrypt[channelId] = on;
    await persist();
}

/** Delete all saved keys (current + history) for a context. Past messages won't decrypt afterward. */
export async function clearKeys(ctx: Context) {
    const ck = contextKey(ctx);
    const rec = getRecord(ck);
    rec.keys.forEach(k => keyCache.delete(k.keyId));
    state.records[ck] = { currentKeyId: null, keys: [], stego: rec.stego };
    await persist();
}

export async function setStego(ctx: Context, on: boolean) {
    const ck = contextKey(ctx);
    state.records[ck] = { ...getRecord(ck), stego: on };
    await persist();
}
