import mapboxgl from 'mapbox-gl';

// The selected glider's section hung as a vertical "curtain" under its track,
// seen when the map is tilted. A Mapbox custom WebGL layer: one triangle strip
// along the track (a top and a bottom vertex per profile) textured with the
// section's cells, coloured by the map's own colorbar.
const LAYER_ID = 'glider-curtain';
// Depth is stretched or a 1000 m dive under a ~150 km transect is a hairline.
export const CURTAIN_EXAGGERATION = 30;
// Straight down, a vertical curtain is edge-on: fade it in as the map tilts (degrees).
const PITCH_HIDDEN = 10;
const PITCH_SHOWN = 30;
const DEPTH_LINE_STEP_M = 200;
// Columns past this are sampled, not all uploaded (well under any GPU's limit).
const MAX_TEXTURE_WIDTH = 4096;

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

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed');
    return sh;
}

function createCurtainLayer(map: mapboxgl.Map) {
    let gl: WebGL2RenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let vao: WebGLVertexArrayObject | null = null;
    let buffer: WebGLBuffer | null = null;
    let tex: WebGLTexture | null = null;
    let loc = {} as {
        pos: number; uv: number;
        matrix: WebGLUniformLocation | null; tex: WebGLUniformLocation | null; opacity: WebGLUniformLocation | null;
        depth: WebGLUniformLocation | null; step: WebGLUniformLocation | null;
    };
    let geometry: Geometry | null = null;
    // Uploads wait for render(): Mapbox caches GL bindings and only resets that
    // cache after a custom layer draws, so touching GL elsewhere would desync it.
    let pending: Geometry | null | undefined;
    let visible = true;
    // Depth-line labels: DOM text over the canvas, re-placed every frame.
    const labelBox = document.createElement('div');
    labelBox.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    let labels: HTMLElement[] = [];

    function buildLabels(geo: Geometry | null) {
        labelBox.replaceChildren();
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

    function upload(g: WebGL2RenderingContext, geo: Geometry) {
        g.bindVertexArray(vao);
        g.bindBuffer(g.ARRAY_BUFFER, buffer);
        g.bufferData(g.ARRAY_BUFFER, geo.vertices, g.STATIC_DRAW);
        g.enableVertexAttribArray(loc.pos);
        g.vertexAttribPointer(loc.pos, 3, g.FLOAT, false, 20, 0);
        g.enableVertexAttribArray(loc.uv);
        g.vertexAttribPointer(loc.uv, 2, g.FLOAT, false, 20, 12);
        g.bindVertexArray(null);

        g.bindTexture(g.TEXTURE_2D, tex);
        g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
        g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        g.pixelStorei(g.UNPACK_ALIGNMENT, 4);
        g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, geo.width, geo.height, 0, g.RGBA, g.UNSIGNED_BYTE, geo.texture);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    }

    const layer = {
        id: LAYER_ID,
        type: 'custom' as const,
        // 2D: no depth test, so the track and markers drawn after it stay on top
        // (anything at the surface is in front of anything below it).
        renderingMode: '2d' as const,

        onAdd(_map: mapboxgl.Map, context: WebGL2RenderingContext) {
            gl = context;
            map.getCanvasContainer().appendChild(labelBox);
            if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
                console.warn('glider curtain needs WebGL2');
                gl = null;
                return;
            }
            program = gl.createProgram()!;
            gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
            gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
            gl.linkProgram(program);
            loc = {
                pos: gl.getAttribLocation(program, 'a_pos'),
                uv: gl.getAttribLocation(program, 'a_uv'),
                matrix: gl.getUniformLocation(program, 'u_matrix'),
                tex: gl.getUniformLocation(program, 'u_tex'),
                opacity: gl.getUniformLocation(program, 'u_opacity'),
                depth: gl.getUniformLocation(program, 'u_depth'),
                step: gl.getUniformLocation(program, 'u_step'),
            };
            vao = gl.createVertexArray();
            buffer = gl.createBuffer();
            tex = gl.createTexture();
        },

        render(g: WebGL2RenderingContext, matrix: number[]) {
            if (!gl || !program) return;
            if (pending !== undefined) {
                geometry = pending;
                if (geometry) upload(g, geometry);
                buildLabels(geometry);
                pending = undefined;
            }
            const t = Math.max(0, Math.min(1, (map.getPitch() - PITCH_HIDDEN) / (PITCH_SHOWN - PITCH_HIDDEN)));
            labelBox.style.display = visible && geometry && t ? '' : 'none';
            if (!visible || !geometry || !t) return;
            labelBox.style.opacity = String(t);
            placeLabels(geometry, matrix);

            g.useProgram(program);
            g.uniformMatrix4fv(loc.matrix, false, new Float32Array(matrix));
            g.uniform1f(loc.opacity, 0.95 * t);
            g.uniform2f(loc.depth, geometry.depthRange[0], geometry.depthRange[1]);
            g.uniform1f(loc.step, DEPTH_LINE_STEP_M);
            g.activeTexture(g.TEXTURE0);
            g.bindTexture(g.TEXTURE_2D, tex);
            g.uniform1i(loc.tex, 0);
            g.disable(g.DEPTH_TEST);
            g.disable(g.CULL_FACE);
            g.enable(g.BLEND);
            g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
            g.bindVertexArray(vao);
            g.drawArrays(g.TRIANGLE_STRIP, 0, geometry.count);
            g.bindVertexArray(null);
        },

        onRemove(_map: mapboxgl.Map, g: WebGL2RenderingContext) {
            labelBox.remove();
            if (!gl) return;
            g.deleteProgram(program);
            g.deleteVertexArray(vao);
            g.deleteBuffer(buffer);
            g.deleteTexture(tex);
            gl = null;
        },

        setSection(section: CurtainSection | null) {
            pending = section ? buildGeometry(section) : null;
            map.triggerRepaint();
        },

        setVisible(v: boolean) {
            visible = v;
            map.triggerRepaint();
        },
    };
    return layer;
}

const layers = new WeakMap<mapboxgl.Map, ReturnType<typeof createCurtainLayer>>();

/** Show `section` as the curtain (null clears it), adding the layer below `beforeId` on first use. */
export function setGliderCurtain(map: mapboxgl.Map | null, section: CurtainSection | null, beforeId?: string) {
    if (!map) return;
    let layer = layers.get(map);
    if (!layer || !map.getLayer(LAYER_ID)) {
        if (!section) return;
        layer = createCurtainLayer(map);
        layers.set(map, layer);
        map.addLayer(layer, beforeId && map.getLayer(beforeId) ? beforeId : undefined);
    }
    layer.setSection(section);
}

export function setGliderCurtainVisibility(map: mapboxgl.Map | null, visible: boolean) {
    if (map) layers.get(map)?.setVisible(visible);
}
