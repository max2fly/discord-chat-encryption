import { Message } from "@vencord/discord-types";
import { useEffect, useState } from "@webpack/common";
import { FluxDispatcher } from "@webpack/common";
import { findByPropsLazy } from "@webpack";

import { EncryptionIcon } from "./EncryptionIcon";
import { settings } from "./settings";
import { cl, decryptWithMultiplePhrases, EncryptionResult, isEncryptedMessage, isHiddenMessage, extractHiddenMessage, isEncryptedImageMessage, decryptImageMessage, ImageEncryptionData, isEncryptedVideoMessage, decryptVideoMessage, VideoEncryptionData } from "./utils";

// Cache for downloaded attachment content to avoid re-downloading
const AttachmentContentCache = new Map<string, string>();

const DecryptedMessages = new Map<string, EncryptionResult>();
const MessageInstances = new Map<string, Message>();
const UpdateTriggers = new Map<string, () => void>();
const EncryptedMessageQueue = new Map<string, string>(); // messageId -> encrypted content
const DecryptedImages = new Map<string, ImageEncryptionData>(); // messageId -> decrypted image data
const DecryptedVideos = new Map<string, VideoEncryptionData>(); // messageId -> decrypted video data
const ProcessedAttachments = new Set<string>(); // Track processed attachment URLs to avoid re-processing
const DownloadQueue = new Map<string, Promise<string>>(); // Track ongoing downloads to avoid duplicates
const UpgradeProcessed = new Set<string>(); // Track attachments we've already attempted to upgrade
const RestoredAttachments = new Set<string>(); // Track attachments we've already restored from cache

export function getDecryptedMessages() {
    return DecryptedMessages;
}

export function getDecryptedImages() {
    return DecryptedImages;
}

export function getDecryptedVideos() {
    return DecryptedVideos;
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
    console.log("ChatEncryption: Restoring all cached content...");

    let restoredAttachments = 0;
    let restoredVideos = 0;
    let restoredTexts = 0;

    // Restore cached text decryptions
    for (const [messageId, cachedDecryption] of DecryptedMessages.entries()) {
        const messageInstance = MessageInstances.get(messageId);
        if (messageInstance && cachedDecryption.success) {
            // Check if message content is still encrypted (needs restoration)
            if (isEncryptedMessage(messageInstance.content) || isHiddenMessage(messageInstance.content)) {
                console.log("ChatEncryption: Restoring cached text decryption for message:", messageId);
                messageInstance.content = cachedDecryption.text;
                restoredTexts++;

                // Force message update
                FluxDispatcher.dispatch({
                    type: "MESSAGE_UPDATE",
                    message: messageInstance
                });
            }
        }
    }

    // Restore cached image attachments
    for (const [attachmentKey, cachedDecryption] of DecryptedImages.entries()) {
        // Extract message ID and attachment ID from the key format: "messageId-attachmentId"
        const [messageId, attachmentId] = attachmentKey.split('-');

        // Get the message instance if it exists
        const messageInstance = MessageInstances.get(messageId);
        if (messageInstance && messageInstance.attachments) {
            // Find the attachment in the message
            const attachmentIndex = messageInstance.attachments.findIndex(att => att.id === attachmentId);

            if (attachmentIndex !== -1) {
                const attachment = messageInstance.attachments[attachmentIndex];

                // Only restore if it's still a .txt file (not already restored)
                if (attachment.filename?.endsWith('.txt') &&
                    attachment.content_type?.startsWith('text/plain') &&
                    !attachment.url?.startsWith('data:')) {

                    const dataUrl = `data:${cachedDecryption.mimeType};base64,${cachedDecryption.imageData}`;

                    const syntheticAttachment = {
                        ...attachment,
                        filename: cachedDecryption.filename,
                        content_type: cachedDecryption.mimeType,
                        url: dataUrl,
                        proxy_url: dataUrl,
                        width: cachedDecryption.width || 400,
                        height: cachedDecryption.height || 300,
                        size: Math.ceil(cachedDecryption.imageData.length * 0.75)
                    };

                    messageInstance.attachments[attachmentIndex] = syntheticAttachment;
                    restoredAttachments++;

                    // Force message update
                    FluxDispatcher.dispatch({
                        type: "MESSAGE_UPDATE",
                        message: messageInstance
                    });
                }
            }
        }
    }

    // Restore cached video attachments
    for (const [attachmentKey, cachedDecryption] of DecryptedVideos.entries()) {
        // Extract message ID and attachment ID from the key format: "messageId-attachmentId"
        const [messageId, attachmentId] = attachmentKey.split('-');

        // Get the message instance if it exists
        const messageInstance = MessageInstances.get(messageId);
        if (messageInstance && messageInstance.attachments) {
            // Find the attachment in the message
            const attachmentIndex = messageInstance.attachments.findIndex(att => att.id === attachmentId);

            if (attachmentIndex !== -1) {
                const attachment = messageInstance.attachments[attachmentIndex];

                // Only restore if it's still a .txt file (not already restored)
                if (attachment.filename?.endsWith('.txt') &&
                    attachment.content_type?.startsWith('text/plain') &&
                    !attachment.url?.startsWith('blob:')) {

                    // Convert base64 to blob for videos
                    const binaryString = atob(cachedDecryption.videoData);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    
                    const blob = new Blob([bytes], { type: cachedDecryption.mimeType });
                    const blobUrl = URL.createObjectURL(blob);

                    // Generate thumbnail for video preview
                    let thumbnail = null;
                    try {
                        thumbnail = await generateVideoThumbnail(blob, cachedDecryption.mimeType);
                    } catch (error) {
                        console.warn("ChatEncryption: Failed to generate video thumbnail during cache restore:", error);
                    }

                    const syntheticAttachment = {
                        ...attachment,
                        filename: cachedDecryption.filename,
                        content_type: cachedDecryption.mimeType,
                        url: blobUrl,
                        proxy_url: blobUrl,
                        width: cachedDecryption.width || 640,
                        height: cachedDecryption.height || 480,
                        size: blob.size,
                        ...(thumbnail && { thumbnail_url: thumbnail, thumbnail_proxy_url: thumbnail }),
                        isEncryptedVideo: true,
                        originalBlob: blob
                    };

                    messageInstance.attachments[attachmentIndex] = syntheticAttachment;
                    restoredVideos++;

                    // Force message update
                    FluxDispatcher.dispatch({
                        type: "MESSAGE_UPDATE",
                        message: messageInstance
                    });
                }
            }
        }
    }

    if (restoredTexts > 0 || restoredAttachments > 0 || restoredVideos > 0) {
        console.log(`ChatEncryption: Restored ${restoredTexts} cached texts, ${restoredAttachments} cached images, and ${restoredVideos} cached videos`);
    }
}

