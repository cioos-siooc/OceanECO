/**
 * The base map's own styling, independent of the app's data layers: basemap
 * paint and satellite imagery, the style's label groups, and the bathymetry
 * contour lines. Every function takes the map and is a no-op without one.
 */
import type mapboxgl from 'mapbox-gl';
import { BASEMAP_PAINT, BASEMAP_FILLS, BASEMAP_HIDDEN_SOURCE_LAYERS } from '@/config/app';

// Recolour the basemap's fills to the app's surfaces (see BASEMAP_PAINT) and
// hide the layers it doesn't need (BASEMAP_HIDDEN_SOURCE_LAYERS).
export function applyBasemapPaint(map: mapboxgl.Map | null) {
    if (!map) return;
    for (const layer of map.getStyle().layers) {
        if (BASEMAP_HIDDEN_SOURCE_LAYERS.includes(layer['source-layer'])) {
            map.setLayoutProperty(layer.id, 'visibility', 'none');
        }
    }
    for (const [id, paint] of Object.entries(BASEMAP_PAINT)) {
        if (!map.getLayer(id)) continue;
        for (const [prop, value] of Object.entries(paint)) {
            try { map.setPaintProperty(id, prop, value); } catch { /* layer type mismatch */ }
        }
    }
}

// Satellite imagery in place of the basemap fills, always under the model
// raster: the raster may be added before or after this, so it's re-ordered on
// every toggle. Added once at load; Mapbox fetches no tiles while it's hidden.
export function addSatelliteLayer(map: mapboxgl.Map | null) {
    if (!map || map.getLayer('satellite')) return;
    map.addSource('satellite', { type: 'raster', url: 'mapbox://mapbox.satellite', tileSize: 512 });
    map.addLayer({
        id: 'satellite', type: 'raster', source: 'satellite',
        paint: { 'raster-saturation': -0.3, 'raster-brightness-max': 0.8 },
        layout: { visibility: 'none' },
    }, 'country-boundaries');
}

export function setSatelliteVisibility(map: mapboxgl.Map | null, visible: boolean) {
    if (!map?.getLayer('satellite')) return;
    map.moveLayer('satellite', map.getLayer('png-image-layer') ? 'png-image-layer' : 'country-boundaries');
    map.setLayoutProperty('satellite', 'visibility', visible ? 'visible' : 'none');
    for (const id of BASEMAP_FILLS) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'none' : 'visible');
    }
}

// Cached id of the style's built-in water-name-labels layer (added directly
// in Mapbox Studio, e.g. "Puget Sound", "Strait of Georgia" — not something
// this app adds itself). Studio slugifies a layer's display name into its
// id, so resolve by fuzzy match rather than hardcoding a guess at the id.
let waterNamesLayerId: string | null = null;
let warnedMissingWaterNamesLayer = false;

function resolveWaterNamesLayer(map: mapboxgl.Map | null): string | null {
    if (!map) return null;
    if (waterNamesLayerId && map.getLayer(waterNamesLayerId)) return waterNamesLayerId;
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const layers = map.getStyle()?.layers ?? [];
    const match = layers.find((l: { id: string }) => normalize(l.id) === normalize('water names'));
    waterNamesLayerId = match ? match.id : null;
    if (!waterNamesLayerId && !warnedMissingWaterNamesLayer) {
        warnedMissingWaterNamesLayer = true;
        console.warn('Could not find a "water names" layer in the map style; labels will not be forced on top.');
    }
    return waterNamesLayerId;
}

// Re-raise the water-name labels to the very top of the style's layer stack.
// Bound to the map's 'idle' event so every current and future layer-adding
// function on the page stays below it without each needing to know this
// layer exists. Skips the move when already topmost so it can't loop.
export function raiseWaterNamesLayer(map: mapboxgl.Map | null) {
    if (!map) return;
    const layerId = resolveWaterNamesLayer(map);
    if (!layerId) return;
    try {
        const layers = map.getStyle()?.layers;
        if (!layers || !layers.length) return;
        if (layers[layers.length - 1].id !== layerId) {
            map.moveLayer(layerId);
        }
    } catch { /* map may be mid-teardown */ }
}

