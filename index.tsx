import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import { Channel, Message, User } from "@vencord/discord-types";
import { ChannelRouter, ChannelStore, GuildStore, Menu, SelectedChannelStore, StickersStore, Toasts, UserStore } from "@webpack/common";
import { findByPropsLazy } from "@webpack";

import { publicBundle, sealTo, serializeSealed } from "./crypto/asymmetric";
import { sealAttachment, sealAttachmentSealed } from "./crypto/attachment";
import { unpackBundle } from "./crypto/codec";
import { contextKey, getContext } from "./crypto/context";
import { makeCoverPng } from "./crypto/cover";
import { utf8Encode } from "./crypto/encoding";
import { CT_STICKER, CT_TEXT, packStickerBody, StickerRef } from "./crypto/envelope";
import { embedPrivateChunk } from "./crypto/imagecarrier";
import { buildKeyAnnounceWire, buildSealedWire, buildSymWire, trialDecode } from "./crypto/stealth";
import { detectWire, wrapWire } from "./crypto/stego";
import { buildKeyTransfer } from "./crypto/keytransfer";
import { splitMentions } from "./crypto/symmetric";
import { Context } from "./crypto/types";
import { insertMyKeyIntoChat } from "./dmActions";
import { EncryptionAccessory, decryptForChannel, handleDecryption, getDecryptedImages, getDecryptedVideos } from "./EncryptionAccessory";
import { EncryptionChatBarIcon, EncryptionIcon } from "./EncryptionIcon";
import { GuildKeyPicker } from "./GuildKeyPicker";
import { KeyEntryModal } from "./KeyEntryModal";
import { ensureIdentity, forcePinPeer, getChannelAutoEncrypt, getContextKeys, getCurrentKey, getCurrentPassword, getIdentity, getPeer, getRecord, getSelfId, loadStore } from "./store";
import { settings } from "./settings";
import { VaultUnlockModal } from "./VaultUnlockModal";
import { getRandomWords } from "./utils";
import { cleanupLegacyCache, decryptedNameForUrl, mapAttachmentsForRender, mapEmbedsForRender, mapStickersForRender } from "./EncryptionAccessory";

// Find Discord's upload modules  
const UploadStore = findByPropsLazy("getUploads", "upload");
const FileUtils = findByPropsLazy("makeFile");
const UploadAttachmentStore = findByPropsLazy("addFiles");
const CloudUpload = findByPropsLazy("CloudUpload", "upload");

// Find Discord's download/save modules
const DownloadModule = findByPropsLazy("downloadFile", "saveFile");
const AttachmentActions = findByPropsLazy("downloadAttachment");

// Force a real file download from a blob:/data: URL (Discord's <a> links have no `download` attr,
// and a blob: URL has no Content-Disposition, so a plain click just navigates instead of saving).
function directDownload(url: string, filename: string) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
}

// Files WE generated (already sealed cover-PNGs injected by the over-cap fallback). The upload
// interceptor must NOT re-encrypt these — they're complete envelopes already. Keyed by File
// identity: the interceptor passes the very same File object through to processFilesBeforeAdd.
const pluginFiles = new WeakSet<File>();
function markPluginFile(f: File) { pluginFiles.add(f); }

// Module-level handle to Discord's ORIGINAL (un-intercepted) addFiles, set by
// setupUploadInterception. onBeforeMessageSend is registered as a bare listener (no `this`
// binding — see PluginManager.startPlugin destructuring + MessageEvents._handlePreSend), so the
// over-cap fallback resolves the original through this module ref rather than `this.originalAddFiles`.
let pluginOriginalAddFiles: ((config: any) => any) | null = null;

// 6 random digits for an IMG_*.png filename (mirrors crypto/attachment.ts randomImageName style).
function rnd6(): string {
    const d = () => crypto.getRandomValues(new Uint8Array(1))[0] % 10;
    return [...Array(6)].map(d).join("");
}

// Helper function to check if file is an image
function isImageFile(fileItem: any): boolean {
    // Handle both direct File objects and Discord's file wrapper objects
    const actualFile = fileItem?.file || fileItem;
    
    if (!actualFile || !actualFile.type) {
        console.log("ChatEncryption: No file.type found for:", fileItem);
        return false;
    }
    
    console.log("ChatEncryption: Checking file type:", actualFile.type);
    return actualFile.type.startsWith('image/');
}

// Helper function to check if file is a video
function isVideoFile(fileItem: any): boolean {
    // Handle both direct File objects and Discord's file wrapper objects
    const actualFile = fileItem?.file || fileItem;
    
    if (!actualFile || !actualFile.type) {
        console.log("ChatEncryption: No file.type found for:", fileItem);
        return false;
    }
    
    console.log("ChatEncryption: Checking file type:", actualFile.type);
    return actualFile.type.startsWith('video/');
}

// Helper function to check if file is an audio file
function isAudioFile(fileItem: any): boolean {
    // Handle both direct File objects and Discord's file wrapper objects
    const actualFile = fileItem?.file || fileItem;
    
    if (!actualFile || !actualFile.type) {
        console.log("ChatEncryption: No file.type found for:", fileItem);
        return false;
    }
    
    console.log("ChatEncryption: Checking file type:", actualFile.type);
    return actualFile.type.startsWith('audio/');
}

// Attachments encrypt only when the active context has auto-encrypt on and the means to encrypt:
// a symmetric password (guild/group DM) or — for a 1:1 DM — our identity plus the peer's pinned key.
function shouldEncryptAttachments(): boolean {
    const channelId = SelectedChannelStore.getChannelId();
    const channel = channelId && ChannelStore.getChannel(channelId);
    if (!channel) return false;
    const ctx = getContext(channel, getSelfId());
    if (!getChannelAutoEncrypt(channelId)) return false;
    if (ctx.type === "dm") return getIdentity() != null && getPeer(ctx.id) != null;
    return getCurrentPassword(ctx) != null;
}

// Seal an uploaded file into a cover PNG (raw binary in a private PNG chunk). Any input type →
// a single IMG_*.png carrier. Passes the file through unmodified when the active context has no key.
async function createEncryptedFile(originalFile: File): Promise<File> {
    const channelId = SelectedChannelStore.getChannelId();
    const channel = channelId && ChannelStore.getChannel(channelId);
    if (!channel) return originalFile;
    const ctx = getContext(channel, getSelfId());

    // 1:1 DM → sealed-box (PGP/ECDH) cover, addressed to us + the pinned peer.
    if (ctx.type === "dm") {
        const id = getIdentity();
        const peer = getPeer(ctx.id);
        if (!id || !peer) return originalFile;    // identity or peer key missing → pass through
        return sealAttachmentSealed(originalFile, [publicBundle(id), peer.bundle], id.ecdsaPrivateJwk);
    }

    // Guild / group DM → symmetric cover.
    const current = await getCurrentKey(ctx);
    if (!current) return originalFile;            // no symmetric key for this context → pass through
    return sealAttachment(originalFile, current.key, contextKey(ctx)); // → IMG_*.png cover
}

