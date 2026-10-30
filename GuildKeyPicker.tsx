import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { ModalContent, ModalHeader, ModalRoot, ModalSize } from "@utils/modal";
import { RenderModalProps } from "@vencord/discord-types";
import { Alerts, GuildStore, IconUtils, useMemo } from "@webpack/common";

import { contextKey, getContext } from "./crypto/context";
import { Context } from "./crypto/types";
import { getRecord, getSelfId, setPassword } from "./store";
import { cl } from "./utils";
import { ensureVaultUnlocked } from "./vaultGate";

export function GuildKeyPicker({ rootProps, mode, presetGuildId, presetContext, password, onSend }: {
    rootProps: RenderModalProps;
    mode: "save" | "send";
    /** Highlight (save) or pre-select a guild target. */
    presetGuildId?: string;
    /** Non-guild target (e.g. a group DM) — when present, an extra tile saves the password to this context. */
    presetContext?: Context;
    /** The received password to apply in "save" mode. */
    password?: string;
    /** Callback in "send" mode: receives the chosen target context. */
    onSend?: (ctx: Context) => void;
}) {
    const guilds = useMemo(() => {
        const all = Object.values(GuildStore.getGuilds());
        // In "send" mode only offer servers that currently have a key to share.
        if (mode === "send") {
            return all.filter(g => !!getRecord(contextKey(getContext({ id: g.id, guild_id: g.id }, getSelfId()))).currentKeyId);
        }
        return all;
    }, [mode]);

    const apply = async (ctx: Context) => {
        if (mode === "send") {
            onSend?.(ctx);
            return rootProps.onClose();
        }
        // save mode
        const existing = getRecord(contextKey(ctx)).currentKeyId;
        const doSave = async () => {
            if (!ensureVaultUnlocked()) return;
            await setPassword(ctx, password!);
            rootProps.onClose();
        };
        if (existing) {
            Alerts.show({
                title: "Rotate key?",
                body: <>Saving this key rotates the current key for this {ctx.type === "groupdm" ? "group DM" : "server"}. Your current key moves to history so old messages still decrypt.</>,
                confirmText: "Rotate",
                cancelText: "Cancel",
                onConfirm: doSave,
            });
        } else {
            await doSave();
        }
    };

    const guildContext = (guildId: string): Context => getContext({ id: guildId, guild_id: guildId }, getSelfId());

    return (
        <ModalRoot {...rootProps} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <Heading tag="h2">
                    {mode === "save" ? "Save key to server" : "Send which server's key?"}
                </Heading>
            </ModalHeader>
            <ModalContent>
                {mode === "send" && guilds.length === 0 && (
                    <Paragraph>You have no servers with a key to share yet. Set a key on a server first.</Paragraph>
                )}
                <div className={cl("guild-grid")}>
                    {presetContext && presetContext.type === "groupdm" && (
                        <div
                            key={contextKey(presetContext)}
                            className={cl({ "guild-tile": true, "preset": true })}
                            onClick={() => apply(presetContext)}
                        >
                            <div className={cl("guild-fallback")}>👥</div>
                            <span>this group DM</span>
                        </div>
                    )}
                    {guilds.map(g => (
                        <div
                            key={g.id}
                            className={cl({ "guild-tile": true, "preset": g.id === presetGuildId })}
                            onClick={() => apply(guildContext(g.id))}
                        >
                            {g.icon
                                ? <img width={48} height={48} src={IconUtils.getGuildIconURL({ id: g.id, icon: g.icon, size: 48 })} />
                                : <div className={cl("guild-fallback")}>{g.name?.[0] ?? "?"}</div>}
                            <span>{g.name}</span>
                        </div>
                    ))}
                </div>
            </ModalContent>
        </ModalRoot>
    );
}
