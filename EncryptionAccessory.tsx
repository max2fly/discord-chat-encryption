import { Message } from "@vencord/discord-types";
import { useEffect, useState } from "@webpack/common";
import { FluxDispatcher } from "@webpack/common";

import { EncryptionIcon } from "./EncryptionIcon";
import { settings } from "./settings";
import { cl, decryptWithMultiplePhrases, EncryptionResult, isEncryptedMessage, isHiddenMessage, extractHiddenMessage, isEncryptedImageMessage, decryptImageMessage, ImageEncryptionData } from "./utils";

const DecryptedMessages = new Map<string, EncryptionResult>();
const MessageInstances = new Map<string, Message>();
const UpdateTriggers = new Map<string, () => void>();
const EncryptedMessageQueue = new Map<string, string>(); // messageId -> encrypted content
const DecryptedImages = new Map<string, ImageEncryptionData>(); // messageId -> decrypted image data

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

export function EncryptionAccessory({ message }: { message: Message; }) {
    const [decryptedContent, setDecryptedContent] = useState<string | null>(null);
    const [isEncrypted, setIsEncrypted] = useState(false);

    useEffect(() => {
        if ((message as any).vencordEmbeddedBy) return;

        const messageContent = message.content || "";
        let contentToDecrypt = messageContent;
        let isEncryptedMsg = false;
        let isEncryptedImg = false;

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

        setIsEncrypted(isEncryptedMsg || isEncryptedImg);

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
    
    if (decryptedResult?.success || decryptedImage) {
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
            </div>
        );
    }

    return null;
}