const messageCtxPatch: NavContextMenuPatchCallback = (children, props) => {
    console.log("ChatEncryption: Message context menu patch called with props:", props);
    
    // Handle text decryption - check if there's a message
    if (props?.message) {
        const message = props.message;
        const content = getMessageContent(message);
        
        if (content) {
            const group = findGroupChildrenByChildId("copy-text", children);
            if (group) {
                // Add decrypt message option
                group.splice(group.findIndex(c => c?.props?.id === "copy-text") + 1, 0, (
                    <Menu.MenuItem
                        id="vc-decrypt"
                        label="Decrypt Message"
                        icon={EncryptionIcon}
                        action={async () => {
                            // decryptForChannel detects the stealth wire (zero-width / base64url) itself.
                            const outcome = await decryptForChannel(message.channel_id, content);
                            if (outcome.state === "decrypted") {
                                handleDecryption(message.id, { text: outcome.text, success: true });
                            } else if (outcome.state === "no-key") {
                                Toasts.show({
                                    message: "No encryption key set for this context.",
                                    id: Toasts.genId(),
                                    type: Toasts.Type.FAILURE
                                });
                            } else if (outcome.state === "missing-key") {
                                Toasts.show({
                                    message: "Encrypted with a key you don't have — ask for the current key.",
                                    id: Toasts.genId(),
                                    type: Toasts.Type.MESSAGE
                                });
                            }
                        }}
                    />
                ));

                // Manual save of a peer's PGP key from a key-announce (recover from accidental erasure /
                // old keys without asking them to re-share). Deliberate, MITM-accepting — verify first.
                // Sync gate: detect the stealth wire and structurally unpack a candidate bundle; the action
                // re-validates via trialDecode (self-consistent fingerprint) before saving.
                const wire = detectWire(content);
                const candidate = wire ? unpackBundle(wire.bytes) : null;
                const keyAuthor = message.author?.id;
                if (wire && candidate?.fingerprint && keyAuthor && keyAuthor !== getSelfId() && candidate.fingerprint !== getIdentity()?.fingerprint) {
                    group.push(
                        <Menu.MenuItem
                            id="vc-save-pgp-key"
                            label="Save PGP key"
                            icon={EncryptionIcon}
                            action={async () => {
                                const r = await trialDecode(wire.bytes, { symKeys: [] });
                                if (r?.kind !== "keyannounce") {
                                    Toasts.show({
                                        message: "That message isn't a valid key announcement.",
                                        id: Toasts.genId(),
                                        type: Toasts.Type.FAILURE
                                    });
                                    return;
                                }
                                await forcePinPeer(keyAuthor, r.bundle);
                                Toasts.show({
                                    message: `Saved ${(message.author as any)?.username ?? "their"} encryption key — verify the fingerprint.`,
                                    id: Toasts.genId(),
                                    type: Toasts.Type.SUCCESS
                                });
                            }}
                        />
                    );
                }
            }
        }
    }

    // Handle image copy/save for decrypted images - similar to reverse image search
    if (props?.reverseImageSearchType === "img") {
        console.log("ChatEncryption: Image in message context menu detected");
        const src = props.itemHref ?? props.itemSrc;
        
        if (src && isDecryptedMedia(src)) {
            console.log("ChatEncryption: Adding copy/save options for decrypted media in message context");
            // Try to find the group with copy-native-link (where Copy Link and Open Link are)
            const group = findGroupChildrenByChildId("copy-native-link", children) || 
                         findGroupChildrenByChildId("copy-link", children) ||
                         findGroupChildrenByChildId("open-native-link", children);
            
            console.log("ChatEncryption: Found group for copy/open link:", group);
            
            if (group) {
                const isImage = isDecryptedImage(src);
                const isVideo = isDecryptedVideo(src);
                const mediaType = isImage ? "Image" : "Video";
                
                group.push(
                    <Menu.MenuItem
                        id={`vc-copy-decrypted-${mediaType.toLowerCase()}-msg`}
                        label={`Copy ${mediaType}`}
                        icon={EncryptionIcon}
                        action={() => isImage ? copyDecryptedImage(src) : copyDecryptedVideo(src)}
                    />,
                    <Menu.MenuItem
                        id={`vc-save-decrypted-${mediaType.toLowerCase()}-msg`}
                        label={`Save ${mediaType}`}
                        icon={EncryptionIcon}
                        action={() => isImage ? saveDecryptedImage(src) : saveDecryptedVideo(src)}
                    />
                );
                console.log("ChatEncryption: Added copy/save options to message context menu");
            } else {
                console.log("ChatEncryption: No suitable group found in message context");
            }
        }
    }
};

// Image context menu patch for encrypted images - simplified like reverse image search
const imageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    console.log("ChatEncryption: Image context menu patch called with props:", props);
    console.log("ChatEncryption: Props src:", props?.src);
    console.log("ChatEncryption: Props keys:", Object.keys(props || {}));
    
    if (!props?.src) {
        console.log("ChatEncryption: No src, skipping");
        return;
    }
    
    // Check if this is decrypted media (image or video data URL from our cache)
    const isDecrypted = isDecryptedMedia(props.src);
    console.log("ChatEncryption: Is decrypted media:", isDecrypted);
    console.log("ChatEncryption: Media URL starts with:", props.src.substring(0, 50));
    
    if (isDecrypted) {
        console.log("ChatEncryption: Adding context menu items for decrypted media");
        
        const isImage = isDecryptedImage(props.src);
        const isVideo = isDecryptedVideo(props.src);
        const mediaType = isImage ? "Image" : "Video";
        
        // Find the group with copy-native-link (where "Copy Link" and "Open Link" are)
        const group = findGroupChildrenByChildId("copy-native-link", children);
        console.log("ChatEncryption: Found copy-native-link group:", group);
        
        if (group) {
            // Add copy and save options for decrypted media in the same group as copy/open link
            group.push(
                <Menu.MenuItem
                    id={`vc-copy-decrypted-${mediaType.toLowerCase()}`}
                    label={`Copy ${mediaType}`}
                    icon={EncryptionIcon}
                    action={() => isImage ? copyDecryptedImage(props.src) : copyDecryptedVideo(props.src)}
                />,
                <Menu.MenuItem
                    id={`vc-save-decrypted-${mediaType.toLowerCase()}`}
                    label={`Save ${mediaType}`}
                    icon={EncryptionIcon}
                    action={() => isImage ? saveDecryptedImage(props.src) : saveDecryptedVideo(props.src)}
                />
            );
            
            console.log("ChatEncryption: Added menu items to copy-native-link group, length now:", group.length);
        } else {
            console.log("ChatEncryption: copy-native-link group not found, adding to main children");
            // Fallback: add to main children if group not found
            children.push(
                <Menu.MenuItem
                    id={`vc-copy-decrypted-${mediaType.toLowerCase()}`}
                    label={`Copy ${mediaType}`}
                    icon={EncryptionIcon}
                    action={() => isImage ? copyDecryptedImage(props.src) : copyDecryptedVideo(props.src)}
                />,
                <Menu.MenuItem
                    id={`vc-save-decrypted-${mediaType.toLowerCase()}`}
                    label={`Save ${mediaType}`}
                    icon={EncryptionIcon}
                    action={() => isImage ? saveDecryptedImage(props.src) : saveDecryptedVideo(props.src)}
                />
            );
        }
    } else {
        console.log("ChatEncryption: Not decrypted media, skipping");
    }
};

