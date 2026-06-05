import { openModal } from "@utils/modal";
import { Message } from "@vencord/discord-types";
import { Alerts, Button, ChannelStore, useEffect, useReducer, useState } from "@webpack/common";
import { FluxDispatcher } from "@webpack/common";
import { findByPropsLazy } from "@webpack";

import { openAttachment } from "./crypto/attachment";
import { getContext } from "./crypto/context";
import { toBase64 } from "./crypto/encoding";
import { imageSize } from "./crypto/imagesize";
import { KeyTransfer, parseKeyTransfer } from "./crypto/keytransfer";
import { trialDecode } from "./crypto/stealth";
import { detectWire } from "./crypto/stego";
import { cachedEmbed, findMediaUrls, resolveEmbed } from "./embeds";
import { EncryptionIcon } from "./EncryptionIcon";
import { GuildKeyPicker } from "./GuildKeyPicker";
import { settings } from "./settings";
import { getContextKeys, getForgottenAt, getIdentity, getPeer, getSelfId, pinPeer, subscribe } from "./store";
import { cl, EncryptionResult, ImageEncryptionData, VideoEncryptionData } from "./utils";

export type DecryptOutcome =
    | { state: "plain"; }
    | { state: "decrypted"; text: string; }
    | { state: "no-key"; }
    | { state: "missing-key"; keyId: string; };

/** Per-context decrypt for a single channel's message content (markerless stealth wire). */
export async function decryptForChannel(channelId: string, content: string): Promise<DecryptOutcome> {
    const wire = detectWire(content);
    if (!wire) return { state: "plain" };

    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return { state: "plain" };
    const ctx = getContext(channel, getSelfId());

    const id = getIdentity();
    const symKeys = await getContextKeys(ctx);
    const r = await trialDecode(wire.bytes, {
        symKeys,
        identity: id ? { fingerprint: id.fingerprint, ecdhPrivateJwk: id.ecdhPrivateJwk } : null,
    });

    if (r?.kind === "text") return { state: "decrypted", text: r.text };
    if (r?.kind === "file") return { state: "decrypted", text: `📎 ${r.name}` }; // inline over-cap file — Phase B renders the attachment
    if (r?.kind === "keyannounce") return { state: "plain" };                    // handled by the key-announce accessory branch
    // Nothing opened it. Amber only for the unambiguous zero-width stego signal; a bare base64-looking
    // token (JWTs/hashes/IDs exist) is never mislabelled as encrypted.
    return wire.kind === "stego" ? { state: "no-key" } : { state: "plain" };
}

const DecryptedMessages = new Map<string, EncryptionResult>();
export const MessageInstances = new Map<string, Message>();
const UpdateTriggers = new Map<string, () => void>();
const EncryptedMessageQueue = new Map<string, string>(); // messageId -> encrypted content
// Legacy media maps (messageId -> decrypted media). No longer written by the stealth-PNG path
// (always empty), but kept because index.tsx's copy/save-image context menu reads them via
// getDecryptedImages()/getDecryptedVideos() to recover original filenames.
const DecryptedImages = new Map<string, ImageEncryptionData>(); // messageId -> decrypted image data
const DecryptedVideos = new Map<string, VideoEncryptionData>(); // messageId -> decrypted video data
export const KeyTransfers = new Map<string, KeyTransfer>(); // messageId -> parsed key transfer

// --- Stealth cover-PNG attachment receive state ---
// A cover PNG carries the ciphertext in a private chunk. We probe ONLY image attachments in a
// keyed context, on-view, at most once each (negative cache), then swap in a synthetic attachment
// pointing at an object URL so Discord renders the decrypted media natively.
const NotOurs = new Set<string>(); // attachment ids confirmed to be normal images → never re-probe
const DecryptedAttachments = new Map<string, { url: string; mime: string; name: string; size: number; width?: number; height?: number; }>(); // attachmentId -> decrypted media

/** The original filename for one of our decrypted-attachment URLs (blob:/data:), for the download click
 *  interceptor in index.tsx. Returns undefined for any URL that isn't one of ours → left to Discord. */
export function decryptedNameForUrl(url: string): string | undefined {
    for (const v of DecryptedAttachments.values()) if (v.url === url) return v.name;
    return undefined;
}

