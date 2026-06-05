import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { PgpSettings } from "./PgpSettings";

// Per-context state (passwords, history, auto-encrypt, stego) lives in DataStore via store.ts —
// NOT here. These settings are global toggles only.
export const settings = definePluginSettings({
    vaultEncrypted: {
        type: OptionType.BOOLEAN,
        description: "Encrypt the local key vault at rest (prompts for a master passphrase once per launch). Disable to store keys in plaintext.",
        default: true,
    },
    showAutoEncryptAlert: {
        type: OptionType.BOOLEAN,
        description: "Show an alert the first time auto-encrypt is enabled for a context",
        default: true,
        hidden: true,
    },
    showAutoEncryptTooltip: {
        type: OptionType.BOOLEAN,
        description: "Show a tooltip on the chat-bar button when a message is auto-encrypted",
        default: true,
    },
    defaultStego: {
        type: OptionType.BOOLEAN,
        description: "Default new contexts to steganographic (hidden) message mode",
        default: false,
        hidden: true,
    },
    managePgp: {
        type: OptionType.COMPONENT,
        component: () => <PgpSettings />,
    },
});
