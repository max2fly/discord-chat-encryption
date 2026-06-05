import { Context } from "./types";

/** Minimal shape we need from a Discord channel — keeps this module Vencord-free. */
export interface ChannelLike {
    id: string;
    guild_id?: string | null;
    isGroupDM?: () => boolean;
    recipients?: string[];
}

export function getContext(channel: ChannelLike, selfId: string): Context {
    if (channel.isGroupDM?.()) return { type: "groupdm", id: channel.id };
    if (channel.guild_id) return { type: "guild", id: channel.guild_id };
    const other = channel.recipients?.find(r => r !== selfId) ?? channel.recipients?.[0] ?? channel.id;
    return { type: "dm", id: other };
}

export function contextKey(ctx: Context): string {
    return `${ctx.type}:${ctx.id}`;
}
