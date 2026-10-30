import { Button } from "@components/Button";
import { Divider } from "@components/Divider";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Margins } from "@utils/margins";
import { Alerts, useEffect, useReducer } from "@webpack/common";

import { forgetPeer, getIdentity, getPeers, regenerateIdentity, setPeerVerified, subscribe } from "./store";
import { cl } from "./utils";

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
        confirmColor: cl("danger-btn"),
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
        confirmColor: cl("danger-btn"),
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
        <section>
            <Heading tag="h3">Your identity</Heading>
            <Paragraph className={Margins.bottom8}>
                Fingerprint: <code>{identity?.fingerprint ?? "no identity yet"}</code>
            </Paragraph>

            <Divider className={Margins.bottom16} />

            <Heading tag="h3">Pinned peers</Heading>
            {peers.length === 0 ? (
                <Paragraph className={Margins.bottom8}>No peers pinned yet.</Paragraph>
            ) : (
                peers.map(peer => (
                    <div key={peer.userId} className={Margins.bottom8}>
                        <FormSwitch
                            value={peer.verified}
                            onChange={v => { setPeerVerified(peer.userId, v); }}
                            description={peer.bundle.fingerprint}
                            hideBorder
                            title={peer.userId}
                        />
                        <Button
                            size="small"
                            variant="dangerSecondary"
                            onClick={() => confirmForget(peer.userId)}
                        >
                            Forget key
                        </Button>
                    </div>
                ))
            )}

            <Divider className={Margins.bottom16} />

            <Heading tag="h3">Danger zone</Heading>
            <Paragraph className={Margins.bottom8}>
                Regenerating your identity breaks every existing pinned relationship.
            </Paragraph>
            <Button variant="dangerPrimary" onClick={confirmRegenerate}>
                Regenerate identity
            </Button>
        </section>
    );
}
