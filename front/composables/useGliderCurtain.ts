import mapboxgl from 'mapbox-gl';
import type { SeafloorGrid } from './useSeafloorGrid';
import { circleRing, type AreaCircle } from './useObsAreaLayer';

// The selected glider's section hung as a vertical "curtain" under its track,
// seen when the map is tilted, over a shaded 3D seafloor around it. A Mapbox
// custom WebGL layer:
// - curtain: one triangle strip along the track (a top and a bottom vertex per
//   profile) textured with the section's cells, coloured by the map's colorbar;
// - seafloor: a mesh of the bathymetry grid, depth-ramped slate grey with
//   hillshade, never the field colours, so it can't be read as data.
// - area volume: the Area tab's circle × depth range as a translucent
//   cylinder, with the observations inside it as dots at their depths.
// All are drawn into our own framebuffer with its own depth buffer (so a slope
// in front hides the curtain behind it) and then composited onto the map.
// Mapbox's depth buffer is never touched: the track and markers drawn after it
// stay on top, as they should — anything at the surface is in front of anything
// below it.
const LAYER_ID = 'glider-curtain';
// Depth is stretched or a 1000 m dive under a ~150 km transect is a hairline.
export const CURTAIN_EXAGGERATION = 30;
// Straight down, a vertical curtain is edge-on: fade it in as the map tilts (degrees).
const PITCH_HIDDEN = 10;
const PITCH_SHOWN = 30;
const DEPTH_LINE_STEP_M = 200;
// Columns past this are sampled, not all uploaded (well under any GPU's limit).
const MAX_TEXTURE_WIDTH = 4096;
// Seafloor ramp (shallow → deep, at SEAFLOOR_RAMP_M) and light from the north-west.
const SEAFLOOR_SHALLOW = [150, 164, 178];
const SEAFLOOR_DEEP = [38, 48, 60];
const SEAFLOOR_RAMP_M = 3000;
const LIGHT = (() => { const l = [-1, 1, 1.4]; const n = Math.hypot(...l); return l.map(v => v / n); })();

export type CurtainSection = {
    lon: number[];
    lat: number[];
    depths: number[];               // bin centres (m), ascending and evenly spaced
    values: (number | null)[][];    // [depth][profile], in the display unit `rgb` expects
    rgb: (v: number) => number[];   // [r, g, b] 0–255
};

type Geometry = {
    vertices: Float32Array;         // x, y, z, u, v per vertex
    count: number;
    texture: Uint8Array;
    width: number;
    height: number;
    depthRange: [number, number];   // top and bottom edge of the cells (m)
    anchors: Float64Array;          // per profile: mercator x, y, and z per metre of depth
    reach: Float32Array;            // per profile: bottom of its deepest cell with data (m)
    lines: number[];                // depths of the depth lines (m)
};

const VERT = `#version 300 es
in vec3 a_pos;
in vec2 a_uv;
uniform mat4 u_matrix;
out vec2 v_uv;
void main() {
    v_uv = a_uv;
    gl_Position = u_matrix * vec4(a_pos, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform vec2 u_depth;
uniform float u_step;
in vec2 v_uv;
out vec4 fragColor;
void main() {
    vec4 c = texture(u_tex, v_uv);
    if (c.a < 0.5) discard;
    // Faint depth lines every u_step metres, about a pixel wide at any zoom.
    float depth = mix(u_depth.x, u_depth.y, v_uv.y);
    float off = abs(fract(depth / u_step + 0.5) - 0.5) * u_step;
    float line = (1.0 - smoothstep(0.0, fwidth(depth), off)) * step(1.0, depth);
    vec3 rgb = mix(c.rgb, vec3(1.0), 0.3 * line);
    fragColor = vec4(rgb * u_opacity, u_opacity);
}`;

