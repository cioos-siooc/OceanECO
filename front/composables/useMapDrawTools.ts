/**
 * The map's drawing tools: the analysis box around the clicked point (area
 * query mode), the Cross-Section tab's line (mapbox-gl-draw, with numbered
 * vertices), and the Area tab's circle with its 3D box. Each is shown only on
 * its tab and writes what is drawn to the store.
 */
import type mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import { computed, watch } from 'vue';
import { useMainStore } from '~/stores/main';
import { useObsAreaLayer } from './useObsAreaLayer';
import { setAreaVolume, cameraForAreaVolume } from './useGliderCurtain';
import { GLIDER_BASE_LAYER } from './useGliderLayer';
import { GLIDER_TILT_PITCH } from './useGliderMap';
import { hexToRgb } from './useFieldColorRamp';
import { chart } from '@/config/palette';

export function useMapDrawTools(
    getMap: () => mapboxgl.Map | null,
    triggerMapClick: (lat: number, lng: number) => void,
    isMapLoaded: () => boolean,
) {
    const mainStore = useMainStore();
    const activeTab = computed(() => mainStore.activeBottomTab);
    const lastClicked = computed(() => mainStore.lastClickedMapPoint);
    let crossSectionDraw: MapboxDraw | null = null;

    // --- ANALYSIS REGION BOX ---
    const ABOX_SOURCE = 'analysis-region'
    const ABOX_FILL = 'analysis-region-fill'
    const ABOX_LINE = 'analysis-region-line'

    function updateAnalysisBox() {
        const map = getMap();
        if (!map || !map.isStyleLoaded()) return
        const pt = lastClicked.value
        const show = mainStore.queryMode === 'area' && !!pt

        const data: GeoJSON.Feature<GeoJSON.Polygon> = show
            ? {
                type: 'Feature', properties: {}, geometry: {
                    type: 'Polygon', coordinates: [[
                        [pt!.lng - 0.05, pt!.lat - 0.05],
                        [pt!.lng + 0.05, pt!.lat - 0.05],
                        [pt!.lng + 0.05, pt!.lat + 0.05],
                        [pt!.lng - 0.05, pt!.lat + 0.05],
                        [pt!.lng - 0.05, pt!.lat - 0.05],
                    ]]
                }
            }
            : { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[]] } }

        if (map.getSource(ABOX_SOURCE)) {
            (map.getSource(ABOX_SOURCE) as mapboxgl.GeoJSONSource).setData(data)
            map.setLayoutProperty(ABOX_FILL, 'visibility', show ? 'visible' : 'none')
            map.setLayoutProperty(ABOX_LINE, 'visibility', show ? 'visible' : 'none')
        } else {
            map.addSource(ABOX_SOURCE, { type: 'geojson', data })
            map.addLayer({
                id: ABOX_FILL, type: 'fill', source: ABOX_SOURCE,
                paint: { 'fill-color': 'rgba(255,193,7,0.08)' },
                layout: { visibility: show ? 'visible' : 'none' }
            })
            map.addLayer({
                id: ABOX_LINE, type: 'line', source: ABOX_SOURCE,
                paint: { 'line-color': '#ff5722', 'line-width': 1.5, 'line-dasharray': [4, 2] },
                layout: { visibility: show ? 'visible' : 'none' }
            })
        }
    }

    watch([lastClicked, activeTab], updateAnalysisBox)
    watch(() => mainStore.queryMode, () => {
        updateAnalysisBox()
        if (lastClicked.value) triggerMapClick(lastClicked.value.lat, lastClicked.value.lng)
    })

    // No activeTab watcher any more: panes that were hidden used to miss updates
    // because this page fetched on their behalf and gated on which tab was showing.
    // Each pane now watches the store itself and re-measures when it becomes active.

    // --- CROSS-SECTION LINE DRAWING ---
    // This one *is* an activeTab watcher, unlike the panes above — it isn't data
    // fetching done on a pane's behalf, it's map-control-mode plumbing that has to
    // live here because `crossSectionDraw`/`map` are page-scoped, not reachable
    // from CrossSectionPanel.vue.
    function onCrossSectionDrawChange() {
        const line = crossSectionDraw?.getAll().features
            .find((f) => f.geometry?.type === 'LineString') as GeoJSON.Feature<GeoJSON.LineString> | undefined;
        if (!line) { mainStore.setCrossSectionLine(null); return; }
        // GeoJSON coordinates are [lng, lat]; the store (like lastClickedMapPoint) uses {lat, lng}.
        mainStore.setCrossSectionLine(line.geometry.coordinates.map(([lng, lat]) => ({ lat: lat!, lng: lng! })));
    }

    // mapbox-gl-draw only renders vertex handles while the line is the *active*
    // selection (mid-draw, or selected in simple_select) — once you click away it
    // reverts to a plain line, so there's nothing on the map to tell "dashed line
    // #2 in the chart" apart from "dashed line #3". This numbered overlay stays
    // pinned to the vertices regardless of draw/selection state, matching the
    // 1-based numbering CrossSectionPanel.vue's own vertex markers use.
    const CS_VERTEX_SOURCE = 'cross-section-vertices'
    const CS_VERTEX_CIRCLES = 'cross-section-vertex-circles'
    const CS_VERTEX_LABELS = 'cross-section-vertex-labels'

    function updateCrossSectionVertexLabels() {
        const map = getMap();
        if (!map) return
        const line = mainStore.crossSectionLine
        const data: GeoJSON.FeatureCollection<GeoJSON.Point> = {
            type: 'FeatureCollection',
            features: (line ?? []).map((pt, i) => ({
                type: 'Feature',
                properties: { label: String(i + 1) },
                geometry: { type: 'Point', coordinates: [pt.lng, pt.lat] },
            })),
        }
        const existingSource = map.getSource(CS_VERTEX_SOURCE) as mapboxgl.GeoJSONSource | undefined;
        if (existingSource) {
            // Updating an existing source's data doesn't require the style to be
            // fully loaded — only creating new sources/layers below does. Gating
            // this on isStyleLoaded() left stale vertex markers on the map when a
            // tab switch fired mid-style-update (e.g. right after deleteAll()).
            existingSource.setData(data)
        } else if (map.isStyleLoaded()) {
            map.addSource(CS_VERTEX_SOURCE, { type: 'geojson', data })
            map.addLayer({
                id: CS_VERTEX_CIRCLES, type: 'circle', source: CS_VERTEX_SOURCE,
                paint: {
                    'circle-radius': 8, 'circle-color': '#12181f',
                    'circle-stroke-width': 1.5, 'circle-stroke-color': '#eef3f7',
                },
            })
            map.addLayer({
                id: CS_VERTEX_LABELS, type: 'symbol', source: CS_VERTEX_SOURCE,
                layout: {
                    'text-field': ['get', 'label'], 'text-size': 10, 'text-font': ['Open Sans Bold'],
                    'text-allow-overlap': true, 'text-ignore-placement': true,
                },
                paint: { 'text-color': '#eef3f7' },
            })
        }
    }

    watch(() => mainStore.crossSectionLine, updateCrossSectionVertexLabels, { deep: true })

    watch(activeTab, (tab) => {
        const map = getMap();
        if (!crossSectionDraw) return;
        crossSectionDraw.deleteAll();
        mainStore.setCrossSectionLine(null);
        crossSectionDraw.changeMode(tab === 'crossSection' ? 'draw_line_string' : 'simple_select');

        // The point-click marker and the cross-section line/vertices are mutually
        // exclusive map decorations — only one mode's input should be visible at a time.
        if (tab === 'crossSection' || tab === 'area') {
            try { if ((map as any).__clickMarker) ((map as any).__clickMarker).remove(); } catch (e) { }
        } else if (lastClicked.value) {
            triggerMapClick(lastClicked.value.lat, lastClicked.value.lng);
        }
    });

    // A finished line leaves mapbox-gl-draw in simple_select mode (its own
    // draw_line_string mode exits there once you click back on the last vertex or
    // press Enter) — clicking the map again would just select/drag the existing
    // line, not start a new one. CrossSectionPanel's "New line" button bumps this
    // token to re-arm drawing without waiting for a tab round-trip.
    watch(() => mainStore.crossSectionRedrawToken, () => {
        if (!crossSectionDraw) return;
        crossSectionDraw.deleteAll();
        crossSectionDraw.changeMode('draw_line_string');
    });

    // --- AREA TAB CIRCLE ---
    // Shown only on the Area tab; drawing is armed on entering it with no circle
    // yet, and by AreaPanel's "Redraw" (obsAreaDrawToken).
    let areaLayer: ReturnType<typeof useObsAreaLayer> | null = null;
    const AREA_DEFAULT_DEPTH: [number, number] = [0, 20];

    function syncAreaLayer() {
        if (!areaLayer) return;
        const onTab = activeTab.value === 'area';
        // Only arms or disarms on its own when there's no circle or no tab: a
        // depth change mid-redraw must not cancel the redraw.
        if (!onTab) areaLayer.arm(false);
        else if (!mainStore.obsArea) areaLayer.arm(true);
        areaLayer.render(onTab ? mainStore.obsArea : null);
    }
    watch([activeTab, () => mainStore.obsArea], syncAreaLayer);
    watch(() => mainStore.obsAreaDrawToken, () => {
        if (activeTab.value === 'area') areaLayer?.arm(true);
    });

    // The box in 3D under the circle, seen when the map is tilted
    // (useGliderCurtain.ts): a cylinder over the depth range, with the loaded
    // observations (mainStore.obsAreaMarkers) as dots at their depths.
    const AREA_RGB = hexToRgb(chart.model);
    function updateAreaVolume() {
        const map = getMap();
        const a = mainStore.obsArea;
        if (!map || activeTab.value !== 'area' || !a) {
            setAreaVolume(map, null);
            return;
        }
        setAreaVolume(map, {
            ...a,
            rgb: AREA_RGB,
            markers: mainStore.obsAreaMarkers.map(m => ({ ...m, rgb: hexToRgb(m.color) })),
        }, GLIDER_BASE_LAYER);
    }
    watch([activeTab, () => mainStore.obsArea, () => mainStore.obsAreaMarkers], updateAreaVolume);

    // AreaPanel's 3D button: tilt onto the box (north up), or flatten.
    watch(() => mainStore.obsAreaTiltToken, () => {
        const map = getMap();
        const a = mainStore.obsArea;
        if (!map || !a) return;
        if (map.getPitch() > 10) {
            map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
            return;
        }
        // Fit the cylinder itself, both rims at their exaggerated depths.
        const cam = cameraForAreaVolume(map, a, GLIDER_TILT_PITCH);
        map.easeTo({ ...cam, bearing: 0, pitch: GLIDER_TILT_PITCH, duration: 1200 });
    });

    /**
     * Put a shared cross-section line back on the map. `mainStore.crossSectionLine`
     * alone only feeds the panel's fetch — the line itself lives in
     * mapbox-gl-draw's own store, which starts empty on a fresh load, so the
     * geometry has to be handed back to it explicitly.
     */
    let crossSectionRestored = false;
    function restoreSharedCrossSection() {
        if (!crossSectionDraw || crossSectionRestored) return;
        const line = mainStore.crossSectionLine;
        if (line?.length) {
            crossSectionRestored = true;
            crossSectionDraw.add({
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: line.map(p => [p.lng, p.lat]) },
            } as GeoJSON.Feature<GeoJSON.LineString>);
            updateCrossSectionVertexLabels();
        } else if (!mainStore.shareRestorePending) {
            // No line to put back (and none still arriving). Arm drawing if the
            // app opened straight into this tab — the activeTab watcher only fires
            // on a *change* of tab, so a shared link that lands here never triggers it.
            crossSectionRestored = true;
            if (activeTab.value === 'crossSection') crossSectionDraw.changeMode('draw_line_string');
        }
    }
    // The payload finishes decoding after the map is built, so the line can arrive
    // later than `map.on('load')` — retry once it does (the flag above makes this
    // idempotent, and leaves the user's own subsequent drawing alone).
    watch([() => mainStore.shareRestorePending, () => mainStore.crossSectionLine], () => {
        if (isMapLoaded() || getMap()) restoreSharedCrossSection();
    });

    /** Adds the drawing control and the Area circle once the map's style has loaded. */
    function attachDrawTools() {
        const map = getMap();
        updateAnalysisBox();

        // Cross-Section tab's line-drawing control. Added once and left on the
        // map permanently (mode is toggled by the activeTab watcher below)
        // rather than added/removed per tab switch — mapbox-gl-draw's own
        // draw_line_string mode already handles double-click-zoom
        // suspension and Enter/Escape-to-finish, so there's nothing else to
        // hand-roll here.
        crossSectionDraw = new MapboxDraw({ displayControlsDefault: false, controls: {} });
        map?.addControl(crossSectionDraw);
        map?.on('draw.create', onCrossSectionDrawChange);
        map?.on('draw.update', onCrossSectionDrawChange);
        map?.on('draw.delete', () => mainStore.setCrossSectionLine(null));

        if (map) {
            areaLayer = useObsAreaLayer(map, (c) => mainStore.setObsArea({
                ...c,
                depthMin: mainStore.obsArea?.depthMin ?? AREA_DEFAULT_DEPTH[0],
                depthMax: mainStore.obsArea?.depthMax ?? AREA_DEFAULT_DEPTH[1],
            }));
            syncAreaLayer();
            updateAreaVolume();
        }
        // A shared line (or a link opened straight into Cross-Section) may already be in the store.
        restoreSharedCrossSection();
    }

    /** Removes the analysis box's layers. */
    function detachDrawTools() {
        const map = getMap();
        if (!map) return;
        try { if (map.getLayer(ABOX_FILL)) map.removeLayer(ABOX_FILL); } catch (e) { }
        try { if (map.getLayer(ABOX_LINE)) map.removeLayer(ABOX_LINE); } catch (e) { }
        try { if (map.getSource(ABOX_SOURCE)) map.removeSource(ABOX_SOURCE); } catch (e) { }
    }

    return { attachDrawTools, detachDrawTools };
}
