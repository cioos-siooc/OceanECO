<template>
  <main class="grow min-h-0">
    <BetaDisclaimerDialog />
    <!-- <div class="flex flex-col h-screen overflow-hidden"> -->
    <!-- Top: Map -->
    <div
      ref="mapContainer"
      class="grow"
      :style="{ position: 'relative', height: `calc(100% - ${footerHeight})`, '--nav-ctrl-right': (drawerOpen ? 300 : 0) + 'px' }"
    >
      <MapOverlays
        class="overlay"
        :style="{
          top: `${overlayGap}px`,
          left:
            (mainStore.isControlPanelOpen
              ? mainStore.controlPanel_width + overlayGap
              : overlayGap) + 'px',
        }"
        @autorange="autorange"
      />

      <ColorbarSettings
        v-if="showColorbarSettings"
        class="overlay"
        :style="{
          left:
            (mainStore.isControlPanelOpen
              ? mainStore.controlPanel_width + overlayGap + 200
              : overlayGap + 200) + 'px',
          transition: 'left 0.3s ease',
        }"
      />

      <selectedInfo
        class="overlay"
        :style="{
          bottom: `${overlayGap}px`,
          left:
            (mainStore.isControlPanelOpen
              ? mainStore.controlPanel_width + overlayGap
              : overlayGap) + 'px',
        }"
      />

      <controlPanel />

      <!-- <div class="map-drawer-toggle" :style="{ right: drawerOpen ? '312px' : '12px' }">
                <UButton color="warning" class="size-[24px] p-0 justify-center m-0 p-0" @click="drawerOpen = !drawerOpen" title="Vertical Profile">
                    <UIcon name="i-mdi-chart-line" class="size-[20px]" />
                </UButton>
            </div> -->

      <SelectedVariableDrawer
        v-model="drawerOpen"
        :selected-point="lastClicked"
        :footer-height="footerHeight"
      />

      <!-- Query mode toggle -->
      <!-- <div style="position: absolute; top: 10px; right: 10px; z-index: 10">
        <SegmentedControl
          :model-value="mainStore.queryMode"
          :items="queryModeItems"
          size="sm"
          aria-label="Map query mode"
          @update:model-value="(v) => mainStore.setQueryMode(v as string)"
        />
      </div> -->

      <!-- Multi-sensor location picker (exact same coordinate) -->
      <SensorPickerPopover
        :visible="sensorPicker.visible"
        :x="sensorPicker.x"
        :y="sensorPicker.y"
        :sensors="sensorPicker.sensors"
        @pick="(s) => clickSensor(s.id, s.depth)"
        @close="sensorPicker.visible = false"
      />

      <!-- Spiderfy overlay: sensors near each other, or casts stacked on one spot -->
      <div
        v-if="spiderfy.visible"
        style="position: absolute; inset: 0; z-index: 5000; pointer-events: all"
        @click.self="spiderfy.visible = false"
      >
        <svg
          style="
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
          "
        >
          <line
            v-for="(spoke, i) in spiderfy.spokes"
            :key="`sl-${i}`"
            :x1="spiderfy.centerX"
            :y1="spiderfy.centerY"
            :x2="spoke.x"
            :y2="spoke.y"
            :stroke="spoke.line"
            stroke-width="1.5"
          />
          <circle
            :cx="spiderfy.centerX"
            :cy="spiderfy.centerY"
            r="5"
            fill="#aaaaaa"
            stroke="#333"
            stroke-width="1.5"
          />
        </svg>
        <div
          v-for="(spoke, i) in spiderfy.spokes"
          :key="`sn-${i}`"
          class="spiderfy-node"
          :style="{ left: spoke.x + 'px', top: spoke.y + 'px' }"
          @click.stop="spiderfy.visible = false; spoke.pick()"
        >
          <div
            class="spiderfy-dot"
            :style="{ background: spoke.dot, borderColor: spoke.ring }"
          />
          <div class="spiderfy-label">{{ spoke.label }}</div>
        </div>
      </div>

      <!-- Colour legend for the raster layer, bottom-right like the layer
           readout's bottom-left. -->
      <div class="map-legend" :style="{ right: (drawerOpen ? 300 : 0) + overlayGap + 'px', bottom: overlayGap + 'px' }">
        <ColormapBar />
      </div>

      <!-- Cursor readout (coordinates and/or model value), follows the mouse over the map -->
      <div
        v-if="mouseCoords.visible && (mainStore.showCursorCoords || cursorValueText)"
        class="cursor-coord-label"
        :style="{ left: mouseCoords.x + 'px', top: mouseCoords.y + 'px' }"
      >
        <div v-if="cursorValueText" class="cursor-value">{{ cursorValueText }}</div>
        <div v-if="mainStore.showCursorCoords">{{ mouseCoords.lat?.toFixed(5) }}, {{ mouseCoords.lng?.toFixed(5) }}</div>
      </div>
    </div>

    <!-- Bottom: Global Chart Footer -->
    <footer
      class="m-0 p-0 footer-resizable"
      :style="{ height: footerHeight, maxHeight: footerHeight }"
    >
      <!-- Drag handle: resize the bottom sheet by dragging this top edge up/down -->
      <div
        class="footer-resize-handle"
        :class="{ 'is-resizing': isResizingFooter }"
        title="Drag to resize"
        @pointerdown="startFooterResize"
      >
        <div class="footer-resize-grip"/>
      </div>
      <div class="flex footer-content" style="width: 100%">
        <!-- Content area. Both panes stay mounted (like the fullscreen
                     workspaces below) so switching tabs doesn't refetch or reset
                     whatever each pane had already loaded. -->
        <div class="grow" style="min-width: 0; height: 100%; overflow: hidden">
          <!-- Timeseries tab -->
          <!-- The one map-synced pane: the clicked point's data at the
                         map's depth, over a paged window. -->
          <div v-show="activeTab === 'explore'" style="height: 100%">
            <ExplorePanel :active="activeTab === 'explore'" />
          </div>
          <!-- Cross-Section tab: reads a drawn line instead of a clicked
                         point, so it gets its own pane rather than living inside
                         ExplorePanel's point-shaped view. -->
          <div v-show="activeTab === 'crossSection'" style="height: 100%">
            <CrossSectionPanel :active="activeTab === 'crossSection'" />
          </div>
          <!-- Area tab: every visible observation inside a drawn circle. -->
          <div v-show="activeTab === 'area'" style="height: 100%">
            <AreaPanel :active="activeTab === 'area'" />
          </div>
        </div>
        <!-- Model, depth and field controls with every variable at the point;
             permanent and shared by both panes. -->
        <PointSnapshot class="footer-snap" />
      </div>
    </footer>

    <!-- Fullscreen workspaces. Kept mounted so closing and reopening one
             doesn't refetch everything it had already loaded. -->
    <AnalysisWorkspace v-model="analysisOpen" />
    <ComparisonWorkspace v-model="comparisonOpen" />
    <!-- <div class="footer-chart" style="height: 260px; border-top: 1px solid rgba(0,0,0,0.12);">
            <div ref="globalChartContainer" class="w-full h-full"></div>
        </div> -->
    <!-- </div> -->
  </main>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue';