function buildGeometry(s: CurtainSection): Geometry | null {
    const n = s.lon.length;
    const m = s.depths.length;
    if (n < 2 || !m) return null;

    const bin = m > 1 ? (s.depths[m - 1]! - s.depths[0]!) / (m - 1) : 10;
    const top = Math.max(0, s.depths[0]! - bin / 2);
    const bottom = s.depths[m - 1]! + bin / 2;

    const vertices = new Float32Array(n * 2 * 5);
    const anchors = new Float64Array(n * 3);
    const reach = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const u = (i + 0.5) / n;
        const lngLat: [number, number] = [s.lon[i]!, s.lat[i]!];
        const a = mapboxgl.MercatorCoordinate.fromLngLat(lngLat, -top * CURTAIN_EXAGGERATION);
        const b = mapboxgl.MercatorCoordinate.fromLngLat(lngLat, -bottom * CURTAIN_EXAGGERATION);
        vertices.set([a.x, a.y, a.z, u, 0, b.x, b.y, b.z, u, 1], i * 10);
        anchors.set([a.x, a.y, a.meterInMercatorCoordinateUnits() * CURTAIN_EXAGGERATION], i * 3);
        for (let j = m - 1; j >= 0; j--) {
            if (s.values[j]![i] != null) { reach[i] = s.depths[j]! + bin / 2; break; }
        }
    }
    const lines: number[] = [];
    for (let d = DEPTH_LINE_STEP_M; d < bottom; d += DEPTH_LINE_STEP_M) lines.push(d);

    const width = Math.min(n, MAX_TEXTURE_WIDTH);
    const texture = new Uint8Array(width * m * 4);
    for (let j = 0; j < m; j++) {
        const row = s.values[j]!;
        for (let c = 0; c < width; c++) {
            const v = row[Math.floor(c * n / width)];
            if (v == null || !Number.isFinite(v)) continue;
            const [r, g, b] = s.rgb(v);
            texture.set([r!, g!, b!, 255], (j * width + c) * 4);
        }
    }
    return { vertices, count: n * 2, texture, width, height: m, depthRange: [top, bottom], anchors, reach, lines };
}

type Seafloor = {
    vertices: Float32Array;         // x, y, z, r, g, b, a per node
    indices: Uint32Array;
};

const SEA_VERT = `#version 300 es
in vec3 a_pos;
in vec4 a_color;
uniform mat4 u_matrix;
out vec4 v_color;
void main() {
    v_color = a_color;
    gl_Position = u_matrix * vec4(a_pos, 1.0);
}`;

const SEA_FRAG = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 fragColor;
void main() {
    fragColor = vec4(v_color.rgb * v_color.a, v_color.a);
}`;

// One full-screen triangle sampling the offscreen render (premultiplied).
const COMP_VERT = `#version 300 es
out vec2 v_uv;
void main() {
    vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
    v_uv = p * 0.5 + 0.5;
    gl_Position = vec4(p, 0.0, 1.0);
}`;

const COMP_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_opacity;
in vec2 v_uv;
out vec4 fragColor;
void main() {
    fragColor = texture(u_tex, v_uv) * u_opacity;
}`;

function buildSeafloor(grid: SeafloorGrid): Seafloor | null {
    const { nx, ny, x0, y0, dx, dy, depth } = grid;
    // Exaggerated height (m, up); land counts as sea level so the coast slopes up to it.
    const h = (i: number, j: number) => {
        const v = depth[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))]!;
        return Number.isNaN(v) ? 0 : -v * CURTAIN_EXAGGERATION;
    };
    const fade = Math.max(2, 0.08 * Math.min(nx, ny));
    const vertices = new Float32Array(nx * ny * 7);
    for (let j = 0; j < ny; j++) {
        const y = y0 + j * dy;
        const unitsPerM = new mapboxgl.MercatorCoordinate(x0, y, 0).meterInMercatorCoordinateUnits();
        const mx = dx / unitsPerM, my = dy / unitsPerM; // node spacing in metres
        for (let i = 0; i < nx; i++) {
            const d = depth[j * nx + i]!;
            if (Number.isNaN(d)) continue;
            // Normal from central differences (east, north, up); rows run north → south.
            const ex = -(h(i + 1, j) - h(i - 1, j)) / (2 * mx);
            const ey = -(h(i, j - 1) - h(i, j + 1)) / (2 * my);
            const nl = Math.hypot(ex, ey, 1);
            const lambert = Math.max(0, (ex * LIGHT[0]! + ey * LIGHT[1]! + LIGHT[2]!) / nl);
            const shade = 0.35 + 0.65 * lambert;
            const t = Math.min(1, d / SEAFLOOR_RAMP_M);
            const edge = Math.min(1, Math.min(i, j, nx - 1 - i, ny - 1 - j) / fade);
            vertices.set([
                x0 + i * dx, y, -d * CURTAIN_EXAGGERATION * unitsPerM,
                ...SEAFLOOR_SHALLOW.map((c, k) => (c + (SEAFLOOR_DEEP[k]! - c) * t) * shade / 255),
                edge,
            ], (j * nx + i) * 7);
        }
    }
    const idx: number[] = [];
    for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
            const a = j * nx + i, b = a + 1, c = a + nx, e = c + 1;
            if ([a, b, c, e].some(k => Number.isNaN(depth[k]!))) continue;
            idx.push(a, c, b, b, c, e);
        }
    }
    return idx.length ? { vertices, indices: new Uint32Array(idx) } : null;
}

/** The Area tab's 4D box in space: its circle and depth range, and the observations in it. */
export type AreaVolume = AreaCircle & {
    depthMin: number;
    depthMax: number;
    rgb: number[];                                              // cylinder colour, 0–255
    markers: { lon: number; lat: number; depth: number; rgb: number[] }[];
};

