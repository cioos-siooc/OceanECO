import { useRuntimeConfig } from '#app';
import { createRequestCache } from './useRequestCache';

// Seafloor depth around a glider track, for the 3D seafloor under its curtain.
// Read from the API's value-packed seafloor tiles (scripts/cnvMaster_RGBcoded.py:
// 24-bit q = (elevation - BASE) / STEP across R,G,B, alpha 0 = land / no data,
// lossless 512 px WebP, z5–10).
const BASE = -11000;
const STEP = 1;
const TILE = 512;
const MIN_ZOOM = 5;
const MAX_ZOOM = 10;
// Grid nodes along the longer side; enough for relief at glider scale.
const MAX_NODES = 256;

export type SeafloorGrid = {
    nx: number;
    ny: number;
    x0: number;            // mercator x/y (0–1) of node (0, 0), the NW corner
    y0: number;
    dx: number;            // node spacing in mercator units
    dy: number;
    depth: Float32Array;   // metres, positive down, row-major from the north; NaN = land / no data
};

const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

async function decodeTile(url: string): Promise<Float32Array | null> {
    const res = await fetch(url);
    if (res.status === 404) return null; // outside the tiled extent
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    // Raw bytes: any colour management or alpha premultiplication corrupts the packed integers.
    const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(bmp.width, bmp.height)
        : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const { data } = ctx.getImageData(0, 0, TILE, TILE);
    const elev = new Float32Array(TILE * TILE);
    for (let i = 0, p = 0; i < elev.length; i++, p += 4) {
        elev[i] = data[p + 3] ? ((data[p]! << 16) | (data[p + 1]! << 8) | data[p + 2]!) * STEP + BASE : NaN;
    }
    return elev;
}

async function loadGrid(bbox: [number, number, number, number]): Promise<SeafloorGrid> {
    const apiBaseUrl = useRuntimeConfig().public.apiBaseUrl;
    const [w, s, e, n] = bbox;
    const mx0 = mercX(w), mx1 = mercX(e), my0 = mercY(n), my1 = mercY(s);

    // Coarsest zoom whose tiles still give at least one pixel per grid node.
    const span = Math.max(mx1 - mx0, my1 - my0);
    let z = MIN_ZOOM;
    while (z < MAX_ZOOM && span * 2 ** z * TILE < MAX_NODES * 2) z++;
    const scale = 2 ** z;
    const tx0 = Math.floor(mx0 * scale), tx1 = Math.floor(mx1 * scale);
    const ty0 = Math.floor(my0 * scale), ty1 = Math.floor(my1 * scale);

    const tiles = new Map<string, Float32Array | null>();
    const jobs: Promise<void>[] = [];
    for (let tx = tx0; tx <= tx1; tx++) {
        for (let ty = ty0; ty <= ty1; ty++) {
            jobs.push(decodeTile(`${apiBaseUrl}/seafloor/${z}/${tx}/${ty}.webp`).then((t) => { tiles.set(`${tx}/${ty}`, t); }));
        }
    }
    await Promise.all(jobs);

    const aspect = (mx1 - mx0) / (my1 - my0);
    const nx = aspect >= 1 ? MAX_NODES : Math.max(16, Math.round(MAX_NODES * aspect));
    const ny = aspect >= 1 ? Math.max(16, Math.round(MAX_NODES / aspect)) : MAX_NODES;
    const dx = (mx1 - mx0) / (nx - 1), dy = (my1 - my0) / (ny - 1);
    const depth = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
        const py = (my0 + j * dy) * scale;
        const ty = Math.min(Math.floor(py), ty1);
        const row = Math.min(TILE - 1, Math.floor((py - ty) * TILE));
        for (let i = 0; i < nx; i++) {
            const px = (mx0 + i * dx) * scale;
            const tx = Math.min(Math.floor(px), tx1);
            const tile = tiles.get(`${tx}/${ty}`);
            const v = tile ? tile[row * TILE + Math.min(TILE - 1, Math.floor((px - tx) * TILE))]! : NaN;
            depth[j * nx + i] = v < 0 ? -v : NaN;
        }
    }
    return { nx, ny, x0: mx0, y0: my0, dx, dy, depth };
}

// Tiles are immutable, so a grid only goes stale if the tile tree is rebuilt.
const cache = createRequestCache<SeafloorGrid>(3_600_000);

/** Seafloor around `bbox` ([w, s, e, n]), padded by a quarter of its size on each side. */
export function fetchSeafloorGrid(bbox: [number, number, number, number]): Promise<SeafloorGrid> {
    const [w, s, e, n] = bbox;
    const padX = Math.max(0.1, (e - w) * 0.25), padY = Math.max(0.07, (n - s) * 0.25);
    const padded: [number, number, number, number] = [w - padX, s - padY, e + padX, n + padY];
    return cache.fetch(padded.map(v => v.toFixed(3)).join(','), () => loadGrid(padded));
}