// Guild-header popout: "Manage Encryption Key" → opens the key modal bound to the guild's context
const guildHeaderCtxPatch: NavContextMenuPatchCallback = (children, { guild }: { guild?: { id: string; }; }) => {
    if (!guild) return;
    children.push(
        <Menu.MenuItem
            id="vc-chatenc-setkey"
            label="Manage Encryption Key"
            icon={EncryptionIcon}
            action={() =>
                openModal(props => (
                    <KeyEntryModal rootProps={props} context={getContext({ id: guild.id, guild_id: guild.id }, getSelfId())} />
                ))
            }
        />
    );
};

// Helper function to check if an image URL is from our decrypted cache
function isDecryptedImage(imageUrl: string): boolean {
    console.log("ChatEncryption: Checking if image is decrypted:", imageUrl?.substring(0, 50));
    // Our decrypted images use data URLs
    const isDataUrl = imageUrl?.startsWith('data:image/');
    
    // Also check if this URL exists in our decrypted images cache
    const decryptedImages = getDecryptedImages();
    let isInCache = false;
    for (const [key, imageInfo] of decryptedImages.entries()) {
        const cachedDataUrl = `data:${imageInfo.mimeType};base64,${imageInfo.imageData}`;
        if (cachedDataUrl === imageUrl) {
            isInCache = true;
            break;
        }
    }
    
    console.log("ChatEncryption: Is data URL:", isDataUrl, "Is in cache:", isInCache);
    return isDataUrl || isInCache;
}

// Helper function to check if a video URL is from our decrypted cache
function isDecryptedVideo(videoUrl: string): boolean {
    console.log("ChatEncryption: Checking if video is decrypted:", videoUrl?.substring(0, 50));
    // Our decrypted videos use data URLs
    const isDataUrl = videoUrl?.startsWith('data:video/');
    
    // Also check if this URL exists in our decrypted videos cache
    const decryptedVideos = getDecryptedVideos();
    let isInCache = false;
    for (const [key, videoInfo] of decryptedVideos.entries()) {
        const cachedDataUrl = `data:${videoInfo.mimeType};base64,${videoInfo.videoData}`;
        if (cachedDataUrl === videoUrl) {
            isInCache = true;
            break;
        }
    }
    
    console.log("ChatEncryption: Is video data URL:", isDataUrl, "Is in cache:", isInCache);
    return isDataUrl || isInCache;
}

// Helper function to check if a media URL is from our decrypted cache (images or videos)
function isDecryptedMedia(mediaUrl: string): boolean {
    return isDecryptedImage(mediaUrl) || isDecryptedVideo(mediaUrl);
}

// Helper function to copy decrypted image to clipboard
async function copyDecryptedImage(imageUrl: string) {
    try {
        // Convert data URL to blob
        const response = await fetch(imageUrl);
        let imageData = await response.blob();
        
        // Get original image info from our cache
        const decryptedImages = getDecryptedImages();
        let originalMimeType = imageData.type;
        let filename = "image";
        
        // Find the original image data to get proper mime type and filename
        for (const [key, imageInfo] of decryptedImages.entries()) {
            const cachedDataUrl = `data:${imageInfo.mimeType};base64,${imageInfo.imageData}`;
            if (cachedDataUrl === imageUrl) {
                originalMimeType = imageInfo.mimeType;
                filename = imageInfo.filename;
                console.log("ChatEncryption: Found original image info:", filename, originalMimeType);
                break;
            }
        }
        
        // Try to copy in original format first
        try {
            const clipboardData: Record<string, Blob> = {};
            
            // Add the original format
            if (originalMimeType && originalMimeType.startsWith('image/')) {
                clipboardData[originalMimeType] = imageData;
                console.log("ChatEncryption: Adding original format to clipboard:", originalMimeType);
            }
            
            // Also add PNG as fallback for compatibility
            if (originalMimeType !== "image/png") {
                const bitmap = await createImageBitmap(imageData);
                const canvas = document.createElement("canvas");
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const ctx = canvas.getContext("2d");
                if (ctx) {
                    ctx.drawImage(bitmap, 0, 0);
                    
                    const pngBlob = await new Promise<Blob | null>(resolve => {
                        canvas.toBlob(data => resolve(data), "image/png");
                    });
                    
                    if (pngBlob) {
                        clipboardData["image/png"] = pngBlob;
                        console.log("ChatEncryption: Added PNG fallback to clipboard");
                    }
                }
            }
            
            // Copy to clipboard with multiple formats
            await navigator.clipboard.write([new ClipboardItem(clipboardData)]);
            
            console.log(`ChatEncryption: Successfully copied decrypted image "${filename}" to clipboard in original format (${originalMimeType})`);
        } catch (error) {
            console.warn("ChatEncryption: Failed to copy in original format, falling back to PNG:", error);
            
            // Fallback: convert to PNG and copy
            const bitmap = await createImageBitmap(imageData);
            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext("2d");
            if (ctx) {
                ctx.drawImage(bitmap, 0, 0);
                
                const pngBlob = await new Promise<Blob | null>(resolve => {
                    canvas.toBlob(data => resolve(data), "image/png");
                });
                
                if (pngBlob) {
                    await navigator.clipboard.write([
                        new ClipboardItem({ "image/png": pngBlob })
                    ]);
                    console.log("ChatEncryption: Successfully copied as PNG fallback");
                }
            }
        }
        
    } catch (error) {
        console.error("ChatEncryption: Failed to copy decrypted image:", error);
    }
}

// Helper function to save decrypted image
async function saveDecryptedImage(imageUrl: string) {
    try {
        // Convert data URL to blob
        const response = await fetch(imageUrl);
        const imageData = await response.blob();
        
        // Get original filename from decrypted images cache or create default
        const decryptedImages = getDecryptedImages();
        let filename = "decrypted_image.png";
        
        // Try to find the original filename
        for (const [key, imageInfo] of decryptedImages.entries()) {
            const cachedDataUrl = `data:${imageInfo.mimeType};base64,${imageInfo.imageData}`;
            if (cachedDataUrl === imageUrl) {
                filename = imageInfo.filename;
                break;
            }
        }
        
        // Create file and trigger download
        const file = new File([imageData], filename, { type: imageData.type });
        
        // Create download link
        const downloadUrl = URL.createObjectURL(file);
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = filename;
        link.style.display = 'none';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Clean up object URL
        URL.revokeObjectURL(downloadUrl);
        
        console.log("ChatEncryption: Successfully saved decrypted image:", filename);
    } catch (error) {
        console.error("ChatEncryption: Failed to save decrypted image:", error);
    }
}

