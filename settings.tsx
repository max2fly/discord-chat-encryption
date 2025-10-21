import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    secretPhrase: {
        type: OptionType.STRING,
        description: "Secret phrase for encryption/decryption",
        default: "",
        hidden: true
    },
    backupSecretPhrases: {
        type: OptionType.STRING,
        description: "Backup secret phrases (comma-separated) for decryption",
        default: "",
        hidden: true
    },
    autoEncrypt: {
        type: OptionType.BOOLEAN,
        description: "Automatically encrypt all outgoing messages",
        default: false,
        hidden: true
    },
    showAutoEncryptAlert: {
        type: OptionType.BOOLEAN,
        description: "Show alert when auto-encrypt is enabled",
        default: true,
        hidden: true
    },
    showAutoEncryptTooltip: {
        type: OptionType.BOOLEAN,
        description: "Show tooltip when auto-encrypt is enabled",
        default: true,
        hidden: true
    },
    useHiddenMessages: {
        type: OptionType.BOOLEAN,
        description: "Hide encrypted messages in innocent-looking text",
        default: false,
        hidden: true
    },
    autoEncryptImages: {
        type: OptionType.BOOLEAN,
        description: "Automatically encrypt image attachments",
        default: false,
        hidden: true
    }
});