import { useRuntimeConfig } from '#app';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import axios from 'axios'
import moment from 'moment-timezone'
import SelectedVariableDrawer from '../components/SelectedVariableDrawer.vue'
import BetaDisclaimerDialog from '../components/BetaDisclaimerDialog.vue'
import AnalysisWorkspace from '../components/AnalysisWorkspace.vue'
import ExplorePanel from '../components/ExplorePanel.vue'
import ComparisonWorkspace from '../components/ComparisonWorkspace.vue'
import CrossSectionPanel from '../components/crossSection/CrossSectionPanel.vue'
import AreaPanel from '../components/area/AreaPanel.vue'
import PointSnapshot from '../components/snapshot/PointSnapshot.vue'
import { MAP_BOUNDS, MAP_MIN_ZOOM, MAP_MAX_ZOOM, MAP_STYLE } from '@/config/app'
import { useMainStore, type BottomTab } from '../stores/main'
import { trackEvent } from '~~/composables/useAnalytics'
import { useRasterProbe } from '~~/composables/useRasterProbe'
import { useVariableRegistry } from '~~/composables/useVariableRegistry'
import { CAST_CLICK_LAYERS } from '~~/composables/useCastLayer';
import { GLIDER_CLICK_LAYERS } from '~~/composables/useGliderLayer';
// The map's layers, each driven off the store (this page only creates the map and routes clicks).
import { applyBasemapPaint, addSatelliteLayer, setSatelliteVisibility, raiseWaterNamesLayer, setMapLabelsVisibility, applyBathymetryContours } from '~~/composables/useBasemap'
import { useModelRasterLayer } from '~~/composables/useModelRasterLayer'
import { useSensorMap } from '~~/composables/useSensorMap'
import { useGliderMap } from '~~/composables/useGliderMap'
import { useCastMap } from '~~/composables/useCastMap'
import { useMapDrawTools } from '~~/composables/useMapDrawTools'

