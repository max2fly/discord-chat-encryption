import { Margins } from "@utils/margins";
import { ModalContent, ModalHeader, ModalRoot, ModalSize } from "@utils/modal";
import { RenderModalProps } from "@vencord/discord-types";
import { Alerts, Button, Forms, Switch, useEffect, useReducer } from "@webpack/common";

import { contextKey } from "./crypto/context";
import { Context } from "./crypto/types";
import { insertMyKeyIntoChat } from "./dmActions";
import { forgetPeer, getChannelAutoEncrypt, getIdentity, getPeer, getRecord, setChannelAutoEncrypt, setStego, subscribe } from "./store";

/** Left-click menu for the chat-bar lock in a 1:1 DM: share key (to message box), forget peer key, toggle auto-encrypt. */
export function DmKeyMenu({ rootProps, peerId, channelId }: { rootProps: RenderModalProps; peerId: string; channelId: string; }) {
    const [, tick] = useReducer(x => x + 1, 0);
    useEffect(() => subscribe(tick), []);

    const peer = getPeer(peerId);
    const myFingerprint = getIdentity()?.fingerprint;
    const dmCtx: Context = { type: "dm", id: peerId };
    const stego = getRecord(contextKey(dmCtx)).stego;

    const insertKey = async () => {
        await insertMyKeyIntoChat(); // plain; stego (if enabled) is applied when the message is sent
        rootProps.onClose();
    };

    const forget = () => Alerts.show({
        title: "Forget their key?",
        body: "Removes this person's recorded public key. The next key they share will be recorded fresh "
            + "(trust-on-first-use). Do this only if you've verified their key legitimately changed.",
        confirmText: "Forget",
        cancelText: "Cancel",
        confirmColor: Button.Colors.RED,
        onConfirm: () => {
            forgetPeer(peerId).catch(e => console.error("ChatEncryption: forgetPeer failed:", e));
            rootProps.onClose();
        },
    });

    return (
        <ModalRoot {...rootProps} size={ModalSize.SMALL}>
            <ModalHeader><Forms.FormTitle tag="h2">Encrypted DM</Forms.FormTitle></ModalHeader>
            <ModalContent>
                <Forms.FormText className={Margins.bottom8}>
                    Your key: <code>{myFingerprint ?? "no identity yet"}</code>
                </Forms.FormText>
                <Forms.FormText className={Margins.bottom16}>
                    {peer
                        ? <>Their saved key: <code>{peer.bundle.fingerprint}</code></>
                        : "You haven't recorded their key yet. Share yours below, and have them share theirs."}
                </Forms.FormText>

                <Switch
                    value={getChannelAutoEncrypt(channelId)}
                    onChange={v => setChannelAutoEncrypt(channelId, v)}
                    hideBorder
                >
                    Auto-encrypt messages in this DM
                </Switch>
                <Switch
                    value={stego}
                    onChange={v => setStego(dmCtx, v)}
                    hideBorder
                >
                    Hide messages as innocent text (steganography)
                </Switch>

                <Button className={Margins.top8} onClick={insertKey}>
                    Insert my key into the message box
                </Button>
                {peer && (
                    <Button className={Margins.top8} color={Button.Colors.RED} look={Button.Looks.LINK} onClick={forget}>
                        Forget their key
                    </Button>
                )}
            </ModalContent>
        </ModalRoot>
    );
}
