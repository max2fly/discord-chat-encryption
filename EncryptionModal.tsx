import { Divider } from "@components/Divider";
import { FormSwitch } from "@components/FormSwitch";
import { Margins } from "@utils/margins";
import { ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot } from "@utils/modal";
import { Forms, TextInput, useState } from "@webpack/common";

import { settings } from "./settings";
import { cl } from "./utils";

function SecretPhraseInput() {
    const [localPhrase, setLocalPhrase] = useState(settings.store.secretPhrase);
    const [showPhrase, setShowPhrase] = useState(false);

    const updatePhrase = (value: string) => {
        setLocalPhrase(value);
        settings.store.secretPhrase = value;
    };

    return (
        <section className={Margins.bottom16}>
            <Forms.FormTitle tag="h3">
                Secret Phrase
            </Forms.FormTitle>
            <Forms.FormText className={Margins.bottom8}>
                This phrase will be used to encrypt and decrypt your messages. Keep it secure and share it only with trusted contacts.
            </Forms.FormText>

            <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                    <TextInput
                        type={showPhrase ? "text" : "password"}
                        value={localPhrase}
                        onChange={updatePhrase}
                        placeholder="Enter your secret phrase..."
                    />
                </div>
                <button
                    type="button"
                    onClick={() => setShowPhrase(!showPhrase)}
                    style={{
                        padding: "8px 12px",
                        border: "1px solid var(--background-modifier-accent)",
                        borderRadius: "4px",
                        background: "var(--background-secondary)",
                        color: "var(--text-normal)",
                        cursor: "pointer"
                    }}
                >
                    {showPhrase ? "Hide" : "Show"}
                </button>
            </div>
        </section>
    );
}

function AutoEncryptToggle() {
    const value = settings.use(["autoEncrypt"]).autoEncrypt;

    return (
        <FormSwitch
            title="Auto Encrypt"
            description="Automatically encrypt all outgoing messages when enabled"
            value={value}
            onChange={v => settings.store.autoEncrypt = v}
            hideBorder
        />
    );
}

function HiddenMessageToggle() {
    const value = settings.use(["useHiddenMessages"]).useHiddenMessages;

    return (
        <FormSwitch
            title="Use Hidden Messages"
            description="Hide encrypted messages within innocent-looking text using steganography"
            value={value}
            onChange={v => settings.store.useHiddenMessages = v}
            hideBorder
        />
    );
}

function BackupSecretPhrasesInput() {
    const [localPhrases, setLocalPhrases] = useState(settings.store.backupSecretPhrases);
    const [showPhrases, setShowPhrases] = useState(false);

    const updatePhrases = (value: string) => {
        setLocalPhrases(value);
        settings.store.backupSecretPhrases = value;
    };

    return (
        <section className={Margins.bottom16}>
            <Forms.FormTitle tag="h3">
                Backup Secret Phrases
            </Forms.FormTitle>
            <Forms.FormText className={Margins.bottom8}>
                Additional secret phrases for decryption (comma-separated). Used when different groups have different passwords.
            </Forms.FormText>

            <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                    <TextInput
                        type={showPhrases ? "text" : "password"}
                        value={localPhrases}
                        onChange={updatePhrases}
                        placeholder="phrase1, phrase2, phrase3..."
                    />
                </div>
                <button
                    type="button"
                    onClick={() => setShowPhrases(!showPhrases)}
                    style={{
                        padding: "8px 12px",
                        border: "1px solid var(--background-modifier-accent)",
                        borderRadius: "4px",
                        background: "var(--background-secondary)",
                        color: "var(--text-normal)",
                        cursor: "pointer"
                    }}
                >
                    {showPhrases ? "Hide" : "Show"}
                </button>
            </div>
        </section>
    );
}


export function EncryptionModal({ rootProps }: { rootProps: ModalProps; }) {
    return (
        <ModalRoot {...rootProps}>
            <ModalHeader className={cl("modal-header")}>
                <Forms.FormTitle tag="h2" className={cl("modal-title")}>
                    Chat Encryption Settings
                </Forms.FormTitle>
                <ModalCloseButton onClick={rootProps.onClose} />
            </ModalHeader>

            <ModalContent className={cl("modal-content")}>
                <SecretPhraseInput />

                <Divider className={Margins.bottom16} />

                <BackupSecretPhrasesInput />

                <Divider className={Margins.bottom16} />

                <AutoEncryptToggle />

                <Divider className={Margins.bottom16} />

                <HiddenMessageToggle />

                <Divider className={Margins.bottom16} />

                <Forms.FormText style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                    <strong>Security Notice:</strong> Messages are encrypted using AES-256-GCM with PBKDF2 key derivation.
                    Your secret phrase is stored locally and never transmitted. Only share your secret phrase with trusted contacts
                    who need to decrypt your messages.
                </Forms.FormText>
            </ModalContent>
        </ModalRoot>
    );
}
