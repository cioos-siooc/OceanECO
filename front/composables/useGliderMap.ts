/**
 * Gliders and Argo floats on the map (one shared layer), and the selected
 * deployment's 3D views: its section hung under the track as a curtain, the
 * seafloor beneath it (or beneath the Area tab's circle), and the tilt that
 * frames them. Everything is driven off the store.
 */
import mapboxgl from 'mapbox-gl';
import axios from 'axios';
import { watch } from 'vue';
import { useMainStore, type GliderDeployment } from '~/stores/main';
import { addGliderLayer, setGliderTracks, setGliderPins, setSelectedGlider, setHoveredGlider, setGliderRangeTrack, GLIDER_BASE_LAYER } from './useGliderLayer';
import { setGliderCurtain, setGliderCurtainVisibility, setGliderSeafloor, setGliderSeafloorVisibility, CURTAIN_EXAGGERATION } from './useGliderCurtain';
import { fetchSeafloorGrid } from './useSeafloorGrid';
import { fetchGliderSection, sectionInPeriod } from './useGliderSectionFetch';
import { useFieldColorRamp } from './useFieldColorRamp';
import { useVariableRegistry } from './useVariableRegistry';
import { circleRing } from './useObsAreaLayer';

/** Camera pitch of the 3D views (glider curtain and the Area tab's box). */
export const GLIDER_TILT_PITCH = 60;

