/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot } from "@utils/modal";
import { Button, Forms, TextInput, useState } from "@webpack/common";

import { decryptAllQueuedMessages } from "./EncryptionAccessory";
import { settings } from "./settings";
import { cl, decrypt } from "./utils";

interface DecryptionModalProps {
    rootProps: ModalProps;
    encryptedContent: string;
    onSuccess: (decryptedText: string, usedPhrase: string) => void;
}

export function DecryptionModal({ rootProps, encryptedContent, onSuccess }: DecryptionModalProps) {
    const [phrase, setPhrase] = useState("");
    const [isDecrypting, setIsDecrypting] = useState(false);
    const [error, setError] = useState("");

    const handleDecrypt = async () => {
        if (!phrase.trim()) {
            setError("Please enter a secret phrase");
            return;
        }

        setIsDecrypting(true);
        setError("");

        try {
            const result = await decrypt(encryptedContent, phrase.trim());
            
            if (result.success) {
                // Auto-add to backup phrases if not already present
                const currentBackupPhrases = settings.store.backupSecretPhrases
                    .split(',')
                    .map(p => p.trim())
                    .filter(Boolean);
                
                const trimmedPhrase = phrase.trim();
                if (!currentBackupPhrases.includes(trimmedPhrase) && 
                    settings.store.secretPhrase !== trimmedPhrase) {
                    
                    const newBackupPhrases = [...currentBackupPhrases, trimmedPhrase].join(', ');
                    settings.store.backupSecretPhrases = newBackupPhrases;
                }

                onSuccess(result.text, trimmedPhrase);
                
                // Trigger batch decryption for all queued messages with new phrase
                setTimeout(() => {
                    decryptAllQueuedMessages();
                }, 100);
                
                rootProps.onClose();
            } else {
                setError(result.error || "Decryption failed");
            }
        } catch (err) {
            setError("An error occurred during decryption");
            console.error("Decryption error:", err);
        } finally {
            setIsDecrypting(false);
        }
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !isDecrypting) {
            handleDecrypt();
        }
    };

    return (
        <ModalRoot {...rootProps}>
            <ModalHeader className={cl("modal-header")}>
                <Forms.FormTitle tag="h2" className={cl("modal-title")}>
                    Decrypt Message
                </Forms.FormTitle>
                <ModalCloseButton onClick={rootProps.onClose} />
            </ModalHeader>

            <ModalContent className={cl("modal-content")}>
                <Forms.FormText style={{ marginBottom: "12px", color: "var(--text-normal)" }}>
                    Enter the secret phrase to decrypt this message:
                </Forms.FormText>

                <TextInput
                    type="password"
                    placeholder="Enter secret phrase..."
                    value={phrase}
                    onChange={setPhrase}
                    onKeyPress={handleKeyPress}
                    autoFocus
                    style={{ marginBottom: "12px" }}
                />

                {error && (
                    <Forms.FormText style={{ color: "var(--text-danger)", marginBottom: "12px", fontSize: "14px" }}>
                        {error}
                    </Forms.FormText>
                )}

                <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                    <Button 
                        color={Button.Colors.PRIMARY}
                        size={Button.Sizes.SMALL}
                        onClick={rootProps.onClose}
                        disabled={isDecrypting}
                    >
                        Cancel
                    </Button>
                    <Button 
                        color={Button.Colors.BRAND}
                        size={Button.Sizes.SMALL}
                        onClick={handleDecrypt}
                        disabled={isDecrypting || !phrase.trim()}
                    >
                        {isDecrypting ? "Decrypting..." : "Decrypt"}
                    </Button>
                </div>

                <Forms.FormText style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "12px" }}>
                    If decryption is successful, this phrase will be automatically added to your backup secret phrases.
                </Forms.FormText>
            </ModalContent>
        </ModalRoot>
    );
}