const mainStore = useMainStore();

const config = useRuntimeConfig();
const apiBaseUrl = config.public.apiBaseUrl

const mapContainer = ref<HTMLDivElement | null>(null);
let map: mapboxgl.Map | null = null;
const getMap = () => map;
const drawerOpen = computed({
    get: () => mainStore.isVerticalProfileOpen,
    set: (v: boolean) => mainStore.setIsVerticalProfileOpen(v),
});

// Auto-open the vertical profile drawer on switching into either depth
// section — the section is a time-depth slice at one instant per column, the
// drawer is that same coordinate's full water column at one instant, so the
// two naturally belong side by side. One-directional on purpose: leaving a
// depth view never force-closes a drawer the user opened deliberately.
watch(() => mainStore.exploreView, (view) => {
    if (view === 'model-depth' || view === 'sensor-depth') mainStore.setIsVerticalProfileOpen(true);
});

const activeTab = computed({
    get: () => mainStore.activeBottomTab,
    set: (v: BottomTab) => mainStore.setActiveBottomTab(v),
});
// Navigation between panes and workspaces lives in the header (AppNav.vue);
// Explore's own sub-views are picked from ExplorePanel's toolbar.

const analysisOpen = computed({
    get: () => activeTab.value === 'analysis',
    set: (open: boolean) => { if (!open) activeTab.value = 'explore'; },
});
const comparisonOpen = computed({
    get: () => activeTab.value === 'comparison',
    set: (open: boolean) => { if (!open) activeTab.value = 'explore'; },
});

// Comparison has nothing to show without a sensor — close it if one is cleared.
watch(() => mainStore.selectedSensor, (sensor) => {
    if (!sensor?.id && activeTab.value === 'comparison') {
        activeTab.value = 'explore';
    }
});

// Bottom-sheet height is user-resizable via the drag handle on the footer's top edge.
const MIN_FOOTER_PX = 160;
const footerHeightPx = ref<number>(440);
const footerHeight = computed<string>(() => `${footerHeightPx.value}px`);
const isResizingFooter = ref<boolean>(false);

/** Largest the footer may grow to, always leaving room for the map above it. */
function maxFooterPx(): number {
    return Math.max(MIN_FOOTER_PX, window.innerHeight - 160);
}

/** Drag handle on the footer's top edge: dragging up grows the sheet, down shrinks it. */
function startFooterResize(e: PointerEvent) {
    e.preventDefault();
    isResizingFooter.value = true;
    const startY = e.clientY;
    const startH = footerHeightPx.value;
    let rafId = 0;

    const onMove = (ev: PointerEvent) => {
        // Dragging upward (smaller clientY) increases the footer height.
        const next = startH + (startY - ev.clientY);
        footerHeightPx.value = Math.min(maxFooterPx(), Math.max(MIN_FOOTER_PX, next));
        if (!rafId) {
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                map?.resize();
            });
        }
    };
    const onUp = () => {
        isResizingFooter.value = false;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (rafId) cancelAnimationFrame(rafId);
        // Final sync so map/charts settle exactly on the released size.
        // The footer panes carry their own ResizeObservers, so only the map
        // needs telling explicitly.
        map?.resize();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
}

// [-126.4002914428711, 46.85966491699218, -121.31835174560548, 51.10480117797852]
const bounds = MAP_BOUNDS;

const mouseCoords = ref<{ lng: number | null, lat: number | null, x: number, y: number, visible: boolean }>({ lng: null, lat: null, x: 0, y: 0, visible: false });

// "Cursor Value": decode the model layer's own value-packed image (see useRasterProbe)
// and read it under the mouse. Only fetched/decoded while the toggle is on.
const rasterProbe = useRasterProbe();
const { formatDisplayValue, toDisplayValue } = useVariableRegistry();
const {
    probeImage, updatePngOverlay, removePngOverlay, addBathymetryTilesLayer, removeBathymetryTilesLayer,
    onPngSourceSettled, clearMapLoadTimers,
} = useModelRasterLayer(getMap, apiBaseUrl, onMapClick, () => mapLoaded.value);

watch([probeImage, () => mainStore.showCursorValue], ([img, on]) => {
    if (!on || !img) return rasterProbe.clear();
    rasterProbe.load(img.url, img.precision, img.bounds);
});