export function useGliderMap(getMap: () => mapboxgl.Map | null, apiBaseUrl: string) {
    const mainStore = useMainStore();
    const { toDisplayValue } = useVariableRegistry();

    // Gliders and Argo floats share one layer; either list failing leaves the other.
    async function addGliders() {
        const map = getMap();
        const [gliders, argo] = await Promise.allSettled([
            axios.get<Omit<GliderDeployment, 'kind'>[]>(`${apiBaseUrl}/gliders`),
            axios.get<GliderDeployment[]>(`${apiBaseUrl}/argo`),
        ]);
        if (gliders.status === 'rejected') console.warn('gliders failed:', gliders.reason);
        if (argo.status === 'rejected') console.warn('argo failed:', argo.reason);
        mainStore.setGliders([
            ...(gliders.status === 'fulfilled' ? gliders.value.data.map(g => ({ ...g, kind: 'glider' as const })) : []),
            ...(argo.status === 'fulfilled' ? argo.value.data : []),
        ]);
        const detach = await addGliderLayer(map, mainStore.mapGliders, mainStore.gliderClips, (id) => {
            mainStore.setSelectedSensor(null);
            mainStore.selectGlider(id);
        });
        (map as any).__glidersDetach?.();
        (map as any).__glidersDetach = detach;
        setSelectedGlider(map, mainStore.selectedGliderId);
        setGliderPins(map, mainStore.gliderPins, mainStore.gliderHover);
        updateGliderCurtain();
        updateGliderSeafloor();
    }

    // The observation period cuts every glider track to its matching stretches.
    watch(() => mainStore.gliderClips, (clips) => {
        const map = getMap();
        if (map?.getSource('glider-tracks')) setGliderTracks(map, mainStore.mapGliders, clips);
        updateGliderCurtain();
    });

    /** Whether the selected deployment's kind (glider or Argo) is on the map. */
    function selectedGliderShown(): boolean {
        const g = mainStore.gliders.find(d => d.id === mainStore.selectedGliderId);
        return g?.kind === 'argo' ? mainStore.showArgoLayer : mainStore.showGliderLayer;
    }

    // The selected glider's section, hung under its track when the map is tilted:
    // the whole deployment, or the stretch its Explore section is zoomed to, which
    // the track highlights too.
    const { rgbFn: fieldRgbFn } = useFieldColorRamp();
    let curtainSeq = 0;
    let curtainBottomM = 1000; // deepest cell of the curtain on show, for framing it
    let curtainTrack: [number, number][] = []; // its columns' positions, for framing it
    async function updateGliderCurtain() {
        const map = getMap();
        const seq = ++curtainSeq;
        const v = mainStore.selected_variable.var;
        const range = mainStore.gliderRange;
        const g = mainStore.gliders.find(d => d.id === mainStore.selectedGliderId);
        if (!map || !g || !g.variables.includes(v)) {
            setGliderCurtain(map, null);
            setGliderRangeTrack(map, null);
            curtainTrack = [];
            return;
        }
        try {
            const s = sectionInPeriod(await fetchGliderSection(g.id, v, range), mainStore.obsResolved);
            if (seq !== curtainSeq) return;
            const deepest = s.values.findLastIndex(row => row.some(x => x != null));
            if (deepest >= 0) curtainBottomM = s.depths[deepest]!;
            curtainTrack = s.lon.map((lon, i) => [lon, s.lat[i]!]);
            setGliderRangeTrack(map, range ? curtainTrack : null);
            setGliderCurtain(map, {
                lon: s.lon,
                lat: s.lat,
                depths: s.depths,
                values: s.values.map(row => row.map(x => x == null ? null : toDisplayValue(v, x))),
                rgb: fieldRgbFn.value,
            }, GLIDER_BASE_LAYER);
            setGliderCurtainVisibility(map, selectedGliderShown());
        } catch (e) {
            console.warn('glider curtain failed:', e);
        }
    }
    // fieldRgbFn changes identity with the palette, range and display unit.
    watch([() => mainStore.selectedGliderId, () => mainStore.selected_variable.var, () => mainStore.gliderRange, fieldRgbFn], updateGliderCurtain);

    // The seafloor under the 3D views: around the Area tab's circle while that
    // tab is open, else around the selected glider's track — always the whole
    // deployment's area, so zooming the section doesn't reshape the terrain.
    let seafloorSeq = 0;
    let seafloorDeepestM = 0;
    function areaBbox(): [number, number, number, number] | null {
        const a = mainStore.obsArea;
        if (mainStore.activeBottomTab !== 'area' || !a) return null;
        const ring = circleRing(a, 32);
        const lons = ring.map(p => p[0]), lats = ring.map(p => p[1]);
        return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
    }
    async function updateGliderSeafloor() {
        const map = getMap();
        const seq = ++seafloorSeq;
        const g = mainStore.gliders.find(d => d.id === mainStore.selectedGliderId);
        const bbox = areaBbox() ?? g?.bbox;
        seafloorDeepestM = 0;
        if (!map || !bbox) {
            setGliderSeafloor(map, null);
            return;
        }
        try {
            const grid = await fetchSeafloorGrid(bbox);
            if (seq !== seafloorSeq) return;
            seafloorDeepestM = grid.depth.reduce((a, d) => (d > a ? d : a), 0);
            setGliderSeafloor(map, grid, GLIDER_BASE_LAYER);
            setGliderCurtainVisibility(map, selectedGliderShown());
            setGliderSeafloorVisibility(map, mainStore.showSeafloor);
        } catch (e) {
            console.warn('glider seafloor failed:', e);
        }
    }
    watch([() => mainStore.selectedGliderId, areaBbox], updateGliderSeafloor);
    watch(() => mainStore.showSeafloor, (v: boolean) => setGliderSeafloorVisibility(getMap(), v));

    /** Bearing that looks across the track's main axis, keeping north as near to up as possible. */
    function sideOnBearing(track: GliderDeployment['track']): number {
        const k = Math.cos(track[0]![1] * Math.PI / 180);
        const xs = track.map(p => p[0] * k);
        const ys = track.map(p => p[1]);
        const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
        const my = ys.reduce((a, b) => a + b, 0) / ys.length;
        let sxx = 0, syy = 0, sxy = 0;
        xs.forEach((x, i) => {
            const dx = x - mx, dy = ys[i]! - my;
            sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
        });
        // Principal axis as an azimuth (clockwise from north); face 90° off it.
        const azimuth = 90 - (0.5 * Math.atan2(2 * sxy, sxx - syy)) * 180 / Math.PI;
        const bearing = azimuth - 90;
        return ((bearing + 90) % 180 + 180) % 180 - 90; // into [-90, 90)
    }

    // GliderSection's 3D button: tilt to see the selected track's curtain side-on,
    // or flatten (north up) if the map is already tilted.
    watch(() => mainStore.gliderTiltToken, () => {
        const map = getMap();
        if (!map) return;
        if (map.getPitch() > 10) {
            map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
            return;
        }
        const g = mainStore.gliders.find(d => d.id === mainStore.selectedGliderId);
        // The curtain on show: the zoomed stretch when there is one.
        const track = curtainTrack.length > 1 ? curtainTrack : g?.track ?? [];
        if (track.length < 2) return;
        const bearing = sideOnBearing(track);
        // The curtain hangs toward the camera, so its bottom edge lands this far
        // short of the track on screen: frame those points too.
        const deepestM = mainStore.showSeafloor ? Math.max(curtainBottomM, seafloorDeepestM) : curtainBottomM;
        const reachM = deepestM * CURTAIN_EXAGGERATION * Math.tan(GLIDER_TILT_PITCH * Math.PI / 180);
        const b = bearing * Math.PI / 180;
        const bounds = new mapboxgl.LngLatBounds();
        for (const [lon, lat] of track) {
            bounds.extend([lon, lat]);
            bounds.extend([
                lon - Math.sin(b) * reachM / (111_320 * Math.cos(lat * Math.PI / 180)),
                lat - Math.cos(b) * reachM / 111_320,
            ]);
        }
        map.fitBounds(bounds, { bearing, pitch: GLIDER_TILT_PITCH, padding: 60, maxZoom: 10, duration: 1200 });
    });

    watch(() => mainStore.selectedGliderId, (id) => {
        const map = getMap();
        setSelectedGlider(map, id);
        // Offshore tracks often sit outside the Salish Sea view: bring the whole track in.
        const g = mainStore.gliders.find(d => d.id === id);
        if (!g || !map) return;
        const [w, s, e, n] = g.bbox;
        const view = map.getBounds();
        if (!view?.contains([w, s]) || !view.contains([e, n])) {
            map.fitBounds([[w, s], [e, n]], { padding: 80, maxZoom: 10, duration: 800 });
        }
    });
    watch(() => mainStore.hoveredGliderId, (id) => setHoveredGlider(getMap(), id));
    watch([() => mainStore.gliderPins, () => mainStore.gliderHover], ([pins, hover]) => setGliderPins(getMap(), pins, hover));
    watch([() => mainStore.showGliderLayer, () => mainStore.showArgoLayer], () => {
        const map = getMap();
        if (map?.getSource('glider-tracks')) setGliderTracks(map, mainStore.mapGliders, mainStore.gliderClips);
        setGliderCurtainVisibility(map, selectedGliderShown());
    });

    return { addGliders, updateGliderSeafloor, areaBbox };
}