/** Build the synthetic attachment that replaces a cover attachment at render time: decrypted url/mime/
 *  name/size, with sensible dimensions per media kind (and image fields stripped for non-visual files so
 *  Discord renders a download card instead of an empty mosaic tile). */
// Image content-types Discord renders inline. Anything else (bmp, tiff, …) gets an empty mosaic tile
// unless we claim a supported type so Discord builds an <img> — the data: URL still carries the real format.
const DISCORD_NATIVE_IMG = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/avif"]);

function buildSyntheticAttachment(attachment: any, dec: { url: string; mime: string; name: string; size: number; width?: number; height?: number; }): any {
    const isImage = dec.mime.startsWith("image/");
    const isVideo = dec.mime.startsWith("video/");
    const s: any = { ...attachment, filename: dec.name, content_type: dec.mime, url: dec.url, proxy_url: dec.url, size: dec.size };
    if (isImage) {
        s.width = dec.width || 400;
        s.height = dec.height || 300;
        // Unsupported image format (e.g. bmp): make the attachment look EXACTLY like a png to Discord —
        // both content_type AND a .png filename (Discord's mosaic also gates on the extension) — so it
        // builds an <img>. The data: URL still carries the real format, which the browser decodes. The
        // download keeps the REAL name (the click handler reads it from DecryptedAttachments, not here).
        if (!DISCORD_NATIVE_IMG.has(dec.mime.toLowerCase())) {
            s.content_type = "image/png";
            s.filename = dec.name.replace(/\.[^.]+$/, "") + ".png";
        }
    } else if (isVideo) {
        s.width = dec.width || 640;
        s.height = dec.height || 360;
    } else {
        delete s.width; delete s.height; delete s.placeholder; delete s.placeholder_version;
    }
    return s;
}

/** Render-time substitution for the renderAttachments patch: replace any attachment we've decrypted
 *  with its synthetic (decrypted url/mime/name/dims). Returns the SAME array if nothing changed. */
export function mapAttachmentsForRender(attachments: any[]): any[] {
    if (!attachments?.length) return attachments;
    let changed = false;
    const out = attachments.map(att => {
        const dec = DecryptedAttachments.get(att?.id);
        if (!dec) return att;
        changed = true;
        return buildSyntheticAttachment(att, dec);
    });
    return changed ? out : attachments;
}
const ProbingAttachments = new Set<string>(); // attachment ids with an in-flight probe (dedupe)
// Over-cap-text cover PNGs ({ kind: "text" }): handled once via handleDecryption (which mutates
// message.content and re-fires the decrypt effect). Marked seen so we never re-fetch + re-decrypt the
// same cover every render — there's no synthetic-attachment swap for these, so the live attachment.url
// stays the cdn url forever and would otherwise keep failing the DecryptedAttachments/NotOurs guards.
const DecryptedTextAttachments = new Set<string>();

/**
 * Render-time media-embed injection — the renderEmbeds-patch sibling of mapAttachmentsForRender.
 * Encrypted messages carry no server embed, so a Tenor/Giphy/direct media link renders as plain text.
 * For a message we've decrypted (looked up in DecryptedMessages), recreate the embeds and append them to
 * the embeds array AT RENDER TIME (mutating message.embeds doesn't stick — renderEmbeds destructures the
 * array early, same as renderAttachments). Uncached URLs resolve in the background and dispatch a re-render.
 */
