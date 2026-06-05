/**
 * Read an image's intrinsic pixel dimensions straight from its header bytes — pure, no DOM/canvas.
 * Covers the formats Discord users actually send (PNG, JPEG, GIF, WebP). Returns null if unknown
 * or malformed, so callers can fall back to a default box.
 *
 * Needed because our attachments arrive as a small cover PNG; the decrypted image's real size lives
 * only in its own bytes, so the synthetic attachment must be sized from here (not the cover's 128×128).
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
    try {
        // PNG: 8-byte signature, then IHDR — width @16 (BE u32), height @20 (BE u32).
        if (
            bytes.length >= 24 &&
            bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        ) {
            const w = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
            const h = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
            if (w && h) return { width: w, height: h };
        }

        // GIF: "GIF8", logical-screen width @6 (LE u16), height @8 (LE u16).
        if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
            return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
        }

        // JPEG: FFD8, then walk segments to a Start-Of-Frame marker (SOFn) — height/width are
        // big-endian u16 at marker+5 / marker+7. Skip non-SOF segments by their length field.
        if (bytes[0] === 0xff && bytes[1] === 0xd8) {
            let o = 2;
            while (o + 9 < bytes.length) {
                if (bytes[o] !== 0xff) { o++; continue; }
                let marker = bytes[o + 1];
                if (marker === 0xff) { o++; continue; } // padding
                // SOF0..SOF15 carry the frame size, except DHT(C4)/JPG(C8)/DAC(CC).
                if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    const h = (bytes[o + 5] << 8) | bytes[o + 6];
                    const w = (bytes[o + 7] << 8) | bytes[o + 8];
                    if (w && h) return { width: w, height: h };
                    return null;
                }
                const len = (bytes[o + 2] << 8) | bytes[o + 3];
                if (len < 2) break;
                o += 2 + len;
            }
        }

        // WebP: "RIFF"...."WEBP" + a VP8/VP8L/VP8X chunk.
        if (
            bytes.length >= 30 &&
            bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
            bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
        ) {
            const fmt = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
            if (fmt === "VP8 ") {
                // lossy: 14-byte VP8 frame header; dimensions @26/@28 (LE u14).
                return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
            }
            if (fmt === "VP8L") {
                // lossless: after 1-byte signature (0x2f), 14-bit width-1 then 14-bit height-1.
                const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
                const w = 1 + (((b1 & 0x3f) << 8) | b0);
                const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
                return { width: w, height: h };
            }
            if (fmt === "VP8X") {
                // extended: canvas width-1 @24 (LE u24), height-1 @27 (LE u24).
                const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
                const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
                return { width: w, height: h };
            }
        }

        return null;
    } catch {
        return null;
    }
}
