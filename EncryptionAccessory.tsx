import { Message } from "@vencord/discord-types";
import { useEffect, useState } from "@webpack/common";

import { EncryptionIcon } from "./EncryptionIcon";
import { settings } from "./settings";
import { cl, decryptWithMultiplePhrases, EncryptionResult, isEncryptedMessage, isHiddenMessage, extractHiddenMessage } from "./utils";

const DecryptedMessages = new Map<string, EncryptionResult>();
const MessageInstances = new Map<string, Message>();
const UpdateTriggers = new Map<string, () => void>();
const EncryptedMessageQueue = new Map<string, string>(); // messageId -> encrypted content

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
    const [isDecrypted, setIsDecrypted] = useState(() => {
        // Check if already decrypted on initial render
        return DecryptedMessages.has(message.id);
    });
    const [decryptedContent, setDecryptedContent] = useState<string | null>(null);
    const [, forceUpdate] = useState({});

    useEffect(() => {
        if ((message as any).vencordEmbeddedBy) return;

        // Register message instance and update trigger
        MessageInstances.set(message.id, message);
        UpdateTriggers.set(message.id, () => {
            setIsDecrypted(true);
            forceUpdate({});
        });

        const messageContent = message.content || "";
        let contentToDecrypt = messageContent;
        let isEncryptedMsg = false;

        // Check if this is a hidden message first
        if (isHiddenMessage(messageContent)) {
            const extractedEncrypted = extractHiddenMessage(messageContent);
            if (extractedEncrypted) {
                contentToDecrypt = extractedEncrypted;
                isEncryptedMsg = isEncryptedMessage(contentToDecrypt);
            }
        } else {
            isEncryptedMsg = isEncryptedMessage(messageContent);
        }

        // Check if already processed, but re-process if content changed back to encrypted
        const existingDecryption = DecryptedMessages.get(message.id);
        if (existingDecryption && existingDecryption.success) {
            // If we have a decryption but the current content is encrypted again (server update), re-decrypt
            if (isEncryptedMsg) {
                // Don't return, continue with decryption
            } else {
                setIsDecrypted(true);
                return;
            }
        }

        if (isEncryptedMsg) {
            // Add to queue for potential future decryption
            EncryptedMessageQueue.set(message.id, contentToDecrypt);

            const allPhrases = [
                settings.store.secretPhrase,
                ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
            ].filter(Boolean);

            if (allPhrases.length > 0) {
                // Process decryption immediately without waiting for user interaction
                setTimeout(() => {
                    decryptWithMultiplePhrases(contentToDecrypt, allPhrases)
                        .then(result => {
                            if (result.success) {
                                // Override the message content immediately
                                (message as any).content = result.text;
                                DecryptedMessages.set(message.id, result);
                                EncryptedMessageQueue.delete(message.id); // Remove from queue once decrypted
                                setIsDecrypted(true);

                                // Force a re-render of the message
                                setTimeout(() => forceUpdate({}), 10);
                            }
                        })
                        .catch(error => {
                            console.error("Auto-decryption failed for message:", message.id, error);
                        });
                }, 0); // Process in next tick to ensure DOM is ready
            }
        }

        // Cleanup function
        return () => {
            MessageInstances.delete(message.id);
            UpdateTriggers.delete(message.id);
            EncryptedMessageQueue.delete(message.id);
        };

    }, [message.id, message.content]); // Also depend on content changes

    // If we have decrypted content, temporarily override the message content
    const originalContent = message.content;
    const decryptedResult = DecryptedMessages.get(message.id);

    if (decryptedResult?.success && originalContent !== decryptedResult.text) {
        // Override the message content for display
        (message as any).content = decryptedResult.text;
    }

    if (!isDecrypted) return null;

    return (
        <div className={cl("profile-lock-indicator")}>
            <EncryptionIcon width={12} height={12} className={cl("profile-lock-icon")} />
        </div>
    );
}
