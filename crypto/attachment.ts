import { makeCoverPng } from "./cover";
import { CT_FILE, packFileBody } from "./envelope";
import { embedPrivateChunk, extractCandidatePayloads } from "./imagecarrier";
import { buildSymWire, SymCandidate, trialDecode } from "./stealth";

/** Encrypt raw bytes + metadata into a cover PNG (private chunk). Returns the PNG bytes. */
export async function sealAttachmentBytes(
    mime: string,
    name: string,
    data: Uint8Array,
    key: CryptoKey,
    contextKey: string
): Promise<Uint8Array> {
    const body = packFileBody(mime || "application/octet-stream", name, data);
    const wire = await buildSymWire(CT_FILE, body, key, contextKey); // [iv][ct] of packInner(CT_FILE, body)
    return embedPrivateChunk(makeCoverPng(), wire);
}

/** File wrapper for the upload path. */
export async function sealAttachment(
    file: File,
    key: CryptoKey,
    contextKey: string
): Promise<File> {
    const data = new Uint8Array(await file.arrayBuffer());
    const png = await sealAttachmentBytes(file.type, file.name, data, key, contextKey);
    return new File([png], randomImageName(), { type: "image/png" });
}

export async function openAttachment(
    png: Uint8Array,
    symKeys: SymCandidate[]
): Promise<
    | { kind: "file"; mime: string; name: string; data: Uint8Array }
    | { kind: "text"; text: string }
    | null
> {
    for (const payload of extractCandidatePayloads(png)) {
        const r = await trialDecode(payload, { symKeys });
        if (r && (r.kind === "file" || r.kind === "text")) return r;
    }
    return null;
}

function randomImageName(): string {
    const d = () => crypto.getRandomValues(new Uint8Array(1))[0] % 10;
    return `IMG_${[...Array(8)].map(d).join("")}.png`;
}