export function mapEmbedsForRender(message: any, embeds: any[]): any[] {
    const all = embeds || [];
    if (!settings.store.recreateEmbeds) return all.filter(e => !e?.__ceSynth); // disabled → strip ours, never inject/fetch
    const dec = DecryptedMessages.get(message?.id);
    if (!dec?.success || !dec.text) return all;
    // The patch reassigns message.embeds every render, so `all` already holds the embeds WE injected last
    // render. Strip them (marked __ceSynth) and re-derive from the REAL server embeds — otherwise the array
    // grows every render and the growth keeps re-triggering renders (runaway).
    const server = all.filter(e => !e?.__ceSynth);
    const urls = findMediaUrls(dec.text);
    if (!urls.length) return server;

    const synth: any[] = [];
    for (const url of urls) {
        // Don't duplicate an embed Discord already generated for this URL — it sometimes does, especially
        // after a page refresh, which is the "doubled Tenor embed". Match against the real server embeds.
        if (server.some(e => e?.url === url)) continue;
        const e = cachedEmbed(url);
        if (e) { e.__ceSynth = true; synth.push(e); } // reuse the cached object (stable ref), marked for the strip above
        else if (e === undefined) {
            // Not yet resolved — look it up; a successful resolve re-renders (renderEmbeds re-runs and
            // finds it cached). resolveEmbed caches null on failure so we don't retry.
            resolveEmbed(url)
                .then(r => { if (r) FluxDispatcher.dispatch({ type: "MESSAGE_UPDATE", message }); })
                .catch(() => { /* degrade to plain link */ });
        }
    }
    return synth.length ? [...server, ...synth] : server;
}

/**
 * Probe one image attachment: download the cdn ORIGINAL (attachment.url, never proxy_url —
 * media.discordapp.net re-encodes and would destroy the private chunk), try openAttachment with
 * the context keys, and on success swap in a synthetic attachment + re-render. Over-cap text
 * ({ kind: "text" }) is routed through the normal decrypted-text bubble path.
 */
async function tryDecryptAttachment(message: Message, attachment: any): Promise<void> {
    const id = attachment.id;
    if (NotOurs.has(id) || DecryptedAttachments.has(id) || DecryptedTextAttachments.has(id) || ProbingAttachments.has(id)) return;
    if (!attachment.content_type?.startsWith("image/")) return; // covers are image/png
    if (attachment.url?.startsWith("blob:") || attachment.url?.startsWith("data:")) return; // already swapped

    const channel = ChannelStore.getChannel(message.channel_id);
    if (!channel) return;
    const ctx = getContext(channel, getSelfId());
    const symKeys = await getContextKeys(ctx);
    const identity = getIdentity();
    // Proceed when we have a symmetric key (guild/group) OR this is a 1:1 DM with a pinned peer and our
    // identity (sealed-box covers carry no symmetric key, so the symKeys.length gate would skip them).
    const canDm = ctx.type === "dm" && !!identity && !!getPeer(ctx.id);
    if (symKeys.length === 0 && !canDm) return; // nothing to try → leave Discord's native rendering

    ProbingAttachments.add(id);
    try {
        const res = await fetch(attachment.url); // cdn ORIGINAL — byte-exact, keeps the chunk
        const png = new Uint8Array(await res.arrayBuffer());
        const r = await openAttachment(
            png,
            symKeys,
            identity ? { fingerprint: identity.fingerprint, ecdhPrivateJwk: identity.ecdhPrivateJwk } : null
        );

        if (!r) {
            // Tested, nothing decrypted → it's a normal image. Cache so we never re-download it.
            NotOurs.add(id);
            return;
        }

        if (r.kind === "text") {
            // Over-cap text fallback (Phase B7): the same message envelope rode a cover PNG.
            // Render it as a decrypted text bubble via the existing text path. Mark seen BEFORE the
            // handler — handleDecryption mutates message.content and re-fires this effect, and there is
            // no attachment-url swap to gate on, so without this the cover would be re-fetched +
            // re-decrypted on every render.
            DecryptedTextAttachments.add(id);
            handleDecryption(message.id, { text: r.text, success: true });
            return;
        }

        // r.kind === "file": build a URL and swap in a synthetic attachment so Discord renders it
        // inline by mime. IMAGES must use a data: URL — Discord appends media-proxy resize params
        // (?format=webp&width=&height=) to the thumbnail src, which breaks a blob: URL (exact-string
        // lookup fails → ERR_FILE_NOT_FOUND) but is harmless on a self-contained data: URL. Video/audio
        // keep a blob: URL (a data: URL would be far too large) — they don't get image-resize params.
        const isImg = r.mime.startsWith("image/");
        const url = isImg
            ? `data:${r.mime};base64,${toBase64(r.data)}`
            : URL.createObjectURL(new Blob([r.data], { type: r.mime }));
        const dim = isImg ? imageSize(r.data) : null; // size the layout from the REAL image, not the cover
        DecryptedAttachments.set(id, { url, mime: r.mime, name: r.name, size: r.data.length, width: dim?.width, height: dim?.height });
        // DecryptedAttachments is now populated; re-render so the renderAttachments patch substitutes it.
        FluxDispatcher.dispatch({ type: "MESSAGE_UPDATE", message });
        if (r.mime.startsWith("video/")) readVideoDimensions(message, id, url); // video size isn't in a cheap header
    } catch {
        // Network/parse error: treat as a normal image so we don't hammer the cdn on every render.
        NotOurs.add(id);
    } finally {
        ProbingAttachments.delete(id);
    }
}

