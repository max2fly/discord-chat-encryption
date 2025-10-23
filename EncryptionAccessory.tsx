import { Message } from "@vencord/discord-types";
import { useEffect, useState } from "@webpack/common";
import { FluxDispatcher } from "@webpack/common";
import { findByPropsLazy } from "@webpack";

import { EncryptionIcon } from "./EncryptionIcon";
import { settings } from "./settings";
import { cl, decryptWithMultiplePhrases, EncryptionResult, isEncryptedMessage, isHiddenMessage, extractHiddenMessage, isEncryptedImageMessage, decryptImageMessage, ImageEncryptionData, isEncryptedVideoMessage, decryptVideoMessage, VideoEncryptionData, isEncryptedAudioMessage, decryptAudioMessage, AudioEncryptionData, isEncryptedFileMessage, decryptFileMessage, FileEncryptionData } from "./utils";

// Cache for downloaded attachment content to avoid re-downloading
const AttachmentContentCache = new Map<string, string>();

const DecryptedMessages = new Map<string, EncryptionResult>();
const MessageInstances = new Map<string, Message>();
const UpdateTriggers = new Map<string, () => void>();
const EncryptedMessageQueue = new Map<string, string>(); // messageId -> encrypted content
const DecryptedImages = new Map<string, ImageEncryptionData>(); // messageId -> decrypted image data
const DecryptedVideos = new Map<string, VideoEncryptionData>(); // messageId -> decrypted video data
const DecryptedAudio = new Map<string, AudioEncryptionData>(); // messageId -> decrypted audio data
const DecryptedFiles = new Map<string, FileEncryptionData>(); // messageId -> decrypted file data
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

export function getDecryptedAudio() {
    return DecryptedAudio;
}