const cursorValueText = computed(() => {
    if (!mainStore.showCursorValue || !mainStore.showModelLayer) return '';
    const img = probeImage.value;
    const g = rasterProbe.grid.value;
    const { lng, lat } = mouseCoords.value;
    if (!img || !g || g.url !== img.url || lng == null || lat == null) return '';
    const v = rasterProbe.sample(lng, lat);
    if (v == null) return '';
    return formatDisplayValue(img.varName, toDisplayValue(img.varName, v), { unit: true });
});

// Flags to coordinate initial click: mapLoaded becomes true when map 'load' fires;
// selectedReady becomes true when initial variables/selectedVariable are set.
const mapLoaded = ref(false);
const selectedReady = ref(false);
let didInitClick = false;

const zoom = ref('');

// Nuxt UI has no queue component: UApp renders a single Toaster and `toast.add`
// pushes into it. Drain the store's queue as messages arrive so every existing
// `pushSnack` caller keeps working unchanged.
const toast = useToast();
watch(() => mainStore.snackMessages.length, (n) => {
    if (!n) return;
    for (const m of mainStore.snackMessages.splice(0)) {
        toast.add({ title: m.text, color: (m.color as never) ?? 'info' });
    }
});

// Keeps the style's water-name labels on top of whatever was added since (see raiseWaterNamesLayer).
const onMapIdle = () => raiseWaterNamesLayer(map);

const overlayGap = 8; // gap in px between map edge and overlays (info, colorbar, buttons)

///////////////////////////////////  COMPUTED  ///////////////////////////////////

const lastClicked = computed(() => mainStore.lastClickedMapPoint);

const mapCenter = computed(() => mainStore.mapCenter);

const showColorbarSettings = computed(() => mainStore.showColorbarSettings);


///////////////////////////////////  HOOKS  ///////////////////////////////////
onMounted(async () => {
    mapboxgl.accessToken = config.public.mapboxToken;
    if (!mapContainer.value) return;

    map = new mapboxgl.Map({
        container: mapContainer.value,
        // style: 'mapbox://styles/taimazb/cmk1jwu8o005101sv1j41cj6j?optimize=true&fresh=true',
        // style: 'mapbox://styles/taimazb/cmkcsejwe005m01ssgtdz3tgd?optimize=true&fresh=true',
        style: MAP_STYLE,
        // center: [-123.2, 48.8],
        bounds,
        // zoom: 9.5,
        // pitch: 45,
        minZoom: MAP_MIN_ZOOM,
        maxZoom: MAP_MAX_ZOOM,
        antialias: true,
        preserveDrawingBuffer: true, // needed for exporting canvas
    });
    console.log(map);

    // Zoom in/out plus a compass that resets bearing and pitch to north-up.
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');

    // When the map finishes loading the style, add the PNG overlay and chart
    map.on('load', () => {
        applyBasemapPaint(map);
        addSatelliteLayer(map);
        // Every other layer added below/elsewhere on this page (PNG overlay,
        // bathymetry, stations, analysis box, cross-section...) can land
        // above the style's built-in "water names" labels depending on add
        // order. Re-raising on 'idle' (fires once per settled render, not
        // per frame) keeps it on top of whatever's underneath without every
        // layer-adding function here needing to know it exists.
        map?.on('idle', onMapIdle);

        map?.on('sourcedata', onPngSourceSettled);
        map?.on('error', onPngSourceSettled);

        map?.on('mousemove', (e) => {
            mouseCoords.value.lng = e.lngLat.lng;
            mouseCoords.value.lat = e.lngLat.lat;
            mouseCoords.value.x = e.point.x;
            mouseCoords.value.y = e.point.y;
            mouseCoords.value.visible = true;
        });
        map?.getContainer().addEventListener('mouseleave', () => {
            mouseCoords.value.visible = false;
        });
        // Fetch colormaps and variables in parallel
        Promise.all([init()]).catch((e) => console.warn('init failed:', e));
        addSensors()
            .catch((e) => console.warn('addSensors failed:', e))
            .finally(() => {
                addGliders().catch((e) => console.warn('addGliders failed:', e));
                addCasts().catch((e) => console.warn('addCasts failed:', e));
            });

        map?.on('zoom', () => {
            if (map) zoom.value = map.getZoom().toFixed(2);
        });

        // Publish the camera so the Share button — mounted in the app header,
        // nowhere near this page's `map` instance — can capture it. `moveend`
        // rather than `move`: one write per settled gesture, not per frame.
        map?.on('moveend', publishMapView);
        publishMapView();

        applyPendingMapView();
        // A share link sets these before the style has loaded, when their watchers can't add layers yet.
        if (mainStore.showBathymetryContours) applyBathymetryContours(map, true, apiBaseUrl);
        if (mainStore.showMapLabels) setMapLabelsVisibility(map, true);
        if (mainStore.showSatellite) setSatelliteVisibility(map, true);

        attachDrawTools();
        if (map && areaBbox()) updateGliderSeafloor();
    });


})

