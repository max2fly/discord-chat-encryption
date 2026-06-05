import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import { Channel, Message, User } from "@vencord/discord-types";
import { ChannelRouter, ChannelStore, GuildStore, Menu, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";
import { findByPropsLazy } from "@webpack";

import { publicBundle, sealTo } from "./crypto/asymmetric";
import { decodeKeyAnnounce, encodeKeyAnnounce, encodeMessage, encodeSealed, isEncoded, isKeyAnnounce, isSealedWire } from "./crypto/codec";
import { contextKey, getContext } from "./crypto/context";
import { buildKeyTransfer } from "./crypto/keytransfer";
import { encryptSym, splitMentions } from "./crypto/symmetric";
import { Context } from "./crypto/types";
import { insertMyKeyIntoChat } from "./dmActions";
import { EncryptionAccessory, decryptForChannel, handleDecryption, getDecryptedMessages, getDecryptedImages, getDecryptedVideos, getDecryptedAudio, getDecryptedFiles } from "./EncryptionAccessory";
import { EncryptionChatBarIcon, EncryptionIcon } from "./EncryptionIcon";
import { GuildKeyPicker } from "./GuildKeyPicker";
import { KeyEntryModal } from "./KeyEntryModal";
import { ensureIdentity, forcePinPeer, getChannelAutoEncrypt, getCurrentKey, getCurrentPassword, getIdentity, getPeer, getRecord, getSelfId, loadStore } from "./store";
import { settings } from "./settings";
import { VaultUnlockModal } from "./VaultUnlockModal";
import { createHiddenMessage, extractHiddenMessage, isHiddenMessage, encryptImageToMessage, encryptVideoToMessage, encryptAudioToMessage, encryptFileToMessage } from "./utils";
import { cleanupLegacyCache } from "./EncryptionAccessory";

// Find Discord's upload modules  
const UploadStore = findByPropsLazy("getUploads", "upload");
const FileUtils = findByPropsLazy("makeFile");
const UploadAttachmentStore = findByPropsLazy("addFiles");
const CloudUpload = findByPropsLazy("CloudUpload", "upload");

// Find Discord's download/save modules
const DownloadModule = findByPropsLazy("downloadFile", "saveFile");
const AttachmentActions = findByPropsLazy("downloadAttachment");

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

// Resolve the active channel's per-context password (uploads happen in the focused channel)
function getActiveContextPassword(): string | null {
    const channelId = SelectedChannelStore.getChannelId();
    const channel = channelId && ChannelStore.getChannel(channelId);
    if (!channel) return null;
    return getCurrentPassword(getContext(channel, getSelfId()));
}

// Attachments encrypt only when the active context has auto-encrypt on and a key set
function shouldEncryptAttachments(): boolean {
    const channelId = SelectedChannelStore.getChannelId();
    const channel = channelId && ChannelStore.getChannel(channelId);
    if (!channel) return false;
    const ctx = getContext(channel, getSelfId());
    return getChannelAutoEncrypt(channelId) && getCurrentPassword(ctx) != null;
}

// Helper function to create encrypted file replacement
async function createEncryptedFile(originalFile: File): Promise<File> {
    const password = getActiveContextPassword();
    if (!password) {
        // No key for this context — pass the file through unmodified
        return originalFile;
    }

    let result;

    // Choose encryption method based on file type
    if (originalFile.type.startsWith('image/')) {
        result = await encryptImageToMessage(originalFile, password);
    } else if (originalFile.type.startsWith('video/')) {
        result = await encryptVideoToMessage(originalFile, password);
    } else if (originalFile.type.startsWith('audio/')) {
        result = await encryptAudioToMessage(originalFile, password);
    } else {
        // Wildcard catch for any other file type
        result = await encryptFileToMessage(originalFile, password);
    }

    if (!result.success) {
        throw new Error(result.error || "Encryption failed");
    }
    
    // Create a text file with the encrypted content (explicitly UTF-8)
    const encryptedBlob = new Blob([result.text], { type: 'text/plain; charset=utf-8' });
    
    // Remove extension from filename and add .txt to make it a valid text file
    const baseName = originalFile.name.replace(/\.[^/.]+$/, "");
    
    return new File([encryptedBlob], `${baseName}.txt`, {
        type: 'text/plain; charset=utf-8'
    });
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
                            let contentToDecrypt = content;

                            // Check if this is a hidden message first
                            if (isHiddenMessage(content)) {
                                const extractedEncrypted = extractHiddenMessage(content);
                                if (extractedEncrypted) {
                                    contentToDecrypt = extractedEncrypted;
                                }
                            }

                            const outcome = await decryptForChannel(message.channel_id, contentToDecrypt);
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
                const keyRaw = isHiddenMessage(content) ? (extractHiddenMessage(content) ?? content) : content;
                if (isKeyAnnounce(keyRaw)) {
                    const keyBundle = decodeKeyAnnounce(keyRaw);
                    const keyAuthor = message.author?.id;
                    if (keyBundle && keyAuthor && keyAuthor !== getSelfId() && keyBundle.fingerprint !== getIdentity()?.fingerprint) {
                        group.push(
                            <Menu.MenuItem
                                id="vc-save-pgp-key"
                                label="Save PGP key"
                                icon={EncryptionIcon}
                                action={async () => {
                                    await forcePinPeer(keyAuthor, keyBundle);
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

// Stego-wrap `encoded` if enabled AND the result (plus a trailing suffix of `suffixLen`, e.g. mentions)
// still fits the cap; otherwise fall back to the visible blob and warn. Returns content WITHOUT the suffix.
async function stegoOrVisible(encoded: string, stego: boolean, suffixLen: number): Promise<string> {
    if (!stego) return encoded;
    try {
        const hidden = await createHiddenMessage(encoded);
        if (hidden.length + suffixLen <= maxMessageLength()) return hidden;
        Toasts.show({
            message: "Message too long to hide — sent as visible encrypted text.",
            id: Toasts.genId(),
            type: Toasts.Type.MESSAGE
        });
        return encoded;
    } catch (e) {
        console.error("ChatEncryption: stego wrap failed, sending visible:", e);
        return encoded;
    }
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
    sendMessage(channelId, { content: encodeKeyAnnounce(publicBundle(id)) });
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
    const wire = encodeSealed(sealed);
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
    sendMessage(channelId, { content: encodeSealed(sealed) });
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

    patches: [],

    contextMenus: {
        "message": messageCtxPatch,
        "image-context": imageContextMenuPatch,
        "guild-header-popout": guildHeaderCtxPatch,
        "user-context": userCtxPatch,
        "gdm-context": gdmCtxPatch
    },

    renderMessageAccessory: props => <EncryptionAccessory message={props.message} />,

    chatBarButton: {
        icon: EncryptionIcon,
        render: EncryptionChatBarIcon
    },

    // Runtime interception setup
    originalAddFiles: null as any,
    originalDownloadFunction: null as any,
    posterObserver: null as any,
    originalFetch: null as any,
    
    setupUploadInterception() {
        console.log("ChatEncryption: Setting up upload interception...");
        
        try {
            // Wait for modules to be available
            setTimeout(() => {
                if (UploadAttachmentStore && UploadAttachmentStore.addFiles) {
                    console.log("ChatEncryption: Found UploadAttachmentStore.addFiles, intercepting...");
                    
                    // Store original function
                    this.originalAddFiles = UploadAttachmentStore.addFiles.bind(UploadAttachmentStore);
                    
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
                        console.log("ChatEncryption: Download intercepted:", url, filename);
                        
                        // Check if this is an encrypted video blob URL
                        const decryptedVideos = getDecryptedVideos();
                        for (const [key, videoData] of decryptedVideos.entries()) {
                            // Check if the URL matches our blob or if filename matches
                            if (url.startsWith('blob:') && (filename === videoData.filename || url.includes(key))) {
                                console.log("ChatEncryption: Intercepting download for encrypted video:", videoData.filename);
                                this.downloadEncryptedVideo(videoData);
                                return; // Prevent original download
                            }
                        }

                        // Note: Audio and generic file downloads are handled by DOM interception only
                        // since they will always fail the original download method anyway
                        
                        // Call original function for non-encrypted files
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
        console.log("ChatEncryption: Setting up DOM-based download interception");
        
        // Fallback DOM-based interception with comprehensive selectors
        document.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            
            // More comprehensive download action detection
            const isDownloadAction = target.closest('a[download]') || 
                                   target.closest('[aria-label*="download"]') ||
                                   target.closest('[aria-label*="Download"]') ||
                                   target.closest('[aria-label*="Save"]') ||
                                   target.closest('[aria-label*="save"]') ||
                                   target.closest('button[class*="download"]') ||
                                   target.closest('[role="menuitem"]') && 
                                   target.textContent?.toLowerCase().includes('download');

            // Also check for filename clicks (another way Discord allows file downloads)
            const isFilenameClick = target.closest('[class*="filename"]') ||
                                  target.closest('[class*="attachment"]') && target.tagName === 'A' ||
                                  (target.tagName === 'A' && target.href && target.href.includes('cdn.discordapp.com'));
            
            if (isDownloadAction || isFilenameClick) {
                console.log("ChatEncryption: Download/filename click detected, checking for encrypted media");
                
                // Look for media containers in various ways
                const mediaContainer = target.closest('[class*="attachment"]') || 
                                     target.closest('[class*="media"]') ||
                                     target.closest('[class*="embed"]') ||
                                     // Look in the broader message area
                                     target.closest('[id^="message-"]') ||
                                     target.closest('[class*="message"]');
                
                if (mediaContainer) {
                    // Check for video elements first
                    const video = mediaContainer.querySelector('video') as HTMLVideoElement;
                    console.log("ChatEncryption: Found video element:", video);
                    console.log("ChatEncryption: Video encrypted key:", (video as any)?.encryptedVideoKey);
                    
                    if (video && (video as any).encryptedVideoKey) {
                        console.log("ChatEncryption: DOM intercepting download for encrypted video");
                        event.preventDefault();
                        event.stopPropagation();
                        
                        const videoKey = (video as any).encryptedVideoKey;
                        const decryptedVideos = getDecryptedVideos();
                        const videoData = decryptedVideos.get(videoKey);
                        
                        if (videoData) {
                            console.log("ChatEncryption: Found video data, triggering download:", videoData.filename);
                            this.downloadEncryptedVideo(videoData);
                        } else {
                            console.warn("ChatEncryption: Could not find video data for download, key:", videoKey);
                            console.warn("ChatEncryption: Available video keys:", Array.from(decryptedVideos.keys()));
                        }
                        return;
                    }
                    
                    // Check for audio elements
                    const audio = mediaContainer.querySelector('audio') as HTMLAudioElement;
                    
                    // If audio element exists but no encrypted key, try to find it by checking all audio data
                    if (audio && !(audio as any).encryptedAudioKey) {
                        const decryptedAudio = getDecryptedAudio();
                        for (const [key, audioData] of decryptedAudio.entries()) {
                            // Try to match by checking if this audio element should have this key
                            const messageId = key.split('-')[0];
                            const currentMessage = mediaContainer.closest('[id^="message-"]');
                            if (currentMessage && currentMessage.id.includes(messageId)) {
                                (audio as any).encryptedAudioKey = key;
                                break;
                            }
                        }
                    }
                    
                    if (audio && (audio as any).encryptedAudioKey) {
                        console.log("ChatEncryption: DOM intercepting download for encrypted audio");
                        event.preventDefault();
                        event.stopPropagation();
                        
                        const audioKey = (audio as any).encryptedAudioKey;
                        const decryptedAudio = getDecryptedAudio();
                        const audioData = decryptedAudio.get(audioKey);
                        
                        if (audioData) {
                            console.log("ChatEncryption: Found audio data, triggering download:", audioData.filename);
                            this.downloadEncryptedAudio(audioData);
                        } else {
                            console.warn("ChatEncryption: Could not find audio data for download, key:", audioKey);
                            console.warn("ChatEncryption: Available audio keys:", Array.from(decryptedAudio.keys()));
                        }
                        return;
                    }
                    
                    // Check for file attachments by looking for filename in the container
                    const attachmentElements = mediaContainer.querySelectorAll('[class*="filename"], [class*="attachment"], a[download]');
                    for (const attachmentEl of attachmentElements) {
                        const filename = attachmentEl.textContent || (attachmentEl as HTMLAnchorElement).download || '';
                        
                        if (filename) {
                            const decryptedFiles = getDecryptedFiles();
                            for (const [key, fileData] of decryptedFiles.entries()) {
                                if (fileData.filename === filename.trim()) {
                                    console.log("ChatEncryption: DOM intercepting download for encrypted file:", fileData.filename);
                                    event.preventDefault();
                                    event.stopPropagation();
                                    
                                    this.downloadEncryptedFile(fileData);
                                    return;
                                }
                            }
                        }
                    }
                }
            }
        }, true);
    },
    
    setupPosterFixObserver() {
        console.log("ChatEncryption: Setting up poster fix observer");
        
        // Observer to fix video poster URLs that get set to blob URLs
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'poster') {
                    const video = mutation.target as HTMLVideoElement;
                    if (video.poster && video.poster.startsWith('blob:') && (video as any).encryptedVideoKey) {
                        console.log("ChatEncryption: Detected blob poster URL, fixing...");
                        this.fixVideoPoster(video);
                    }
                }
                
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const element = node as Element;
                            
                            // Check if it's a video with a blob poster
                            if (element.tagName === 'VIDEO') {
                                const video = element as HTMLVideoElement;
                                if (video.poster && video.poster.startsWith('blob:') && (video as any).encryptedVideoKey) {
                                    console.log("ChatEncryption: New video with blob poster detected, fixing...");
                                    setTimeout(() => this.fixVideoPoster(video), 100);
                                }
                            }
                            
                            // Check for videos in child elements
                            const videos = element.querySelectorAll ? element.querySelectorAll('video') : [];
                            videos.forEach((video: HTMLVideoElement) => {
                                if (video.poster && video.poster.startsWith('blob:') && (video as any).encryptedVideoKey) {
                                    console.log("ChatEncryption: Child video with blob poster detected, fixing...");
                                    setTimeout(() => this.fixVideoPoster(video), 100);
                                }
                            });
                        }
                    });
                }
            });
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['poster']
        });
        
        this.posterObserver = observer;
    },
    
    fixVideoPoster(video: HTMLVideoElement) {
        const encryptedKey = (video as any).encryptedVideoKey;
        if (!encryptedKey) return;
        
        console.log("ChatEncryption: Fixing poster for video with key:", encryptedKey);
        
        const decryptedVideos = getDecryptedVideos();
        const messageId = encryptedKey.split('-')[0];
        const messageInstances = require('./EncryptionAccessory').MessageInstances;
        const messageInstance = messageInstances.get(messageId);
        
        if (messageInstance && messageInstance.attachments) {
            const attachment = messageInstance.attachments.find(att => 
                (att as any).encryptedVideoKey === encryptedKey);
            if (attachment) {
                const thumbnailUrl = (attachment as any).thumbnail_url || 
                                   (attachment as any)._customThumbnail ||
                                   (attachment as any).poster ||
                                   (attachment as any).thumbnail;
                
                if (thumbnailUrl && thumbnailUrl.startsWith('data:')) {
                    // Set poster aggressively with multiple methods
                    video.poster = thumbnailUrl;
                    video.setAttribute('poster', thumbnailUrl);
                    (video as any).thumbnail = thumbnailUrl;
                    
                    // Also try to override any cached poster data Discord might have
                    Object.defineProperty(video, 'poster', {
                        value: thumbnailUrl,
                        writable: false,
                        configurable: true
                    });
                    
                    console.log('ChatEncryption: Aggressively fixed video poster to data URL');
                    
                    // Set up continuous monitoring to prevent Discord from changing it back
                    const observer = new MutationObserver(() => {
                        if (video.poster !== thumbnailUrl && video.poster.startsWith('blob:')) {
                            console.log('ChatEncryption: Discord changed poster back to blob, re-fixing...');
                            video.poster = thumbnailUrl;
                            video.setAttribute('poster', thumbnailUrl);
                        }
                    });
                    
                    observer.observe(video, {
                        attributes: true,
                        attributeFilter: ['poster']
                    });
                    
                    // Store observer for cleanup
                    (video as any)._posterObserver = observer;
                }
            }
        }
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
    
    getCustomThumbnailForBlobUrl(url: string): string | null {
        // Extract the blob ID from the URL
        const blobId = url.match(/blob:https:\/\/discord\.com\/([^?]+)/)?.[1];
        
        if (blobId) {
            const decryptedVideos = getDecryptedVideos();
            // Find videos with similar blob URLs
            const videos = document.querySelectorAll('video');
            for (const video of videos) {
                if (video.src.includes(blobId)) {
                    const encryptedKey = (video as any).encryptedVideoKey;
                    if (encryptedKey && decryptedVideos.has(encryptedKey)) {
                        console.log("ChatEncryption: Found matching encrypted video for blob:", blobId);
                        
                        // Get the custom thumbnail from attachment
                        const messageId = encryptedKey.split('-')[0];
                        const messageInstances = require('./EncryptionAccessory').MessageInstances;
                        const messageInstance = messageInstances.get(messageId);
                        
                        if (messageInstance && messageInstance.attachments) {
                            const attachment = messageInstance.attachments.find(att => 
                                (att as any).encryptedVideoKey === encryptedKey);
                            if (attachment && (attachment as any).thumbnail_url) {
                                const thumbnailUrl = (attachment as any).thumbnail_url;
                                if (thumbnailUrl && thumbnailUrl.startsWith('data:')) {
                                    return thumbnailUrl;
                                }
                            }
                        }
                    }
                }
            }
        }
        
        return null;
    },

    downloadEncryptedVideo(videoData) {
        try {
            // Convert base64 back to blob
            const binaryString = atob(videoData.videoData);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            
            const blob = new Blob([bytes], { type: videoData.mimeType });
            const file = new File([blob], videoData.filename, { type: videoData.mimeType });
            
            // Create download link
            const downloadUrl = URL.createObjectURL(file);
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.download = videoData.filename;
            link.style.display = 'none';
            
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            // Clean up
            URL.revokeObjectURL(downloadUrl);
            
            console.log("ChatEncryption: Successfully downloaded encrypted video:", videoData.filename);
        } catch (error) {
            console.error("ChatEncryption: Failed to download encrypted video:", error);
        }
    },

    downloadEncryptedAudio(audioData) {
        try {
            // Convert base64 back to blob
            const binaryString = atob(audioData.audioData);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            
            const blob = new Blob([bytes], { type: audioData.mimeType });
            const file = new File([blob], audioData.filename, { type: audioData.mimeType });
            
            // Create download link
            const downloadUrl = URL.createObjectURL(file);
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.download = audioData.filename;
            link.style.display = 'none';
            
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            // Clean up
            URL.revokeObjectURL(downloadUrl);
            
            console.log("ChatEncryption: Successfully downloaded encrypted audio:", audioData.filename);
        } catch (error) {
            console.error("ChatEncryption: Failed to download encrypted audio:", error);
        }
    },

    downloadEncryptedFile(fileData) {
        try {
            // Convert base64 back to blob
            const binaryString = atob(fileData.fileData);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            
            const blob = new Blob([bytes], { type: fileData.mimeType });
            const file = new File([blob], fileData.filename, { type: fileData.mimeType });
            
            // Create download link
            const downloadUrl = URL.createObjectURL(file);
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.download = fileData.filename;
            link.style.display = 'none';
            
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            // Clean up
            URL.revokeObjectURL(downloadUrl);
            
            console.log("ChatEncryption: Successfully downloaded encrypted file:", fileData.filename);
        } catch (error) {
            console.error("ChatEncryption: Failed to download encrypted file:", error);
        }
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
        
        // Setup poster fix observer
        this.setupPosterFixObserver();
        
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
        
        // Clean up poster observer
        if (this.posterObserver) {
            console.log("ChatEncryption: Disconnecting poster observer");
            this.posterObserver.disconnect();
            this.posterObserver = null;
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
                    let contentToDecrypt = content;

                    // Check if this is a hidden message first
                    if (isHiddenMessage(content)) {
                        const extractedEncrypted = extractHiddenMessage(content);
                        if (extractedEncrypted) {
                            contentToDecrypt = extractedEncrypted;
                        }
                    }

                    const outcome = await decryptForChannel(message.channel_id, contentToDecrypt);
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

    async onBeforeMessageSend(channelId, message) {
        if (!message.content) return;
        const channel = ChannelStore.getChannel(channelId);
        if (!channel) return;

        const ctx = getContext(channel, getSelfId());
        const ck = contextKey(ctx);
        const record = getRecord(ck);

        // A key-announce handshake is a public key, not an encryptable message — never seal it.
        // Apply steganography here (send time) if enabled for this context, exactly like encrypted messages.
        if (isKeyAnnounce(message.content)) {
            message.content = await stegoOrVisible(message.content, record.stego, 0);
            return;
        }

        // Already-encrypted content (e.g. a pasted key-transfer [PGP:…] or symmetric [ENC:…]) — never
        // re-encrypt it; just hide it if stego is on for this context.
        if (isSealedWire(message.content) || isEncoded(message.content)) {
            message.content = await stegoOrVisible(message.content, record.stego, 0);
            return;
        }

        // 1:1 DM sealed-box (PGP) path — needs both our identity and the peer's pinned key.
        if (ctx.type === "dm") {
            if (!getChannelAutoEncrypt(channelId)) return;
            const id = getIdentity();
            const peer = getPeer(ctx.id);
            if (!id) return; // identity not ready yet — send plaintext rather than break
            if (!peer) { await publishKeyIfNeeded(channelId); return; } // can't encrypt without their key

            const { text, mentions } = splitMentions(message.content);
            const sealed = await sealTo(text, [publicBundle(id), peer.bundle], id.ecdsaPrivateJwk);
            const encoded = encodeSealed(sealed);
            const suffix = mentions.length ? ` ${mentions.join(" ")}` : "";
            message.content = (await stegoOrVisible(encoded, record.stego, suffix.length)) + suffix;
            return;
        }

        // Guild / group-DM symmetric path (Phase 1)
        if (!getChannelAutoEncrypt(channelId)) return;

        const current = await getCurrentKey(ctx);
        if (!current) return; // no key — send plaintext rather than break

        const { text, mentions } = splitMentions(message.content);
        const payload = await encryptSym(text, current.key, current.keyId, ck);
        const encoded = encodeMessage(payload);
        const suffix = mentions.length ? ` ${mentions.join(" ")}` : "";
        message.content = (await stegoOrVisible(encoded, record.stego, suffix.length)) + suffix;
    }
});
