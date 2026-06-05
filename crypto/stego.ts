import { fromBase64Url, toBase64Url } from "./encoding";

// 4 invisible symbols → 2 bits each (4 chars/byte). Detection scans for a contiguous run of these.
const HIDDEN = ["‌", "‍", "⁠", "⁡"];
const HIDDEN_SET = new Set(HIDDEN);
const MIN_RUN = 32; // ≥ 8 payload bytes; real envelopes are ≥ 28 bytes → ≥ 112 chars
const MIN_ENVELOPE = 28; // 12 iv + 16 GCM tag
const MIN_B64 = 38; // ceil(28 * 4 / 3)

function rand(n: number): number {
    return crypto.getRandomValues(new Uint32Array(1))[0] % n;
}

export function encodeZeroWidth(bytes: Uint8Array): string {
    let out = "";
    for (const byte of bytes) for (let shift = 6; shift >= 0; shift -= 2) out += HIDDEN[(byte >> shift) & 0b11];
    return out;
}

export function decodeZeroWidth(s: string): Uint8Array {
    const sym: number[] = [];
    for (const ch of s) {
        const i = HIDDEN.indexOf(ch);
        if (i >= 0) sym.push(i);
    }
    const out: number[] = [];
    for (let i = 0; i + 4 <= sym.length; i += 4)
        out.push((sym[i] << 6) | (sym[i + 1] << 4) | (sym[i + 2] << 2) | sym[i + 3]);
    return new Uint8Array(out);
}

export function hasZeroWidthRun(s: string, min = MIN_RUN): boolean {
    let run = 0;
    for (const ch of s) {
        if (HIDDEN_SET.has(ch)) {
            if (++run >= min) return true;
        } else run = 0;
    }
    return false;
}

/** Frame envelope bytes for the wire. stego → hidden between cover words; else a bare base64url token. */
export function wrapWire(bytes: Uint8Array, opts: { stego: boolean; words: string[] }): string {
    if (opts.stego) {
        const zw = encodeZeroWidth(bytes);
        const w = opts.words.length >= 2 ? opts.words : [...opts.words, "ok", "yeah"];
        const splitAt = 1 + rand(w.length - 1); // 1..len-1 → a visible word always follows
        return `${w.slice(0, splitAt).join(" ")} ${zw}${w.slice(splitAt).join(" ")}`;
    }
    return toBase64Url(bytes);
}

/** Cheap pre-filter + extract. Returns null for ordinary messages. */
export function detectWire(content: string): { kind: "stego" | "visible"; bytes: Uint8Array } | null {
    if (hasZeroWidthRun(content)) {
        const bytes = decodeZeroWidth(content);
        if (bytes.length >= MIN_ENVELOPE) return { kind: "stego", bytes };
    }
    const tok = content
        .split(/\s+/)
        .filter(t => /^[A-Za-z0-9_-]+$/.test(t))
        .sort((a, b) => b.length - a.length)[0];
    if (tok && tok.length >= MIN_B64) {
        try {
            const bytes = fromBase64Url(tok);
            if (bytes.length >= MIN_ENVELOPE) return { kind: "visible", bytes };
        } catch {
            /* not ours */
        }
    }
    return null;
}