onBeforeUnmount(() => {
    clearMapLoadTimers();
    mainStore.setMapLayerLoading(false);
    if (map) {
        map.off('idle', onMapIdle);
        map.off('sourcedata', onPngSourceSettled);
        map.off('error', onPngSourceSettled);
        map.off('moveend', publishMapView);
        // detach station handlers if attached
        try { const sd = (map as any).__stationsDetach; if (sd) sd(); } catch { /* best-effort: the map, layer or chart may already be gone */ }
        detachCasts();

        // remove png overlay if present
        try { if (map.getLayer && map.getLayer('png-image-layer')) map.removeLayer('png-image-layer'); } catch { /* best-effort: the map, layer or chart may already be gone */ }
        try { if (map.getSource && map.getSource('png-image')) map.removeSource('png-image'); } catch { /* best-effort: the map, layer or chart may already be gone */ }
        try { const ov = (map as any).__activePngOverlay; if (ov && ov.clickHandler) map.off('click', ov.clickHandler); } catch { /* best-effort: the map, layer or chart may already be gone */ }
        try { if ((map as any).__clickMarker) ((map as any).__clickMarker).remove(); } catch { /* best-effort: the map, layer or chart may already be gone */ }

        detachDrawTools();

        // remove stations layers + source if present
        try { if (map.getLayer && map.getLayer('stations-badge')) map.removeLayer('stations-badge'); } catch { /* best-effort: the map, layer or chart may already be gone */ }
        try { if (map.getLayer && map.getLayer('stations-circles')) map.removeLayer('stations-circles'); } catch { /* best-effort: the map, layer or chart may already be gone */ }
        try { if (map.getSource && map.getSource('stations-points')) map.removeSource('stations-points'); } catch { /* best-effort: the map, layer or chart may already be gone */ }

        map.remove();
    }

});

///////////////////////////////////  WATCH  ///////////////////////////////////

// Watcher: add/update/remove overlay when selected variable, depth or datetime
// changes. `dt` shares this one watcher rather than getting its own — a depth
// section cell click (or the variable picker's source switch) sets `depth`
// and `dt` together in the same tick, and two separate watchers each calling
// updatePngOverlay() would independently fire off the same request, doubling
// the image fetch. One watcher covering every source that can move the
// overlay collapses that to a single call no matter how many of them changed
// at once.
watch(() => [mainStore.selected_variable.source, mainStore.selected_variable.var, mainStore.selected_variable.depth, mainStore.selected_variable.dt, mainStore.midDate], async ([, v]: [string, string, string | null, moment.Moment | null, moment.Moment | null]) => {
    if (!map) return;

    if (!v) {
        removePngOverlay();
        removeBathymetryTilesLayer();
        return;
    }

    try {
        // Check if bathymetry is selected
        if (v === 'bathymetry') {
            removePngOverlay();
            addBathymetryTilesLayer();
        } else {
            removeBathymetryTilesLayer();
            await updatePngOverlay();
        }

        mapLoaded.value = true;

        // Nothing to refetch here on a var/depth change any more: the footer
        // panes watch `selected_variable` themselves. Only the "no point picked
        // yet" bootstrap still belongs to the page.
        if (!lastClicked.value || v === 'bathymetry') maybeInitClick();
    } catch (e) {
        console.error('Failed to load PNG for variable', v, e);
        removePngOverlay();
    }
}, { immediate: true });

// Watcher: Explore panel's bin-mode toggle changes which dt resolution the raster tile URL
// requests (hourly/daily/monthly — see updatePngOverlay), so the map layer needs its own refresh.
watch(() => mainStore.exploreBinMode, async () => {
    // A shared link restores the bin mode before `/variables` has landed, so
    // this can fire with no variable metadata (and therefore no bounds) to
    // render against. Nothing is lost by skipping: the selected_variable
    // watcher above is `immediate` and draws the overlay once the list arrives.
    if (!map || !mainStore.variables.length) return;
    try {
        await updatePngOverlay();
    } catch (e) {
        console.error('Failed to update PNG for bin mode change', e);
    }
});

