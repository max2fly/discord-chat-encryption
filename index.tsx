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

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, Menu } from "@webpack/common";

import { DecryptionModal } from "./DecryptionModal";
import { EncryptionAccessory, handleDecryption } from "./EncryptionAccessory";
import { EncryptionChatBarIcon, EncryptionIcon, setShouldShowEncryptionEnabledTooltip } from "./EncryptionIcon";
import { settings } from "./settings";
import { decryptWithMultiplePhrases, encrypt, isEncryptedMessage } from "./utils";

const messageCtxPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    const content = getMessageContent(message);
    if (!content) return;

    const group = findGroupChildrenByChildId("copy-text", children);
    if (!group) return;

    group.splice(group.findIndex(c => c?.props?.id === "copy-text") + 1, 0, (
        <Menu.MenuItem
            id="vc-decrypt"
            label="Decrypt Message"
            icon={EncryptionIcon}
            action={async () => {
                if (isEncryptedMessage(content)) {
                    // Try auto-decryption first
                    const allPhrases = [
                        settings.store.secretPhrase,
                        ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
                    ].filter(Boolean);
                    
                    if (allPhrases.length > 0) {
                        const result = await decryptWithMultiplePhrases(content, allPhrases);
                        if (result.success) {
                            handleDecryption(message.id, result);
                            return;
                        }
                    }
                }

                // Show manual decryption modal
                openModal(props => (
                    <DecryptionModal
                        rootProps={props}
                        encryptedContent={content}
                        onSuccess={(decryptedText, usedPhrase) => {
                            handleDecryption(message.id, { text: decryptedText, success: true });
                        }}
                    />
                ));
            }}
        />
    ));
};

function getMessageContent(message: Message) {
    return message.content
        || message.messageSnapshots?.[0]?.message.content
        || message.embeds?.find(embed => embed.type === "auto_moderation_message")?.rawDescription || "";
}

let tooltipTimeout: any;

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
    contextMenus: {
        "message": messageCtxPatch
    },

    renderMessageAccessory: props => <EncryptionAccessory message={props.message} />,

    renderChatBarButton: EncryptionChatBarIcon,

    start() {
        // Auto-decrypt messages when the plugin starts
        this.autoDecryptVisibleMessages();
    },

    stop() {
        // Clean up when plugin is disabled
    },

    async autoDecryptVisibleMessages() {
        // This will be called to decrypt all visible messages
        const allPhrases = [
            settings.store.secretPhrase,
            ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
        ].filter(Boolean);

        if (allPhrases.length === 0) return;

        // Process messages in the background
        setTimeout(async () => {
            const { decryptAllQueuedMessages } = await import("./EncryptionAccessory");
            decryptAllQueuedMessages();
        }, 1000);
    },

    renderMessagePopoverButton(message: Message) {
        const content = getMessageContent(message);
        if (!content) return null;

        return {
            label: "Decrypt",
            icon: EncryptionIcon,
            message,
            channel: ChannelStore.getChannel(message.channel_id),
            onClick: async () => {
                if (isEncryptedMessage(content)) {
                    // Try auto-decryption first
                    const allPhrases = [
                        settings.store.secretPhrase,
                        ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
                    ].filter(Boolean);
                    
                    if (allPhrases.length > 0) {
                        const result = await decryptWithMultiplePhrases(content, allPhrases);
                        if (result.success) {
                            handleDecryption(message.id, result);
                            return;
                        }
                    }
                }

                // Show manual decryption modal
                openModal(props => (
                    <DecryptionModal
                        rootProps={props}
                        encryptedContent={content}
                        onSuccess={(decryptedText, usedPhrase) => {
                            handleDecryption(message.id, { text: decryptedText, success: true });
                        }}
                    />
                ));
            }
        };
    },

    async onBeforeMessageSend(_, message) {
        if (!settings.store.autoEncrypt) return;
        if (!message.content) return;
        if (!settings.store.secretPhrase) {
            console.warn("Auto-encrypt enabled but no secret phrase set");
            return;
        }

        setShouldShowEncryptionEnabledTooltip?.(true);
        clearTimeout(tooltipTimeout);
        tooltipTimeout = setTimeout(() => setShouldShowEncryptionEnabledTooltip?.(false), 2000);

        const result = await encrypt(message.content, settings.store.secretPhrase);
        if (result.success) {
            message.content = result.text;
        } else {
            console.error("Failed to encrypt message:", result.error);
        }
    }
});
