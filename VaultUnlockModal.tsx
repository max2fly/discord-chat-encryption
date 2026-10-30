import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { ModalContent, ModalFooter, ModalHeader, ModalRoot, ModalSize } from "@utils/modal";
import { RenderModalProps } from "@vencord/discord-types";
import { TextInput, useState } from "@webpack/common";

import { settings } from "./settings";
import { ensureIdentity, loadStore } from "./store";

export function VaultUnlockModal({ rootProps, fresh }: { rootProps: RenderModalProps; fresh: boolean; }) {
    const [pass, setPass] = useState("");
    const [err, setErr] = useState("");

    // First run, encrypted: create the vault under a master passphrase.
    const createEncrypted = async () => {
        try {
            settings.store.vaultEncrypted = true;
            await ensureIdentity(pass); // sets master pass, generates identity, persists encrypted
            rootProps.onClose();
        } catch {
            setErr("Could not create vault");
        }
    };

    // Returning, encrypted: unlock with the existing passphrase.
    const unlock = async () => {
        try {
            const r = await loadStore(pass);
            if (r !== "ok") throw new Error("bad pass");
            rootProps.onClose();
        } catch {
            setErr("Incorrect passphrase");
        }
    };

    // First run, opt out of encryption: store keys in plaintext.
    const goPasswordless = async () => {
        settings.store.vaultEncrypted = false;
        await ensureIdentity(); // plaintext vault
        rootProps.onClose();
    };

    return (
        <ModalRoot {...rootProps} size={ModalSize.SMALL}>
            <ModalHeader>
                <Heading tag="h2">{fresh ? "Set up encryption vault" : "Unlock encryption vault"}</Heading>
            </ModalHeader>
            <ModalContent>
                {fresh ? (
                    <Paragraph>
                        Set a master passphrase to encrypt your keys at rest — you'll enter it once per launch.
                        Or continue without a password: simpler, but your keys are stored <b>unencrypted</b> on this device.
                    </Paragraph>
                ) : (
                    <Paragraph>Enter your master passphrase to unlock your saved keys.</Paragraph>
                )}
                <TextInput
                    type="password"
                    value={pass}
                    onChange={setPass}
                    autoFocus
                    placeholder="Master passphrase"
                />
                {err && <Paragraph style={{ color: "var(--text-danger)" }}>{err}</Paragraph>}
            </ModalContent>
            <ModalFooter>
                <Button disabled={!pass} onClick={fresh ? createEncrypted : unlock}>
                    {fresh ? "Create encrypted vault" : "Unlock"}
                </Button>
                {fresh && (
                    <Button variant="secondary" onClick={goPasswordless}>
                        Continue without a password
                    </Button>
                )}
            </ModalFooter>
        </ModalRoot>
    );
}
