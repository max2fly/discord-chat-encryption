import { assemblePng, PngChunk, readChunks } from "./png";

const STANDARD = new Set([
    "IHDR",
    "PLTE",
    "IDAT",
    "IEND",
    "tRNS",
    "gAMA",
    "cHRM",
    "sRGB",
    "iCCP",
    "bKGD",
    "pHYs",
    "tIME",
    "tEXt",
    "zTXt",
    "iTXt",
    "eXIf",
    "sBIT",
    "hIST",
    "sPLT",
    "acTL",
    "fcTL",
    "fdAT",
]);

function randomPrivateChunkType(): string {
    const lc = () => String.fromCharCode(97 + (crypto.getRandomValues(new Uint8Array(1))[0] % 26));
    const uc = () => String.fromCharCode(65 + (crypto.getRandomValues(new Uint8Array(1))[0] % 26));
    return lc() + lc() + uc() + lc(); // ancillary, private, reserved(UC), safe-to-copy
}

/** Insert the payload as a private ancillary chunk (random type) just before IEND. */
export function embedPrivateChunk(png: Uint8Array, payload: Uint8Array): Uint8Array {
    const chunks = readChunks(png);
    const iend = chunks.findIndex(c => c.type === "IEND");
    const chunk: PngChunk = { type: randomPrivateChunkType(), data: payload };
    chunks.splice(iend < 0 ? chunks.length : iend, 0, chunk);
    return assemblePng(chunks);
}

/** Every non-standard chunk's data — trial-decrypt each to find ours. */
export function extractCandidatePayloads(png: Uint8Array): Uint8Array[] {
    return readChunks(png)
        .filter(c => !STANDARD.has(c.type))
        .map(c => new Uint8Array(c.data));
}
