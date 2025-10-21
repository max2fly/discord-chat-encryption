import { Message } from "@vencord/discord-types";
import { useEffect, useState } from "@webpack/common";
import { FluxDispatcher } from "@webpack/common";

import { EncryptionIcon } from "./EncryptionIcon";
import { settings } from "./settings";
import { cl, decryptWithMultiplePhrases, EncryptionResult, isEncryptedMessage, isHiddenMessage, extractHiddenMessage } from "./utils";

const DecryptedMessages = new Map<string, EncryptionResult>();
const MessageInstances = new Map<string, Message>();
const UpdateTriggers = new Map<string, () => void>();
const EncryptedMessageQueue = new Map<string, string>(); // messageId -> encrypted content

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

        setIsEncrypted(isEncryptedMsg);

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

    // Show lock icon if we have a decrypted message (check the global map)
    const decryptedResult = DecryptedMessages.get(message.id);
    if (decryptedResult?.success) {
        return (
            <div className={cl("profile-lock-indicator")}>
                <EncryptionIcon width={12} height={12} className={cl("profile-lock-icon")} />
            </div>
        );
    }

    return null;
}
