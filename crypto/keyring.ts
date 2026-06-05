import { ContextRecord, KeyEntry } from "./types";

/** Pure: returns a new record with `entry` as current; previous current retained in history. */
export function addOrRotateKey(record: ContextRecord, entry: KeyEntry): ContextRecord {
    const keys = record.keys.some(k => k.keyId === entry.keyId)
        ? record.keys
        : [...record.keys, entry];
    return { ...record, keys, currentKeyId: entry.keyId };
}

export function getKeyEntry(record: ContextRecord, keyId: string): KeyEntry | undefined {
    return record.keys.find(k => k.keyId === keyId);
}

export function hasKeyId(record: ContextRecord, keyId: string): boolean {
    return record.keys.some(k => k.keyId === keyId);
}