// Function to decrypt all queued messages with new phrases
export async function decryptAllQueuedMessages() {
    const allPhrases = [
        settings.store.secretPhrase,
        ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
    ].filter(Boolean);

    if (allPhrases.length === 0) return;

    // Process all encrypted messages that haven't been decrypted yet
    for (const [messageId, encryptedContent] of EncryptedMessageQueue.entries()) {
        if (!DecryptedMessages.has(messageId)) {
            try {
                let contentToDecrypt = encryptedContent;

                // Check if this is a hidden message in the original message
                const messageInstance = MessageInstances.get(messageId);
                if (messageInstance && isHiddenMessage(messageInstance.content)) {
                    const extractedEncrypted = extractHiddenMessage(messageInstance.content);
                    if (extractedEncrypted) {
                        contentToDecrypt = extractedEncrypted;
                    }
                }

                const result = await decryptWithMultiplePhrases(contentToDecrypt, allPhrases);
                if (result.success) {
                    handleDecryption(messageId, result);
                    EncryptedMessageQueue.delete(messageId); // Remove from queue once decrypted
                }
            } catch (error) {
                console.error("Batch decryption failed for message:", messageId, error);
            }
        }
    }
}

// Generate video thumbnail for preview
async function generateVideoThumbnail(videoBlob: Blob, mimeType: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        if (!ctx) {
            reject(new Error('Cannot get canvas context'));
            return;
        }
        
        video.crossOrigin = 'anonymous';
        video.muted = true;
        video.playsInline = true;
        
        video.addEventListener('loadedmetadata', () => {
            // Set canvas dimensions to video dimensions
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            
            // Seek to 1 second or 10% of duration, whichever is smaller
            const seekTime = Math.min(1, video.duration * 0.1);
            video.currentTime = seekTime;
        });
        
        video.addEventListener('seeked', () => {
            try {
                // Draw current frame to canvas
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                
                // Convert to data URL
                const thumbnailDataUrl = canvas.toDataURL('image/jpeg', 0.8);
                
                // Clean up
                URL.revokeObjectURL(video.src);
                
                resolve(thumbnailDataUrl);
            } catch (error) {
                reject(error);
            }
        });
        
        video.addEventListener('error', (e) => {
            URL.revokeObjectURL(video.src);
            reject(new Error(`Video load error: ${e}`));
        });
        
        // Set video source
        video.src = URL.createObjectURL(videoBlob);
    });
}