// Base style's "Place labels" group (settlement/state/country/continent
// names) — a fixed, standard set of Mapbox Streets layer ids, unlike the
// water-names layer which is custom and has to be resolved by name.
const PLACE_LABEL_LAYER_IDS = [
    'settlement-subdivision-label',
    'settlement-minor-label',
    'settlement-major-label',
    'state-label',
    'country-label',
    'continent-label',
];

// Drives the "Map Labels" overlay button: shows/hides the water-name labels
// together with the place-name labels as one group.
export function setMapLabelsVisibility(map: mapboxgl.Map | null, visible: boolean) {
    if (!map) return;
    const visibility = visible ? 'visible' : 'none';
    const waterLayerId = resolveWaterNamesLayer(map);
    const targetIds = waterLayerId ? [waterLayerId, ...PLACE_LABEL_LAYER_IDS] : PLACE_LABEL_LAYER_IDS;
    for (const id of targetIds) {
        try {
            if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
        } catch { /* layer not present in this style version */ }
    }
}

export function applyBathymetryContours(map: mapboxgl.Map | null, show: boolean, apiBaseUrl: string) {
    if (!map) return;
    try {
        if (show) {
            if (!map.getSource('nonna'))
                map?.addSource('nonna', {
                    type: 'vector',
                    tiles: [`${apiBaseUrl}/vector/{z}/{x}/{y}.pbf`],
                });

            // Contour lines
            map?.addLayer({
                id: 'nonna-layer',
                type: 'line',
                source: 'nonna',
                'source-layer': 'nonna', // name of the layer in the vector tile source
                filter: [
                    "step",
                    ["zoom"],
                    [
                        "case",
                        ["==", ["%", ["to-number", ["get", "ELEV"]], 100], 0],
                        true,
                        false
                    ],
                    8,
                    [
                        "case",
                        ["==", ["%", ["to-number", ["get", "ELEV"]], 50], 0],
                        true,
                        false
                    ],
                    12,
                    true
                ],
                paint: {
                    "line-color": "#999",
                    "line-width": 1,
                    // "line-opacity": [
                    //     "step",
                    //     ["zoom"],
                    //     [
                    //         "case",
                    //         ["==", ["%", ["to-number", ["get", "ELEV"]], 100], 0],
                    //         1,
                    //         0
                    //     ],
                    //     8,
                    //     [
                    //         "case",
                    //         ["==", ["%", ["to-number", ["get", "ELEV"]], 50], 0],
                    //         1,
                    //         0
                    //     ],
                    //     12,
                    //     1
                    // ]
                }
            });

            // Labels for every 100m contour
            map?.addLayer({
                id: 'nonna-labels',
                type: 'symbol',
                source: 'nonna',
                'source-layer': 'nonna',
                // filter: ["==", ["%", ["to-number", ["get", "ELEV"]], 100], 0],
                filter: [
                    "step",
                    ["zoom"],
                    [
                        "case",
                        ["==", ["%", ["to-number", ["get", "ELEV"]], 100], 0],
                        true,
                        false
                    ],
                    8,
                    [
                        "case",
                        ["==", ["%", ["to-number", ["get", "ELEV"]], 50], 0],
                        true,
                        false
                    ],
                    12,
                    true
                ],
                layout: {
                    "symbol-placement": "line",
                    "text-field": ["to-string", ["get", "ELEV"]],
                    // "text-font": ["Inter Regular"],
                    "text-size": 12,
                    "text-allow-overlap": true,
                    // "symbol-spacing": 250
                },
                paint: {
                    "text-color": "#ccc",
                    "text-halo-color": "#333",
                    "text-halo-width": 1,
                    "text-halo-blur": 1
                }
            });

        } else {
            if (map.getLayer('nonna-layer')) map.removeLayer('nonna-layer');
            if (map.getLayer('nonna-labels')) map.removeLayer('nonna-labels');
            if (map.getSource('nonna')) map.removeSource('nonna');
        }
    } catch (e) {
        console.warn('Failed to toggle bathymetry contours layer visibility:', e);
    }
}