type Volume = {
    walls: Float32Array;            // x, y, z, r, g, b, a per vertex: a triangle strip
    lines: Float32Array;            // same layout: line pairs (rims and a few verticals)
    markers: Float32Array;          // same layout: one point per observation
    ring: Float64Array;             // per rim vertex: mercator x, y, and z per metre of depth
    depths: [number, number];
};

const VOLUME_WALL_ALPHA = 0.16;
const VOLUME_LINE_ALPHA = 0.9;
const VOLUME_VERTICALS = 8;
const MARKER_PX = 7;

function buildVolume(v: AreaVolume): Volume {
    const ring = circleRing(v, 96);
    const n = ring.length;
    const [r, g, b] = v.rgb.map(c => c / 255) as [number, number, number];
    const top = v.depthMin, bottom = Math.max(v.depthMax, v.depthMin + 0.5);
    const at = (lngLat: [number, number], depth: number) =>
        mapboxgl.MercatorCoordinate.fromLngLat(lngLat, -depth * CURTAIN_EXAGGERATION);
    const premul = (a: number) => [r * a, g * a, b * a, a];

    const walls = new Float32Array(n * 2 * 7);
    const anchors = new Float64Array(n * 3);
    const tops: number[][] = [], bottoms: number[][] = [];
    ring.forEach((lngLat, i) => {
        const a = at(lngLat, top), c = at(lngLat, bottom);
        tops.push([a.x, a.y, a.z]);
        bottoms.push([c.x, c.y, c.z]);
        walls.set([a.x, a.y, a.z, ...premul(VOLUME_WALL_ALPHA), c.x, c.y, c.z, ...premul(VOLUME_WALL_ALPHA)], i * 14);
        const s0 = at(lngLat, 0);
        anchors.set([s0.x, s0.y, s0.meterInMercatorCoordinateUnits() * CURTAIN_EXAGGERATION], i * 3);
    });

    const line: number[] = [];
    const lc = premul(VOLUME_LINE_ALPHA);
    for (const rim of [tops, bottoms]) {
        for (let i = 0; i < n - 1; i++) line.push(...rim[i]!, ...lc, ...rim[i + 1]!, ...lc);
    }
    for (let k = 0; k < VOLUME_VERTICALS; k++) {
        const i = Math.round(k * (n - 1) / VOLUME_VERTICALS);
        line.push(...tops[i]!, ...lc, ...bottoms[i]!, ...lc);
    }

    const markers = new Float32Array(v.markers.length * 7);
    v.markers.forEach((m, i) => {
        const p = at([m.lon, m.lat], m.depth);
        markers.set([p.x, p.y, p.z, ...m.rgb.map(c => c / 255), 1], i * 7);
    });
    return { walls, lines: new Float32Array(line), markers, ring: anchors, depths: [top, bottom] };
}

// Round, outlined dots of a fixed pixel size (premultiplied colour).
const POINT_VERT = `#version 300 es
in vec3 a_pos;
in vec4 a_color;
uniform mat4 u_matrix;
uniform float u_size;
out vec4 v_color;
void main() {
    v_color = a_color;
    gl_Position = u_matrix * vec4(a_pos, 1.0);
    gl_PointSize = u_size;
}`;

const POINT_FRAG = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 fragColor;
void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0) discard;
    vec3 rgb = r > 0.7 ? vec3(0.07, 0.09, 0.1) : v_color.rgb;
    fragColor = vec4(rgb, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed');
    return sh;
}

/**
 * Mapbox fits its far plane to the sea surface, so seafloor tens of km below it
 * (exaggerated) gets clipped, worst at low pitch. Our pass has its own depth
 * buffer, so push the far plane out for it: recover near/far from the clip
 * matrix's z row (row2 = -P22 * row3 + P23 * e4 for a GL perspective, column-
 * major) and rebuild that row with a farther far.
 */
function withFarPlane(m: number[], factor: number): Float32Array {
    const out = Float32Array.from(m);
    const r3 = [m[3]!, m[7]!, m[11]!, m[15]!];
    let k = 0;
    for (let c = 1; c < 3; c++) if (Math.abs(r3[c]!) > Math.abs(r3[k]!)) k = c;
    if (!r3[k]) return out;
    const p22 = -m[k * 4 + 2]! / r3[k]!;
    const p23 = m[14]! + p22 * m[15]!;
    const near = p23 / (p22 - 1), far = p23 / (p22 + 1) * factor;
    const q22 = (far + near) / (near - far), q23 = (2 * far * near) / (near - far);
    for (let c = 0; c < 4; c++) out[c * 4 + 2] = -q22 * r3[c]! + (c === 3 ? q23 : 0);
    return out;
}

function link(gl: WebGL2RenderingContext, vert: string, frag: string) {
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vert));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'program link failed');
    return p;
}