watch(() => mainStore.showBathymetryContours, (show) => applyBathymetryContours(map, show, apiBaseUrl));

watch(() => mainStore.showMapLabels, (visible: boolean) => {
    try {
        setMapLabelsVisibility(map, visible);
    } catch (e) {
        console.warn('Failed to toggle map labels visibility:', e);
    }
});

watch(() => mainStore.showSatellite, (visible: boolean) => {
    try {
        setSatelliteVisibility(map, visible);
    } catch (e) {
        console.warn('Failed to toggle satellite imagery:', e);
    }
});

watch(() => mainStore.lastClickedMapPoint, (point) => {
    if (!point) return;
    trigger_mapClick(point.lat, point.lng);
}, { immediate: true });

// Handler for time controls component
// function onTimeControlDt(dt: any) {
//     // dt is a moment object (UTC)
//     mainStore.updateSelectedVariable({ dt });
// }

watch(() => mapCenter.value, (newCenter) => {
    if (!map || !newCenter) return;
    map.easeTo({ center: [newCenter.lng, newCenter.lat] });
}, { immediate: true })

///////////////////////////////////  MEDTHODS  ///////////////////////////////////
async function init() {
    if (!map) return;

    mainStore.setMidDate(moment.utc()); // Initialize midDate to now.

    selectedReady.value = true;
    maybeInitClick();

    // For the new flow we don't use station points. Instead, we start with NO PNG overlay.

    // Chart is initialized by the TimeseriesChart component itself
}


function publishMapView() {
    if (!map) return;
    const c = map.getCenter();
    mainStore.setMapView({
        center: [c.lng, c.lat],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
    });
}

/**
 * A shared link's camera. Applied here rather than in the Map constructor
 * because the payload is decoded asynchronously in app.vue and may still be in
 * flight when this page mounts — hence the watcher below as well, which covers
 * a decode that lands after the map is already up.
 */
function applyPendingMapView() {
    const view = mainStore.takePendingMapView();
    if (!map || !view) return;
    map.jumpTo({ center: view.center, zoom: view.zoom, bearing: view.bearing, pitch: view.pitch });
    publishMapView();
}
watch(() => mainStore.pendingMapView, () => { if (mapLoaded.value || map) applyPendingMapView(); });

function maybeInitClick() {
    // Call initClick only once both the map has finished loading and the selected variable has been initialized
    // — and, for a shared link, once the payload has been decoded, so the
    // shared coordinate isn't overwritten by the default bootstrap point.
    if (mainStore.shareRestorePending) return;
    if (mapLoaded.value && selectedReady.value && !didInitClick) {
        didInitClick = true;
        const shared = mainStore.lastClickedMapPoint;
        if (shared) {
            // Already the app's selected point (applyShareState set it); all
            // that's missing is the marker. Deliberately not initClick(): that
            // reports a `model_point_queried` the user never performed.
            trigger_mapClick(shared.lat, shared.lng);
        } else {
            initClick(49.2, -123.5); // Center of the map
        }
    }
}

// A share payload finishes decoding after this page has mounted, so the
// bootstrap click above has to be retried once the restore releases it.
watch(() => mainStore.shareRestorePending, (pending) => { if (!pending) maybeInitClick(); });

function initClick(lat: number, lng: number) {
    if (!map) return;

    trackEvent('model_point_queried', {
        lat, lon: lng,
        source: mainStore.selected_variable.source,
        variable: mainStore.selected_variable.var,
        query_mode: mainStore.queryMode,
    });
    mainStore.setLastClickedMapPoint({ lat, lng });
    map.fire('click', { lngLat: { lat, lng } });
}


// The page no longer fetches timeseries itself. Each footer pane owns its own
// data: the Depth tab pulls the model section (and slices the single-depth line
// out of it) plus the climatology envelope, and the Comparison pane fetches its
// own model/sensor pair. This page's remaining job around a click is to place
// the marker and publish the coordinate on the store.

const { sensorPicker, spiderfy, addSensors, clickSensor, openCastSpiderfy } = useSensorMap(getMap, apiBaseUrl);
const { addGliders, updateGliderSeafloor, areaBbox } = useGliderMap(getMap, apiBaseUrl);
const { attachDrawTools, detachDrawTools } = useMapDrawTools(getMap, trigger_mapClick, () => mapLoaded.value);
const { addCasts, detach: detachCasts } = useCastMap(getMap, apiBaseUrl, openCastSpiderfy);

