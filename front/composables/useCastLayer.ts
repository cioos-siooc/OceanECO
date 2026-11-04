import type { FeatureCollection, Point } from 'geojson';
import type mapboxgl from 'mapbox-gl';
import { chart } from '@/config/palette';
import type { ShipCast } from '@/stores/main';

// DFO IOS ship casts: one dot per cast, sensor blue like every observation.
// A CTD cast is a filled dot, a bottle cast a ring (discrete samples). A year
// of casts runs to a couple of thousand points, often repeated at the same
// stations, so they cluster below CLUSTER_MAX_ZOOM; a cluster click zooms in.
const INK = '#d4d9de';
const ACCENT = '#e2a336';

const SOURCE = 'ship-casts';
const LAYER_CLUSTER = 'ship-casts-cluster';
const LAYER_CLUSTER_COUNT = 'ship-casts-cluster-count';
const LAYER_POINT = 'ship-casts-point';
const LAYER_SELECTED = 'ship-casts-selected';
export const CAST_CLICK_LAYERS = [LAYER_CLUSTER, LAYER_POINT];
const CAST_LAYER_IDS = [LAYER_CLUSTER, LAYER_CLUSTER_COUNT, LAYER_SELECTED, LAYER_POINT];
const CLUSTER_MAX_ZOOM = 9;
const NONE = ['==', ['get', 'id'], '__none__'];

function toGeoJSON(casts: ShipCast[]): FeatureCollection {
    return {
        type: 'FeatureCollection',
        features: casts.map(c => ({
            type: 'Feature',
            properties: { id: c.id, kind: c.kind },
            geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        })),
    };
}

/**
 * Add the cast layers, or replace their points. Clicking a cast selects it
 * through `onClick`; clicking a cluster zooms to where it splits. Returns a
 * detach function for the listeners (only attached on first add).
 */
export function addCastLayer(map: mapboxgl.Map, casts: ShipCast[], onClick: (id: string) => void): (() => void) | null {
    const data = toGeoJSON(casts);
    const existing = map.getSource(SOURCE) as mapboxgl.GeoJSONSource | undefined;
    if (existing) {
        existing.setData(data);
        return null;
    }
    map.addSource(SOURCE, {
        type: 'geojson', data,
        cluster: true, clusterMaxZoom: CLUSTER_MAX_ZOOM, clusterRadius: 28,
    });
    // Under the sensor markers when they exist, so a mooring beside a station stays clickable.
    const before = map.getLayer('stations-selected') ? 'stations-selected' : undefined;
    map.addLayer({
        id: LAYER_CLUSTER, type: 'circle', source: SOURCE, filter: ['has', 'point_count'],
        paint: {
            'circle-color': chart.sensor,
            'circle-opacity': 0.25,
            'circle-stroke-color': chart.sensor,
            'circle-stroke-width': 1.5,
            'circle-radius': ['step', ['get', 'point_count'], 9, 20, 12, 100, 16, 500, 20],
        },
    }, before);
    map.addLayer({
        id: LAYER_CLUSTER_COUNT, type: 'symbol', source: SOURCE, filter: ['has', 'point_count'],
        layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-size': 10,
            'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
            'text-allow-overlap': true,
        },
        paint: { 'text-color': INK },
    }, before);
    map.addLayer({
        id: LAYER_SELECTED, type: 'circle', source: SOURCE, filter: NONE,
        paint: { 'circle-radius': 8, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': ACCENT, 'circle-stroke-width': 2.5 },
    }, before);
    map.addLayer({
        id: LAYER_POINT, type: 'circle', source: SOURCE, filter: ['!', ['has', 'point_count']],
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3, 12, 5],
            'circle-color': ['case', ['==', ['get', 'kind'], 'bottle'], 'rgba(0,0,0,0)', chart.sensor],
            'circle-stroke-color': ['case', ['==', ['get', 'kind'], 'bottle'], chart.sensor, 'rgba(0,0,0,0.7)'],
            'circle-stroke-width': ['case', ['==', ['get', 'kind'], 'bottle'], 1.8, 1],
        },
    }, before);

    const onPoint = (evt: mapboxgl.MapLayerMouseEvent) => {
        const id = evt.features?.[0]?.properties?.id;
        if (id) onClick(id);
    };
    const onCluster = (evt: mapboxgl.MapLayerMouseEvent) => {
        const f = evt.features?.[0];
        if (!f) return;
        const center = (f.geometry as Point).coordinates as [number, number];
        (map.getSource(SOURCE) as mapboxgl.GeoJSONSource).getClusterExpansionZoom(f.properties?.cluster_id, (err, zoom) => {
            if (!err && zoom != null) map.easeTo({ center, zoom });
        });
    };
    const enter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const leave = () => { map.getCanvas().style.cursor = ''; };
    map.on('click', LAYER_POINT, onPoint);
    map.on('click', LAYER_CLUSTER, onCluster);
    for (const layer of CAST_CLICK_LAYERS) {
        map.on('mouseenter', layer, enter);
        map.on('mouseleave', layer, leave);
    }
    return () => {
        try {
            map.off('click', LAYER_POINT, onPoint);
            map.off('click', LAYER_CLUSTER, onCluster);
            for (const layer of CAST_CLICK_LAYERS) {
                map.off('mouseenter', layer, enter);
                map.off('mouseleave', layer, leave);
            }
        } catch { /* map already removed */ }
    };
}

export function setCastLayerVisibility(map: mapboxgl.Map | null, visible: boolean) {
    for (const id of CAST_LAYER_IDS) {
        try { if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none'); } catch { /* style reloading */ }
    }
}

/** Ring the selected cast (or clear with null). Clustered casts show no ring until zoomed in. */
export function setSelectedCast(map: mapboxgl.Map | null, id: string | null) {
    if (map?.getLayer(LAYER_SELECTED)) {
        map.setFilter(LAYER_SELECTED, id ? ['all', ['!', ['has', 'point_count']], ['==', ['get', 'id'], id]] : NONE);
    }
}