// Helper function to copy decrypted video to clipboard
async function copyDecryptedVideo(videoUrl: string) {
    try {
        // Convert data URL to blob
        const response = await fetch(videoUrl);
        const videoData = await response.blob();
        
        // Get original video info from our cache
        const decryptedVideos = getDecryptedVideos();
        let originalMimeType = videoData.type;
        let filename = "video";
        
        // Find the original video data to get proper mime type and filename
        for (const [key, videoInfo] of decryptedVideos.entries()) {
            const cachedDataUrl = `data:${videoInfo.mimeType};base64,${videoInfo.videoData}`;
            if (cachedDataUrl === videoUrl) {
                originalMimeType = videoInfo.mimeType;
                filename = videoInfo.filename;
                console.log("ChatEncryption: Found original video info:", filename, originalMimeType);
                break;
            }
        }
        
        // Try to copy video to clipboard (note: video clipboard support is limited)
        try {
            const clipboardData: Record<string, Blob> = {};
            
            // Add the original format
            if (originalMimeType && originalMimeType.startsWith('video/')) {
                clipboardData[originalMimeType] = videoData;
                console.log("ChatEncryption: Adding original video format to clipboard:", originalMimeType);
            }
            
            // Copy to clipboard
            await navigator.clipboard.write([new ClipboardItem(clipboardData)]);
            
            console.log(`ChatEncryption: Successfully copied decrypted video "${filename}" to clipboard in original format (${originalMimeType})`);
        } catch (error) {
            console.warn("ChatEncryption: Video clipboard not supported, falling back to save:", error);
            // Fallback: save the video instead since video clipboard support is limited
            await saveDecryptedVideo(videoUrl);
        }
        
    } catch (error) {
        console.error("ChatEncryption: Failed to copy decrypted video:", error);
    }
}

// Helper function to save decrypted video
async function saveDecryptedVideo(videoUrl: string) {
    try {
        // Convert data URL to blob
        const response = await fetch(videoUrl);
        const videoData = await response.blob();
        
        // Get original filename from decrypted videos cache or create default
        const decryptedVideos = getDecryptedVideos();
        let filename = "decrypted_video.mp4";
        
        // Try to find the original filename
        for (const [key, videoInfo] of decryptedVideos.entries()) {
            const cachedDataUrl = `data:${videoInfo.mimeType};base64,${videoInfo.videoData}`;
            if (cachedDataUrl === videoUrl) {
                filename = videoInfo.filename;
                break;
            }
        }
        
        // Create file and trigger download
        const file = new File([videoData], filename, { type: videoData.type });
        
        // Create download link
        const downloadUrl = URL.createObjectURL(file);
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = filename;
        link.style.display = 'none';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Clean up object URL
        URL.revokeObjectURL(downloadUrl);
        
        console.log("ChatEncryption: Successfully saved decrypted video:", filename);
    } catch (error) {
        console.error("ChatEncryption: Failed to save decrypted video:", error);
    }
}

function getMessageContent(message: Message) {
    return message.content
        || message.messageSnapshots?.[0]?.message.content
        || message.embeds?.find(embed => embed.type === "auto_moderation_message")?.rawDescription || "";
}

// Discord's message-length cap (full Nitro raises it to 4000). Used to decide if a stego'd message fits.
function maxMessageLength(): number {
    return (UserStore.getCurrentUser() as any)?.premiumType === 2 ? 4000 : 2000;
}

// TOFU handshake: publish our public-key bundle into a DM so the peer can auto-pin it.
// Returns true if a key was published (caller should abort encrypting this turn).
async function publishKeyIfNeeded(channelId: string): Promise<boolean> {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return false;

    const ctx = getContext(channel, getSelfId());
    if (ctx.type !== "dm") return false;
    if (getPeer(ctx.id)) return false; // already have the peer's key — nothing to publish

    const id = await ensureIdentity();
    const bytes = await buildKeyAnnounceWire(publicBundle(id));
    const rec = getRecord(contextKey(ctx));
    sendMessage(channelId, { content: wrapWire(bytes, { stego: rec.stego, words: getRandomWords(4) }) });
    Toasts.show({
        message: "Shared your encryption key — ask them to do the same to start an encrypted chat.",
        id: Toasts.genId(),
        type: Toasts.Type.MESSAGE
    });
    return true;
}

