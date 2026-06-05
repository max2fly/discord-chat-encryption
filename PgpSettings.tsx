import { Margins } from "@utils/margins";
import { Alerts, Button, Forms, Switch, useEffect, useReducer } from "@webpack/common";

import { forgetPeer, getIdentity, getPeers, regenerateIdentity, setPeerVerified, subscribe } from "./store";

// re-render this component whenever the store changes
function useStoreTick() {
    const [, force] = useReducer(x => x + 1, 0);
    useEffect(() => subscribe(force), []);
}

function confirmRegenerate() {
    Alerts.show({
        title: "Regenerate identity?",
        body: "This replaces your encryption identity with a new one. Every peer who pinned your old "
            + "fingerprint will see a key-change warning and must re-verify you. This cannot be undone.",
        confirmText: "Regenerate",
        cancelText: "Cancel",
        confirmColor: Button.Colors.RED,
        onConfirm: () => {
            regenerateIdentity().catch(error => {
                console.error("ChatEncryption: Failed to regenerate identity:", error);
            });
        },
    });
}

function confirmForget(userId: string) {
    Alerts.show({
        title: "Forget recorded key?",
        body: "Removes this peer's recorded public key. The next key they share in your DM will be recorded "
            + "fresh (trust-on-first-use). Do this only if you've verified their key legitimately changed.",
        confirmText: "Forget",
        cancelText: "Cancel",
        confirmColor: Button.Colors.RED,
        onConfirm: () => {
            forgetPeer(userId).catch(error => {
                console.error("ChatEncryption: Failed to forget peer:", error);
            });
        },
    });
}

export function PgpSettings() {
    useStoreTick();

    const identity = getIdentity();
    const peers = getPeers();

    return (
        <Forms.FormSection>
            <Forms.FormTitle tag="h3">Your identity</Forms.FormTitle>
            <Forms.FormText className={Margins.bottom8}>
                Fingerprint: <code>{identity?.fingerprint ?? "no identity yet"}</code>
            </Forms.FormText>

            <Forms.FormDivider className={Margins.bottom16} />

            <Forms.FormTitle tag="h3">Pinned peers</Forms.FormTitle>
            {peers.length === 0 ? (
                <Forms.FormText className={Margins.bottom8}>No peers pinned yet.</Forms.FormText>
            ) : (
                peers.map(peer => (
                    <div key={peer.userId} className={Margins.bottom8}>
                        <Switch
                            value={peer.verified}
                            onChange={v => { setPeerVerified(peer.userId, v); }}
                            note={peer.bundle.fingerprint}
                            hideBorder
                        >
                            {peer.userId}
                        </Switch>
                        <Button
                            size={Button.Sizes.SMALL}
                            color={Button.Colors.RED}
                            look={Button.Looks.LINK}
                            onClick={() => confirmForget(peer.userId)}
                        >
                            Forget key
                        </Button>
                    </div>
                ))
            )}

            <Forms.FormDivider className={Margins.bottom16} />

            <Forms.FormTitle tag="h3">Danger zone</Forms.FormTitle>
            <Forms.FormText className={Margins.bottom8}>
                Regenerating your identity breaks every existing pinned relationship.
            </Forms.FormText>
            <Button color={Button.Colors.RED} onClick={confirmRegenerate}>
                Regenerate identity
            </Button>
        </Forms.FormSection>
    );
}