// Download attachment content with retry logic, caching, and timeout protection
async function downloadAttachment(attachment: any, url: string, maxAttempts = 3): Promise<string> {
    const cacheKey = `${attachment.id}-${url}`;

    // Check cache first
    if (AttachmentContentCache.has(cacheKey)) {
        console.log("ChatEncryption: Using cached content for:", attachment.filename);
        return AttachmentContentCache.get(cacheKey)!;
    }

    const downloadKey = `${attachment.id}-${attachment.filename}`;

    // Check if already downloading
    if (DownloadQueue.has(downloadKey)) {
        //console.log("ChatEncryption: Download already in progress, waiting...");
        return await DownloadQueue.get(downloadKey)!;
    }

    const downloadPromise = async (): Promise<string> => {
        //console.log("ChatEncryption: Downloading attachment:", attachment.filename, "from:", url);

        // For text files, only use direct CDN URL (proxy URL returns 415 for .txt files)
        const urlsToTry = [attachment.url].filter(Boolean);

        for (const currentUrl of urlsToTry) {
            //console.log("ChatEncryption: Trying URL:", currentUrl);

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    //console.log(`ChatEncryption: Download attempt ${attempt}/${maxAttempts} for ${currentUrl}`);

                    // Add timeout to prevent hanging
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => {
                        console.log("ChatEncryption: Download timeout, aborting...");
                        controller.abort();
                    }, 15000); // 15 second timeout

                    let response;
                    try {
                        response = await fetch(currentUrl, { signal: controller.signal });
                        clearTimeout(timeoutId);
                    } catch (fetchError) {
                        clearTimeout(timeoutId);
                        if (fetchError.name === 'AbortError') {
                            throw new Error('Download timeout - request took too long');
                        }
                        throw fetchError;
                    }

                    if (!response.ok) {
                        // Don't retry on permanent failures
                        if (response.status === 404 || response.status === 403) {
                            throw new Error(`HTTP ${response.status}: ${response.statusText} (permanent failure)`);
                        }

                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }

                    const content = await response.text();
                    //console.log("ChatEncryption: Successfully downloaded content, length:", content.length);
                    //console.log("ChatEncryption: Content preview:", content.substring(0, 100));

                    // Cache the content for future use
                    AttachmentContentCache.set(cacheKey, content);

                    return content;

                } catch (error) {
                    //console.error(`ChatEncryption: Download attempt ${attempt} failed for ${currentUrl}:`, error);

                    // If this is a CORS error, don't retry this URL
                    if ((error as Error).message.includes("CORS") || (error as Error).message.includes("cors")) {
                        //console.log("ChatEncryption: CORS error detected, trying next URL if available");
                        break; // Break out of retry loop for this URL
                    }

                    // If this was the last attempt or a permanent error, continue to next URL
                    if (attempt === maxAttempts || (error as Error).message.includes("permanent failure")) {
                        break;
                    }

                    // Exponential backoff before retry
                    const delay = 1000 * attempt;
                    //console.log(`ChatEncryption: Waiting ${delay}ms before retry...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw new Error("All download attempts failed for all available URLs");
    };

    DownloadQueue.set(downloadKey, downloadPromise());

    try {
        const result = await DownloadQueue.get(downloadKey)!;
        DownloadQueue.delete(downloadKey);
        return result;
    } catch (error) {
        DownloadQueue.delete(downloadKey);
        throw error;
    }
}