/** Read a video's intrinsic size from a hidden <video> element (no cheap header to parse) and re-apply
 *  it, so the decrypted video isn't stuck rendering at the cover PNG's dimensions. */
function readVideoDimensions(message: Message, attachmentId: string, url: string): void {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => {
        if (!v.videoWidth || !v.videoHeight) return;
        const cur = DecryptedAttachments.get(attachmentId);
        if (!cur) return;
        DecryptedAttachments.set(attachmentId, { ...cur, width: v.videoWidth, height: v.videoHeight });
        // Re-render so the patch rebuilds the synthetic attachment with the now-known real dimensions.
        FluxDispatcher.dispatch({ type: "MESSAGE_UPDATE", message });
        const trigger = UpdateTriggers.get(message.id);
        if (trigger) trigger();
    };
    v.src = url;
}

export function getDecryptedMessages() {
    return DecryptedMessages;
}

export function getDecryptedImages() {
    return DecryptedImages;
}

export function getDecryptedVideos() {
    return DecryptedVideos;
}

// Stealth-PNG path lookup: the decrypted media for a cover attachment, keyed by the ORIGINAL
// attachment id. Used by index.tsx's download interception to serve the real bytes (object/data
// URL) instead of the cdn cover when Discord's native download buttons fire.
export function getDecryptedAttachment(id: string) {
    return DecryptedAttachments.get(id);
}

// Clean up old cached data without dimensions on plugin load
export function cleanupLegacyCache() {
    let cleanedCount = 0;
    for (const [key, imageData] of DecryptedImages.entries()) {
        if (!imageData.width || !imageData.height) {
            DecryptedImages.delete(key);
            cleanedCount++;
        }
    }
    if (cleanedCount > 0) {
        console.log(`ChatEncryption: Cleaned up ${cleanedCount} legacy cached images without dimensions`);
    }
}

export function handleDecryption(messageId: string, data: EncryptionResult) {
    // Key-transfer payloads decrypt to a JSON control message — never expose them as message text.
    // Capture the parsed transfer so the accessory renders the key-transfer card instead.
    if (data.success) {
        const kt = parseKeyTransfer(data.text);
        if (kt) {
            KeyTransfers.set(messageId, kt);

            // Trigger re-render so the card appears
            const updateTrigger = UpdateTriggers.get(messageId);
            if (updateTrigger) updateTrigger();
            setTimeout(() => {
                const trigger = UpdateTriggers.get(messageId);
                if (trigger) trigger();
            }, 50);
            return;
        }
    }

    DecryptedMessages.set(messageId, data);

    if (data.success) {
        // Update the message content directly
        const messageInstance = MessageInstances.get(messageId);
        if (messageInstance) {
            (messageInstance as any).content = data.text;
        }

        // Trigger re-render
        const updateTrigger = UpdateTriggers.get(messageId);
        if (updateTrigger) {
            updateTrigger();
        }

        // Force a global re-render as fallback
        setTimeout(() => {
            const trigger = UpdateTriggers.get(messageId);
            if (trigger) {
                trigger();
            }
        }, 50);
    }
}