type Programs = {
    curtain: WebGLProgram; sea: WebGLProgram; comp: WebGLProgram; point: WebGLProgram;
    curtainVao: WebGLVertexArrayObject; seaVao: WebGLVertexArrayObject; compVao: WebGLVertexArrayObject;
    curtainBuf: WebGLBuffer; seaBuf: WebGLBuffer; seaIdx: WebGLBuffer; curtainTex: WebGLTexture;
    wallVao: WebGLVertexArrayObject; lineVao: WebGLVertexArrayObject; markerVao: WebGLVertexArrayObject;
    wallBuf: WebGLBuffer; lineBuf: WebGLBuffer; markerBuf: WebGLBuffer;
};

// Offscreen target: multisampled colour + depth, resolved into a texture.
type Target = { w: number; h: number; ms: WebGLFramebuffer; color: WebGLRenderbuffer; depth: WebGLRenderbuffer; resolve: WebGLFramebuffer; tex: WebGLTexture };

function createCurtainLayer(map: mapboxgl.Map) {
    let gl: WebGL2RenderingContext | null = null;
    let P: Programs | null = null;
    let target: Target | null = null;
    let geometry: Geometry | null = null;
    let seafloor: Seafloor | null = null;
    let seaCount = 0;
    // Uploads wait for render(): Mapbox caches GL bindings and only resets that
    // cache after a custom layer draws, so touching GL elsewhere would desync it.
    let pending: Geometry | null | undefined;
    let pendingSea: Seafloor | null | undefined;
    let volume: Volume | null = null;
    let pendingVolume: Volume | null | undefined;
    let visible = true;
    let seafloorVisible = true;
    // Depth-line labels: DOM text over the canvas, re-placed every frame.
    const labelBox = document.createElement('div');
    labelBox.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    let labels: HTMLElement[] = [];
    // The area volume's top and bottom depths, on its left-most rim edge.
    const volumeLabels = [0, 1].map(() => {
        const el = document.createElement('div');
        el.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;font:10px var(--font-mono);'
            + 'color:rgba(255,255,255,0.9);text-shadow:0 0 2px #000,0 0 4px #000;display:none;';
        labelBox.appendChild(el);
        return el;
    });

    function buildLabels(geo: Geometry | null) {
        labelBox.replaceChildren(...volumeLabels);
        labels = (geo?.lines ?? []).map((d) => {
            const el = document.createElement('div');
            el.textContent = `${d} m`;
            el.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;font:10px var(--font-mono);'
                + 'color:rgba(255,255,255,0.85);text-shadow:0 0 2px #000,0 0 4px #000;';
            labelBox.appendChild(el);
            return el;
        });
    }

    /**
     * Stack the labels like an axis on one profile: the left-most on screen
     * that reaches the deepest line (or, failing that, the next one up).
     */
    function placeLabels(geo: Geometry, m: number[]) {
        const canvas = map.getCanvas();
        const w = canvas.clientWidth, h = canvas.clientHeight;
        // Column-major mercator → clip, then to CSS pixels; null if behind the camera.
        const project = (i: number, depth: number): [number, number] | null => {
            const x = geo.anchors[i * 3]!, y = geo.anchors[i * 3 + 1]!, z = -depth * geo.anchors[i * 3 + 2]!;
            const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
            if (cw <= 0) return null;
            return [((m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / cw + 1) / 2 * w,
                (1 - (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / cw) / 2 * h];
        };
        const onScreen = (p: [number, number] | null): p is [number, number] => !!p && p[0] >= 0 && p[0] <= w && p[1] >= 0 && p[1] <= h;

        let anchor = -1;
        for (let k = geo.lines.length - 1; k >= 0 && anchor < 0; k--) {
            let bestX = Infinity;
            for (let i = 0; i < geo.reach.length; i++) {
                if (geo.reach[i]! < geo.lines[k]!) continue;
                const p = project(i, 0);
                if (onScreen(p) && p[0] < bestX) { bestX = p[0]; anchor = i; }
            }
        }
        geo.lines.forEach((d, k) => {
            const el = labels[k]!;
            const p = anchor >= 0 && geo.reach[anchor]! >= d ? project(anchor, d) : null;
            el.style.display = onScreen(p) ? '' : 'none';
            if (p) el.style.transform = `translate(${Math.round(p[0] + 4)}px, ${Math.round(p[1] - 2)}px) translateY(-100%)`;
        });
    }

    function placeVolumeLabels(vol: Volume | null, m: number[], opacity: number) {
        if (!vol) { volumeLabels.forEach(el => { el.style.display = 'none'; }); return; }
        const canvas = map.getCanvas();
        const w = canvas.clientWidth, h = canvas.clientHeight;
        const project = (i: number, depth: number): [number, number] | null => {
            const x = vol.ring[i * 3]!, y = vol.ring[i * 3 + 1]!, z = -depth * vol.ring[i * 3 + 2]!;
            const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
            if (cw <= 0) return null;
            return [((m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / cw + 1) / 2 * w,
                (1 - (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / cw) / 2 * h];
        };
        let best = -1, bestX = Infinity;
        for (let i = 0; i < vol.ring.length / 3; i++) {
            const p = project(i, vol.depths[1]);
            if (p && p[0] < bestX) { bestX = p[0]; best = i; }
        }
        vol.depths.forEach((d, k) => {
            const el = volumeLabels[k]!;
            const p = best >= 0 ? project(best, d) : null;
            el.style.display = p ? '' : 'none';
            el.style.opacity = String(opacity);
            el.textContent = `${Math.round(d * 10) / 10} m`;
            if (p) el.style.transform = `translate(${Math.round(p[0] - 6)}px, ${Math.round(p[1])}px) translate(-100%, -50%)`;
        });
    }

    function uploadColored(g: WebGL2RenderingContext, prog: WebGLProgram, vao: WebGLVertexArrayObject, buf: WebGLBuffer, data: Float32Array) {
        g.bindVertexArray(vao);
        g.bindBuffer(g.ARRAY_BUFFER, buf);
        g.bufferData(g.ARRAY_BUFFER, data, g.STATIC_DRAW);
        const pos = g.getAttribLocation(prog, 'a_pos'), color = g.getAttribLocation(prog, 'a_color');
        g.enableVertexAttribArray(pos);
        g.vertexAttribPointer(pos, 3, g.FLOAT, false, 28, 0);
        g.enableVertexAttribArray(color);
        g.vertexAttribPointer(color, 4, g.FLOAT, false, 28, 12);
        g.bindVertexArray(null);
    }

    function uploadVolume(g: WebGL2RenderingContext, p: Programs, vol: Volume) {
        uploadColored(g, p.sea, p.wallVao, p.wallBuf, vol.walls);
        uploadColored(g, p.sea, p.lineVao, p.lineBuf, vol.lines);
        uploadColored(g, p.point, p.markerVao, p.markerBuf, vol.markers);
    }

    function uploadCurtain(g: WebGL2RenderingContext, p: Programs, geo: Geometry) {
        g.bindVertexArray(p.curtainVao);
        g.bindBuffer(g.ARRAY_BUFFER, p.curtainBuf);
        g.bufferData(g.ARRAY_BUFFER, geo.vertices, g.STATIC_DRAW);
        const pos = g.getAttribLocation(p.curtain, 'a_pos'), uv = g.getAttribLocation(p.curtain, 'a_uv');
        g.enableVertexAttribArray(pos);
        g.vertexAttribPointer(pos, 3, g.FLOAT, false, 20, 0);
        g.enableVertexAttribArray(uv);
        g.vertexAttribPointer(uv, 2, g.FLOAT, false, 20, 12);
        g.bindVertexArray(null);

        g.bindTexture(g.TEXTURE_2D, p.curtainTex);
        g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
        g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        g.pixelStorei(g.UNPACK_ALIGNMENT, 4);
        g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, geo.width, geo.height, 0, g.RGBA, g.UNSIGNED_BYTE, geo.texture);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    }

    function uploadSeafloor(g: WebGL2RenderingContext, p: Programs, sea: Seafloor) {
        g.bindVertexArray(p.seaVao);
        g.bindBuffer(g.ARRAY_BUFFER, p.seaBuf);
        g.bufferData(g.ARRAY_BUFFER, sea.vertices, g.STATIC_DRAW);
        const pos = g.getAttribLocation(p.sea, 'a_pos'), color = g.getAttribLocation(p.sea, 'a_color');
        g.enableVertexAttribArray(pos);
        g.vertexAttribPointer(pos, 3, g.FLOAT, false, 28, 0);
        g.enableVertexAttribArray(color);
        g.vertexAttribPointer(color, 4, g.FLOAT, false, 28, 12);
        g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, p.seaIdx);
        g.bufferData(g.ELEMENT_ARRAY_BUFFER, sea.indices, g.STATIC_DRAW);
        g.bindVertexArray(null);
    }

    function ensureTarget(g: WebGL2RenderingContext, w: number, h: number): Target {
        if (target && target.w === w && target.h === h) return target;
        if (target) deleteTarget(g, target);
        const samples = Math.min(4, g.getParameter(g.MAX_SAMPLES) as number);
        const color = g.createRenderbuffer()!;
        g.bindRenderbuffer(g.RENDERBUFFER, color);
        g.renderbufferStorageMultisample(g.RENDERBUFFER, samples, g.RGBA8, w, h);
        const depth = g.createRenderbuffer()!;
        g.bindRenderbuffer(g.RENDERBUFFER, depth);
        g.renderbufferStorageMultisample(g.RENDERBUFFER, samples, g.DEPTH_COMPONENT24, w, h);
        const ms = g.createFramebuffer()!;
        g.bindFramebuffer(g.FRAMEBUFFER, ms);
        g.framebufferRenderbuffer(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.RENDERBUFFER, color);
        g.framebufferRenderbuffer(g.FRAMEBUFFER, g.DEPTH_ATTACHMENT, g.RENDERBUFFER, depth);
        const tex = g.createTexture()!;
        g.bindTexture(g.TEXTURE_2D, tex);
        g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, null);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
        const resolve = g.createFramebuffer()!;
        g.bindFramebuffer(g.FRAMEBUFFER, resolve);
        g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
        target = { w, h, ms, color, depth, resolve, tex };
        return target;
    }

    function deleteTarget(g: WebGL2RenderingContext, t: Target) {
        g.deleteFramebuffer(t.ms);
        g.deleteFramebuffer(t.resolve);
        g.deleteRenderbuffer(t.color);
        g.deleteRenderbuffer(t.depth);
        g.deleteTexture(t.tex);
    }

    const layer = {
        id: LAYER_ID,
        type: 'custom' as const,
        renderingMode: '2d' as const,

        onAdd(_map: mapboxgl.Map, context: WebGL2RenderingContext) {
            map.getCanvasContainer().appendChild(labelBox);
            if (typeof WebGL2RenderingContext === 'undefined' || !(context instanceof WebGL2RenderingContext)) {
                console.warn('glider curtain needs WebGL2');
                return;
            }
            gl = context;
            P = {
                curtain: link(gl, VERT, FRAG),
                sea: link(gl, SEA_VERT, SEA_FRAG),
                comp: link(gl, COMP_VERT, COMP_FRAG),
                point: link(gl, POINT_VERT, POINT_FRAG),
                curtainVao: gl.createVertexArray()!,
                seaVao: gl.createVertexArray()!,
                compVao: gl.createVertexArray()!,
                curtainBuf: gl.createBuffer()!,
                seaBuf: gl.createBuffer()!,
                seaIdx: gl.createBuffer()!,
                curtainTex: gl.createTexture()!,
                wallVao: gl.createVertexArray()!,
                lineVao: gl.createVertexArray()!,
                markerVao: gl.createVertexArray()!,
                wallBuf: gl.createBuffer()!,
                lineBuf: gl.createBuffer()!,
                markerBuf: gl.createBuffer()!,
            };
        },

        render(g: WebGL2RenderingContext, matrix: number[]) {
            if (!gl || !P) return;
            if (pending !== undefined) {
                geometry = pending;
                if (geometry) uploadCurtain(g, P, geometry);
                buildLabels(geometry);
                pending = undefined;
            }
            if (pendingSea !== undefined) {
                seafloor = pendingSea;
                if (seafloor) uploadSeafloor(g, P, seafloor);
                seaCount = seafloor?.indices.length ?? 0;
                pendingSea = undefined;
            }
            if (pendingVolume !== undefined) {
                volume = pendingVolume;
                if (volume) uploadVolume(g, P, volume);
                pendingVolume = undefined;
            }
            const t = Math.max(0, Math.min(1, (map.getPitch() - PITCH_HIDDEN) / (PITCH_SHOWN - PITCH_HIDDEN)));
            // The glider layer toggle hides the curtain and its seafloor, not the area's.
            const curtain = visible ? geometry : null;
            const drawSea = seafloorVisible && seaCount > 0 && (visible || !!volume);
            const show = t > 0 && (!!curtain || !!volume || drawSea);
            labelBox.style.display = show && (curtain || volume) ? '' : 'none';
            if (!show) return;
            labels.forEach((el) => { el.style.display = curtain ? '' : 'none'; });
            if (curtain) {
                labels.forEach((el) => { el.style.opacity = String(t); });
                placeLabels(curtain, matrix);
            }
            placeVolumeLabels(volume, matrix, t);

            const prevFbo = g.getParameter(g.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
            const vp = g.getParameter(g.VIEWPORT) as Int32Array;
            const tg = ensureTarget(g, vp[2]!, vp[3]!);
            const m = withFarPlane(matrix, 4);

            // 1. Seafloor and curtain, depth-tested against each other only.
            g.bindFramebuffer(g.FRAMEBUFFER, tg.ms);
            g.viewport(0, 0, tg.w, tg.h);
            g.disable(g.SCISSOR_TEST);
            g.disable(g.STENCIL_TEST);
            g.disable(g.CULL_FACE);
            g.colorMask(true, true, true, true);
            g.depthMask(true);
            g.depthRange(0, 1);
            g.clearColor(0, 0, 0, 0);
            g.clearDepth(1);
            g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);
            g.enable(g.DEPTH_TEST);
            g.depthFunc(g.LEQUAL);
            g.enable(g.BLEND);
            g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);

            if (drawSea) {
                g.useProgram(P.sea);
                g.uniformMatrix4fv(g.getUniformLocation(P.sea, 'u_matrix'), false, m);
                g.bindVertexArray(P.seaVao);
                g.drawElements(g.TRIANGLES, seaCount, g.UNSIGNED_INT, 0);
            }
            if (curtain) {
                const geometry = curtain;
                g.useProgram(P.curtain);
                g.uniformMatrix4fv(g.getUniformLocation(P.curtain, 'u_matrix'), false, m);
                g.uniform1f(g.getUniformLocation(P.curtain, 'u_opacity'), 1);
                g.uniform2f(g.getUniformLocation(P.curtain, 'u_depth'), geometry.depthRange[0], geometry.depthRange[1]);
                g.uniform1f(g.getUniformLocation(P.curtain, 'u_step'), DEPTH_LINE_STEP_M);
                g.activeTexture(g.TEXTURE0);
                g.bindTexture(g.TEXTURE_2D, P.curtainTex);
                g.uniform1i(g.getUniformLocation(P.curtain, 'u_tex'), 0);
                g.bindVertexArray(P.curtainVao);
                g.drawArrays(g.TRIANGLE_STRIP, 0, geometry.count);
            }
            if (volume) {
                // Dots first, depth-written; then the translucent wall and its
                // lines over them, depth-tested (so rock hides what's below it)
                // but not written, so the far side shows through the near one.
                if (volume.markers.length) {
                    g.useProgram(P.point);
                    g.uniformMatrix4fv(g.getUniformLocation(P.point, 'u_matrix'), false, m);
                    g.uniform1f(g.getUniformLocation(P.point, 'u_size'), MARKER_PX * (window.devicePixelRatio || 1));
                    g.bindVertexArray(P.markerVao);
                    g.drawArrays(g.POINTS, 0, volume.markers.length / 7);
                }
                g.depthMask(false);
                g.useProgram(P.sea);
                g.uniformMatrix4fv(g.getUniformLocation(P.sea, 'u_matrix'), false, m);
                g.bindVertexArray(P.wallVao);
                g.drawArrays(g.TRIANGLE_STRIP, 0, volume.walls.length / 7);
                g.bindVertexArray(P.lineVao);
                g.drawArrays(g.LINES, 0, volume.lines.length / 7);
                g.depthMask(true);
            }

            // 2. Resolve the multisampled render into a texture.
            g.bindFramebuffer(g.READ_FRAMEBUFFER, tg.ms);
            g.bindFramebuffer(g.DRAW_FRAMEBUFFER, tg.resolve);
            g.blitFramebuffer(0, 0, tg.w, tg.h, 0, 0, tg.w, tg.h, g.COLOR_BUFFER_BIT, g.NEAREST);

            // 3. Composite onto whatever Mapbox was drawing into.
            g.bindFramebuffer(g.FRAMEBUFFER, prevFbo);
            g.viewport(vp[0]!, vp[1]!, vp[2]!, vp[3]!);
            g.disable(g.DEPTH_TEST);
            g.useProgram(P.comp);
            g.activeTexture(g.TEXTURE0);
            g.bindTexture(g.TEXTURE_2D, tg.tex);
            g.uniform1i(g.getUniformLocation(P.comp, 'u_tex'), 0);
            g.uniform1f(g.getUniformLocation(P.comp, 'u_opacity'), 0.95 * t);
            g.bindVertexArray(P.compVao);
            g.drawArrays(g.TRIANGLES, 0, 3);
            g.bindVertexArray(null);
        },

        onRemove(_map: mapboxgl.Map, g: WebGL2RenderingContext) {
            labelBox.remove();
            if (!gl || !P) return;
            for (const p of [P.curtain, P.sea, P.comp, P.point]) g.deleteProgram(p);
            for (const v of [P.curtainVao, P.seaVao, P.compVao, P.wallVao, P.lineVao, P.markerVao]) g.deleteVertexArray(v);
            for (const b of [P.curtainBuf, P.seaBuf, P.seaIdx, P.wallBuf, P.lineBuf, P.markerBuf]) g.deleteBuffer(b);
            g.deleteTexture(P.curtainTex);
            if (target) deleteTarget(g, target);
            gl = null;
            P = null;
            target = null;
        },

        setSection(section: CurtainSection | null) {
            pending = section ? buildGeometry(section) : null;
            map.triggerRepaint();
        },

        setSeafloor(grid: SeafloorGrid | null) {
            pendingSea = grid ? buildSeafloor(grid) : null;
            map.triggerRepaint();
        },

        setVolume(v: AreaVolume | null) {
            pendingVolume = v ? buildVolume(v) : null;
            map.triggerRepaint();
        },

        setVisible(v: boolean) {
            visible = v;
            map.triggerRepaint();
        },

        setSeafloorVisible(v: boolean) {
            seafloorVisible = v;
            map.triggerRepaint();
        },
    };
    return layer;
}

