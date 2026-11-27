/**
 * The model layer: the selected variable's value-packed raster image at the
 * selected time and depth (or the bathymetry tiles), its colours from the
 * store's colormap and range, and the loading spinner while an image is on
 * its way. Also registers the page's map-click handler alongside the image.
 */
import type mapboxgl from 'mapbox-gl';
import { computed, ref, watch } from 'vue';
import { useMainStore } from '~/stores/main';
import { resolveColormap, packedRasterPaint } from './useColormapResolver';

export function useModelRasterLayer(
    getMap: () => mapboxgl.Map | null,
    apiBaseUrl: string,
    onMapClick: (evt: any) => void,
    isMapLoaded: () => boolean,
) {
    const mainStore = useMainStore();

    // Set by updatePngOverlay — the image currently on the model layer.
    const probeImage = ref<{ url: string, varName: string, precision: number, bounds: [number, number, number, number] } | null>(null);

    const selectedColormap = computed(() => {
        const name = mainStore.selected_variable.colormap;
        if (name) return resolveColormap(mainStore.colormaps, name);
        // Fallback to a default colormap (DB doesn't store colormap field)
        return null;
    });

    // Map-layer loading indicator (selectedInfo.vue's spinner). Every pane that
    // moves the map (Explore clicks, Model depth, Cross-Section, pickers, share
    // restore) funnels through updatePngOverlay, so tracking it here covers them
    // all. The spinner only shows after a delay so cached/fast tiles never flash
    // it; during playback the delay is longer, so animation stays clean unless a
    // frame genuinely stalls.
    const MAP_LOADING_DELAY_MS = 400;
    const MAP_LOADING_DELAY_PLAYING_MS = 1500;
    const MAP_LOADING_GIVE_UP_MS = 60_000;
    let mapLoadUrl: string | null = null;
    let mapLoadShowTimer: number | null = null;
    let mapLoadGiveUpTimer: number | null = null;

    function clearMapLoadTimers() {
        if (mapLoadShowTimer != null) { clearTimeout(mapLoadShowTimer); mapLoadShowTimer = null; }
        if (mapLoadGiveUpTimer != null) { clearTimeout(mapLoadGiveUpTimer); mapLoadGiveUpTimer = null; }
    }

    function beginMapLayerLoad(url: string) {
        clearMapLoadTimers();
        mapLoadUrl = url;
        const delay = mainStore.timePlaying ? MAP_LOADING_DELAY_PLAYING_MS : MAP_LOADING_DELAY_MS;
        mapLoadShowTimer = window.setTimeout(() => {
            mapLoadShowTimer = null;
            mainStore.setMapLayerLoading(true);
        }, delay);
        // Backstop in case mapbox never reports back (e.g. a request it dropped).
        mapLoadGiveUpTimer = window.setTimeout(() => endMapLayerLoad(url), MAP_LOADING_GIVE_UP_MS);
    }

    function endMapLayerLoad(url: string | undefined) {
        // A superseded request finishing must not hide the newer one's spinner.
        if (!url || url !== mapLoadUrl) return;
        mapLoadUrl = null;
        clearMapLoadTimers();
        mainStore.setMapLayerLoading(false);
    }

    // ImageSource sets `url` when a load starts and `loaded()` once its image
    // request completes (success fires 'sourcedata', failure fires 'error', both
    // tagged with sourceId), so matching the url pins the event to the latest request.
    function onPngSourceSettled(e: any) {
        const map = getMap();
        if (e?.sourceId !== 'png-image') return;
        const src = map?.getSource('png-image') as any;
        if (!src) return;
        if (e.type === 'sourcedata' && !src.loaded?.()) return;
        endMapLayerLoad(src.url);
    }

    // Paint for the model layer: packed raster values -> colours, from the store's colormap and range.
    // Separate from updatePngOverlay so a range/palette change only repaints (no image reload).
    function pngRasterPaint() {
        const varName = mainStore.selected_variable.var;
        const precision = mainStore.variables.find(v => v.var === varName)?.precision ?? 0.1;
        return packedRasterPaint(selectedColormap.value, mainStore.selected_variable.colormapMin, mainStore.selected_variable.colormapMax, precision, 0);
    }

    // Add / update / remove PNG overlay for a given public PNG path
    async function updatePngOverlay(sourceId = 'png-image', layerId = 'png-image-layer') {
        const map = getMap();
        if (!map) throw new Error('map not initialized');

        const source = mainStore.selected_variable.source.replace(/\s+/g, ''); // Remove spaces from source name for URL
        const varName = mainStore.selected_variable.var;
        // dt's shape tells the API which bin mode to render (see extract_image.resolve_bin_mode):
        // full timestamp -> hourly, YYYY-MM-DD -> daily, YYYY-MM -> monthly. Keeps the map layer's
        // resolution in sync with the Explore panel's bin-mode toggle used by the timeseries/depth charts.
        const dtFormat = mainStore.exploreBinMode === 'daily' ? 'YYYY-MM-DD'
            : mainStore.exploreBinMode === 'monthly' ? 'YYYY-MM'
                : 'YYYY-MM-DDTHHmmss';
        const dt = mainStore.selected_variable.dt?.format(dtFormat) || '';
        const depth = mainStore.selected_variable.depth
        const pngPath = `${apiBaseUrl}/png/${source}/${varName}/${dt}/${depth}`;

        const bounds = mainStore.variables.find(v => v.source === mainStore.selected_variable.source && v.var === varName)?.bounds;
        if (!bounds) throw new Error('bounds not found');
        const [lonmin, latmin, lonmax, latmax] = bounds;
        const coords = [
            [lonmin, latmax], // top-left
            [lonmax, latmax], // top-right
            [lonmax, latmin], // bottom-right
            [lonmin, latmin], // bottom-left
        ] as [number, number][];

        const paint = pngRasterPaint();

        probeImage.value = {
            url: pngPath, varName,
            precision: mainStore.variables.find(v => v.var === varName)?.precision ?? 0.1,
            bounds: [lonmin, latmin, lonmax, latmax],
        };

        beginMapLayerLoad(pngPath);
        if (map.getSource(sourceId)) {
            map.getSource(sourceId)?.updateImage({
                type: 'image',
                url: pngPath,
                coordinates: coords
            })
            map.setPaintProperty(layerId, 'raster-color', paint.color);
            map.setPaintProperty(layerId, 'raster-color-range', paint.range);
        }
        else {
            map.addSource(sourceId, { type: 'image', url: pngPath, coordinates: coords });
            map.addLayer({
                id: layerId, type: 'raster', source: sourceId, paint: {
                    'raster-opacity': 1.0,
                    'raster-color': paint.color,
                    // Range of the packed integer values
                    'raster-color-range': paint.range,
                    // Mix to recover the 24-bit integer from normalized RGB [0..1]
                    // R_int = R_norm * 255. Packed = R_int*65536 + G_int*256 + B_int
                    // Coeffs: [255*65536, 255*256, 255, 0] -> [16711680, 65280, 255, 0]
                    'raster-color-mix': [256 * 256 * 255, 256 * 255, 255, 0],
                    'raster-fade-duration': 0
                },
                layout: { visibility: mainStore.showModelLayer ? 'visible' : 'none' },
            }, 'country-boundaries');
        }

        // save active overlay metadata on the map instance for access by click handler
        const overlayObj: any = { bounds: [lonmin, latmin, lonmax, latmax], coords, varName, depth: depth, pngPath, clickHandler: null };
        // remove previous click handler if present
        const prev = (map as any).__activePngOverlay;
        if (prev && prev.clickHandler) {
            try { map.off('click', prev.clickHandler); } catch (e) { }
        }
        (map as any).__activePngOverlay = overlayObj;

        overlayObj.clickHandler = onMapClick;
        map.on('click', onMapClick);
    }

    function removePngOverlay(sourceId = 'png-image', layerId = 'png-image-layer') {
        const map = getMap();
        if (!map) return;
        try { const ov = (map as any).__activePngOverlay; if (ov && ov.clickHandler) map.off('click', ov.clickHandler); } catch (e) { }
        try { if ((map as any).__clickMarker) ((map as any).__clickMarker).remove(); } catch (e) { }
        try { if (map.getLayer && map.getLayer(layerId)) map.removeLayer(layerId); } catch (e) { }
        try { if (map.getSource && map.getSource(sourceId)) map.removeSource(sourceId); } catch (e) { }
        try { delete (map as any).__activePngOverlay; } catch (e) { }
    }

    // Bathymetry tiles are packed from -3000 m.
    function bathymetryRasterPaint() {
        const precision = mainStore.variables.find(v => v.var === 'bathymetry')?.precision ?? 1;
        return packedRasterPaint(selectedColormap.value, mainStore.selected_variable.colormapMin, mainStore.selected_variable.colormapMax, precision, -3000);
    }

    // Add bathymetry tiles layer based on raster tiles from backend
    function addBathymetryTilesLayer(sourceId = 'bathymetry-tiles', layerId = 'bathymetry-tiles-layer') {
        const map = getMap();
        if (!map) return;

        try {
            // Remove existing layer and source if they exist
            if (map.getLayer && map.getLayer(layerId)) map.removeLayer(layerId);
            if (map.getSource && map.getSource(sourceId)) map.removeSource(sourceId);

            // Add raster tile source for bathymetry
            map.addSource(sourceId, {
                type: 'raster',
                tiles: [`${apiBaseUrl}/raster_tiles/{z}/{x}/{y}.webp`],
                tileSize: 512,
            });

            const paint = bathymetryRasterPaint();
            map.addLayer({
                id: layerId,
                type: 'raster',
                source: sourceId,
                paint: {
                    // Decode packed 24-bit integer: value = (R*m0 + G*m1 + B*m2) / 255 = R*65536 + G*256 + B
                    'raster-color-mix': [16711680, 65280, 255, 0],
                    'raster-color': paint.color,
                    'raster-color-range': paint.range,
                }
            }, 'country-boundaries');

            // Store metadata for cleanup
            (map as any).__activeBathymetryLayer = {
                sourceId,
                layerId,
            };
        } catch (e) {
            console.error('Error adding bathymetry tiles layer:', e);
        }
    }

    // Update bathymetry tiles layer colorization
    function updateBathymetryTilesLayerColorization(layerId = 'bathymetry-tiles-layer') {
        const map = getMap();
        if (!map) return;

        try {
            if (!map.getLayer(layerId)) return;

            const paint = bathymetryRasterPaint();
            map.setPaintProperty(layerId, 'raster-color', paint.color);
            map.setPaintProperty(layerId, 'raster-color-range', paint.range);
        } catch (e) {
            console.error('Error updating bathymetry tiles colorization:', e);
        }
    }

    // Remove bathymetry tiles layer
    function removeBathymetryTilesLayer() {
        const map = getMap();
        if (!map) return;

        try {
            const bathy = (map as any).__activeBathymetryLayer;
            if (!bathy) return;

            const { sourceId = 'bathymetry-tiles', layerId = 'bathymetry-tiles-layer' } = bathy;

            try { if (map.getLayer && map.getLayer(layerId)) map.removeLayer(layerId); } catch (e) { }
            try { if (map.getSource && map.getSource(sourceId)) map.removeSource(sourceId); } catch (e) { }
            try { delete (map as any).__activeBathymetryLayer; } catch (e) { }
        } catch (e) {
            console.error('Error removing bathymetry tiles layer:', e);
        }
    }



    // Overlay rail: hide/show the model raster tiles. Purely a map concern — the
    // selected variable/depth keep driving the charts either way.
    watch(() => mainStore.showModelLayer, (visible: boolean) => {
        const map = getMap();
        try {
            if (map?.getLayer('png-image-layer')) {
                map.setLayoutProperty('png-image-layer', 'visibility', visible ? 'visible' : 'none');
            }
        } catch (e) {
            console.warn('Failed to toggle model layer visibility:', e);
        }
    });

    // When colormap, min, or max change in store, update overlay
    watch([
        () => mainStore.selected_variable.colormap,
        () => mainStore.selected_variable.colormapMin,
        () => mainStore.selected_variable.colormapMax
    ], async () => {
        const map = getMap();
        if (!map || !isMapLoaded()) return;
        if (mainStore.selected_variable.var === 'bathymetry') {
            updateBathymetryTilesLayerColorization();
        } else if (map.getLayer('png-image-layer')) {
            // Same image, new colours: repaint only. Reloading the image on every slider tick made
            // range drags stutter.
            const paint = pngRasterPaint();
            map.setPaintProperty('png-image-layer', 'raster-color', paint.color);
            map.setPaintProperty('png-image-layer', 'raster-color-range', paint.range);
        } else {
            try {
                await updatePngOverlay();
            } catch (e) {
                console.warn('Failed to update overlay after colormap/min/max change', e);
            }
        }
    }, { immediate: false });

    return {
        probeImage, updatePngOverlay, removePngOverlay, addBathymetryTilesLayer, removeBathymetryTilesLayer,
        onPngSourceSettled, clearMapLoadTimers,
    };
}