// Function to restore all cached content immediately on page load
export async function restoreAllCachedAttachments() {
    let restoredTexts = 0;
    let restoredAttachments = 0;

    // Restore cached text decryptions
    for (const [messageId, cachedDecryption] of DecryptedMessages.entries()) {
        const messageInstance = MessageInstances.get(messageId);
        if (messageInstance && cachedDecryption.success) {
            // Check if message content is still an undecrypted stealth wire (needs restoration)
            if (detectWire(messageInstance.content)) {
                messageInstance.content = cachedDecryption.text;
                restoredTexts++;
                FluxDispatcher.dispatch({ type: "MESSAGE_UPDATE", message: messageInstance });
            }
        }
    }

    // Force a re-render of any message that has a cached decrypted cover-PNG attachment so the
    // renderAttachments patch re-runs and substitutes it. The substitution itself is render-time
    // (DecryptedAttachments keyed by attachment id) — there's nothing to "re-apply", only to re-render.
    for (const [attachmentId] of DecryptedAttachments.entries()) {
        for (const messageInstance of MessageInstances.values()) {
            if (messageInstance.attachments?.some(att => att.id === attachmentId)) {
                FluxDispatcher.dispatch({ type: "MESSAGE_UPDATE", message: messageInstance });
                restoredAttachments++;
                break;
            }
        }
    }

    if (restoredTexts > 0 || restoredAttachments > 0) {
        console.log(`ChatEncryption: Restored ${restoredTexts} cached texts and ${restoredAttachments} cached attachments`);
    }
}

// Function to decrypt all queued messages against their per-context keys
export async function decryptAllQueuedMessages() {
    // Process all encrypted messages that haven't been decrypted yet
    for (const [messageId, encryptedContent] of EncryptedMessageQueue.entries()) {
        if (!DecryptedMessages.has(messageId)) {
            try {
                // Prefer the live message content (the raw stealth wire); fall back to the queued copy.
                // decryptForChannel runs detectWire itself, so no manual unwrap is needed here.
                const messageInstance = MessageInstances.get(messageId);
                if (!messageInstance) continue;
                const contentToDecrypt = messageInstance.content || encryptedContent;
                const outcome = await decryptForChannel(messageInstance.channel_id, contentToDecrypt);
                if (outcome.state === "decrypted") {
                    handleDecryption(messageId, { text: outcome.text, success: true });
                    EncryptedMessageQueue.delete(messageId); // Remove from queue once decrypted
                }
            } catch (error) {
                console.error("Batch decryption failed for message:", messageId, error);
            }
        }
    }
}

// Approximate a message's creation time from its snowflake id (Discord epoch = 2015-01-01).
function snowflakeTime(id: string): number {
    try {
        return Number(BigInt(id) >> 22n) + 1420070400000;
    } catch {
        return Date.now();
    }
}

