import type { Feature, FeatureCollection } from 'geojson';
import { chart } from '@/config/palette';
import type { GliderClip, GliderDeployment } from '@/stores/main';

// C-PROOF glider deployments and Argo floats: a marker at each one's latest
// fix, cut to the observation period when one is set. Only the selected and
// hovered ones draw their track: every track at once cluttered the map and
// slowed panning and period changes. Sensor blue like every other observation;
// a glider is a triangle and a float an upright capsule (fixed sensors are
// squares, profilers diamonds), with the same green live dot.
const INK = '#d4d9de';
const GROUND = '#13161a';
const LIVE = '#5cc28a';
const MUTED = '#7d868f';
const ACCENT = '#e2a336';

const SOURCE_TRACKS = 'glider-tracks';
const SOURCE_HEADS = 'glider-heads';
const SOURCE_RANGE = 'glider-range';
const LAYER_TRACK_CASING = 'glider-track-casing';
const LAYER_TRACK = 'glider-track';
const LAYER_TRACK_SELECTED = 'glider-track-selected';
const LAYER_TRACK_HOVER = 'glider-track-hover';
const LAYER_TRACK_RANGE = 'glider-track-range';
const LAYER_HEAD = 'glider-head';
export const GLIDER_CLICK_LAYERS = [LAYER_TRACK, LAYER_HEAD];
/** Bottom-most glider layer, for slotting the depth curtain under the tracks. */
export const GLIDER_BASE_LAYER = LAYER_TRACK_CASING;
const SELECTED_OPACITY = 1;
// The rest of the selected track, while its section is zoomed to a stretch of it.
const SELECTED_DIMMED_OPACITY = 0.35;
// The selected track while another deployment is hovered.
const HOVER_OTHERS_OPACITY = 0.2;
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

const IMG = { live: 'glider-live', historic: 'glider-historic', argoLive: 'argo-live', argoHistoric: 'argo-historic' } as const;
const NONE = ['==', ['get', 'id'], '__none__'];

function makeMarkerSvg(shape: string, live: boolean) {
    const halo = shape.replace('/>', ' fill="none" stroke="rgba(0,0,0,0.7)" stroke-width="4" stroke-linejoin="round"/>');
    const body = shape.replace('/>', ` fill="${live ? chart.sensor : MUTED}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>`);
    const dot = live ? `<circle cx="16" cy="19" r="4" fill="${LIVE}" stroke="${GROUND}" stroke-width="2"/>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${halo}${body}${dot}</svg>`;
}
const TRIANGLE = '<polygon points="16,5 27,25 5,25"/>';
const CAPSULE = '<rect x="9.5" y="4" width="13" height="24" rx="6.5"/>';

async function loadImage(map: any, id: string, svg: string, size: number): Promise<void> {
    if (map.hasImage(id)) return;
    const img = new Image(size, size);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode().catch(() => {});
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    map.addImage(id, canvas.getContext('2d')!.getImageData(0, 0, size, size), { pixelRatio: 2 });
}

/**
 * Tracks and heads; with `clips` (the observation period is on), each track
 * is only its matching stretches and its head sits at the last of them.
 */
function buildGeoJSON(gliders: GliderDeployment[], clips: Record<string, GliderClip> | null): { tracks: FeatureCollection, heads: FeatureCollection } {
    const lines = gliders
        .map(g => ({ g, segments: clips ? clips[g.id]?.segments ?? [] : [g.track.map(p => [p[0], p[1]] as [number, number])] }))
        .filter(({ segments }) => segments.some(seg => seg.length > 1));
    return {
        tracks: {
            type: 'FeatureCollection',
            features: lines.map(({ g, segments }) => ({
                type: 'Feature',
                properties: { id: g.id, kind: g.kind, active: g.active },
                geometry: { type: 'MultiLineString', coordinates: segments },
            })),
        },
        heads: {
            type: 'FeatureCollection',
            features: lines.map(({ g, segments }) => {
                const seg = segments[segments.length - 1]!;
                const last = seg[seg.length - 1]!;
                return {
                    type: 'Feature',
                    // A head clipped short of the latest fix isn't "on mission now".
                    properties: { id: g.id, kind: g.kind, active: g.active && (!clips || sameFix(last, g.track[g.track.length - 1]!)) },
                    geometry: { type: 'Point', coordinates: [last[0], last[1]] },
                };
            }),
        },
    };
}