// Handle encrypted file attachments
async function handleEncryptedAttachment(message: Message, attachment: any) {
    const attachmentKey = `${message.id}-${attachment.id}`;

    // Check if we have old cached data without proper dimensions, clear it (but only once)
    const existingDecrypted = DecryptedImages.get(attachmentKey);
    if (existingDecrypted && (!existingDecrypted.width || !existingDecrypted.height) && !UpgradeProcessed.has(attachmentKey)) {
        //console.log("ChatEncryption: Found old cached data without dimensions, clearing it");
        DecryptedImages.delete(attachmentKey);
        ProcessedAttachments.delete(attachmentKey);
        UpgradeProcessed.add(attachmentKey); // Mark as upgraded to prevent loops
    }

    // Skip if already processed
    if (ProcessedAttachments.has(attachmentKey)) {
        return;
    }

    ProcessedAttachments.add(attachmentKey);

    try {
        //console.log("ChatEncryption: Downloading encrypted attachment:", attachment.url);

        // For text files, use direct CDN URL only (proxy returns 415 for txt files)
        const urlToFetch = attachment.url;

        //console.log("ChatEncryption: Fetching from URL:", urlToFetch);

        // Download attachment content directly
        const textContent = await downloadAttachment(attachment, urlToFetch);

        console.log("ChatEncryption: Downloaded content preview:", textContent.substring(0, 100));

        // Check if this looks like our encrypted image format
        if (textContent.startsWith('[IMG_ENC:v1:')) {
            //console.log("ChatEncryption: Found encrypted image attachment");

            const allPhrases = [
                settings.store.secretPhrase,
                ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
            ].filter(Boolean);

            if (allPhrases.length > 0) {
                // Try to decrypt with all available phrases
                for (const phrase of allPhrases) {
                    const result = await decryptImageMessage(textContent, phrase);
                    if (result.success && result.imageData) {
                        //console.log("ChatEncryption: Successfully decrypted attachment:", result.imageData.filename);

                        // Handle old format without dimensions - add default dimensions but continue processing
                        if (!result.imageData.width || !result.imageData.height) {
                            //console.log("ChatEncryption: Old format detected (no dimensions), using defaults");
                            result.imageData.width = 400;
                            result.imageData.height = 300;
                        }

                        // Store the decrypted image data
                        DecryptedImages.set(attachmentKey, result.imageData);

                        // Replace the attachment in the message object directly
                        const attachmentIndex = message.attachments.findIndex(att => att.id === attachment.id);
                        if (attachmentIndex !== -1) {
                            // Create data URL for the decrypted image (Discord can't modify these)
                            const dataUrl = `data:${result.imageData.mimeType};base64,${result.imageData.imageData}`;

                            // Create synthetic image attachment
                            const syntheticAttachment = {
                                ...attachment,
                                filename: result.imageData.filename,
                                content_type: result.imageData.mimeType,
                                url: dataUrl,
                                proxy_url: dataUrl,
                                width: result.imageData.width || 400, // Use saved dimensions or fallback
                                height: result.imageData.height || 300, // Use saved dimensions or fallback
                                size: Math.ceil(result.imageData.imageData.length * 0.75) // Approximate size from base64
                            };

                            // Replace the attachment in the message
                            message.attachments[attachmentIndex] = syntheticAttachment;
                            //console.log("ChatEncryption: Replaced attachment in message:", syntheticAttachment);
                        }

                        // Force re-render of the message
                        FluxDispatcher.dispatch({
                            type: "MESSAGE_UPDATE",
                            message: message
                        });
                        break;
                    }
                }
            }
        } 
        // Check if this looks like our encrypted video format
        else if (textContent.startsWith('[VID_ENC:v1:')) {
            console.log("ChatEncryption: Found encrypted video attachment");

            const allPhrases = [
                settings.store.secretPhrase,
                ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
            ].filter(Boolean);

            if (allPhrases.length > 0) {
                // Try to decrypt with all available phrases
                for (const phrase of allPhrases) {
                    const result = await decryptVideoMessage(textContent, phrase);
                    if (result.success && result.videoData) {
                        console.log("ChatEncryption: Successfully decrypted video attachment:", result.videoData.filename);

                        // Store the decrypted video data
                        DecryptedVideos.set(attachmentKey, result.videoData);

                        // Replace the attachment in the message object directly
                        const attachmentIndex = message.attachments.findIndex(att => att.id === attachment.id);
                        if (attachmentIndex !== -1) {
                            // Validate base64 data
                            const videoData = result.videoData.videoData;
                            if (!videoData || videoData.length === 0) {
                                console.error("ChatEncryption: Video data is empty");
                                return;
                            }

                            // Check if base64 is valid
                            try {
                                // Test the base64 string
                                atob(videoData.substring(0, 100)); // Test first 100 chars
                            } catch (error) {
                                console.error("ChatEncryption: Invalid base64 video data:", error);
                                return;
                            }

                            // Convert base64 to blob for better performance
                            const binaryString = atob(videoData);
                            const bytes = new Uint8Array(binaryString.length);
                            for (let i = 0; i < binaryString.length; i++) {
                                bytes[i] = binaryString.charCodeAt(i);
                            }
                            
                            const blob = new Blob([bytes], { type: result.videoData.mimeType });
                            const blobUrl = URL.createObjectURL(blob);
                            
                            console.log("ChatEncryption: Created video blob URL, size:", blob.size, "bytes");
                            
                            // Generate video thumbnail for preview
                            let thumbnail = null;
                            try {
                                thumbnail = await generateVideoThumbnail(blob, result.videoData.mimeType);
                            } catch (error) {
                                console.warn("ChatEncryption: Failed to generate video thumbnail:", error);
                            }

                            // Create synthetic video attachment with blob URL and thumbnail
                            const syntheticAttachment = {
                                ...attachment,
                                filename: result.videoData.filename,
                                content_type: result.videoData.mimeType,
                                url: blobUrl,
                                proxy_url: blobUrl,
                                width: result.videoData.width || 640,
                                height: result.videoData.height || 480,
                                size: blob.size,
                                // Add thumbnail if generated successfully
                                ...(thumbnail && { thumbnail_url: thumbnail, thumbnail_proxy_url: thumbnail }),
                                // Mark as encrypted video for custom download handling
                                isEncryptedVideo: true,
                                originalBlob: blob
                            };

                            // Replace the attachment in the message
                            message.attachments[attachmentIndex] = syntheticAttachment;
                            console.log("ChatEncryption: Replaced video attachment in message with blob URL");
                        }

                        // Force re-render of the message
                        FluxDispatcher.dispatch({
                            type: "MESSAGE_UPDATE",
                            message: message
                        });
                        break;
                    }
                }
            }
        } else {
            //console.log("ChatEncryption: Attachment does not appear to be encrypted format");
        }
    } catch (error) {
        //console.error("ChatEncryption: Failed to process encrypted attachment:", error);
        ProcessedAttachments.delete(attachmentKey); // Allow retry on error
    }
}

