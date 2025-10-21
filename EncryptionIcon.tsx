import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { classes } from "@utils/misc";
import { openModal } from "@utils/modal";
import { Alerts, Forms, Tooltip, useEffect, useState } from "@webpack/common";

import { EncryptionModal } from "./EncryptionModal";
import { settings } from "./settings";
import { cl } from "./utils";

export function EncryptionIcon({ height = 20, width = 20, className }: { height?: number; width?: number; className?: string; }) {
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

export let setShouldShowEncryptionEnabledTooltip: undefined | ((show: boolean) => void);

export const EncryptionChatBarIcon: ChatBarButtonFactory = ({ isMainChat }) => {
    const { autoEncrypt } = settings.use(["autoEncrypt"]);

    const [shouldShowEncryptionEnabledTooltip, setter] = useState(false);
    useEffect(() => {
        setShouldShowEncryptionEnabledTooltip = setter;
        return () => setShouldShowEncryptionEnabledTooltip = undefined;
    }, []);

    if (!isMainChat) return null;

    const toggle = () => {
        const newState = !autoEncrypt;
        settings.store.autoEncrypt = newState;
        if (newState && settings.store.showAutoEncryptAlert !== false)
            Alerts.show({
                title: "Vencord Auto-Encrypt Enabled",
                body: <>
                    <Forms.FormText>
                        You just enabled Auto Encrypt! Any message <b>will automatically be encrypted</b> before being sent.
                    </Forms.FormText>
                    <Forms.FormText>
                        Make sure you have set a secret phrase in the encryption settings!
                    </Forms.FormText>
                </>,
                confirmText: "Disable Auto-Encrypt",
                cancelText: "Got it",
                secondaryConfirmText: "Don't show again",
                onConfirmSecondary: () => settings.store.showAutoEncryptAlert = false,
                onConfirm: () => settings.store.autoEncrypt = false,
                confirmColor: "vc-notification-log-danger-btn",
            });
    };

    const button = (
        <ChatBarButton
            tooltip="Open Encryption Settings"
            onClick={e => {
                openModal(props => (
                    <EncryptionModal rootProps={props} />
                ));
            }}
            onContextMenu={toggle}
            buttonProps={{
                "aria-haspopup": "dialog"
            }}
        >
            <EncryptionIcon className={cl({ "auto-encrypt": autoEncrypt, "chat-button": true })} />
        </ChatBarButton>
    );

    if (shouldShowEncryptionEnabledTooltip && settings.store.showAutoEncryptTooltip)
        return (
            <Tooltip text="Auto Encrypt Enabled" forceOpen>
                {() => button}
            </Tooltip>
        );

    return button;
};