const layers = new WeakMap<mapboxgl.Map, ReturnType<typeof createCurtainLayer>>();

function ensureLayer(map: mapboxgl.Map, beforeId?: string) {
    let layer = layers.get(map);
    if (!layer || !map.getLayer(LAYER_ID)) {
        layer = createCurtainLayer(map);
        layers.set(map, layer);
        map.addLayer(layer, beforeId && map.getLayer(beforeId) ? beforeId : undefined);
    }
    return layer;
}

/** Show `section` as the curtain (null clears it), adding the layer below `beforeId` on first use. */
export function setGliderCurtain(map: mapboxgl.Map | null, section: CurtainSection | null, beforeId?: string) {
    if (!map || (!section && !layers.get(map))) return;
    ensureLayer(map, beforeId).setSection(section);
}

/** Show the seafloor around the curtain (null clears it). */
export function setGliderSeafloor(map: mapboxgl.Map | null, grid: SeafloorGrid | null, beforeId?: string) {
    if (!map || (!grid && !layers.get(map))) return;
    ensureLayer(map, beforeId).setSeafloor(grid);
}

export function setGliderCurtainVisibility(map: mapboxgl.Map | null, visible: boolean) {
    if (map) layers.get(map)?.setVisible(visible);
}

export function setGliderSeafloorVisibility(map: mapboxgl.Map | null, visible: boolean) {
    if (map) layers.get(map)?.setSeafloorVisible(visible);
}

