export interface KeyTransfer {
    type: "key-transfer";
    guildId: string;
    guildName: string;
    password: string;
    fromFingerprint: string;
}

export function buildKeyTransfer(t: Omit<KeyTransfer, "type">): string {
    const payload: KeyTransfer = { type: "key-transfer", ...t };
    return JSON.stringify(payload);
}

export function parseKeyTransfer(text: string): KeyTransfer | null {
    let o: any;
    try {
        o = JSON.parse(text);
    } catch {
        return null;
    }
    if (
        o && o.type === "key-transfer"
        && typeof o.guildId === "string"
        && typeof o.guildName === "string"
        && typeof o.password === "string"
        && typeof o.fromFingerprint === "string"
    ) return o as KeyTransfer;
    return null;
}
