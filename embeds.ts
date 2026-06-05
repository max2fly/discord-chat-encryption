/**
 * Client-side media embed recreation.
 *
 * Encrypted messages never reach Discord's server, so any media URL inside a *decrypted* message
 * has no server-side embed and renders as plain text. This module reconstructs the embed objects
 * locally (Tenor / Giphy / direct image|video|gif links) so Discord's native embed renderer can
 * draw them after we set them on `message.embeds`.
 *
 * The pure URL extraction (`findMediaUrls`) is unit-tested; the network resolution (`resolveEmbed`)
 * is GUI-tested by the user (it may hit CORS in the renderer — see resolveEmbed notes).
 */

// ---------------------------------------------------------------------------
// URL extraction (PURE — unit-tested in tests/embeds.test.ts)
// ---------------------------------------------------------------------------

// Direct-media file extensions we recognise (query string ignored when testing).
const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];
const VIDEO_EXTS = ["mp4", "webm", "mov"];
const DIRECT_EXTS = [...IMAGE_EXTS, ...VIDEO_EXTS];

// Grab http(s) URLs. Stop at whitespace and the angle-bracket chars Discord uses to suppress
// embeds (`<url>`); everything else (path, query, fragment) is kept.
const URL_RE = /https?:\/\/[^\s<>]+/gi;

/** Strip a query string / fragment so we can test the file extension on the bare path. */
function bareExt(url: string): string {
    let u = url;
    const q = u.indexOf("?");
    if (q !== -1) u = u.slice(0, q);
    const h = u.indexOf("#");
    if (h !== -1) u = u.slice(0, h);
    const dot = u.lastIndexOf(".");
    if (dot === -1) return "";
    return u.slice(dot + 1).toLowerCase();
}

function isTenorView(url: string): boolean {
    return /^https?:\/\/(www\.)?tenor\.com\/view\//i.test(url);
}

function isGiphy(url: string): boolean {
    // giphy.com/gifs/<slug>-<id>, media[N].giphy.com/media/<id>/..., or i.giphy.com/<id>.gif
    return /^https?:\/\/(.*\.)?giphy\.com\//i.test(url);
}

/**
 * Extract media URLs from decrypted text. Keeps only:
 *  - tenor.com/view/… page links,
 *  - giphy.com/gifs/… or (media.)giphy.com/… links,
 *  - direct links whose path ends in a known image/video/gif extension (query string ignored).
 * Plain non-media links (e.g. https://example.com/page) are dropped. Order-preserving, deduped.
 */
