import type { FeatureCollection } from 'geojson';
import { chart } from '@/config/palette';
import type { GliderDeployment } from '@/stores/main';

// C-PROOF glider deployments: a track line per deployment plus a marker at its
// latest fix. Sensor blue like every other observation; a triangle (fixed
// sensors are squares, profilers diamonds) with the same green live dot.
const INK = '#d4d9de';
const GROUND = '#13161a';
const LIVE = '#5cc28a';
const MUTED = '#7d868f';
const ACCENT = '#e2a336';

const SOURCE_TRACKS = 'glider-tracks';
const SOURCE_HEADS = 'glider-heads';
const LAYER_TRACK_CASING = 'glider-track-casing';
const LAYER_TRACK = 'glider-track';
const LAYER_TRACK_SELECTED = 'glider-track-selected';
const LAYER_TRACK_HOVER = 'glider-track-hover';
const LAYER_HEAD = 'glider-head';
export const GLIDER_CLICK_LAYERS = [LAYER_TRACK, LAYER_HEAD];
/** Bottom-most glider layer, for slotting the depth curtain under the tracks. */
export const GLIDER_BASE_LAYER = LAYER_TRACK_CASING;
const GLIDER_LAYER_IDS = [LAYER_TRACK_CASING, LAYER_TRACK, LAYER_TRACK_SELECTED, LAYER_TRACK_HOVER, LAYER_HEAD];

const IMG = { live: 'glider-live', historic: 'glider-historic' } as const;
const NONE = ['==', ['get', 'id'], '__none__'];

function makeTriangleSvg(live: boolean) {
    const pts = '16,5 27,25 5,25';
    const halo = `<polygon points="${pts}" fill="none" stroke="rgba(0,0,0,0.7)" stroke-width="4" stroke-linejoin="round"/>`;
    const body = `<polygon points="${pts}" fill="${live ? chart.sensor : MUTED}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>`;
    const dot = live ? `<circle cx="16" cy="19" r="4" fill="${LIVE}" stroke="${GROUND}" stroke-width="2"/>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${halo}${body}${dot}</svg>`;
}

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

function buildGeoJSON(gliders: GliderDeployment[]): { tracks: FeatureCollection, heads: FeatureCollection } {
    return {
        tracks: {
            type: 'FeatureCollection',
            features: gliders.filter(g => g.track.length > 1).map(g => ({
                type: 'Feature',
                properties: { id: g.id, active: g.active },
                geometry: { type: 'LineString', coordinates: g.track.map(p => [p[0], p[1]]) },
            })),
        },
        heads: {
            type: 'FeatureCollection',
            features: gliders.filter(g => g.track.length).map(g => {
                const last = g.track[g.track.length - 1]!;
                return {
                    type: 'Feature',
                    properties: { id: g.id, active: g.active },
                    geometry: { type: 'Point', coordinates: [last[0], last[1]] },
                };
            }),
        },
    };
}

/**
 * Add (or refresh) the glider track and head layers. Clicking either selects
 * that deployment through `onClick`; returns a detach function.
 */
export async function addGliderLayer(
    map: any,
    gliders: GliderDeployment[],
    onClick: (id: string) => void,
): Promise<() => void> {
    await Promise.all([
        loadImage(map, IMG.live, makeTriangleSvg(true), 32),
        loadImage(map, IMG.historic, makeTriangleSvg(false), 32),
    ]);
    const { tracks, heads } = buildGeoJSON(gliders);

    if (map.getSource(SOURCE_TRACKS)) {
        map.getSource(SOURCE_TRACKS).setData(tracks);
        map.getSource(SOURCE_HEADS).setData(heads);
    } else {
        map.addSource(SOURCE_TRACKS, { type: 'geojson', data: tracks });
        map.addSource(SOURCE_HEADS, { type: 'geojson', data: heads });
        // Below the sensor markers when they exist, so a mooring on a track stays clickable.
        const before = map.getLayer('stations-selected') ? 'stations-selected' : undefined;
        map.addLayer({
            id: LAYER_TRACK_CASING, type: 'line', source: SOURCE_TRACKS,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': 'rgba(0,0,0,0.6)', 'line-width': 4.5 },
        }, before);
        map.addLayer({
            id: LAYER_TRACK, type: 'line', source: SOURCE_TRACKS,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': ['case', ['get', 'active'], chart.sensor, MUTED],
                'line-width': 2,
            },
        }, before);
        map.addLayer({
            id: LAYER_TRACK_HOVER, type: 'line', source: SOURCE_TRACKS, filter: NONE,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': chart.sensor, 'line-width': 9, 'line-opacity': 0.45, 'line-blur': 4 },
        }, before);
        map.addLayer({
            id: LAYER_TRACK_SELECTED, type: 'line', source: SOURCE_TRACKS, filter: NONE,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': ACCENT, 'line-width': 3 },
        }, before);
        map.addLayer({
            id: LAYER_HEAD, type: 'symbol', source: SOURCE_HEADS,
            layout: {
                'icon-image': ['case', ['get', 'active'], IMG.live, IMG.historic],
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
    for (const layer of GLIDER_CLICK_LAYERS) {
        map.on('click', layer, handler);
        map.on('mouseenter', layer, enter);
        map.on('mouseleave', layer, leave);
    }
    return () => {
        for (const layer of GLIDER_CLICK_LAYERS) {
            try {
                map.off('click', layer, handler);
                map.off('mouseenter', layer, enter);
                map.off('mouseleave', layer, leave);
            } catch (e) { }
        }
    };
}

export function setGliderLayerVisibility(map: any, visible: boolean) {
    for (const id of GLIDER_LAYER_IDS) {
        try { if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none'); } catch (e) { }
    }
}

/** Highlight the selected deployment's track (or clear with null). */
export function setSelectedGlider(map: any, id: string | null) {
    if (map?.getLayer(LAYER_TRACK_SELECTED)) map.setFilter(LAYER_TRACK_SELECTED, id ? ['==', ['get', 'id'], id] : NONE);
}

/** Glow the hovered deployment's track (or clear with null). */
export function setHoveredGlider(map: any, id: string | null) {
    if (map?.getLayer(LAYER_TRACK_HOVER)) map.setFilter(LAYER_TRACK_HOVER, id ? ['==', ['get', 'id'], id] : NONE);
}