export function getDecryptedFiles() {
    return DecryptedFiles;
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

// Function to mark video elements in DOM for download interception and fix poster
function markVideoElementForDownload(encryptedVideoKey: string, blobUrl: string) {
    // Find video elements with matching src
    const videos = document.querySelectorAll('video') as NodeListOf<HTMLVideoElement>;

    for (const video of videos) {
        if (video.src === blobUrl && !(video as any).encryptedVideoKey) {
            (video as any).encryptedVideoKey = encryptedVideoKey;
            console.log('ChatEncryption: Marked video element for download interception:', encryptedVideoKey);

            // Fix poster attribute to use data URL thumbnail instead of blob URL
            const decryptedVideos = getDecryptedVideos();
            const videoData = decryptedVideos.get(encryptedVideoKey);
            if (videoData) {
                // Get the attachment to find the thumbnail
                const messageId = encryptedVideoKey.split('-')[0];
                const messageInstance = MessageInstances.get(messageId);
                if (messageInstance && messageInstance.attachments) {
                    const attachment = messageInstance.attachments.find(att =>
                        (att as any).encryptedVideoKey === encryptedVideoKey);
                    if (attachment) {
                        // Try multiple thumbnail properties
                        const thumbnailUrl = (attachment as any).thumbnail_url ||
                                            (attachment as any)._customThumbnail ||
                                            (attachment as any).poster ||
                                            (attachment as any).thumbnail;

                        if (thumbnailUrl && thumbnailUrl.startsWith('data:')) {
                            console.log('ChatEncryption: Setting video poster to:', thumbnailUrl.substring(0, 50));
                            video.poster = thumbnailUrl;

                            // Also try setting other attributes that might work
                            (video as any).thumbnail = thumbnailUrl;
                            video.setAttribute('poster', thumbnailUrl);

                            console.log('ChatEncryption: Fixed video poster to data URL thumbnail');
                            console.log('ChatEncryption: Video poster after fix:', video.poster?.substring(0, 50));
                        } else {
                            console.warn('ChatEncryption: No valid thumbnail URL found in attachment');
                        }
                    }
                }
            }
            break;
        }
    }
}

// Function to mark audio elements in DOM for download interception
function markAudioElementForDownload(encryptedAudioKey: string, blobUrl: string) {
    // Find audio elements with matching src
    const audios = document.querySelectorAll('audio') as NodeListOf<HTMLAudioElement>;

    let marked = false;
    for (const audio of audios) {
        if (audio.src === blobUrl && !(audio as any).encryptedAudioKey) {
            (audio as any).encryptedAudioKey = encryptedAudioKey;
            console.log('ChatEncryption: Marked audio element for download interception:', encryptedAudioKey);
            marked = true;
            break;
        }
    }
    
    if (!marked) {
        // Retry after a longer delay in case the element isn't ready yet
        setTimeout(() => {
            const retryAudios = document.querySelectorAll('audio') as NodeListOf<HTMLAudioElement>;
            for (const audio of retryAudios) {
                if (audio.src === blobUrl && !(audio as any).encryptedAudioKey) {
                    (audio as any).encryptedAudioKey = encryptedAudioKey;
                    console.log('ChatEncryption: Marked audio element for download interception (retry):', encryptedAudioKey);
                    break;
                }
            }
        }, 500);
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
                        originalBlob: blob,
                        encryptedVideoKey: attachmentKey
                    };

                    messageInstance.attachments[attachmentIndex] = syntheticAttachment;
                    restoredVideos++;

                    // Force message update
                    FluxDispatcher.dispatch({
                        type: "MESSAGE_UPDATE",
                        message: messageInstance
                    });

                    // Mark video element for download interception
                    setTimeout(() => {
                        markVideoElementForDownload(attachmentKey, blobUrl);
                    }, 100);
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
        video.preload = 'metadata';

        let hasGenerated = false;

        const cleanup = () => {
            if (video.src) {
                URL.revokeObjectURL(video.src);
            }
        };

        const generateThumbnail = () => {
            if (hasGenerated) return;
            hasGenerated = true;

            try {
                // Ensure video has valid dimensions
                if (video.videoWidth === 0 || video.videoHeight === 0) {
                    throw new Error('Video has no dimensions');
                }

                // Set canvas dimensions to video dimensions
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;

                // Draw current frame to canvas
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

                // Convert to data URL
                const thumbnailDataUrl = canvas.toDataURL('image/jpeg', 0.8);

                cleanup();
                resolve(thumbnailDataUrl);
            } catch (error) {
                cleanup();
                reject(error);
            }
        };

        // Set up event handlers
        video.addEventListener('loadedmetadata', () => {
            console.log('ChatEncryption: Video metadata loaded, dimensions:', video.videoWidth, 'x', video.videoHeight);

            // Try to generate thumbnail immediately if video is ready
            if (video.readyState >= 2) { // HAVE_CURRENT_DATA
                generateThumbnail();
            } else {
                // Seek to a good frame for thumbnail (1 second or 10% of duration)
                const seekTime = Math.min(1, video.duration * 0.1);
                video.currentTime = seekTime;
            }
        });

        video.addEventListener('seeked', generateThumbnail);
        video.addEventListener('loadeddata', generateThumbnail);

        video.addEventListener('error', (e) => {
            console.warn('ChatEncryption: Video thumbnail generation failed:', e);
            cleanup();
            reject(new Error(`Video load error: ${e}`));
        });

        // Timeout fallback
        setTimeout(() => {
            if (!hasGenerated) {
                console.warn('ChatEncryption: Video thumbnail generation timeout');
                cleanup();
                reject(new Error('Video thumbnail generation timeout'));
            }
        }, 10000);

        // Set video source
        video.src = URL.createObjectURL(videoBlob);

        // Try to load the video
        video.load();
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
                                console.log('ChatEncryption: Generating thumbnail for video:', result.videoData.filename);
                                thumbnail = await generateVideoThumbnail(blob, result.videoData.mimeType);
                                console.log('ChatEncryption: Successfully generated thumbnail');
                            } catch (error) {
                                console.warn("ChatEncryption: Failed to generate video thumbnail:", error);
                            }

                            // Always generate a fallback thumbnail as data URL to avoid Discord CDN issues
                            if (!thumbnail) {
                                try {
                                    const canvas = document.createElement('canvas');
                                    canvas.width = 320;
                                    canvas.height = 180;
                                    const ctx = canvas.getContext('2d');
                                    if (ctx) {
                                        // Draw a dark background with video icon
                                        ctx.fillStyle = '#2f3136';
                                        ctx.fillRect(0, 0, 320, 180);

                                        // Draw play icon
                                        ctx.fillStyle = '#ffffff';
                                        ctx.beginPath();
                                        ctx.moveTo(120, 60);
                                        ctx.lineTo(120, 120);
                                        ctx.lineTo(180, 90);
                                        ctx.closePath();
                                        ctx.fill();

                                        thumbnail = canvas.toDataURL('image/jpeg', 0.8);
                                        console.log('ChatEncryption: Generated fallback thumbnail');
                                    }
                                } catch (fallbackError) {
                                    console.warn('ChatEncryption: Failed to generate fallback thumbnail:', fallbackError);
                                }
                            }

                            // Debug: Log the thumbnail to see what we're setting
                            console.log("ChatEncryption: Generated thumbnail type:", thumbnail ? "data URL" : "none");
                            console.log("ChatEncryption: Thumbnail starts with data:", thumbnail?.startsWith('data:'));

                            // Debug: Log original attachment to see CDN-related properties
                            console.log("ChatEncryption: Original attachment keys:", Object.keys(attachment));
                            console.log("ChatEncryption: Original attachment ID:", attachment.id);
                            console.log("ChatEncryption: Original proxy_url:", attachment.proxy_url);

                            // INSIGHT: Discord is auto-generating thumbnails for ANY video content_type
                            const syntheticAttachment = {
                                filename: result.videoData.filename,
                                content_type: result.videoData.mimeType,
                                size: blob.size,
                                url: blobUrl,
                                proxy_url: blobUrl, // Main video blob URL
                                width: result.videoData.width || 640,
                                height: result.videoData.height || 480,
                                // Thumbnail properties - Discord expects these for video thumbnails
                                thumbnail: thumbnail ? {
                                    url: thumbnail,
                                    proxy_url: thumbnail, // Use data URL directly as proxy
                                    width: 320,
                                    height: 180
                                } : null,
                                // Additional thumbnail properties Discord might check
                                thumbnail_url: thumbnail,
                                thumbnail_proxy_url: thumbnail,
                                thumbnail_width: 320,
                                thumbnail_height: 180,
                                // Prevent CDN processing by removing Discord-specific properties
                                spoiler: false,
                                deleted: false,
                                // Mark as encrypted video for our custom handling
                                isEncryptedVideo: true,
                                originalBlob: blob,
                                encryptedVideoKey: attachmentKey
                            };

                            // Remove any properties that might contain blob URLs
                            const propsToClean = ['thumbnail_url', 'thumbnail_proxy_url', 'poster', 'preview', 'thumbnail'];
                            propsToClean.forEach(prop => {
                                if (syntheticAttachment[prop] && syntheticAttachment[prop].startsWith('blob:')) {
                                    console.warn(`ChatEncryption: Found blob URL in ${prop}, replacing with data URL`);
                                    syntheticAttachment[prop] = thumbnail || null;
                                }
                            });

                            // Debug: log the final attachment structure
                            console.log("ChatEncryption: Final attachment thumbnail_url:", syntheticAttachment.thumbnail_url?.substring(0, 50));
                            console.log("ChatEncryption: Full attachment object:", {
                                filename: syntheticAttachment.filename,
                                content_type: syntheticAttachment.content_type,
                                url: syntheticAttachment.url?.substring(0, 50),
                                thumbnail_url: syntheticAttachment.thumbnail_url?.substring(0, 50),
                                thumbnail_width: syntheticAttachment.thumbnail_width,
                                thumbnail_height: syntheticAttachment.thumbnail_height,
                                width: syntheticAttachment.width,
                                height: syntheticAttachment.height,
                                size: syntheticAttachment.size
                            });

                            // Replace the attachment in the message
                            message.attachments[attachmentIndex] = syntheticAttachment;
                            console.log("ChatEncryption: Replaced video attachment in message with blob URL");
                            console.log("ChatEncryption: ✅ IMPORTANT: No CDN network error - check if thumbnail is now visible!");

                            // Set up observer to mark video elements when they appear in DOM
                            setTimeout(() => {
                                markVideoElementForDownload(attachmentKey, blobUrl);

                                // Additional debugging - check if video element exists and what its poster is
                                setTimeout(() => {
                                    const videos = document.querySelectorAll('video');
                                    for (const video of videos) {
                                        if (video.src === blobUrl) {
                                            console.log('ChatEncryption: Found video element after marking');
                                            console.log('ChatEncryption: Video poster:', video.poster?.substring(0, 50));
                                            console.log('ChatEncryption: Video encrypted key:', (video as any).encryptedVideoKey);
                                            console.log('ChatEncryption: Video attributes:', {
                                                src: video.src?.substring(0, 50),
                                                poster: video.poster?.substring(0, 50),
                                                width: video.width,
                                                height: video.height,
                                                videoWidth: video.videoWidth,
                                                videoHeight: video.videoHeight
                                            });

                                            // Set up a detailed observer for this specific video
                                            const detailObserver = new MutationObserver((mutations) => {
                                                mutations.forEach((mutation) => {
                                                    if (mutation.attributeName === 'poster') {
                                                        console.log('ChatEncryption: POSTER CHANGED!');
                                                        console.log('ChatEncryption: Old poster:', mutation.oldValue?.substring(0, 50));
                                                        console.log('ChatEncryption: New poster:', video.poster?.substring(0, 50));
                                                        console.log('ChatEncryption: Change time:', new Date().toISOString());
                                                    }
                                                });
                                            });

                                            detailObserver.observe(video, {
                                                attributes: true,
                                                attributeOldValue: true,
                                                attributeFilter: ['poster', 'src']
                                            });

                                            break;
                                        }
                                    }
                                }, 500);
                            }, 100);
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
        // Check if this looks like our encrypted audio format
        else if (textContent.startsWith('[AUD_ENC:v1:')) {
            console.log("ChatEncryption: Found encrypted audio attachment");

            const allPhrases = [
                settings.store.secretPhrase,
                ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
            ].filter(Boolean);

            if (allPhrases.length > 0) {
                // Try to decrypt with all available phrases
                for (const phrase of allPhrases) {
                    const result = await decryptAudioMessage(textContent, phrase);
                    if (result.success && result.audioData) {
                        console.log("ChatEncryption: Successfully decrypted audio attachment:", result.audioData.filename);

                        // Store the decrypted audio data
                        DecryptedAudio.set(attachmentKey, result.audioData);

                        // Replace the attachment in the message object directly
                        const attachmentIndex = message.attachments.findIndex(att => att.id === attachment.id);
                        if (attachmentIndex !== -1) {
                            // Convert base64 to blob for audio
                            const binaryString = atob(result.audioData.audioData);
                            const bytes = new Uint8Array(binaryString.length);
                            for (let i = 0; i < binaryString.length; i++) {
                                bytes[i] = binaryString.charCodeAt(i);
                            }

                            const blob = new Blob([bytes], { type: result.audioData.mimeType });
                            const blobUrl = URL.createObjectURL(blob);

                            console.log("ChatEncryption: Created audio blob URL, size:", blob.size, "bytes");

                            // Create synthetic audio attachment
                            const syntheticAttachment = {
                                ...attachment,
                                filename: result.audioData.filename,
                                content_type: result.audioData.mimeType,
                                url: blobUrl,
                                proxy_url: blobUrl,
                                size: blob.size,
                                isEncryptedAudio: true,
                                originalBlob: blob,
                                encryptedAudioKey: attachmentKey,
                                duration_secs: result.audioData.duration
                            };

                            // Replace the attachment in the message
                            message.attachments[attachmentIndex] = syntheticAttachment;
                            console.log("ChatEncryption: Replaced audio attachment in message with blob URL");

                            // Mark audio element for download interception
                            setTimeout(() => {
                                markAudioElementForDownload(attachmentKey, blobUrl);
                            }, 100);
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
        // Check if this looks like our encrypted file format
        else if (textContent.startsWith('[FILE_ENC:v1:')) {
            console.log("ChatEncryption: Found encrypted file attachment");

            const allPhrases = [
                settings.store.secretPhrase,
                ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
            ].filter(Boolean);

            if (allPhrases.length > 0) {
                // Try to decrypt with all available phrases
                for (const phrase of allPhrases) {
                    const result = await decryptFileMessage(textContent, phrase);
                    if (result.success && result.fileData) {
                        console.log("ChatEncryption: Successfully decrypted file attachment:", result.fileData.filename);

                        // Store the decrypted file data
                        DecryptedFiles.set(attachmentKey, result.fileData);

                        // Replace the attachment in the message object directly
                        const attachmentIndex = message.attachments.findIndex(att => att.id === attachment.id);
                        if (attachmentIndex !== -1) {
                            // For generic files, we don't create blob URLs immediately
                            // They'll be created on-demand when user clicks download
                            const syntheticAttachment = {
                                ...attachment,
                                filename: result.fileData.filename,
                                content_type: result.fileData.mimeType,
                                size: result.fileData.size,
                                isEncryptedFile: true,
                                encryptedFileKey: attachmentKey
                            };

                            // Replace the attachment in the message
                            message.attachments[attachmentIndex] = syntheticAttachment;
                            console.log("ChatEncryption: Replaced file attachment in message");
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
                                            originalBlob: blob,
                                            encryptedVideoKey: attachmentKey
                                        };

                                        message.attachments[attachmentIndex] = syntheticAttachment;

                                        FluxDispatcher.dispatch({
                                            type: "MESSAGE_UPDATE",
                                            message: message
                                        });

                                        // Mark video element for download interception
                                        setTimeout(() => {
                                            markVideoElementForDownload(attachmentKey, blobUrl);
                                        }, 100);
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
                                            originalBlob: blob,
                                            encryptedVideoKey: attachmentKey
                                        };

                                        message.attachments[attachmentIndex] = syntheticAttachment;

                                        FluxDispatcher.dispatch({
                                            type: "MESSAGE_UPDATE",
                                            message: message
                                        });

                                        // Mark video element for download interception
                                        setTimeout(() => {
                                            markVideoElementForDownload(attachmentKey, blobUrl);
                                        }, 100);
                                    });
                            }
                        }
                    }, 100);
                }

                // Also check for cached audio that needs restoration
                const cachedAudioDecryption = DecryptedAudio.get(attachmentKey);
                if (cachedAudioDecryption && !attachment.url?.startsWith('blob:')) {
                    // Delay slightly to avoid immediate re-render conflicts
                    setTimeout(() => {
                        const currentAttachment = message.attachments?.find(att => att.id === attachment.id);
                        if (currentAttachment && !currentAttachment.url?.startsWith('blob:')) {
                            const attachmentIndex = message.attachments.findIndex(att => att.id === attachment.id);
                            if (attachmentIndex !== -1) {
                                // Convert base64 to blob for audio
                                const binaryString = atob(cachedAudioDecryption.audioData);
                                const bytes = new Uint8Array(binaryString.length);
                                for (let i = 0; i < binaryString.length; i++) {
                                    bytes[i] = binaryString.charCodeAt(i);
                                }

                                const blob = new Blob([bytes], { type: cachedAudioDecryption.mimeType });
                                const blobUrl = URL.createObjectURL(blob);

                                const syntheticAttachment = {
                                    ...currentAttachment,
                                    filename: cachedAudioDecryption.filename,
                                    content_type: cachedAudioDecryption.mimeType,
                                    url: blobUrl,
                                    proxy_url: blobUrl,
                                    size: blob.size,
                                    isEncryptedAudio: true,
                                    originalBlob: blob,
                                    encryptedAudioKey: attachmentKey,
                                    duration_secs: cachedAudioDecryption.duration
                                };

                                message.attachments[attachmentIndex] = syntheticAttachment;

                                FluxDispatcher.dispatch({
                                    type: "MESSAGE_UPDATE",
                                    message: message
                                });

                                // Mark audio element for download interception
                                setTimeout(() => {
                                    markAudioElementForDownload(attachmentKey, blobUrl);
                                }, 100);
                            }
                        }
                    }, 100);
                }

                // Also check for cached files that need restoration  
                const cachedFileDecryption = DecryptedFiles.get(attachmentKey);
                if (cachedFileDecryption) {
                    // For generic files, we don't need to create blob URLs since they'll be downloaded on demand
                    // Just mark the attachment as decrypted and update the filename/size
                    setTimeout(() => {
                        const currentAttachment = message.attachments?.find(att => att.id === attachment.id);
                        if (currentAttachment) {
                            const attachmentIndex = message.attachments.findIndex(att => att.id === attachment.id);
                            if (attachmentIndex !== -1) {
                                const syntheticAttachment = {
                                    ...currentAttachment,
                                    filename: cachedFileDecryption.filename,
                                    content_type: cachedFileDecryption.mimeType,
                                    size: cachedFileDecryption.size,
                                    isEncryptedFile: true,
                                    encryptedFileKey: attachmentKey
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
        const isEncryptedAud = isEncryptedAudioMessage(messageContent);
        const isEncryptedFile = isEncryptedFileMessage(messageContent);
        setIsEncrypted(isEncryptedMsg || isEncryptedImg || isEncryptedVid || isEncryptedAud || isEncryptedFile || hasEncryptedAttachment);

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

        // Handle encrypted audio messages
        if (isEncryptedAud && !DecryptedAudio.has(message.id)) {
            const allPhrases = [
                settings.store.secretPhrase,
                ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
            ].filter(Boolean);

            if (allPhrases.length > 0) {
                // Try to decrypt the audio with all available phrases
                (async () => {
                    for (const phrase of allPhrases) {
                        const result = await decryptAudioMessage(messageContent, phrase);
                        if (result.success && result.audioData) {
                            DecryptedAudio.set(message.id, result.audioData);
                            // Force re-render
                            FluxDispatcher.dispatch({
                                type: "MESSAGE_UPDATE",
                                message: message
                            });
                            break;
                        }
                    }
                })().catch(error => {
                    console.error("Auto-decryption failed for audio message:", message.id, error);
                });
            }
        }

        // Handle encrypted file messages
        if (isEncryptedFile && !DecryptedFiles.has(message.id)) {
            const allPhrases = [
                settings.store.secretPhrase,
                ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
            ].filter(Boolean);

            if (allPhrases.length > 0) {
                // Try to decrypt the file with all available phrases
                (async () => {
                    for (const phrase of allPhrases) {
                        const result = await decryptFileMessage(messageContent, phrase);
                        if (result.success && result.fileData) {
                            DecryptedFiles.set(message.id, result.fileData);
                            // Force re-render
                            FluxDispatcher.dispatch({
                                type: "MESSAGE_UPDATE",
                                message: message
                            });
                            break;
                        }
                    }
                })().catch(error => {
                    console.error("Auto-decryption failed for file message:", message.id, error);
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

    // Check for decrypted messages, images, videos, audio, and files
    const decryptedResult = DecryptedMessages.get(message.id);
    const decryptedImage = DecryptedImages.get(message.id);
    const decryptedVideo = DecryptedVideos.get(message.id);
    const decryptedAudio = DecryptedAudio.get(message.id);
    const decryptedFile = DecryptedFiles.get(message.id);

    // Check if any attachments for this message have been decrypted
    const hasDecryptedAttachments = Array.from(DecryptedImages.keys()).some(key => key.startsWith(`${message.id}-`));
    const hasDecryptedVideoAttachments = Array.from(DecryptedVideos.keys()).some(key => key.startsWith(`${message.id}-`));
    const hasDecryptedAudioAttachments = Array.from(DecryptedAudio.keys()).some(key => key.startsWith(`${message.id}-`));
    const hasDecryptedFileAttachments = Array.from(DecryptedFiles.keys()).some(key => key.startsWith(`${message.id}-`));

    // Don't show decrypted attachments in accessory - always use Discord's native viewer via attachment replacement
    const decryptedAttachments: ImageEncryptionData[] = [];

    if (decryptedResult?.success || decryptedImage || decryptedVideo || decryptedAudio || decryptedFile || hasDecryptedAttachments || hasDecryptedVideoAttachments || hasDecryptedAudioAttachments || hasDecryptedFileAttachments || decryptedAttachments.length > 0) {
        return (
            <div className={cl("encryption-accessories")}>
                {(decryptedResult?.success || hasDecryptedAttachments || hasDecryptedVideoAttachments || hasDecryptedAudioAttachments || hasDecryptedFileAttachments) && (
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
                {decryptedAudio && (
                    <div className={cl("decrypted-audio-container")}>
                        <audio
                            src={`data:${decryptedAudio.mimeType};base64,${decryptedAudio.audioData}`}
                            className={cl("decrypted-audio")}
                            controls
                            style={{ width: '100%', maxWidth: '400px' }}
                        />
                        <div className={cl("audio-info")}>
                            <EncryptionIcon width={12} height={12} className={cl("audio-lock-icon")} />
                            {" "}{decryptedAudio.filename}
                            {decryptedAudio.duration && (
                                <span className={cl("audio-duration")}> ({Math.round(decryptedAudio.duration)}s)</span>
                            )}
                        </div>
                    </div>
                )}
                {decryptedFile && (
                    <div className={cl("decrypted-file-container")}>
                        <div className={cl("file-attachment")}>
                            <div className={cl("file-icon")}>📄</div>
                            <div className={cl("file-details")}>
                                <div className={cl("file-name")}>
                                    <EncryptionIcon width={12} height={12} className={cl("file-lock-icon")} />
                                    {" "}{decryptedFile.filename}
                                </div>
                                <div className={cl("file-size")}>
                                    {(decryptedFile.size / 1024).toFixed(1)} KB
                                </div>
                            </div>
                            <button
                                className={cl("file-download-button")}
                                onClick={() => {
                                    // Create download link
                                    const blob = new Blob([new Uint8Array(atob(decryptedFile.fileData).split('').map(c => c.charCodeAt(0)))], { type: decryptedFile.mimeType });
                                    const url = URL.createObjectURL(blob);
                                    const link = document.createElement('a');
                                    link.href = url;
                                    link.download = decryptedFile.filename;
                                    link.style.display = 'none';
                                    document.body.appendChild(link);
                                    link.click();
                                    document.body.removeChild(link);
                                    URL.revokeObjectURL(url);
                                }}
                            >
                                💾 Download
                            </button>
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