// A click on the map (not on a sensor, glider or cast, which handle their own)
// picks that point; registered by the model layer (useModelRasterLayer).
function onMapClick(evt: any) {
    if (!map) return;
    // While drawing a cross-section line, clicks add vertices via
    // crossSectionDraw (see onCrossSectionDrawChange) — they aren't a
    // point query, and must not clear the sensor selection mid-draw.
    if (mainStore.activeBottomTab === 'crossSection' || mainStore.activeBottomTab === 'area') return;

    const { lng, lat } = evt.lngLat;

    // Check if click landed on a sensor feature (layer may not exist yet)
    const stationLayers = map.getLayer('stations-circles') ? ['stations-circles'] : [];
    const features = stationLayers.length
        ? map.queryRenderedFeatures(evt.point, { layers: stationLayers })
        : [];

    // Glider tracks/heads are handled by useGliderLayer's own click handler.
    const gliderLayers = GLIDER_CLICK_LAYERS.filter(id => map.getLayer(id));
    if (gliderLayers.length && map.queryRenderedFeatures(evt.point, { layers: gliderLayers }).length) return;
    // So are ship casts, by useCastLayer's.
    const castLayers = CAST_CLICK_LAYERS.filter(id => map.getLayer(id));
    if (castLayers.length && map.queryRenderedFeatures(evt.point, { layers: castLayers }).length) return;

    if (features.length > 0) {
        // Sensor click is fully handled by useStationsInteraction → clickSensor.
        // Returning here prevents a duplicate getTimeseriesPromises call.
        return;
    }

    mainStore.setSelectedSensor(null); // Clear selected sensor on map click
    mainStore.selectGlider(null);
    mainStore.selectCast(null);
    sensorPicker.value.visible = false;
    mainStore.setLastClickedMapPoint({ lat, lng });
}

/** Drops the click marker at a coordinate. Data fetching is the panes' job. */
function trigger_mapClick(lat: number, lng: number) {
    const overlay = (map as any).__activePngOverlay;
    if (!overlay) return;
    try { if ((map as any).__clickMarker) ((map as any).__clickMarker).remove(); } catch { /* best-effort: the map, layer or chart may already be gone */ }
    if (mainStore.queryMode === 'point') {
        const el = document.createElement('div');
        el.className = 'map-click-marker';
        const marker = new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(map);
        (map as any).__clickMarker = marker;
    }
}

async function autorange() {
    if (!map || !mapLoaded.value) {
        console.warn('Map not loaded yet');
        return;
    }

    try {
        const selectedSource = mainStore.selected_variable.source;
        const selectedVar = mainStore.selected_variable.var;
        const selectedDt = mainStore.selected_variable.dt;
        const selectedDepth = mainStore.selected_variable.depth_nc;

        if (!selectedVar || !selectedDt) {
            console.warn('No variable or datetime selected');
            return;
        }

        // Get the visible map bounds
        const bounds = map.getBounds();
        const north = bounds.getNorth();
        const south = bounds.getSouth();
        const east = bounds.getEast();
        const west = bounds.getWest();

        // Format datetime as ISO string
        const dtStr = selectedDt.format('YYYY-MM-DDTHH:mm:ss');

        // Call the new getMinMax endpoint to extract min/max directly from the NC file
        const response = await axios.post(`${apiBaseUrl}/getMinMax`, {
            source: selectedSource,
            var: selectedVar,
            dt: dtStr,
            depth: selectedDepth,
            bin_mode: mainStore.exploreBinMode,
            north: north,
            south: south,
            east: east,
            west: west
        });

        console.log(response.data);

        if (response.data && response.data.min !== null && response.data.max !== null) {
            let minVal = response.data.min;
            let maxVal = response.data.max;

            // Round using the precision from the selected variable
            const precision = mainStore.selected_variable.precision || 0;
            if (precision > 0) {
                minVal = Math.round(minVal / precision) * precision;
                maxVal = Math.round(maxVal / precision) * precision;
            }

            mainStore.updateSelectedVariable({
                colormapMin: minVal,
                colormapMax: maxVal
            });
        } else {
            console.warn('No valid min/max values in response');
        }
    } catch (e) {
        console.error('Error in autorange:', e);
    } finally {
        mainStore.setAutoRangeDisabled(false);
    }
}

</script>

