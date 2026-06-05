import { Margins } from "@utils/margins";
import { ModalContent, ModalFooter, ModalHeader, ModalRoot, ModalSize } from "@utils/modal";
import { RenderModalProps } from "@vencord/discord-types";
import { Alerts, Button, Forms, Switch, TextInput, useState } from "@webpack/common";

import { contextKey } from "./crypto/context";
import { Context } from "./crypto/types";
import { clearKeys, getRecord, setPassword, setStego } from "./store";
import { ensureVaultUnlocked } from "./vaultGate";

export function KeyEntryModal({ rootProps, context }: { rootProps: RenderModalProps; context: Context; }) {
    const ck = contextKey(context);
    const record = getRecord(ck);
    const [password, setPwd] = useState("");
    const [busy, setBusy] = useState(false);
    const [stego, setStegoLocal] = useState(record.stego);

    const isRotation = !!record.currentKeyId;

    const save = async () => {
        if (!password) return;
        if (!ensureVaultUnlocked()) return; // locked → opens vault modal; retry after setup
        setBusy(true);
        await setPassword(context, password); // derives, adds/rotates, persists
        setBusy(false);
        rootProps.onClose();
    };

    return (
        <ModalRoot {...rootProps} size={ModalSize.SMALL}>
            <ModalHeader>
                <Forms.FormTitle tag="h2">
                    {isRotation ? "Rotate encryption key" : "Set encryption key"} — {context.type}
                </Forms.FormTitle>
            </ModalHeader>
            <ModalContent>
                <Forms.FormText className={Margins.bottom8}>
                    Everyone using the same password for this {context.type} can read each other's messages.
                    Use a strong passphrase — the salt is public.
                </Forms.FormText>
                {isRotation && (
                    <Forms.FormText className={Margins.bottom8} style={{ color: "var(--text-warning)" }}>
                        ⚠ This rotates the key. Your current key is kept in history so old messages still decrypt;
                        new messages use the new key until others receive it.
                    </Forms.FormText>
                )}
                <TextInput
                    type="password"
                    value={password}
                    placeholder="Enter passphrase"
                    onChange={setPwd}
                    autoFocus
                />
                <Switch
                    className={Margins.top16}
                    value={stego}
                    onChange={v => { setStegoLocal(v); setStego(context, v); }}
                >
                    Hide messages as innocent text (steganography)
                </Switch>
                <Forms.FormText className={Margins.top8}>
                    Keys in history: {record.keys.length}
                </Forms.FormText>
            </ModalContent>
            <ModalFooter>
                <Button disabled={!password || busy} onClick={save}>
                    {isRotation ? "Rotate" : "Set key"}
                </Button>
                {record.keys.length > 0 && (
                    <Button
                        color={Button.Colors.RED}
                        look={Button.Looks.LINK}
                        onClick={() => Alerts.show({
                            title: "Delete saved keys?",
                            body: <>
                                This permanently deletes all {record.keys.length} saved key(s) for this {context.type}.
                                Messages encrypted with them will no longer decrypt on this device.
                            </>,
                            confirmText: "Delete keys",
                            cancelText: "Cancel",
                            confirmColor: Button.Colors.RED,
                            onConfirm: async () => { await clearKeys(context); rootProps.onClose(); },
                        })}
                    >
                        Delete saved keys
                    </Button>
                )}
            </ModalFooter>
        </ModalRoot>
    );
}
