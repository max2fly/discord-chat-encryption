import { Message } from "@vencord/discord-types";
import { useEffect, useState } from "@webpack/common";
import { FluxDispatcher } from "@webpack/common";
import { findByPropsLazy } from "@webpack";

import { EncryptionIcon } from "./EncryptionIcon";
import { settings } from "./settings";
import { cl, decryptWithMultiplePhrases, EncryptionResult, isEncryptedMessage, isHiddenMessage, extractHiddenMessage, isEncryptedImageMessage, decryptImageMessage, ImageEncryptionData } from "./utils";

// Cache for downloaded attachment content to avoid re-downloading
const AttachmentContentCache = new Map<string, string>();

const DecryptedMessages = new Map<string, EncryptionResult>();
const MessageInstances = new Map<string, Message>();
const UpdateTriggers = new Map<string, () => void>();
const EncryptedMessageQueue = new Map<string, string>(); // messageId -> encrypted content
const DecryptedImages = new Map<string, ImageEncryptionData>(); // messageId -> decrypted image data
const ProcessedAttachments = new Set<string>(); // Track processed attachment URLs to avoid re-processing
const DownloadQueue = new Map<string, Promise<string>>(); // Track ongoing downloads to avoid duplicates

export function getDecryptedMessages() {
    return DecryptedMessages;
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

// Download attachment content with retry logic and caching
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
        console.log("ChatEncryption: Download already in progress, waiting...");
        return await DownloadQueue.get(downloadKey)!;
    }
    
    const downloadPromise = async (): Promise<string> => {
        console.log("ChatEncryption: Downloading attachment:", attachment.filename, "from:", url);
        
        // For text files, only use direct CDN URL (proxy URL returns 415 for .txt files)
        const urlsToTry = [attachment.url].filter(Boolean);
        
        for (const currentUrl of urlsToTry) {
            console.log("ChatEncryption: Trying URL:", currentUrl);
            
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    console.log(`ChatEncryption: Download attempt ${attempt}/${maxAttempts} for ${currentUrl}`);
                    
                    const response = await fetch(currentUrl);
                    
                    if (!response.ok) {
                        // Don't retry on permanent failures
                        if (response.status === 404 || response.status === 403) {
                            throw new Error(`HTTP ${response.status}: ${response.statusText} (permanent failure)`);
                        }
                        
                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }
                    
                    const content = await response.text();
                    console.log("ChatEncryption: Successfully downloaded content, length:", content.length);
                    console.log("ChatEncryption: Content preview:", content.substring(0, 100));
                    
                    // Cache the content for future use
                    AttachmentContentCache.set(cacheKey, content);
                    
                    return content;
                    
                } catch (error) {
                    console.error(`ChatEncryption: Download attempt ${attempt} failed for ${currentUrl}:`, error);
                    
                    // If this is a CORS error, don't retry this URL
                    if ((error as Error).message.includes("CORS") || (error as Error).message.includes("cors")) {
                        console.log("ChatEncryption: CORS error detected, trying next URL if available");
                        break; // Break out of retry loop for this URL
                    }
                    
                    // If this was the last attempt or a permanent error, continue to next URL
                    if (attempt === maxAttempts || (error as Error).message.includes("permanent failure")) {
                        break;
                    }
                    
                    // Exponential backoff before retry
                    const delay = 1000 * attempt;
                    console.log(`ChatEncryption: Waiting ${delay}ms before retry...`);
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
    
    // Skip if already processed
    if (ProcessedAttachments.has(attachmentKey)) {
        return;
    }
    
    ProcessedAttachments.add(attachmentKey);
    
    try {
        console.log("ChatEncryption: Downloading encrypted attachment:", attachment.url);
        
        // For text files, use direct CDN URL only (proxy returns 415 for txt files)
        const urlToFetch = attachment.url;
        
        console.log("ChatEncryption: Fetching from URL:", urlToFetch);
        
        // Download attachment content directly
        const textContent = await downloadAttachment(attachment, urlToFetch);
        
        console.log("ChatEncryption: Downloaded content preview:", textContent.substring(0, 100));
        
        // Check if this looks like our encrypted image format
        if (textContent.startsWith('[IMG_ENC:v1:')) {
            console.log("ChatEncryption: Found encrypted image attachment");
            
            const allPhrases = [
                settings.store.secretPhrase,
                ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
            ].filter(Boolean);

            if (allPhrases.length > 0) {
                // Try to decrypt with all available phrases
                for (const phrase of allPhrases) {
                    const result = await decryptImageMessage(textContent, phrase);
                    if (result.success && result.imageData) {
                        console.log("ChatEncryption: Successfully decrypted attachment:", result.imageData.filename);
                        
                        // Store the decrypted image data
                        DecryptedImages.set(attachmentKey, result.imageData);
                        
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
            console.log("ChatEncryption: Attachment does not appear to be encrypted image format");
        }
    } catch (error) {
        console.error("ChatEncryption: Failed to process encrypted attachment:", error);
        ProcessedAttachments.delete(attachmentKey); // Allow retry on error
    }
}

export function EncryptionAccessory({ message }: { message: Message; }) {
    const [decryptedContent, setDecryptedContent] = useState<string | null>(null);
    const [isEncrypted, setIsEncrypted] = useState(false);

    useEffect(() => {
        if ((message as any).vencordEmbeddedBy) return;

        const messageContent = message.content || "";
        let contentToDecrypt = messageContent;
        let isEncryptedMsg = false;
        let isEncryptedImg = false;
        let hasEncryptedAttachment = false;

        // Check for encrypted file attachments
        console.log("ChatEncryption: Checking message attachments:", message.attachments);
        if (message.attachments && message.attachments.length > 0) {
            console.log("ChatEncryption: Found", message.attachments.length, "attachments");
            for (const attachment of message.attachments) {
                console.log("ChatEncryption: Checking attachment:", {
                    filename: attachment.filename,
                    content_type: attachment.content_type,
                    size: attachment.size,
                    url: attachment.url
                });
                
                // Check if this looks like an encrypted file
                // Our encrypted files are .txt files with text/plain content type
                if (attachment.filename.endsWith('.txt') && 
                    attachment.content_type?.startsWith('text/plain')) {
                    console.log("ChatEncryption: Found potential encrypted attachment (.txt file):", attachment);
                    hasEncryptedAttachment = true;
                    // Try to download and decrypt this attachment
                    handleEncryptedAttachment(message, attachment);
                } else {
                    console.log("ChatEncryption: Attachment doesn't match encrypted file pattern:", {
                        filename: attachment.filename,
                        isTxtFile: attachment.filename.endsWith('.txt'),
                        contentType: attachment.content_type
                    });
                }
            }
        } else {
            console.log("ChatEncryption: No attachments found in message");
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

        setIsEncrypted(isEncryptedMsg || isEncryptedImg || hasEncryptedAttachment);

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

        // Check if already decrypted
        const existingDecryption = DecryptedMessages.get(message.id);
        if (existingDecryption?.success) {
            setDecryptedContent(existingDecryption.text);
            return;
        }

        if (isEncryptedMsg) {
            const allPhrases = [
                settings.store.secretPhrase,
                ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
            ].filter(Boolean);

            if (allPhrases.length > 0) {
                // Process decryption immediately
                decryptWithMultiplePhrases(contentToDecrypt, allPhrases)
                    .then(result => {
                        if (result.success) {
                            DecryptedMessages.set(message.id, result);
                            // Modify the message content directly
                            (message as any).content = result.text;
                            setDecryptedContent(result.text);
                            
                            // Force Discord to re-render this message using Flux
                            FluxDispatcher.dispatch({
                                type: "MESSAGE_UPDATE",
                                message: message
                            });
                        }
                    })
                    .catch(error => {
                        console.error("Auto-decryption failed for message:", message.id, error);
                    });
            }
        }
    }, [message.id, message.content]);

    // Check for decrypted messages and images
    const decryptedResult = DecryptedMessages.get(message.id);
    const decryptedImage = DecryptedImages.get(message.id);
    
    // Check for decrypted attachments
    const decryptedAttachments: ImageEncryptionData[] = [];
    if (message.attachments && message.attachments.length > 0) {
        for (const attachment of message.attachments) {
            const attachmentKey = `${message.id}-${attachment.id}`;
            const decryptedAttachment = DecryptedImages.get(attachmentKey);
            if (decryptedAttachment) {
                decryptedAttachments.push(decryptedAttachment);
            }
        }
    }
    
    if (decryptedResult?.success || decryptedImage || decryptedAttachments.length > 0) {
        return (
            <div className={cl("encryption-accessories")}>
                {decryptedResult?.success && (
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
