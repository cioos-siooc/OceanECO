/**
 * Sensor stations on the map: markers grouped by position, filtered with the
 * sensor list, dimmed when they don't measure the selected variable — and the
 * spiderfy fan that splits a marker (or a stack of casts) into its members.
 */
import type mapboxgl from 'mapbox-gl';
import axios from 'axios';
import { ref, watch } from 'vue';
import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';
import { useMainStore, type Sensor, type ShipCast } from '~/stores/main';
import { addBuoyLayer, setBuoyLayerVisibility, setSelectedBuoy, setHoveredBuoy, SOURCE_ID, STATIONS_LAYER_ID, type MultiSensorCandidate } from './useBuoyLayer';
import { trackEvent } from './useAnalytics';
import { haversineM } from '@/utils/sensorMerge';
import { chart } from '@/config/palette';

export function useSensorMap(getMap: () => mapboxgl.Map | null, apiBaseUrl: string) {
    const mainStore = useMainStore();

    const sensorPicker = ref<{ visible: boolean; x: number; y: number; sensors: MultiSensorCandidate[] }>({
        visible: false,
        x: 0,
        y: 0,
        sensors: [],
    });

    const spiderfy = ref<{
        visible: boolean;
        centerX: number;
        centerY: number;
        spokes: Array<{ label: string; dot: string; ring?: string; line: string; pick: () => void; x: number; y: number }>;
    }>({ visible: false, centerX: 0, centerY: 0, spokes: [] });

    const REALTIME_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
    const PROXIMITY_M = 100; // sensors within 100 m share one map marker

    /**
     * Sensors sharing a map marker. The radius grows with the merge tolerance:
     * a site's merged depths are each centred on their own members, so at a wide
     * tolerance they can sit further apart than 100 m and would otherwise stack
     * as separate, overlapping markers.
     */
    function groupSensors(sensors: Sensor[]): Sensor[][] {
        const radius = Math.max(PROXIMITY_M, mainStore.sensorMerge.distanceM);
        const groups: Sensor[][] = [];
        for (const s of sensors) {
            const existing = groups.find(g =>
                haversineM(g[0].latitude, g[0].longitude, s.latitude, s.longitude) < radius
            );
            if (existing) existing.push(s);
            else groups.push([s]);
        }
        return groups;
    }

    let _sensorGroups: any[][] = [];
    let _groupedFrom: Sensor[] | null = null; // the mainStore.sensors list _sensorGroups was built from
    let _sensorIsRealtime: (s: any) => boolean = () => false;
    let _visibleSensorGroups: any[][] = []; // _sensorGroups filtered to mainStore.filteredSensors

    function coordKey(lat: number, lon: number): string {
        return `${lat.toFixed(6)},${lon.toFixed(6)}`;
    }

    function buildSensorGeoJSON(groups: any[][], sensorIsRealtime: (s: any) => boolean): FeatureCollection<Geometry, GeoJsonProperties> {
        const features = groups.map(group => {
            const first = group[0];
            const anyActive = group.some((s: any) => s.active);
            const isRealtime = group.some(sensorIsRealtime);
            const allRealtime = group.every(sensorIsRealtime);
            const hasMixed = group.length > 1 && isRealtime && !allRealtime;
            return {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [first.longitude, first.latitude] },
                properties: {
                    coordKey: coordKey(first.latitude, first.longitude),
                    // "|id1|id2|" so the selection layer can match one sensor by substring.
                    sensorIds: `|${group.map((s: any) => s.id).join('|')}|`,
                    sensorCount: group.length,
                    active: anyActive,
                    isRealtime,
                    hasMixed,
                    isVariableDepth: group.some((s: any) => s.depth < 0),
                    sensorsJson: JSON.stringify(
                        group.map((s: any) => ({
                            id: s.id,
                            name: s.name,
                            depth: s.depth,
                            depth_min: s.depth_min ?? null,
                            depth_max: s.depth_max ?? null,
                            isRealtime: sensorIsRealtime(s),
                            lat: s.latitude,
                            lon: s.longitude,
                        }))
                    ),
                }
            };
        });
        return { type: 'FeatureCollection', features };
    }

    function updateBuoyVarOpacity(selectedVar: string | null) {
        const map = getMap();
        if (!map || !_visibleSensorGroups.length) return;
        const keysWithVar = _visibleSensorGroups
            .filter(g => !selectedVar || g.some((s: any) => selectedVar in (s.variables ?? {})))
            .map(g => coordKey(g[0].latitude, g[0].longitude));
        const expr: any = (!selectedVar || keysWithVar.length === _visibleSensorGroups.length)
            ? 0.95
            : ['case', ['in', ['get', 'coordKey'], ['literal', keysWithVar]], 0.95, 0.2];
        try { (map as any).setPaintProperty(STATIONS_LAYER_ID, 'icon-opacity', expr); } catch { /* best-effort: the map, layer or chart may already be gone */ }
    }

    // Recomputes which station groups are visible on the map from mainStore.filteredSensors
    // (the same filter criteria — search/organization/variable — driving the sensorInfo.vue list),
    // and pushes the resulting geometry into the existing source via setData.
    // Each group is trimmed down to only its filter-matching members, so clusters that survive
    // the filter don't still expose non-matching sensors when spiderfied.
    function applyBuoyFilters() {
        const map = getMap();
        if (!map || !_groupedFrom) return;
        // A merge-tolerance change rebuilds mainStore.sensors; regroup from it.
        if (_groupedFrom !== mainStore.sensors) {
            _sensorGroups = groupSensors(mainStore.sensors);
            _groupedFrom = mainStore.sensors;
        }
        const filteredIds = new Set(mainStore.filteredSensors.map((s: any) => s.id));
        _visibleSensorGroups = _sensorGroups
            .map(g => g.filter((s: any) => filteredIds.has(s.id)))
            .filter(g => g.length > 0);
        const geojson = buildSensorGeoJSON(_visibleSensorGroups, _sensorIsRealtime);
        const source = map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
        if (source) source.setData(geojson);
        updateBuoyVarOpacity(mainStore.selected_variable?.var ?? null);
    }

    watch(() => mainStore.filteredSensors, applyBuoyFilters);

    async function addSensors() {
        const map = getMap();
        await getSensors();
        const now = Date.now();

        // The store's list, not the response: deployments are merged there.
        const groups = groupSensors(mainStore.sensors);
        _groupedFrom = mainStore.sensors;

        const sensorIsRealtime = (s: any) =>
            s.latest_data_at && (now - new Date(s.latest_data_at).getTime()) < REALTIME_THRESHOLD_MS;

        _sensorGroups = groups;
        _sensorIsRealtime = sensorIsRealtime;

        const filteredIds = new Set(mainStore.filteredSensors.map((s: any) => s.id));
        _visibleSensorGroups = groups
            .map(g => g.filter((s: any) => filteredIds.has(s.id)))
            .filter(g => g.length > 0);

        const geojson = buildSensorGeoJSON(_visibleSensorGroups, sensorIsRealtime);

        try {
            const detach = await addBuoyLayer(map, geojson, clickSensor, openSensorPicker, openSpiderfy);
            (map as any).__stationsDetach = detach;
            setSelectedBuoy(map, mainStore.selectedSensor?.id ?? null);
            setHoveredBuoy(map, mainStore.hoveredSensorId);
            // addBuoyLayer re-creates the layers from scratch, so the rail's toggle
            // has to be re-applied every time the sensor list changes.
            setBuoyLayerVisibility(map, mainStore.showSensorLayer);
        } catch (e) {
            console.warn('Failed to add buoy layer:', e);
        }

        updateBuoyVarOpacity(mainStore.selected_variable?.var ?? null);
    }

    watch(() => mainStore.selected_variable.var, (newVar) => {
        updateBuoyVarOpacity(newVar ?? null);
    });

    function openSensorPicker(sensors: MultiSensorCandidate[], screenX: number, screenY: number) {
        openSpiderfy(sensors, screenX, screenY);
    }

    function openSpiderfy(sensors: MultiSensorCandidate[], screenX: number, screenY: number) {
        showSpiderfy(sensors.map(s => ({
            label: s.name,
            dot: s.isRealtime ? '#5cc28a' : '#13161a',
            line: s.isRealtime ? 'rgba(92,194,138,0.7)' : 'rgba(125,134,143,0.7)',
            pick: () => clickSensor(s.id, s.depth),
        })), screenX, screenY);
    }

    // Casts at one spot: drawn like their map dots, CTD filled and bottle a ring.
    function openCastSpiderfy(ids: string[], screenX: number, screenY: number) {
        const casts = ids.map(id => mainStore.casts.find(c => c.id === id)).filter((c): c is ShipCast => !!c);
        showSpiderfy(casts.map(c => ({
            label: `${c.kind === 'bottle' ? 'Bottle' : 'CTD'} cast · to ${Math.round(c.maxDepth)} m`,
            dot: c.kind === 'bottle' ? 'transparent' : chart.sensor,
            ring: chart.sensor,
            line: 'rgba(125,134,143,0.7)',
            pick: () => mainStore.selectCast(c.id),
        })), screenX, screenY);
    }

    function showSpiderfy(items: Array<Omit<typeof spiderfy.value.spokes[number], 'x' | 'y'>>, screenX: number, screenY: number) {
        const map = getMap();
        sensorPicker.value.visible = false;
        const radius = 70;
        const startAngle = -Math.PI / 2;
        const spokes = items.map((item, i) => {
            const angle = startAngle + (2 * Math.PI / items.length) * i;
            return { ...item, x: screenX + radius * Math.cos(angle), y: screenY + radius * Math.sin(angle) };
        });
        spiderfy.value = { visible: true, centerX: screenX, centerY: screenY, spokes };
        map?.once('movestart', () => { spiderfy.value.visible = false; });
    }

    function clickSensor(sensor_id: string, depth: number) {
        trackEvent('sensor_selected', { sensor_id, source: 'map' });
        sensorPicker.value.visible = false;
        mainStore.selectSensor(sensor_id, depth);
        // Publishing the coordinate is the whole job — the panes fetch off the store.
        // (No fetch to de-duplicate here any more, so the old _sensorClickPending
        // guard against a double request from the var/depth watcher is gone too.)
        const sensor = mainStore.sensors.find((s: any) => s.id === sensor_id);
        if (sensor) {
            mainStore.setLastClickedMapPoint({ lat: sensor.latitude, lng: sensor.longitude });
        }
    }


    async function getSensors() {
        // Coverage only matters once a period is picked; it lands on its own.
        axios.get(`${apiBaseUrl}/sensors/coverage`)
            .then((r) => mainStore.setSensorCoverage(r.data))
            .catch((e) => console.warn('sensor coverage failed:', e));
        try {
            const r = await axios.get(`${apiBaseUrl}/sensors`);
            const data = r.data;
            mainStore.setSensors(data);
            return data;
        } catch (e) {
            console.error('Failed to fetch sensors:', e);
            return [];
        }
    }

    // Overlay rail: hide/show the buoy symbols (and their badges).
    watch(() => mainStore.showSensorLayer, (visible: boolean) => {
        const map = getMap();
        try {
            setBuoyLayerVisibility(map, visible);
        } catch (e) {
            console.warn('Failed to toggle sensor layer visibility:', e);
        }
    });

    // Ring the selected sensor's marker.
    watch(() => mainStore.selectedSensor?.id, (id) => setSelectedBuoy(getMap(), id ?? null));
    watch(() => mainStore.hoveredSensorId, (id) => setHoveredBuoy(getMap(), id));

    return { sensorPicker, spiderfy, addSensors, clickSensor, openCastSpiderfy };
}
