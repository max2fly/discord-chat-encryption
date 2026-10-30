import { Button } from "@components/Button";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Margins } from "@utils/margins";
import { ModalContent, ModalHeader, ModalRoot, ModalSize } from "@utils/modal";
import { RenderModalProps } from "@vencord/discord-types";
import { Alerts, useEffect, useReducer } from "@webpack/common";

import { contextKey } from "./crypto/context";
import { Context } from "./crypto/types";
import { insertMyKeyIntoChat } from "./dmActions";
import { forgetPeer, getChannelAutoEncrypt, getIdentity, getPeer, getRecord, setChannelAutoEncrypt, setStego, subscribe } from "./store";
import { cl } from "./utils";

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
        confirmColor: cl("danger-btn"),
        onConfirm: () => {
            forgetPeer(peerId).catch(e => console.error("ChatEncryption: forgetPeer failed:", e));
            rootProps.onClose();
        },
    });

    return (
        <ModalRoot {...rootProps} size={ModalSize.SMALL}>
            <ModalHeader><Heading tag="h2">Encrypted DM</Heading></ModalHeader>
            <ModalContent>
                <Paragraph className={Margins.bottom8}>
                    Your key: <code>{myFingerprint ?? "no identity yet"}</code>
                </Paragraph>
                <Paragraph className={Margins.bottom16}>
                    {peer
                        ? <>Their saved key: <code>{peer.bundle.fingerprint}</code></>
                        : "You haven't recorded their key yet. Share yours below, and have them share theirs."}
                </Paragraph>

                <FormSwitch
                    value={getChannelAutoEncrypt(channelId)}
                    onChange={v => setChannelAutoEncrypt(channelId, v)}
                    hideBorder
                    title="Auto-encrypt messages in this DM"
                />
                <FormSwitch
                    value={stego}
                    onChange={v => setStego(dmCtx, v)}
                    hideBorder
                    title="Hide messages as innocent text (steganography)"
                />

                <Button className={Margins.top8} onClick={insertKey}>
                    Insert my key into the message box
                </Button>
                {peer && (
                    <Button className={Margins.top8} variant="dangerSecondary" onClick={forget}>
                        Forget their key
                    </Button>
                )}
            </ModalContent>
        </ModalRoot>
    );
}