function sameFix(a: number[], b: number[]): boolean {
    return Math.abs(a[0]! - b[0]!) < 1e-6 && Math.abs(a[1]! - b[1]!) < 1e-6;
}

// Module state so hover and selection compose: hover fades everything but the
// hovered track, and leaving restores the selection's own fading.
let selectedId: string | null = null;
let hoveredId: string | null = null;
let selectedBaseOpacity = SELECTED_OPACITY;
// Every deployment's track; the map source holds only the focused ones.
let allTracks: Feature[] = [];

function focusedTracks(): FeatureCollection {
    return { type: 'FeatureCollection', features: allTracks.filter(f => f.properties!.id === selectedId || f.properties!.id === hoveredId) };
}

/** Replace the track and head geometry, e.g. when the observation period changes. */
export function setGliderTracks(map: any, gliders: GliderDeployment[], clips: Record<string, GliderClip> | null) {
    const { tracks, heads } = buildGeoJSON(gliders, clips);
    allTracks = tracks.features;
    map.getSource(SOURCE_TRACKS)?.setData(focusedTracks());
    map.getSource(SOURCE_HEADS)?.setData(heads);
}

/**
 * Add (or refresh) the glider track and head layers. Clicking either selects
 * that deployment through `onClick`; returns a detach function.
 */
export async function addGliderLayer(
    map: any,
    gliders: GliderDeployment[],
    clips: Record<string, GliderClip> | null,
    onClick: (id: string) => void,
): Promise<() => void> {
    await Promise.all([
        loadImage(map, IMG.live, makeMarkerSvg(TRIANGLE, true), 32),
        loadImage(map, IMG.historic, makeMarkerSvg(TRIANGLE, false), 32),
        loadImage(map, IMG.argoLive, makeMarkerSvg(CAPSULE, true), 32),
        loadImage(map, IMG.argoHistoric, makeMarkerSvg(CAPSULE, false), 32),
    ]);
    const { tracks, heads } = buildGeoJSON(gliders, clips);
    allTracks = tracks.features;

    if (map.getSource(SOURCE_TRACKS)) {
        map.getSource(SOURCE_TRACKS).setData(focusedTracks());
        map.getSource(SOURCE_HEADS).setData(heads);
    } else {
        map.addSource(SOURCE_TRACKS, { type: 'geojson', data: focusedTracks() });
        map.addSource(SOURCE_HEADS, { type: 'geojson', data: heads });
        map.addSource(SOURCE_RANGE, { type: 'geojson', data: EMPTY });
        // Below the sensor markers when they exist, so a mooring on a track stays clickable.
        const before = map.getLayer('stations-selected') ? 'stations-selected' : undefined;
        map.addLayer({
            id: LAYER_TRACK_CASING, type: 'line', source: SOURCE_TRACKS,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': 'rgba(0,0,0,0.6)', 'line-width': 4.5, 'line-opacity': 1 },
        }, before);
        map.addLayer({
            id: LAYER_TRACK, type: 'line', source: SOURCE_TRACKS,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': ['case', ['get', 'active'], chart.sensor, MUTED],
                'line-width': 2,
                'line-opacity': 1,
            },
        }, before);
        map.addLayer({
            id: LAYER_TRACK_HOVER, type: 'line', source: SOURCE_TRACKS, filter: NONE,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': ACCENT, 'line-width': 3 },
        }, before);
        map.addLayer({
            id: LAYER_TRACK_SELECTED, type: 'line', source: SOURCE_TRACKS, filter: NONE,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': ACCENT, 'line-width': 3, 'line-opacity': SELECTED_OPACITY },
        }, before);
        map.addLayer({
            id: LAYER_TRACK_RANGE, type: 'line', source: SOURCE_RANGE,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': ACCENT, 'line-width': 4.5 },
        }, before);
        map.addLayer({
            id: LAYER_HEAD, type: 'symbol', source: SOURCE_HEADS,
            layout: {
                'icon-image': ['case', ['==', ['get', 'kind'], 'argo'],
                    ['case', ['get', 'active'], IMG.argoLive, IMG.argoHistoric],
                    ['case', ['get', 'active'], IMG.live, IMG.historic]],
                'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.85, 10, 1, 14, 1.25],
                'icon-allow-overlap': true,
            },
        }, before);
    }

    const handler = (evt: any) => {
        const id = evt.features?.[0]?.properties?.id;
        if (id) onClick(id);
    };
    const enter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const leave = () => { map.getCanvas().style.cursor = ''; };
    // Hovering a marker previews its track.
    const headMove = (evt: any) => {
        const id = evt.features?.[0]?.properties?.id ?? null;
        if (id !== hoveredId) setHoveredGlider(map, id);
    };
    const headLeave = () => setHoveredGlider(map, null);
    for (const layer of GLIDER_CLICK_LAYERS) {
        map.on('click', layer, handler);
        map.on('mouseenter', layer, enter);
        map.on('mouseleave', layer, leave);
    }
    map.on('mousemove', LAYER_HEAD, headMove);
    map.on('mouseleave', LAYER_HEAD, headLeave);
    return () => {
        for (const layer of GLIDER_CLICK_LAYERS) {
            try {
                map.off('click', layer, handler);
                map.off('mouseenter', layer, enter);
                map.off('mouseleave', layer, leave);
            } catch (e) { }
        }
        try {
            map.off('mousemove', LAYER_HEAD, headMove);
            map.off('mouseleave', LAYER_HEAD, headLeave);
        } catch (e) { }
    };
}