/** Show the Area tab's box and observations under its circle (null clears it). */
export function setAreaVolume(map: mapboxgl.Map | null, volume: AreaVolume | null, beforeId?: string) {
    if (!map || (!volume && !layers.get(map))) return;
    ensureLayer(map, beforeId).setVolume(volume);
}

// Mapbox's vertical field of view (its transform's default).
const MAPBOX_FOV = 0.6435011087932844;

/**
 * Camera (centre, zoom) that fits the area volume's cylinder — both rims,
 * at their exaggerated depths — inside the map with `padding` px to spare,
 * seen from the south at `pitch`. fitBounds can't: it fits a flat box, and
 * under perspective a deep cylinder ends up small. This projects the rims
 * as Mapbox's camera would (bearing 0) and refines centre and zoom.
 */
export function cameraForAreaVolume(map: mapboxgl.Map, v: AreaCircle & { depthMin: number; depthMax: number },
    pitch: number, padding?: number): { center: [number, number]; zoom: number } {
    const canvas = map.getCanvas();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    // Default: a clear margin that scales with the map (the map's own overlays sit at its edges).
    padding ??= Math.max(60, 0.15 * Math.min(w, h));
    const focal = (h / 2) / Math.tan(MAPBOX_FOV / 2);
    const p = pitch * Math.PI / 180;
    const sp = Math.sin(p), cp = Math.cos(p);
    const rims = circleRing(v, 48).flatMap(ll => [v.depthMin, v.depthMax].map(d =>
        mapboxgl.MercatorCoordinate.fromLngLat(ll, -d * CURTAIN_EXAGGERATION)));

    let c = mapboxgl.MercatorCoordinate.fromLngLat([v.lng, v.lat]);
    let cx = c.x, cy = c.y;
    let zoom = map.getZoom();
    for (let it = 0; it < 8; it++) {
        const s = 512 * 2 ** zoom; // px per mercator unit
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const q of rims) {
            // East, north, up (px) from the camera, which sits `focal` px from the centre.
            const e = (q.x - cx) * s, n = -(q.y - cy) * s + focal * sp, u = q.z * s - focal * cp;
            const along = n * sp - u * cp;
            if (along <= 1) continue;
            const sx = w / 2 + focal * e / along;
            const sy = h / 2 - focal * (n * cp + u * sp) / along;
            x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
        }
        if (!Number.isFinite(x0)) break;
        // Re-centre on the box (a screen-y step is about 1/cos(pitch) on the ground), then zoom to fit.
        cx += ((x0 + x1) / 2 - w / 2) / s;
        cy += ((y0 + y1) / 2 - h / 2) / (s * cp);
        const k = Math.min((w - 2 * padding) / Math.max(1, x1 - x0), (h - 2 * padding) / Math.max(1, y1 - y0));
        zoom = Math.min(16, Math.max(2, zoom + Math.log2(k) * 0.8));
    }
    const ll = new mapboxgl.MercatorCoordinate(cx, cy, 0).toLngLat();
    return { center: [ll.lng, ll.lat], zoom };
}