export function EncryptionAccessory({ message }: { message: Message; }) {
    const [decryptedContent, setDecryptedContent] = useState<string | null>(null);
    const [isEncrypted, setIsEncrypted] = useState(false);
    // Per-context receive state for the hint UI: null = nothing to show
    const [receiveState, setReceiveState] = useState<"no-key" | "missing-key" | null>(null);
    // TOFU handshake: fingerprint of a peer key auto-pinned from this message (null = no handshake)
    const [pinnedFingerprint, setPinnedFingerprint] = useState<string | null>(null);
    // A handshake key that's visible but NOT saved (older than a "forget") — offered for manual save.
    const [oldKeyFp, setOldKeyFp] = useState<string | null>(null);
    // Force a re-render after capturing a key-transfer (which lives outside React state)
    const [, forceTick] = useReducer(x => x + 1, 0);
    // Re-run decryption when the key store changes (e.g. a key was just added that can now decrypt this message)
    const [storeTick, bumpStore] = useReducer(x => x + 1, 0);
    useEffect(() => subscribe(bumpStore), []);

    // Store message instance for potential updates (like text decryption does)
    MessageInstances.set(message.id, message);

    // Safety net: Check for cached text that needs restoration (handles race conditions)
    const cachedTextDecryption = DecryptedMessages.get(message.id);
    if (cachedTextDecryption?.success && detectWire(message.content)) {
        // Text is cached but message content is still an undecrypted stealth wire - restore it
        setTimeout(() => {
            //console.log("ChatEncryption: Auto-restoring cached text for message:", message.id);
            message.content = cachedTextDecryption.text;

            FluxDispatcher.dispatch({
                type: "MESSAGE_UPDATE",
                message: message
            });
        }, 100);
    }

    useEffect(() => {
        if ((message as any).vencordEmbeddedBy) return;

        const rawContent = message.content || "";

        // TOFU handshake: a public key was posted — show a note (both sides) and record a peer's key.
        // Detection is markerless: detectWire → trialDecode; r.kind === "keyannounce" carries r.bundle.
        const handshakeWire = detectWire(rawContent);
        if (handshakeWire) {
            (async () => {
                const r = await trialDecode(handshakeWire.bytes, { symKeys: [] });
                if (r?.kind !== "keyannounce") return;
                const bundle = r.bundle;
                const channel = ChannelStore.getChannel(message.channel_id);
                const authorId = message.author?.id;
                // "Mine" if WE authored it, OR if the announced key IS our own (someone copied/echoed our
                // key message back) — either way, never record our own key as a peer's.
                const isMine = (!!authorId && authorId === getSelfId()) || bundle.fingerprint === getIdentity()?.fingerprint;
                const existing = authorId ? getPeer(authorId) : undefined;
                // Ignore a handshake OLDER than the last "forget" for this peer, so forgetting sticks even
                // while the old key message is still on screen. A genuine re-share is a newer message.
                const forgotten = !isMine && !existing && !!authorId && snowflakeTime(message.id) <= getForgottenAt(authorId);

                if (!forgotten) {
                    setOldKeyFp(null);
                    // Show the fingerprint immediately on BOTH sides. For a changed key keep the trusted one.
                    setPinnedFingerprint(existing && !isMine ? existing.bundle.fingerprint : bundle.fingerprint);

                    // Record a peer's key (TOFU) — only for OTHERS' keys, only in a 1:1 DM.
                    if (!isMine && authorId && channel && getContext(channel, getSelfId()).type === "dm") {
                        pinPeer(authorId, bundle).then(result => {
                            if (result === "changed") {
                                const trusted = getPeer(authorId);
                                if (trusted) setPinnedFingerprint(trusted.bundle.fingerprint);
                                Alerts.show({
                                    title: "Encryption key mismatch",
                                    body: `⚠ A different encryption key was posted for ${(message.author as any)?.username ?? "this user"}. It was NOT trusted — your originally-recorded key is kept (a message edit or impersonation can cause this). To intentionally accept a new key, use "Forget key" for this peer in plugin settings, then have them re-share.\n\nRejected key: ${bundle.fingerprint}`,
                                });
                            }
                        }).catch(error => {
                            console.error("ChatEncryption: Failed to pin peer key:", error);
                        });
                    }
                } else {
                    // Old/forgotten handshake — show it as visible-but-not-saved; right-click → "Save PGP key".
                    setPinnedFingerprint(null);
                    setOldKeyFp(bundle.fingerprint);
                }
            })().catch(error => console.error("ChatEncryption: key-announce detection failed:", error));
            // A key-announce also matches detectWire below; trialDecode returns "keyannounce" (not text),
            // so decryptForChannel yields "plain" and the text path is a no-op. Fall through is harmless.
        }

        // Probe image attachments for a stealth cover PNG (on-view, negative-cached, keyed-context
        // only — see tryDecryptAttachment). Any of our covers is image/png; non-ours images are
        // confirmed once and never re-downloaded. Runs in the background; the swap re-renders.
        if (message.attachments?.length) {
            for (const attachment of message.attachments) {
                if (attachment.content_type?.startsWith("image/")) {
                    tryDecryptAttachment(message, attachment).catch(error => {
                        console.error("ChatEncryption: Attachment probe failed:", error);
                    });
                }
            }
        }

        // Markerless detection: a zero-width or bare-base64url stealth wire. decryptForChannel
        // detects + trial-decodes the raw content itself, so no manual unwrap is needed.
        const contentToDecrypt = rawContent;
        const isEncryptedMsg = !!handshakeWire; // handshakeWire = detectWire(rawContent), computed above
        setIsEncrypted(isEncryptedMsg);

        // Check if already decrypted
        const existingDecryption = DecryptedMessages.get(message.id);
        if (existingDecryption?.success) {
            //console.log("ChatEncryption: Found existing text decryption for message:", message.id);
            setDecryptedContent(existingDecryption.text);
            // Also update the message content directly for cache persistence
            (message as any).content = existingDecryption.text;
            return;
        }

        if (isEncryptedMsg) {
            //console.log("ChatEncryption: Processing encrypted text message:", message.id, "Content to decrypt:", contentToDecrypt.substring(0, 50));

            // Per-context decrypt against the channel's keys (current + history)
            decryptForChannel(message.channel_id, contentToDecrypt)
                .then(outcome => {
                    if (outcome.state === "decrypted") {
                        setReceiveState(null);

                        // Key-transfer payloads decrypt to a JSON control message — never write that
                        // into message.content. Capture it so the key-transfer card renders instead.
                        const _kt = parseKeyTransfer(outcome.text);
                        if (_kt) {
                            KeyTransfers.set(message.id, _kt);
                            forceTick();
                            return;
                        }

                        const result: EncryptionResult = { text: outcome.text, success: true };
                        DecryptedMessages.set(message.id, result);
                        // Modify the message content directly
                        (message as any).content = outcome.text;
                        setDecryptedContent(outcome.text);

                        // Force Discord to re-render this message using Flux
                        FluxDispatcher.dispatch({
                            type: "MESSAGE_UPDATE",
                            message: message
                        });
                    } else if (outcome.state === "no-key") {
                        setReceiveState("no-key");
                    } else if (outcome.state === "missing-key") {
                        setReceiveState("missing-key");
                    } else {
                        console.log("ChatEncryption: Text decryption outcome:", outcome.state);
                    }
                })
                .catch(error => {
                    console.error("ChatEncryption: Auto-decryption failed for message:", message.id, error);
                });
        }
    }, [message.id, message.content, storeTick]);

    // Check for decrypted messages, images, and videos
    const decryptedResult = DecryptedMessages.get(message.id);
    const decryptedImage = DecryptedImages.get(message.id);
    const decryptedVideo = DecryptedVideos.get(message.id);
    const keyTransfer = KeyTransfers.get(message.id) ?? null;

    // Check if any attachments for this message have been decrypted
    const hasDecryptedAttachments = Array.from(DecryptedImages.keys()).some(key => key.startsWith(`${message.id}-`));
    const hasDecryptedVideoAttachments = Array.from(DecryptedVideos.keys()).some(key => key.startsWith(`${message.id}-`));
    // Cover-PNG attachments are rendered natively (synthetic swap); show the lock badge for them.
    const hasDecryptedCoverAttachments = !!message.attachments?.some(att => DecryptedAttachments.has(att.id));

    // Don't show decrypted attachments in accessory - always use Discord's native viewer via attachment replacement
    const decryptedAttachments: ImageEncryptionData[] = [];

    // Secure key-transfer card — a DM (or group DM) that carries a server/group key.
    // Must run BEFORE the generic decrypted-result block so the transfer renders the card
    // rather than a lock indicator, and so the JSON payload is never shown as text.
    // Never auto-applies: the user explicitly picks a target via the server-icon picker.
    if (keyTransfer) {
        const peer = getPeer(message.author?.id ?? "");
        const trusted = !!peer && peer.bundle.fingerprint === keyTransfer.fromFingerprint;
        const channel = ChannelStore.getChannel(message.channel_id);
        const fromCtx = channel ? getContext(channel, getSelfId()) : null;
        const isGroupKey = fromCtx?.type === "groupdm" && keyTransfer.guildId === channel?.id;
        const presetContext = isGroupKey ? fromCtx : undefined;

        return (
            <div className={cl({ "encryption-accessories": true })}>
                <div className={cl("keytransfer-card")}>
                    <div>
                        🔑 <b>{(message.author as any)?.username ?? "Someone"}</b> shared a key for{" "}
                        <b>{keyTransfer.guildName}</b>
                    </div>
                    {!peer ? (
                        <div className={cl({ "hint": true, "untrusted": true })}>
                            ⚠ No prior contact with this sender — verify before saving.
                        </div>
                    ) : (
                        <div className={cl({ "hint": true, "trusted": trusted, "untrusted": !trusted })}>
                            {trusted ? "✅" : "⚠"} {keyTransfer.fromFingerprint}
                        </div>
                    )}
                    <Button
                        size={Button.Sizes.SMALL}
                        onClick={() => openModal(p => (
                            <GuildKeyPicker
                                rootProps={p}
                                mode="save"
                                presetGuildId={presetContext ? undefined : keyTransfer.guildId}
                                presetContext={presetContext}
                                password={keyTransfer.password}
                            />
                        ))}
                    >
                        Save key to server…
                    </Button>
                </div>
            </div>
        );
    }

    if (decryptedResult?.success || decryptedImage || decryptedVideo || hasDecryptedAttachments || hasDecryptedVideoAttachments || hasDecryptedCoverAttachments || decryptedAttachments.length > 0) {
        return (
            <div className={cl("encryption-accessories")}>
                {(decryptedResult?.success || hasDecryptedAttachments || hasDecryptedVideoAttachments || hasDecryptedCoverAttachments) && (
                    <div className={cl("profile-lock-indicator")}>
                        <EncryptionIcon width={12} height={12} className={cl("profile-lock-icon")} />
                    </div>
                )}
                {decryptedImage && (
                    <div className={cl("decrypted-image-container")}>
                        <img
                            src={`data:${decryptedImage.mimeType};base64,${decryptedImage.imageData}`}
                            alt={decryptedImage.filename}
                            className={cl("decrypted-image")}
                            style={{ maxWidth: '400px', maxHeight: '300px', objectFit: 'contain' }}
                        />
                        <div className={cl("image-info")}>
                            <EncryptionIcon width={12} height={12} className={cl("image-lock-icon")} />
                            {" "}{decryptedImage.filename}
                        </div>
                    </div>
                )}
                {decryptedVideo && (
                    <div className={cl("decrypted-video-container")}>
                        <video
                            src={`data:${decryptedVideo.mimeType};base64,${decryptedVideo.videoData}`}
                            className={cl("decrypted-video")}
                            controls
                            style={{ maxWidth: '400px', maxHeight: '300px' }}
                        />
                        <div className={cl("video-info")}>
                            <EncryptionIcon width={12} height={12} className={cl("video-lock-icon")} />
                            {" "}{decryptedVideo.filename}
                        </div>
                    </div>
                )}
                {decryptedAttachments.map((attachment, index) => (
                    <div key={index} className={cl("decrypted-image-container")}>
                        <img
                            src={`data:${attachment.mimeType};base64,${attachment.imageData}`}
                            alt={attachment.filename}
                            className={cl("decrypted-image")}
                            style={{ maxWidth: '400px', maxHeight: '300px', objectFit: 'contain' }}
                        />
                        <div className={cl("image-info")}>
                            <EncryptionIcon width={12} height={12} className={cl("image-lock-icon")} />
                            {" "}🔓 {attachment.filename}
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    // TOFU note — a public key from this message: ours (just shared) or a peer's (recorded on first sight)
    if (pinnedFingerprint) {
        const isMyKey = pinnedFingerprint === getIdentity()?.fingerprint;
        return (
            <div className={cl({ "encryption-accessories": true })}>
                <span className={cl({ "hint": true })}>
                    🔑 {isMyKey ? "your encryption key" : "saved their key"} · {pinnedFingerprint}
                </span>
            </div>
        );
    }

    // An old/forgotten handshake — visible but not auto-saved. Offer manual recovery via right-click.
    if (oldKeyFp) {
        return (
            <div className={cl({ "encryption-accessories": true })}>
                <span className={cl({ "hint": true, "missing": true })}>
                    🔑 old key (not saved) · {oldKeyFp} — verify, then right-click → “Save PGP key”
                </span>
            </div>
        );
    }

    // Encrypted message we couldn't decrypt — show a subtle per-context hint instead of gibberish
    if (receiveState === "no-key") {
        return (
            <div className={cl({ "encryption-accessories": true })}>
                <span className={cl({ "hint": true, "nokey": true })}>
                    🔴 Encrypted — no key set for this server
                </span>
            </div>
        );
    }
    if (receiveState === "missing-key") {
        return (
            <div className={cl({ "encryption-accessories": true })}>
                <span className={cl({ "hint": true, "missing": true })}>
                    ⚠️ Encrypted with a key you don't have — ask for the current key
                </span>
            </div>
        );
    }

    return null;
}