function applyOpacity(map: any) {
    const focus = hoveredId ?? selectedId;
    const trackOpacity = focus ? ['case', ['==', ['get', 'id'], focus], 1, HOVER_OTHERS_OPACITY] : 1;
    map.setPaintProperty(LAYER_TRACK_CASING, 'line-opacity', trackOpacity);
    map.setPaintProperty(LAYER_TRACK, 'line-opacity', trackOpacity);
    const hoveringOther = hoveredId && hoveredId !== selectedId;
    map.setPaintProperty(LAYER_TRACK_SELECTED, 'line-opacity', hoveringOther ? HOVER_OTHERS_OPACITY : selectedBaseOpacity);
    map.setPaintProperty(LAYER_TRACK_RANGE, 'line-opacity', hoveringOther ? HOVER_OTHERS_OPACITY : 1);
}

/** Draw the selected deployment's track (or clear with null). */
export function setSelectedGlider(map: any, id: string | null) {
    if (!map?.getLayer(LAYER_TRACK_SELECTED)) return;
    selectedId = id;
    map.getSource(SOURCE_TRACKS).setData(focusedTracks());
    map.setFilter(LAYER_TRACK_SELECTED, id ? ['==', ['get', 'id'], id] : NONE);
    applyOpacity(map);
}

/** Draw and glow the hovered deployment's track, fading the selected one (or restore with null). */
export function setHoveredGlider(map: any, id: string | null) {
    if (!map?.getLayer(LAYER_TRACK_HOVER)) return;
    hoveredId = id;
    map.getSource(SOURCE_TRACKS).setData(focusedTracks());
    map.setFilter(LAYER_TRACK_HOVER, id ? ['==', ['get', 'id'], id] : NONE);
    applyOpacity(map);
}

/**
 * Highlight the stretch of the selected track its section is zoomed to, and dim
 * the rest of it; null restores the whole track.
 */
export function setGliderRangeTrack(map: any, coords: [number, number][] | null) {
    const src = map?.getSource(SOURCE_RANGE);
    if (!src) return;
    src.setData(coords && coords.length > 1
        ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }
        : EMPTY);
    selectedBaseOpacity = coords ? SELECTED_DIMMED_OPACITY : SELECTED_OPACITY;
    applyOpacity(map);
}