// "Start encrypted chat" — publish our key into the current/target DM unconditionally.
async function startEncryptedChat(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return;

    const ctx = getContext(channel, getSelfId());
    if (ctx.type !== "dm") {
        Toasts.show({
            message: "Encrypted chat handshake is only available in 1:1 DMs.",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
        return;
    }

    await insertMyKeyIntoChat();
    Toasts.show({
        message: "Inserted your encryption key into the message box — review and send it.",
        id: Toasts.genId(),
        type: Toasts.Type.SUCCESS
    });
}

// Seal a context's current symmetric key to a pinned 1:1 DM peer and post it as a sealed message.
// `sourceCtx` is the context whose key is being shared (a guild or the group DM itself).
async function sendServerKey(channelId: string, sourceCtx: Context) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return;

    const ctx = getContext(channel, getSelfId());
    if (ctx.type !== "dm") return;

    const peer = getPeer(ctx.id);
    const id = getIdentity();
    if (!peer || !id) {
        Toasts.show({
            message: "Set up an encrypted chat with this person first (no pinned key yet).",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
        return;
    }

    const rec = getRecord(contextKey(sourceCtx));
    const current = rec.currentKeyId && rec.keys.find(k => k.keyId === rec.currentKeyId);
    if (!current) {
        Toasts.show({
            message: "No key to send for that server.",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
        return;
    }

    const guild = sourceCtx.type === "guild" ? GuildStore.getGuild(sourceCtx.id) : null;
    const guildName = guild?.name ?? (sourceCtx.type === "groupdm" ? (channel.name || "Group DM") : sourceCtx.id);

    const text = buildKeyTransfer({
        guildId: sourceCtx.id,
        guildName,
        password: current.password,
        fromFingerprint: id.fingerprint,
    });
    const sealed = await sealTo(text, [publicBundle(id), peer.bundle], id.ecdsaPrivateJwk);
    // Insert a VISIBLE markerless token the user can review; onBeforeMessageSend re-detects it via
    // detectWire on send and leaves it untouched (never re-encrypts an existing stealth wire).
    const wire = wrapWire(utf8Encode(serializeSealed(sealed)), { stego: false, words: getRandomWords(4) });
    ChannelRouter.transitionToChannel(channelId); // open/focus the DM so its message box is the target
    setTimeout(() => insertTextIntoChatInputBox(wire), 100); // let the channel switch settle, then paste
    Toasts.show({
        message: `Key for ${guildName} is in the message box — review and send it.`,
        id: Toasts.genId(),
        type: Toasts.Type.SUCCESS
    });
}

// Open the server-icon picker (send mode) in a DM, listing servers that currently have a key.
function openSendKeyPicker(channelId: string) {
    openModal(props => (
        <GuildKeyPicker
            rootProps={props}
            mode="send"
            onSend={sourceCtx => sendServerKey(channelId, sourceCtx)}
        />
    ));
}

// Group-DM key distribution: seal the group's current key to ALL pinned recipients (≤10) at once,
// posting a single sealed message in the group DM. Each recipient saves it via the key-transfer card.
async function distributeGroupKey(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return;

    const ctx = getContext(channel, getSelfId());
    if (ctx.type !== "groupdm") {
        Toasts.show({
            message: "Group key distribution is only available in group DMs.",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
        return;
    }

    const id = getIdentity();
    if (!id) {
        Toasts.show({
            message: "Your encryption identity is not ready yet.",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
        return;
    }

    const rec = getRecord(contextKey(ctx));
    const current = rec.currentKeyId && rec.keys.find(k => k.keyId === rec.currentKeyId);
    if (!current) {
        Toasts.show({
            message: "Set a key for this group DM first.",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
        return;
    }

    const selfId = getSelfId();
    const recipientIds = (channel.recipients ?? []).filter(r => r !== selfId);
    const recipients = recipientIds.map(r => getPeer(r)).filter((p): p is NonNullable<typeof p> => !!p);
    if (recipients.length === 0) {
        Toasts.show({
            message: "No pinned recipients yet — exchange keys with members first.",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
        return;
    }

    const missing = recipientIds.length - recipients.length;
    const bundles = recipients.map(p => p.bundle).slice(0, 9); // ≤10 wraps incl. self

    const text = buildKeyTransfer({
        guildId: ctx.id,
        guildName: channel.name || "Group DM",
        password: current.password,
        fromFingerprint: id.fingerprint,
    });
    const sealed = await sealTo(text, [publicBundle(id), ...bundles], id.ecdsaPrivateJwk);
    const bytes = utf8Encode(serializeSealed(sealed));
    sendMessage(channelId, { content: wrapWire(bytes, { stego: rec.stego, words: getRandomWords(4) }) });
    Toasts.show({
        message: missing > 0
            ? `Distributed the group key to ${bundles.length} member(s); ${missing} not yet pinned.`
            : `Distributed the group key to ${bundles.length} member(s).`,
        id: Toasts.genId(),
        type: Toasts.Type.SUCCESS
    });
}

// User context menu (DM): "Start encrypted chat" → publishes your public key to that DM;
// once a peer is pinned, also offers "Send a server's key" via the server-icon picker.
const userCtxPatch: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; user?: User; }) => {
    if (!channel || !channel.isDM?.()) return;
    children.push(
        <Menu.MenuItem
            id="vc-chatenc-start-encrypted"
            label="Share my encryption key"
            icon={EncryptionIcon}
            action={() => startEncryptedChat(channel.id)}
        />
    );
    if (getPeer(getContext(channel, getSelfId()).id)) {
        children.push(
            <Menu.MenuItem
                id="vc-chatenc-send-server-key"
                label="Send a server's key"
                icon={EncryptionIcon}
                action={() => openSendKeyPicker(channel.id)}
            />
        );
    }
};

// Group-DM context menu: "Distribute group key" → seals the group key to all pinned members.
const gdmCtxPatch: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    if (!channel) return;
    children.push(
        <Menu.MenuItem
            id="vc-chatenc-distribute-group-key"
            label="Distribute group key"
            icon={EncryptionIcon}
            action={() => distributeGroupKey(channel.id)}
        />
    );
};


export default definePlugin({
    name: "ChatEncryption",
    description: "Encrypt and decrypt Discord messages with AES-256-GCM encryption",
    authors: [
        {
        id: 236950175480807424n,
        name: "max2fly"
        }
    ],
    settings,

    patches: [
        {
            // Substitute our decrypted attachment at render time (copied from fakeNitro's filterAttachments
            // patch). Render-time → nothing to revert: every re-render re-runs mapAttachments, so the cover
            // is replaced afresh each time and there's no store mutation/MESSAGE_UPDATE re-swap loop.
            find: "}renderStickersAccessories(",
            replacement: [
                {
                    match: /renderAttachments\(\i\){.+?{attachments:(\i).+?;/,
                    replace: (m, attachments) => `${m}${attachments}=$self.mapAttachments(${attachments});`
                },
                {
                    // Inject our client-recreated media embeds (Tenor/Giphy/direct) for decrypted
                    // messages at the START of renderEmbeds — reassign the message's embeds BEFORE any
                    // length-check/early-return or the .map, so an encrypted message (0 server embeds)
                    // still gets our synthesized ones. The param IS the message (fakeNitro treats it so).
                    match: /renderEmbeds\((\i)\){/,
                    replace: (m, msg) => `${m}${msg}.embeds=$self.mapEmbeds(${msg}.embeds,${msg});`
                },
                {
                    // Inject our decrypted native stickers into the stickers array (fakeNitro's
                    // patchFakeNitroStickers mechanism). Render-time → revert-proof like mapAttachments.
                    match: /renderStickersAccessories\((\i)\){let (\i)=\(0,\i\.\i\)\(\i\).+?;/,
                    replace: (m, message, stickers) => `${m}${stickers}=$self.mapStickers(${stickers},${message});`
                }
            ]
        }
    ],

    contextMenus: {
        "message": messageCtxPatch,
        "image-context": imageContextMenuPatch,
        "guild-header-popout": guildHeaderCtxPatch,
        "user-context": userCtxPatch,
        "gdm-context": gdmCtxPatch
    },

    renderMessageAccessory: props => <EncryptionAccessory message={props.message} />,

    // Called by the renderAttachments patch: swap any decrypted cover attachment for its synthetic
    // (decrypted url/mime/name/dims) at render time. Returns the input untouched on any failure.
    mapAttachments(attachments: any[]) {
        try { return mapAttachmentsForRender(attachments); } catch { return attachments; }
    },

    mapEmbeds(embeds: any[], message: any) {
        try { return mapEmbedsForRender(message, embeds); } catch { return embeds; }
    },

    // Called by the renderStickersAccessories patch: append decrypted native stickers at render time.
    mapStickers(stickers: any[], message: any) {
        try { return mapStickersForRender(stickers, message); } catch { return stickers; }
    },

    chatBarButton: {
        icon: EncryptionIcon,
        render: EncryptionChatBarIcon
    },

    // Runtime interception setup
    originalAddFiles: null as any,
    originalDownloadFunction: null as any,
    downloadClickHandler: null as any,
    originalFetch: null as any,
    
    setupUploadInterception() {
        console.log("ChatEncryption: Setting up upload interception...");
        
        try {
            // Wait for modules to be available
            setTimeout(() => {
                if (UploadAttachmentStore && UploadAttachmentStore.addFiles) {
                    console.log("ChatEncryption: Found UploadAttachmentStore.addFiles, intercepting...");
                    
                    // Store original function (both on the plugin, for stop(), and at module level so
                    // the bare-listener onBeforeMessageSend over-cap fallback can reach it without `this`).
                    this.originalAddFiles = UploadAttachmentStore.addFiles.bind(UploadAttachmentStore);
                    pluginOriginalAddFiles = this.originalAddFiles;

                    // Replace with our interceptor
                    UploadAttachmentStore.addFiles = async (uploadConfig: any) => {
                        console.log("ChatEncryption: addFiles intercepted with uploadConfig:", uploadConfig);
                        
                        if (uploadConfig && uploadConfig.files && Array.isArray(uploadConfig.files)) {
                            console.log("ChatEncryption: Found files in uploadConfig:", uploadConfig.files);
                            
                            if (shouldEncryptAttachments()) {
                                console.log("ChatEncryption: Processing files...");
                                const processedFiles = await this.processFilesBeforeAdd(uploadConfig.files);
                                
                                // Create modified config with processed files
                                const modifiedConfig = {
                                    ...uploadConfig,
                                    files: processedFiles
                                };
                                
                                console.log("ChatEncryption: Calling original addFiles with processed files");
                                return this.originalAddFiles(modifiedConfig);
                            }
                        }
                        
                        return this.originalAddFiles(uploadConfig);
                    };
                    
                    console.log("ChatEncryption: Upload interception setup complete");
                } else {
                    console.warn("ChatEncryption: UploadAttachmentStore.addFiles not found, retrying...");
                    // Retry in case modules aren't loaded yet
                    setTimeout(() => this.setupUploadInterception(), 1000);
                }
            }, 100);
        } catch (error) {
            console.error("ChatEncryption: Failed to setup upload interception:", error);
        }
    },

    // Process files before they're added to the upload store
    async processFilesBeforeAdd(files: any) {
        console.log("ChatEncryption: processFilesBeforeAdd called with files:", files);
        console.log("ChatEncryption: files type:", typeof files);
        console.log("ChatEncryption: files is array:", Array.isArray(files));
        
        // Handle case where files might not be an array or might be undefined
        if (!files) {
            console.log("ChatEncryption: files is null/undefined, returning as-is");
            return files;
        }
        
        // Convert to array if it's not already
        const filesArray = Array.isArray(files) ? files : [files];
        console.log("ChatEncryption: filesArray:", filesArray);
        
        if (!shouldEncryptAttachments()) {
            console.log("ChatEncryption: Skipping - encryption not enabled or no key for this context");
            return files;
        }

        // Process each file and replace with encrypted version (all types in this context)
        const processedFiles = [];
        for (let i = 0; i < filesArray.length; i++) {
            const fileItem = filesArray[i];
            console.log(`ChatEncryption: Processing file ${i}:`, fileItem);

            const actualFile = fileItem.file || fileItem;

            // Already-sealed cover PNGs we injected ourselves (over-cap text fallback) must pass through
            // untouched — re-encrypting would wrap a finished envelope in a second cover and the receiver
            // would never decrypt it. Keyed on File identity, which survives into this loop intact.
            if (actualFile instanceof File && pluginFiles.has(actualFile)) {
                console.log("ChatEncryption: Skipping re-encryption of plugin-generated file:", actualFile.name);
                processedFiles.push(fileItem);
                continue;
            }

            if (fileItem) {
                try {
                    let fileType = "file";
                    if (isImageFile(fileItem)) fileType = "image";
                    else if (isVideoFile(fileItem)) fileType = "video";
                    else if (isAudioFile(fileItem)) fileType = "audio";

                    console.log(`ChatEncryption: Encrypting ${fileType} file:`, actualFile.name);
                    
                    const encryptedFile = await createEncryptedFile(actualFile);
                    console.log("ChatEncryption: Created encrypted file:", encryptedFile);
                    
                    // Create new file item with encrypted file
                    const processedFileItem = {
                        ...fileItem,
                        file: encryptedFile
                    };
                    
                    processedFiles.push(processedFileItem);
                    console.log(`ChatEncryption: Successfully processed ${fileType} file`);
                    
                } catch (error) {
                    console.error("ChatEncryption: Failed to encrypt file:", error);
                    processedFiles.push(fileItem); // fallback to original
                }
            } else {
                console.log(`ChatEncryption: File ${i} is not an encryptable type or encryption disabled, keeping original`);
                processedFiles.push(fileItem);
            }
        }
        
        console.log("ChatEncryption: Finished processing files, returning:", processedFiles);
        return processedFiles;
    },

    // Process all uploads in-place before Discord handles them
    async processUploadsBlocking(uploads: any[]) {
        console.log("ChatEncryption: processUploadsBlocking called with uploads:", uploads);
        
        if (!shouldEncryptAttachments()) {
            console.log("ChatEncryption: Skipping - encryption not enabled or no key for this context");
            return;
        }

        // Process uploads in-place - modify the array elements directly
        for (let i = 0; i < uploads.length; i++) {
            const upload = uploads[i];
            console.log(`ChatEncryption: Processing upload ${i}:`, upload);
            
            // Check if this upload has an image file
            if (upload?.item?.file && isImageFile(upload.item.file)) {
                try {
                    console.log("ChatEncryption: Encrypting image upload:", upload.filename);
                    
                    const encryptedFile = await createEncryptedFile(upload.item.file);
                    console.log("ChatEncryption: Created encrypted file:", encryptedFile);
                    
                    // Modify the upload object in-place
                    upload.item.file = encryptedFile;
                    upload.filename = encryptedFile.name;
                    upload.mimeType = encryptedFile.type;
                    upload.isImage = false;
                    upload.isVideo = false;
                    upload.classification = null;
                    
                    // Update size properties
                    upload.currentSize = encryptedFile.size;
                    upload.preCompressionSize = encryptedFile.size;
                    upload.postCompressionSize = encryptedFile.size;
                    
                    // Clear cached properties
                    upload.contentHash = null;
                    upload.etag = null;
                    
                    console.log("ChatEncryption: Successfully encrypted upload:", upload.filename);
                    
                    // Log file content preview
                    const reader = new FileReader();
                    reader.onload = () => {
                        const content = reader.result as string;
                        console.log("ChatEncryption: Encrypted file content preview:", content.substring(0, 100));
                    };
                    reader.readAsText(encryptedFile);
                    
                } catch (error) {
                    console.error("ChatEncryption: Failed to encrypt upload:", error);
                }
            } else {
                console.log(`ChatEncryption: Upload ${i} is not an image file, skipping`);
            }
        }
        
        console.log("ChatEncryption: Finished processing all uploads");
    },

    setupDownloadInterception() {
        console.log("ChatEncryption: Setting up download interception for encrypted videos...");
        
        try {
            // Wait for modules to be available
            setTimeout(() => {
                // Debug: log what's available in the modules
                console.log("ChatEncryption: DownloadModule:", DownloadModule);
                console.log("ChatEncryption: AttachmentActions:", AttachmentActions);
                
                if (DownloadModule) {
                    console.log("ChatEncryption: DownloadModule keys:", Object.keys(DownloadModule));
                }
                if (AttachmentActions) {
                    console.log("ChatEncryption: AttachmentActions keys:", Object.keys(AttachmentActions));
                }
                
                // Try multiple potential download modules
                let downloadFunction = null;
                
                if (DownloadModule && DownloadModule.downloadFile) {
                    downloadFunction = DownloadModule.downloadFile;
                    console.log("ChatEncryption: Found DownloadModule.downloadFile");
                } else if (DownloadModule && DownloadModule.saveFile) {
                    downloadFunction = DownloadModule.saveFile;
                    console.log("ChatEncryption: Found DownloadModule.saveFile");
                } else if (AttachmentActions && AttachmentActions.downloadAttachment) {
                    downloadFunction = AttachmentActions.downloadAttachment;
                    console.log("ChatEncryption: Found AttachmentActions.downloadAttachment");
                }
                
                if (downloadFunction) {
                    // Store original function
                    this.originalDownloadFunction = downloadFunction.bind(downloadFunction.constructor);
                    
                    // Replace with our interceptor
                    const originalFunc = downloadFunction;
                    const interceptor = (url: string, filename?: string, ...args: any[]) => {
                        // Our decrypted attachments use blob:/data: URLs that already hold the plaintext
                        // bytes. Discord's native download can't fetch those, so download them directly
                        // via a temporary <a download>. Everything else passes through unchanged.
                        if (typeof url === "string" && (url.startsWith("blob:") || url.startsWith("data:"))) {
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = filename || "download";
                            document.body.appendChild(a);
                            a.click();
                            a.remove();
                            return;
                        }
                        return originalFunc(url, filename, ...args);
                    };
                    
                    // Replace the function
                    if (DownloadModule && DownloadModule.downloadFile === originalFunc) {
                        DownloadModule.downloadFile = interceptor;
                    } else if (DownloadModule && DownloadModule.saveFile === originalFunc) {
                        DownloadModule.saveFile = interceptor;
                    } else if (AttachmentActions && AttachmentActions.downloadAttachment === originalFunc) {
                        AttachmentActions.downloadAttachment = interceptor;
                    }
                    
                    console.log("ChatEncryption: Download interception setup complete");
                } else {
                    console.warn("ChatEncryption: Download functions not found, falling back to DOM interception");
                    this.setupDOMDownloadInterception();
                }
            }, 100);
            
            // Also set up DOM interception regardless for testing
            setTimeout(() => {
                console.log("ChatEncryption: Setting up additional DOM interception for testing");
                this.setupDOMDownloadInterception();
            }, 200);
        } catch (error) {
            console.error("ChatEncryption: Failed to setup download interception:", error);
            // Fallback to DOM-based interception
            this.setupDOMDownloadInterception();
        }
    },
    
    setupDOMDownloadInterception() {
        // Discord renders attachment download buttons + filename links as plain
        // <a href="blob:..." target="_blank"> with NO `download` attribute, so a click just navigates
        // to the blob (nothing happens for a binary). Force a real download for any anchor whose href
        // is one of OUR decrypted attachments; every other link (normal cdn URLs) is left to Discord.
        this.downloadClickHandler = (event: MouseEvent) => {
            const anchor = (event.target as HTMLElement)?.closest?.("a[href]") as HTMLAnchorElement | null;
            if (!anchor) return;
            // Skip our own directDownload() anchor (it has a `download` attr; Discord's broken ones don't)
            // so the synthetic click isn't re-intercepted → infinite recursion → stack overflow.
            if (anchor.hasAttribute("download")) return;
            // Act ONLY on genuine download controls: the hover "Download" button or a file's name link.
            // NOT the image's zoom/originalLink anchor (aria-hidden, same data: href) or the media itself —
            // those must keep opening the lightbox / playing.
            const isDownloadBtn = anchor.getAttribute("aria-label") === "Download"
                || !!anchor.querySelector?.("[class*='downloadHoverButton']");
            const isFilenameLink = /fileNameLink/.test(anchor.className || "");
            if (!isDownloadBtn && !isFilenameLink) return;
            const href = anchor.getAttribute("href") || "";
            if (!href.startsWith("blob:") && !href.startsWith("data:")) return;
            const name = decryptedNameForUrl(href);
            if (!name) return; // not one of ours
            event.preventDefault();
            event.stopPropagation();
            directDownload(href, name);
        };
        document.addEventListener("click", this.downloadClickHandler, true);
    },

    setupNetworkInterception() {
        console.log("ChatEncryption: Setting up comprehensive network request logging");
        
        // Store original fetch and XMLHttpRequest
        const originalFetch = window.fetch;
        const OriginalXMLHttpRequest = window.XMLHttpRequest;
        
        // Log ALL fetch requests to see what's happening
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = input.toString();
            
            // Log all blob requests
            if (url.startsWith('blob:')) {
                console.log("ChatEncryption: FETCH REQUEST - Blob URL:", url);
                console.log("ChatEncryption: FETCH REQUEST - Full URL:", url);
                console.log("ChatEncryption: FETCH REQUEST - Has format param:", url.includes('format='));
                console.log("ChatEncryption: FETCH REQUEST - Has width param:", url.includes('width='));
                console.log("ChatEncryption: FETCH REQUEST - Has height param:", url.includes('height='));
            }
            
            // Call original fetch
            return originalFetch(input, init);
        };
        
        // Log ALL XMLHttpRequest requests
        window.XMLHttpRequest = function() {
            const xhr = new OriginalXMLHttpRequest();
            const originalOpen = xhr.open;
            
            xhr.open = function(method: string, url: string | URL, ...args: any[]) {
                const urlStr = url.toString();
                
                // Log all blob requests
                if (urlStr.startsWith('blob:')) {
                    console.log("ChatEncryption: XHR REQUEST - Method:", method);
                    console.log("ChatEncryption: XHR REQUEST - Blob URL:", urlStr);
                    console.log("ChatEncryption: XHR REQUEST - Full URL:", urlStr);
                    console.log("ChatEncryption: XHR REQUEST - Has format param:", urlStr.includes('format='));
                    console.log("ChatEncryption: XHR REQUEST - Has width param:", urlStr.includes('width='));
                    console.log("ChatEncryption: XHR REQUEST - Has height param:", urlStr.includes('height='));
                }
                
                return originalOpen.call(this, method, url, ...args);
            };
            
            return xhr;
        };
        
        // Also add a global error listener to catch network errors
        window.addEventListener('error', (event) => {
            if (event.target && (event.target as any).src && (event.target as any).src.startsWith('blob:')) {
                console.log("ChatEncryption: NETWORK ERROR - Failed to load blob:", (event.target as any).src);
                console.log("ChatEncryption: NETWORK ERROR - Element type:", event.target.constructor.name);
                console.log("ChatEncryption: NETWORK ERROR - Full event:", event);
            }
        }, true);
        
        this.originalFetch = originalFetch;
        this.originalXMLHttpRequest = OriginalXMLHttpRequest;
    },

    async start() {
        console.log("ChatEncryption: Plugin starting...");

        // Load the per-context key/record store before any decrypt sweep, driving the vault unlock flow
        const status = await loadStore();
        if (status === "locked") {
            openModal(props => <VaultUnlockModal rootProps={props} fresh={false} />);
        } else if (status === "fresh" && settings.store.vaultEncrypted) {
            openModal(props => <VaultUnlockModal rootProps={props} fresh={true} />);
        } else {
            await ensureIdentity(); // plaintext vault or already-loaded: make sure identity exists
        }

        // Clean up old cached data without dimensions
        cleanupLegacyCache();

        // Auto-decrypt messages when the plugin starts
        this.autoDecryptVisibleMessages();
        
        // Intercept Discord's upload functions at runtime
        this.setupUploadInterception();
        
        // Setup download interception for encrypted videos
        console.log("ChatEncryption: About to setup download interception...");
        this.setupDownloadInterception();

        // Setup network request interception to block blob thumbnail fetches
        this.setupNetworkInterception();
        
        console.log("ChatEncryption: Plugin startup complete");
    },

    stop() {
        // Clean up when plugin is disabled
        if (this.originalAddFiles && UploadAttachmentStore) {
            console.log("ChatEncryption: Restoring original addFiles function");
            UploadAttachmentStore.addFiles = this.originalAddFiles;
            this.originalAddFiles = null;
            pluginOriginalAddFiles = null;
        }
        
        // Clean up download interception
        if (this.originalDownloadFunction) {
            console.log("ChatEncryption: Restoring original download function");
            if (DownloadModule && DownloadModule.downloadFile) {
                DownloadModule.downloadFile = this.originalDownloadFunction;
            } else if (DownloadModule && DownloadModule.saveFile) {
                DownloadModule.saveFile = this.originalDownloadFunction;
            } else if (AttachmentActions && AttachmentActions.downloadAttachment) {
                AttachmentActions.downloadAttachment = this.originalDownloadFunction;
            }
            this.originalDownloadFunction = null;
        }

        // Clean up the decrypted-attachment download click handler
        if (this.downloadClickHandler) {
            document.removeEventListener("click", this.downloadClickHandler, true);
            this.downloadClickHandler = null;
        }

        // Clean up fetch interception
        if (this.originalFetch) {
            console.log("ChatEncryption: Restoring original fetch");
            window.fetch = this.originalFetch;
            this.originalFetch = null;
        }
    },

    async autoDecryptVisibleMessages() {
        // Process messages in the background, with delay to let Discord load messages first.
        // decryptAllQueuedMessages resolves each message's per-context key internally.
        setTimeout(async () => {
            const { decryptAllQueuedMessages, restoreAllCachedAttachments } = await import("./EncryptionAccessory");
            
            // Process any new encrypted messages first
            decryptAllQueuedMessages();
            
            // Then restore cached attachments after Discord has loaded messages
            setTimeout(() => {
                restoreAllCachedAttachments();
                
                // Set up periodic restoration in case of race conditions
                const intervalId = setInterval(() => {
                    restoreAllCachedAttachments();
                }, 2000);
                
                // Stop after 10 seconds to avoid infinite checking
                setTimeout(() => clearInterval(intervalId), 10000);
            }, 2000);
        }, 1000);
    },

    messagePopoverButton: {
        icon: EncryptionIcon,
        render(message: Message) {
            const content = getMessageContent(message);
            if (!content) return null;

            return {
                label: "Decrypt",
                icon: EncryptionIcon,
                message,
                channel: ChannelStore.getChannel(message.channel_id),
                onClick: async () => {
                    // decryptForChannel detects the stealth wire (zero-width / base64url) itself.
                    const outcome = await decryptForChannel(message.channel_id, content);
                    if (outcome.state === "decrypted") {
                        handleDecryption(message.id, { text: outcome.text, success: true });
                    } else if (outcome.state === "no-key") {
                        Toasts.show({
                            message: "No encryption key set for this context.",
                            id: Toasts.genId(),
                            type: Toasts.Type.FAILURE
                        });
                    } else if (outcome.state === "missing-key") {
                        Toasts.show({
                            message: "Encrypted with a key you don't have — ask for the current key.",
                            id: Toasts.genId(),
                            type: Toasts.Type.MESSAGE
                        });
                    }
                }
            };
        }
    },

    async onBeforeMessageSend(channelId, message, extra) {
        const stickerIds: string[] = extra?.stickers ?? [];
        // Allow a sticker-only message (empty content) through; bail only if there's truly nothing.
        if (!message.content && stickerIds.length === 0) return;
        const channel = ChannelStore.getChannel(channelId);
        if (!channel) return;

        const ctx = getContext(channel, getSelfId());
        const ck = contextKey(ctx);
        const record = getRecord(ck);
        const words = getRandomWords(4); // cover words for the stego transport

        // Already a stealth wire (e.g. a pasted key-transfer / key-announce) — never re-encrypt; leave as-is.
        // Markerless: a single detectWire replaces the old marker-based double-seal guards.
        if (message.content && detectWire(message.content)) return;

        const { text, mentions } = splitMentions(message.content || "");
        const suffix = mentions.length ? ` ${mentions.join(" ")}` : "";

        // Resolve the outgoing stickers to compact refs. Unresolvable ids are dropped from OUR envelope
        // and left in extra.stickers (graceful: they send as normal stickers rather than vanish).
        const stickers: StickerRef[] = stickerIds
            .map(id => StickersStore.getStickerById(id))
            .filter(Boolean)
            .map((s: any) => ({ id: s.id, name: s.name, formatType: s.format_type, type: s.type }));
        const useSticker = stickers.length > 0;
        // Sticker-only message whose ids ALL failed to resolve → don't emit an empty CT_TEXT envelope;
        // bail and leave extra.stickers so the (unresolved) sticker just sends normally.
        if (!message.content && !useSticker) return;
        const contentType = useSticker ? CT_STICKER : CT_TEXT;
        const body = useSticker ? packStickerBody(stickers, text) : utf8Encode(text);
        // KNOWN LIMITATION: a sticker ref is tiny, so a sticker (or sticker-only) message always fits the
        // inline stego/base64url transport. The ONE exception is a sticker sent together with very long
        // text (> ~1900 chars) that pushes the wire over the cap — emit() would then carry this CT_STICKER
        // envelope in a cover PNG, but openAttachment only decodes CT_TEXT/CT_FILE, so the recipient can't
        // render it (benign: no plaintext leak, the sticker is still cleared; they just see the cover art).
        // Closing it means teaching openAttachment + tryDecryptAttachment the sticker kind (deferred).

        // Clear the real stickers so Discord transmits none. Call ONLY after a successful encrypt.
        const consumeStickers = () => { if (extra?.stickers && useSticker) extra.stickers.length = 0; };

        // Frame the envelope bytes onto the wire: stego → hidden between cover words (if it fits the cap);
        // else a bare base64url token. The trailing mention suffix is preserved in both transports.
        const emit = async (bytes: Uint8Array) => {
            if (record.stego) {
                const hidden = wrapWire(bytes, { stego: true, words });
                if (hidden.length + suffix.length <= maxMessageLength()) { message.content = hidden + suffix; return; }
                // Over cap (stego on, but the hidden run + mentions would exceed Discord's char limit):
                // carry the SAME envelope as a stealth cover-PNG. `bytes` is already [iv][ct] of an inner
                // CT_TEXT envelope, so the receiver's openAttachment returns { kind: "text" } and the
                // accessory renders a normal decrypted bubble (no re-wrap — embed the bytes directly).
                if (pluginOriginalAddFiles) {
                    const png = embedPrivateChunk(makeCoverPng(), bytes);
                    const file = new File([png], `IMG_${rnd6()}.png`, { type: "image/png" });
                    markPluginFile(file); // never re-encrypted by the upload interceptor
                    // Match the live uploadConfig shape the interceptor passes through to the original
                    // addFiles: { channelId, draftType, files: [{ file, platform }] }.
                    pluginOriginalAddFiles({ channelId, draftType: 0, files: [{ file, platform: 1 }] });
                    // Keep any pings as the visible content; the secret rides inside the PNG.
                    message.content = mentions.length ? mentions.join(" ") : "";
                    Toasts.show({
                        message: "Message too long to hide inline — sent as an image.",
                        id: Toasts.genId(),
                        type: Toasts.Type.MESSAGE
                    });
                    return;
                }
                // addFiles not intercepted yet (very early send) — degrade to a visible token rather than
                // dropping the message. Rare; the upload module is wired ~100ms after plugin start.
            }
            message.content = wrapWire(bytes, { stego: false, words }) + suffix;
        };

        // 1:1 DM sealed-box (PGP) path — needs both our identity and the peer's pinned key.
        if (ctx.type === "dm") {
            if (!getChannelAutoEncrypt(channelId)) return;
            const id = getIdentity();
            const peer = getPeer(ctx.id);
            if (!id) return; // identity not ready yet — send plaintext rather than break
            if (!peer) { await publishKeyIfNeeded(channelId); return; } // can't encrypt without their key

            await emit(await buildSealedWire(contentType, body, [publicBundle(id), peer.bundle], id.ecdsaPrivateJwk));
            consumeStickers();
            return;
        }

        // Guild / group-DM symmetric path (Phase 1)
        if (!getChannelAutoEncrypt(channelId)) return;

        const current = await getCurrentKey(ctx);
        if (!current) return; // no key — send plaintext rather than break

        await emit(await buildSymWire(contentType, body, current.key, ck));
        consumeStickers();
    }
});
