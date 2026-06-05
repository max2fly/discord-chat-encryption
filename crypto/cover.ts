import { assemblePng, zlibStored } from "./png";

const W = 128,
    H = 128;

function rnd(n: number): number {
    return crypto.getRandomValues(new Uint32Array(1))[0] % n;
}

/** HSL (h∈[0,360), s,l∈[0,1]) → RGB 0-255. A coherent hue family reads as intentional art, not noise. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0,
        g = 0,
        b = 0;
    if (hp < 1) [r, g, b] = [c, x, 0];
    else if (hp < 2) [r, g, b] = [x, c, 0];
    else if (hp < 3) [r, g, b] = [0, c, x];
    else if (hp < 4) [r, g, b] = [0, x, c];
    else if (hp < 5) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    const m = l - c / 2;
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

type Shape = "circle" | "square" | "diamond" | "heart" | "star";
const SHAPES: Shape[] = ["circle", "square", "diamond", "heart", "star"];

function inside(shape: Shape, dx: number, dy: number, r: number): boolean {
    switch (shape) {
        case "circle":
            return dx * dx + dy * dy <= r * r;
        case "square":
            return Math.abs(dx) <= r && Math.abs(dy) <= r;
        case "diamond":
            return Math.abs(dx) + Math.abs(dy) <= r;
        case "heart": {
            const x = dx / r,
                y = -dy / r;
            const t = x * x + y * y - 1;
            return t * t * t - x * x * y * y * y <= 0;
        }
        case "star": {
            const ang = Math.atan2(dy, dx) + Math.PI / 2;
            const seg = Math.PI / 5;
            const m = ((ang % (2 * seg)) + 2 * seg) % (2 * seg);
            const edge = m < seg ? m : 2 * seg - m;
            const rr = r * (0.55 + 0.45 * (1 - edge / seg)); // spiky radius
            return dx * dx + dy * dy <= rr * rr;
        }
    }
}

function drawMotif(px: Uint8Array, idx: number, cx: number, cy: number, r: number, shape: Shape): void {
    for (let y = Math.max(0, cy - r); y < Math.min(H, cy + r + 1); y++)
        for (let x = Math.max(0, cx - r); x < Math.min(W, cx + r + 1); x++)
            if (inside(shape, x - cx, y - cy, r)) px[y * W + x] = idx;
}

const GRAD = 32; // background gradient steps (palette indices 0..GRAD-1)

export function makeCoverPng(): Uint8Array {
    const hue = rnd(360);

    // Palette: a soft vertical gradient background (analogous, light) + a few vivid motif colors.
    const palette: [number, number, number][] = [];
    for (let i = 0; i < GRAD; i++) {
        const t = i / (GRAD - 1);
        palette.push(hslToRgb((hue + 22 * t) % 360, 0.3 + 0.12 * t, 0.9 - 0.2 * t));
    }
    const MOTIF_BASE = palette.length;
    const motifOffsets = [0, 35, -35, 175, 205]; // analogous + complementary accents
    for (const off of motifOffsets) {
        palette.push(hslToRgb((((hue + off) % 360) + 360) % 360, 0.62 + rnd(16) / 100, 0.5 + rnd(16) / 100));
    }
    const motifCount = palette.length - MOTIF_BASE;

    // Background = vertical gradient by row.
    const px = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        const g = Math.min(GRAD - 1, Math.floor((y / H) * GRAD));
        px.fill(g, y * W, (y + 1) * W);
    }

    // Spread motifs over a jittered 4×4 grid, guaranteeing 2–3 per quadrant so the art stays
    // balanced and never clusters in one corner.
    const G = 4;
    const cell = W / G; // 32
    const quadrants = [
        [0, 1, 4, 5],
        [2, 3, 6, 7],
        [8, 9, 12, 13],
        [10, 11, 14, 15],
    ];
    const jitter = () => rnd(Math.floor(cell / 2)) - Math.floor(cell / 4);
    for (const q of quadrants) {
        const qc = [...q];
        for (let i = qc.length - 1; i > 0; i--) {
            const j = rnd(i + 1);
            [qc[i], qc[j]] = [qc[j], qc[i]];
        }
        const n = 2 + rnd(2); // 2–3 motifs per quadrant → 8–12 total
        for (let k = 0; k < n; k++) {
            const gx = qc[k] % G,
                gy = Math.floor(qc[k] / G);
            const cx = Math.round(gx * cell + cell / 2 + jitter());
            const cy = Math.round(gy * cell + cell / 2 + jitter());
            const r = Math.round(cell * 0.32 + rnd(Math.floor(cell * 0.3)));
            drawMotif(px, MOTIF_BASE + rnd(motifCount), cx, cy, r, SHAPES[rnd(SHAPES.length)]);
        }
    }

    const ihdr = new Uint8Array(13);
    ihdr[0] = (W >>> 24) & 0xff;
    ihdr[1] = (W >>> 16) & 0xff;
    ihdr[2] = (W >>> 8) & 0xff;
    ihdr[3] = W & 0xff;
    ihdr[4] = (H >>> 24) & 0xff;
    ihdr[5] = (H >>> 16) & 0xff;
    ihdr[6] = (H >>> 8) & 0xff;
    ihdr[7] = H & 0xff;
    ihdr[8] = 8; // bit depth
    ihdr[9] = 3; // color type: indexed
    // ihdr[10..12] compression/filter/interlace = 0

    const plte = new Uint8Array(palette.length * 3);
    palette.forEach((c, i) => {
        plte[i * 3] = c[0];
        plte[i * 3 + 1] = c[1];
        plte[i * 3 + 2] = c[2];
    });

    const raw = new Uint8Array(H * (1 + W));
    for (let y = 0; y < H; y++) {
        raw[y * (1 + W)] = 0;
        raw.set(px.subarray(y * W, (y + 1) * W), y * (1 + W) + 1);
    }

    return assemblePng([
        { type: "IHDR", data: ihdr },
        { type: "PLTE", data: plte },
        { type: "IDAT", data: zlibStored(raw) },
        { type: "IEND", data: new Uint8Array(0) },
    ]);
}