export function findMediaUrls(text: string): string[] {
    if (!text) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const matches = text.match(URL_RE);
    if (!matches) return out;
    for (const raw of matches) {
        // Trim trailing punctuation that commonly clings to a URL in prose.
        const url = raw.replace(/[)\].,!?;:'"]+$/, "");
        if (seen.has(url)) continue;
        if (isTenorView(url) || isGiphy(url) || DIRECT_EXTS.includes(bareExt(url))) {
            seen.add(url);
            out.push(url);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Embed resolution (NETWORK — GUI-tested)
// ---------------------------------------------------------------------------

// Resolve each URL at most once. `cache` holds finished embeds (or `null` for "no embed");
// `inFlight` dedupes concurrent resolutions so the render-driven calls don't fetch twice.
const cache = new Map<string, any | null>();
const inFlight = new Set<string>();

/** Synchronous lookup used at render-apply time. Returns the embed, `null`, or `undefined` (unresolved). */
export function cachedEmbed(url: string): any | undefined {
    return cache.has(url) ? cache.get(url)! : undefined;
}

function classifyDirect(url: string): "image" | "video" | "gif" | null {
    const ext = bareExt(url);
    if (ext === "gif") return "gif";
    if (VIDEO_EXTS.includes(ext)) return "video";
    if (IMAGE_EXTS.includes(ext)) return "image";
    return null;
}

/** Build a `gifv` embed (animated): a poster thumbnail + an mp4/gif video the client plays. */
function buildGifv(
    pageUrl: string,
    videoUrl: string,
    posterUrl: string,
    width?: number,
    height?: number
): any {
    const dims = width && height ? { width, height } : {};
    return {
        type: "gifv",
        url: pageUrl,
        video: { url: videoUrl, proxy_url: videoUrl, ...dims },
        thumbnail: { url: posterUrl, proxy_url: posterUrl, ...dims },
    };
}

function buildImage(url: string, width?: number, height?: number): any {
    const dims = width && height ? { width, height } : {};
    return {
        type: "image",
        url,
        image: { url, proxy_url: url, ...dims },
    };
}

function buildVideo(url: string, width?: number, height?: number): any {
    const dims = width && height ? { width, height } : {};
    return {
        type: "video",
        url,
        video: { url, proxy_url: url, ...dims },
    };
}

// Long-standing public Tenor v1 key; Giphy's public beta key. Used only to look up the
// direct media host for a link the user already pasted (no extra tracking beyond the fetch).
const TENOR_KEY = "LIVDSRZULELA";
const GIPHY_KEY = "dc6zaTOxFJmzC";

/** tenor.com/view/<slug>-<id> → trailing numeric id. */
function tenorId(url: string): string | null {
    const m = url.match(/tenor\.com\/view\/[^?#]*?-(\d+)/i);
    return m ? m[1] : null;
}

/** giphy.com/gifs/<slug>-<id>, media.giphy.com/media/<id>/..., or i.giphy.com/<id>.gif → id. */
function giphyId(url: string): string | null {
    let m = url.match(/giphy\.com\/(?:media|embed|gifs)\/(?:[^/?#]*-)?([A-Za-z0-9]+)/i);
    if (m) return m[1];
    // i.giphy.com/<id>.gif (or .mp4/.webp): id is the filename before the extension.
    m = url.match(/giphy\.com\/([A-Za-z0-9]+)\.[A-Za-z0-9]+/i);
    return m ? m[1] : null;
}

// Discord's embed renderer needs real width/height (without them the media renders 0×0 / NaN). Direct
// links carry no dimensions, so load the resource and read its natural size.
function loadImageDims(url: string): Promise<{ width: number; height: number } | null> {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? { width: img.naturalWidth, height: img.naturalHeight } : null);
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

function loadVideoDims(url: string): Promise<{ width: number; height: number } | null> {
    return new Promise(resolve => {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.onloadedmetadata = () => resolve(v.videoWidth && v.videoHeight ? { width: v.videoWidth, height: v.videoHeight } : null);
        v.onerror = () => resolve(null);
        v.src = url;
    });
}

/** Build a direct-media embed, loading natural dimensions first (Discord renders 0×0/NaN without them). */
async function buildDirect(url: string, kind: "image" | "video" | "gif"): Promise<any> {
    if (kind === "video") {
        const d = await loadVideoDims(url);
        return buildVideo(url, d?.width, d?.height);
    }
    const d = await loadImageDims(url); // image or gif
    return kind === "gif" ? buildGifv(url, url, url, d?.width, d?.height) : buildImage(url, d?.width, d?.height);
}

async function resolveTenor(url: string): Promise<any | null> {
    const id = tenorId(url);
    if (!id) return null;
    const api = `https://g.tenor.com/v1/gifs?ids=${encodeURIComponent(id)}&key=${TENOR_KEY}&media_filter=minimal`;
    const res = await fetch(api);
    if (!res.ok) return null;
    const json = await res.json();
    const media = json?.results?.[0]?.media?.[0];
    if (!media) return null;
    const mp4 = media.mp4?.url;
    if (!mp4) return null;
    const dims: number[] | undefined = media.mp4?.dims;
    const width = Array.isArray(dims) ? dims[0] : undefined;
    const height = Array.isArray(dims) ? dims[1] : undefined;
    // Poster: prefer the gif's preview frame, then tinygif, then the gif itself.
    const poster = media.gif?.preview || media.tinygif?.url || media.tinygif?.preview || media.gif?.url || mp4;
    return buildGifv(url, mp4, poster, width, height);
}

async function resolveGiphy(url: string): Promise<any | null> {
    const id = giphyId(url);
    if (!id) return null;
    const api = `https://api.giphy.com/v1/gifs/${encodeURIComponent(id)}?api_key=${GIPHY_KEY}`;
    const res = await fetch(api);
    if (!res.ok) return null;
    const json = await res.json();
    const orig = json?.data?.images?.original;
    if (!orig) return null;
    const mp4 = orig.mp4;
    const poster = orig.url; // the animated .gif also serves as the poster frame
    if (!mp4 || !poster) return null;
    const width = orig.width ? Number(orig.width) : undefined;
    const height = orig.height ? Number(orig.height) : undefined;
    const pageUrl = json?.data?.url || url;
    return buildGifv(pageUrl, mp4, poster, width, height);
}

/**
 * Resolve a single media URL to a Discord embed object (shapes above) or `null`. Direct links are
 * built synchronously (no fetch); Tenor/Giphy page links are looked up via their public APIs.
 * Any fetch/parse failure resolves to `null` so the message degrades to a plain link. Result is
 * cached (including `null`) so each URL is resolved at most once across renders.
 */
export async function resolveEmbed(url: string): Promise<any | null> {
    if (cache.has(url)) return cache.get(url)!;
    if (inFlight.has(url)) return null; // a concurrent call owns this resolution
    inFlight.add(url);
    try {
        let embed: any | null = null;
        if (isTenorView(url)) {
            embed = await resolveTenor(url);
        } else if (isGiphy(url)) {
            // A direct giphy media file (i.giphy.com/<id>.gif) can be embedded without the API.
            const direct = classifyDirect(url);
            embed = direct ? await buildDirect(url, direct) : await resolveGiphy(url);
        } else {
            const direct = classifyDirect(url);
            if (direct) embed = await buildDirect(url, direct);
        }
        cache.set(url, embed);
        return embed;
    } catch {
        cache.set(url, null);
        return null;
    } finally {
        inFlight.delete(url);
    }
}
