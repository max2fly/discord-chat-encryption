import { makeCoverPng } from "./cover";
import { CT_FILE, packFileBody } from "./envelope";
import { embedPrivateChunk, extractCandidatePayloads } from "./imagecarrier";
import { buildSealedWire, buildSymWire, SymCandidate, trialDecode } from "./stealth";
import { PublicBundle } from "./types";

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

/** File wrapper for the symmetric (guild/group) upload path. */
export async function sealAttachment(
    file: File,
    key: CryptoKey,
    contextKey: string
): Promise<File> {
    const data = new Uint8Array(await file.arrayBuffer());
    const png = await sealAttachmentBytes(file.type, file.name, data, key, contextKey);
    return new File([png], randomImageName(), { type: "image/png" });
}

/** File wrapper for the 1:1 DM sealed-box (PGP/ECDH) upload path. Seals the same inner CT_FILE
 *  envelope as the symmetric path, so the receiver decodes both through one trialDecode branch. */
export async function sealAttachmentSealed(
    file: File,
    recipients: PublicBundle[],
    signerEcdsaJwk: JsonWebKey
): Promise<File> {
    const body = packFileBody(file.type || "application/octet-stream", file.name, new Uint8Array(await file.arrayBuffer()));
    const wire = await buildSealedWire(CT_FILE, body, recipients, signerEcdsaJwk);
    const png = embedPrivateChunk(makeCoverPng(), wire);
    return new File([png], randomImageName(), { type: "image/png" });
}

export async function openAttachment(
    png: Uint8Array,
    symKeys: SymCandidate[],
    identity?: { fingerprint: string; ecdhPrivateJwk: JsonWebKey } | null
): Promise<
    | { kind: "file"; mime: string; name: string; data: Uint8Array }
    | { kind: "text"; text: string }
    | null
> {
    for (const payload of extractCandidatePayloads(png)) {
        const r = await trialDecode(payload, { symKeys, identity });
        if (r && (r.kind === "file" || r.kind === "text")) return r;
    }
    return null;
}

function randomImageName(): string {
    const d = () => crypto.getRandomValues(new Uint8Array(1))[0] % 10;
    return `IMG_${[...Array(8)].map(d).join("")}.png`;
}
