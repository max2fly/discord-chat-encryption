import { WORD_BANK } from "./wordbank";

export const cl = (className: string | Record<string, boolean>) => {
    if (typeof className === "string") return `vc-encryption-${className}`;
    return Object.entries(className)
        .filter(([, value]) => value)
        .map(([key]) => `vc-encryption-${key}`)
        .join(" ");
};

export interface EncryptionResult {
    text: string;
    success: boolean;
    error?: string;
    mentions?: string;
}

export function getRandomWords(count: number): string[] {
    const selected: string[] = [];
    const used = new Set<number>();

    while (selected.length < count && used.size < WORD_BANK.length) {
        const randomIndex = crypto.getRandomValues(new Uint32Array(1))[0] % WORD_BANK.length;
        if (!used.has(randomIndex)) {
            used.add(randomIndex);
            selected.push(WORD_BANK[randomIndex]);
        }
    }

    return selected;
}

// Legacy media data shapes — no longer produced by the stealth-PNG send path, but kept
// because EncryptionAccessory.tsx's legacy image/video receive maps are still typed against them.
export interface ImageEncryptionData {
    filename: string;
    mimeType: string;
    imageData: string; // base64
    width?: number;
    height?: number;
}

export interface VideoEncryptionData {
    filename: string;
    mimeType: string;
    videoData: string; // base64
    duration?: number;
    width?: number;
    height?: number;
}