export function EncryptionAccessory({ message }: { message: Message; }) {
    const [decryptedContent, setDecryptedContent] = useState<string | null>(null);
    const [isEncrypted, setIsEncrypted] = useState(false);

    // Store message instance for potential updates (like text decryption does)
    MessageInstances.set(message.id, message);

    // Safety net: Check for cached text that needs restoration (handles race conditions)
    const cachedTextDecryption = DecryptedMessages.get(message.id);
    if (cachedTextDecryption?.success && (isEncryptedMessage(message.content) || isHiddenMessage(message.content))) {
        // Text is cached but message content is still encrypted - restore it
        setTimeout(() => {
            //console.log("ChatEncryption: Auto-restoring cached text for message:", message.id);
            message.content = cachedTextDecryption.text;

            FluxDispatcher.dispatch({
                type: "MESSAGE_UPDATE",
                message: message
            });
        }, 100);
    }

    // Safety net: Check for cached attachments that need restoration (handles race conditions)
    if (message.attachments && message.attachments.length > 0) {
        for (const attachment of message.attachments) {
            if (attachment.filename?.endsWith('.txt') && attachment.content_type?.startsWith('text/plain')) {
                const attachmentKey = `${message.id}-${attachment.id}`;
                const cachedDecryption = DecryptedImages.get(attachmentKey);

                if (cachedDecryption && !attachment.url?.startsWith('data:')) {
                    // Delay slightly to avoid immediate re-render conflicts
                    setTimeout(() => {
                        const currentAttachment = message.attachments?.find(att => att.id === attachment.id);
                        if (currentAttachment && !currentAttachment.url?.startsWith('data:')) {
                            const attachmentIndex = message.attachments.findIndex(att => att.id === attachment.id);
                            if (attachmentIndex !== -1) {
                                const dataUrl = `data:${cachedDecryption.mimeType};base64,${cachedDecryption.imageData}`;

                                const syntheticAttachment = {
                                    ...currentAttachment,
                                    filename: cachedDecryption.filename,
                                    content_type: cachedDecryption.mimeType,
                                    url: dataUrl,
                                    proxy_url: dataUrl,
                                    width: cachedDecryption.width || 400,
                                    height: cachedDecryption.height || 300,
                                    size: Math.ceil(cachedDecryption.imageData.length * 0.75)
                                };

                                message.attachments[attachmentIndex] = syntheticAttachment;

                                FluxDispatcher.dispatch({
                                    type: "MESSAGE_UPDATE",
                                    message: message
                                });
                            }
                        }
                    }, 100);
                }
                
                // Also check for cached videos that need restoration
                const cachedVideoDecryption = DecryptedVideos.get(attachmentKey);
                if (cachedVideoDecryption && !attachment.url?.startsWith('blob:')) {
                    // Delay slightly to avoid immediate re-render conflicts
                    setTimeout(() => {
                        const currentAttachment = message.attachments?.find(att => att.id === attachment.id);
                        if (currentAttachment && !currentAttachment.url?.startsWith('blob:')) {
                            const attachmentIndex = message.attachments.findIndex(att => att.id === attachment.id);
                            if (attachmentIndex !== -1) {
                                // Convert base64 to blob for videos
                                const binaryString = atob(cachedVideoDecryption.videoData);
                                const bytes = new Uint8Array(binaryString.length);
                                for (let i = 0; i < binaryString.length; i++) {
                                    bytes[i] = binaryString.charCodeAt(i);
                                }
                                
                                const blob = new Blob([bytes], { type: cachedVideoDecryption.mimeType });
                                const blobUrl = URL.createObjectURL(blob);

                                // Generate thumbnail for video preview
                                generateVideoThumbnail(blob, cachedVideoDecryption.mimeType)
                                    .then(thumbnail => {
                                        const syntheticAttachment = {
                                            ...currentAttachment,
                                            filename: cachedVideoDecryption.filename,
                                            content_type: cachedVideoDecryption.mimeType,
                                            url: blobUrl,
                                            proxy_url: blobUrl,
                                            width: cachedVideoDecryption.width || 640,
                                            height: cachedVideoDecryption.height || 480,
                                            size: blob.size,
                                            thumbnail_url: thumbnail,
                                            thumbnail_proxy_url: thumbnail,
                                            isEncryptedVideo: true,
                                            originalBlob: blob
                                        };

                                        message.attachments[attachmentIndex] = syntheticAttachment;

                                        FluxDispatcher.dispatch({
                                            type: "MESSAGE_UPDATE",
                                            message: message
                                        });
                                    })
                                    .catch(error => {
                                        console.warn("ChatEncryption: Failed to generate video thumbnail during safety net restore:", error);
                                        
                                        // Fallback without thumbnail
                                        const syntheticAttachment = {
                                            ...currentAttachment,
                                            filename: cachedVideoDecryption.filename,
                                            content_type: cachedVideoDecryption.mimeType,
                                            url: blobUrl,
                                            proxy_url: blobUrl,
                                            width: cachedVideoDecryption.width || 640,
                                            height: cachedVideoDecryption.height || 480,
                                            size: blob.size,
                                            isEncryptedVideo: true,
                                            originalBlob: blob
                                        };

                                        message.attachments[attachmentIndex] = syntheticAttachment;

                                        FluxDispatcher.dispatch({
                                            type: "MESSAGE_UPDATE",
                                            message: message
                                        });
                                    });
                            }
                        }
                    }, 100);
                }
            }
        }
    }

    useEffect(() => {
        if ((message as any).vencordEmbeddedBy) return;

        const messageContent = message.content || "";
        let contentToDecrypt = messageContent;
        let isEncryptedMsg = false;
        let isEncryptedImg = false;
        let hasEncryptedAttachment = false;

        // Check for encrypted file attachments (process in background, don't block text decryption)
        if (message.attachments && message.attachments.length > 0) {
            for (const attachment of message.attachments) {
                // Check if this looks like an encrypted file
                // Our encrypted files are .txt files with text/plain content type
                if (attachment.filename.endsWith('.txt') &&
                    attachment.content_type?.startsWith('text/plain')) {
                    //console.log("ChatEncryption: Found encrypted attachment (.txt file):", attachment.filename);
                    hasEncryptedAttachment = true;
                    // Process attachment in background, don't await (non-blocking)
                    handleEncryptedAttachment(message, attachment).catch(error => {
                        console.error("ChatEncryption: Attachment processing failed:", error);
                    });
                }
            }
        }

        // Check if this is a hidden message first
        if (isHiddenMessage(messageContent)) {
            const extractedEncrypted = extractHiddenMessage(messageContent);
            if (extractedEncrypted) {
                contentToDecrypt = extractedEncrypted;
                isEncryptedMsg = isEncryptedMessage(contentToDecrypt);
            }
        } else {
            isEncryptedMsg = isEncryptedMessage(messageContent);
            isEncryptedImg = isEncryptedImageMessage(messageContent);
        }

        const isEncryptedVid = isEncryptedVideoMessage(messageContent);
        setIsEncrypted(isEncryptedMsg || isEncryptedImg || isEncryptedVid || hasEncryptedAttachment);

        // Handle encrypted image messages
        if (isEncryptedImg && !DecryptedImages.has(message.id)) {
            const allPhrases = [
                settings.store.secretPhrase,
                ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
            ].filter(Boolean);

            if (allPhrases.length > 0) {
                // Try to decrypt the image with all available phrases
                (async () => {
                    for (const phrase of allPhrases) {
                        const result = await decryptImageMessage(messageContent, phrase);
                        if (result.success && result.imageData) {
                            DecryptedImages.set(message.id, result.imageData);
                            // Force re-render
                            FluxDispatcher.dispatch({
                                type: "MESSAGE_UPDATE",
                                message: message
                            });
                            break;
                        }
                    }
                })().catch(error => {
                    console.error("Auto-decryption failed for image message:", message.id, error);
                });
            }
        }

        // Handle encrypted video messages
        if (isEncryptedVid && !DecryptedVideos.has(message.id)) {
            const allPhrases = [
                settings.store.secretPhrase,
                ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
            ].filter(Boolean);

            if (allPhrases.length > 0) {
                // Try to decrypt the video with all available phrases
                (async () => {
                    for (const phrase of allPhrases) {
                        const result = await decryptVideoMessage(messageContent, phrase);
                        if (result.success && result.videoData) {
                            DecryptedVideos.set(message.id, result.videoData);
                            // Force re-render
                            FluxDispatcher.dispatch({
                                type: "MESSAGE_UPDATE",
                                message: message
                            });
                            break;
                        }
                    }
                })().catch(error => {
                    console.error("Auto-decryption failed for video message:", message.id, error);
                });
            }
        }

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

            const allPhrases = [
                settings.store.secretPhrase,
                ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
            ].filter(Boolean);

            if (allPhrases.length > 0) {
                //console.log("ChatEncryption: Starting text decryption with", allPhrases.length, "phrases");
                // Process decryption immediately and independently of any image processing
                decryptWithMultiplePhrases(contentToDecrypt, allPhrases)
                    .then(result => {
                        //console.log("ChatEncryption: Text decryption result:", result.success ? "SUCCESS" : "FAILED", message.id);
                        if (result.success) {
                            //console.log("ChatEncryption: Setting decrypted text for message:", message.id);
                            DecryptedMessages.set(message.id, result);
                            // Modify the message content directly
                            (message as any).content = result.text;
                            setDecryptedContent(result.text);

                            // Force Discord to re-render this message using Flux
                            FluxDispatcher.dispatch({
                                type: "MESSAGE_UPDATE",
                                message: message
                            });
                        } else {
                            console.log("ChatEncryption: Text decryption failed:", result.error);
                        }
                    })
                    .catch(error => {
                        console.error("ChatEncryption: Auto-decryption failed for message:", message.id, error);
                    });
            } else {
                console.log("ChatEncryption: No phrases available for text decryption");
            }
        }
    }, [message.id, message.content]);

    // Check for decrypted messages, images, and videos
    const decryptedResult = DecryptedMessages.get(message.id);
    const decryptedImage = DecryptedImages.get(message.id);
    const decryptedVideo = DecryptedVideos.get(message.id);

    // Check if any attachments for this message have been decrypted
    const hasDecryptedAttachments = Array.from(DecryptedImages.keys()).some(key => key.startsWith(`${message.id}-`));
    const hasDecryptedVideoAttachments = Array.from(DecryptedVideos.keys()).some(key => key.startsWith(`${message.id}-`));

    // Don't show decrypted attachments in accessory - always use Discord's native viewer via attachment replacement
    const decryptedAttachments: ImageEncryptionData[] = [];

    if (decryptedResult?.success || decryptedImage || decryptedVideo || hasDecryptedAttachments || hasDecryptedVideoAttachments || decryptedAttachments.length > 0) {
        return (
            <div className={cl("encryption-accessories")}>
                {(decryptedResult?.success || hasDecryptedAttachments || hasDecryptedVideoAttachments) && (
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

    return null;
}