<style scoped>
.footer-resizable {
  position: relative;
  /* `flex-direction`/`align-items` below always assumed a flex box — Vuetify's
     v-footer supplied `display: flex` itself. A plain <footer> is block, which
     left .footer-content unbounded and let the chart grow to its content height. */
  display: flex;
  overflow: hidden;
  flex-direction: column;
  align-items: stretch;
  background: var(--ui-bg-muted);
  border-top: 1px solid var(--ui-border);
}

/* Handle sits in the layout flow as a reserved band above the content,
   so it never overlaps the tab controls (playback buttons, etc.). */
.footer-resize-handle {
  flex: 0 0 6px;
  height: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ns-resize;
  touch-action: none;
  background: transparent;
  transition: background 0.15s ease;
}

.footer-content {
  flex: 1 1 auto;
  min-height: 0;
}

.footer-snap {
  flex: 0 0 340px;
  height: 100%;
}

.footer-resize-handle:hover,
.footer-resize-handle.is-resizing {
  background: rgba(255, 255, 255, 0.06);
}

.footer-resize-grip {
  width: 36px;
  height: 2px;
  background: rgba(255, 255, 255, 0.18);
  transition: background 0.15s ease;
}

.footer-resize-handle:hover .footer-resize-grip,
.footer-resize-handle.is-resizing .footer-resize-grip {
  background: rgba(255, 255, 255, 0.55);
}

.map-drawer-toggle {
  position: absolute;
  top: 12px;
  z-index: 2;
  border-radius: 8px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
}

.cursor-coord-label {
  position: absolute;
  z-index: 998;
  pointer-events: none;
  transform: translate(-14px, 14px);
  width: fit-content;
  padding: 3px 7px;
  background: rgba(19, 22, 26, 0.94);
  border: 1px solid var(--ui-border);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--ui-text-muted);
  white-space: nowrap;
}

.cursor-value {
  color: var(--ui-text);
  font-weight: 500;
}
</style>

/* Shrink Mapbox bottom-left controls (logo + attribution) to reduce visual footprint */
<style>
.mapboxgl-ctrl-bottom-left .mapboxgl-ctrl-logo {
  transform: scale(0.5) translateY(1px) !important;
  transform-origin: left center !important;
}

/* Zoom/compass control: dark to match the map toolbar, slides left with the drawer. */
.mapboxgl-ctrl-top-right {
  right: var(--nav-ctrl-right, 0);
  transition: right 0.3s ease;
}

.mapboxgl-ctrl-top-right .mapboxgl-ctrl-group {
  margin: 8px 8px 0 0;
  border-radius: 0;
  background: rgba(19, 22, 26, 0.94);
  border: 1px solid var(--ui-border);
  box-shadow: none;
}

.mapboxgl-ctrl-top-right .mapboxgl-ctrl-group button {
  width: 30px;
  height: 28px;
}

.mapboxgl-ctrl-top-right .mapboxgl-ctrl-group button + button {
  border-top: 1px solid var(--ui-border);
}

.mapboxgl-ctrl-top-right .mapboxgl-ctrl-group button:not(:disabled):hover {
  background: var(--ui-bg-elevated);
}

.mapboxgl-ctrl-top-right .mapboxgl-ctrl-icon {
  filter: invert(0.85);
}

/* make sure the controls remain clickable when scaled */
.mapboxgl-ctrl-bottom-left a {
  pointer-events: auto;
}

.footer-text {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  vertical-align: text-bottom;
}

.map-click-marker {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), inset 0 0 0 3px transparent;
  background: radial-gradient(circle, #fff 0 2px, transparent 2.5px);
}
</style>

<style scoped>
.h-screen {
  height: calc(100vh - 48px);
}

.overlay {
  position: absolute;
  z-index: 998;
}

.map-legend {
  position: absolute;
  z-index: 998;
  width: 300px;
  padding: 8px 10px 4px;
  background: rgba(19, 22, 26, 0.94);
  border: 1px solid var(--ui-border);
  transition: right 0.3s ease;
}

.spiderfy-node {
  position: absolute;
  transform: translate(-50%, -50%);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}

.spiderfy-dot {
  width: 12px;
  height: 12px;
  border: 2px solid #d4d9de;
  transition: transform 0.12s ease;
}

.spiderfy-node:hover .spiderfy-dot {
  transform: scale(1.35);
}

.spiderfy-label {
  color: #fff;
  font-size: 10px;
  white-space: nowrap;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 1px 3px #000, 0 0 5px #000;
  pointer-events: none;
}
</style>
