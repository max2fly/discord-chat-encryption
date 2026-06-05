import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { classes } from "@utils/misc";
import { openModal } from "@utils/modal";
import { IconComponent } from "@utils/types";
import { ChannelStore, SelectedChannelStore, useEffect, useReducer } from "@webpack/common";

import { contextKey, getContext } from "./crypto/context";
import { ContextRecord } from "./crypto/types";
import { DmKeyMenu } from "./DmKeyMenu";
import { KeyEntryModal } from "./KeyEntryModal";
import { getChannelAutoEncrypt, getPeer, getRecord, getSelfId, setChannelAutoEncrypt, subscribe } from "./store";
import { cl } from "./utils";
import { ensureVaultUnlocked } from "./vaultGate";

export const EncryptionIcon: IconComponent = ({ height = 20, width = 20, className }) => {
    return (
        <svg
            viewBox="0 0 24 24"
            height={height}
            width={width}
            className={classes(cl("icon"), className)}
        >
            <path fill="currentColor" d="M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10A2,2 0 0,1 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z" />
        </svg>
    );
}

// re-render this component whenever the store changes
function useStoreTick() {
    const [, force] = useReducer(x => x + 1, 0);
    useEffect(() => subscribe(force), []);
}

function activeContext() {
    const id = SelectedChannelStore.getChannelId();
    const channel = id && ChannelStore.getChannel(id);
    if (!channel) return null;
    return getContext(channel, getSelfId());
}

export const EncryptionChatBarIcon: ChatBarButtonFactory = ({ isMainChat }) => {
    useStoreTick();
    if (!isMainChat) return null;

    const channelId = SelectedChannelStore.getChannelId();
    const ctx = activeContext();
    const record: ContextRecord | null = ctx ? getRecord(contextKey(ctx)) : null;
    const isDM = ctx?.type === "dm";

    // DMs use PGP: "has key" = we've recorded the peer's public key. Servers/group DMs use a symmetric key.
    const hasKey = isDM ? !!(ctx && getPeer(ctx.id)) : !!record?.currentKeyId;
    const auto = !!channelId && getChannelAutoEncrypt(channelId); // per-channel, not per-server

    const openKeyEntry = () => ctx && openModal(props => <KeyEntryModal rootProps={props} context={ctx} />);
    const toggleAuto = () => channelId && setChannelAutoEncrypt(channelId, !auto);

    // state -> color class
    const stateClass = !ctx ? "disabled" : !hasKey ? "no-key" : auto ? "auto-on" : "key-set";

    return (
        <ChatBarButton
            tooltip={
                isDM
                    ? (!hasKey ? "Click to share your encryption key (PGP)"
                        : auto ? "Encrypted DMs ON (right-click to disable)"
                            : "Peer key recorded (right-click to enable encrypted DMs)")
                    : (!hasKey ? "No key for this server — click to set"
                        : auto ? "Auto-encrypt ON (right-click to disable)"
                            : "Encryption ready (right-click to enable auto-encrypt)")
            }
            onClick={() => {
                // DMs use PGP — open the key menu (share key to message box / forget peer / toggle), not a passphrase
                if (isDM) { if (ctx && channelId) openModal(props => <DmKeyMenu rootProps={props} peerId={ctx.id} channelId={channelId} />); return; }
                if (!ensureVaultUnlocked()) return; // locked → opens setup/unlock modal; retry after
                openKeyEntry();
            }}
            onContextMenu={e => {
                e.preventDefault();
                if (isDM) { if (channelId) setChannelAutoEncrypt(channelId, !auto); return; }
                if (!ensureVaultUnlocked()) return;
                if (!hasKey) return openKeyEntry();
                toggleAuto();
            }}
            buttonProps={{ "aria-haspopup": "dialog" }}
        >
            <EncryptionIcon className={cl({ [stateClass]: true, "chat-button": true })} />
        </ChatBarButton>
    );
};
