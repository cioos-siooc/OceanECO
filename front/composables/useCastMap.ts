/**
 * DFO IOS ship casts on the map: the casts matching the observation period
 * (mainStore.obsResolved), re-fetched whenever it changes.
 */
import type mapboxgl from 'mapbox-gl';
import axios from 'axios';
import { watch } from 'vue';
import { useMainStore, type ShipCast } from '~/stores/main';
import { addCastLayer, setCastLayerVisibility, setSelectedCast } from './useCastLayer';
import { isoDay, matchesTime } from '@/utils/obsFilter';

export function useCastMap(
    getMap: () => mapboxgl.Map | null,
    apiBaseUrl: string,
    openCastSpiderfy: (ids: string[], screenX: number, screenY: number) => void,
) {
    const mainStore = useMainStore();

    // DFO IOS ship casts matching the observation period (mainStore.obsFilter),
    // re-fetched whenever it changes. Day/night needs the sun at each cast, so it
    // is applied here rather than by the API.
    async function addCasts() {
        const r = await axios.get(`${apiBaseUrl}/casts/years`);
        mainStore.setCastYears(r.data);
        await loadCasts();
    }

    let _castsRequest = 0;
    let _castsDetach: (() => void) | null = null;
    async function loadCasts() {
        const map = getMap();
        if (!map) return;
        const p = mainStore.obsResolved;
        const req = ++_castsRequest;
        const r = await axios.get(`${apiBaseUrl}/casts`, {
            params: {
                from: p.from != null ? isoDay(p.from) : undefined,
                to: p.to != null ? isoDay(p.to) : undefined,
                months: p.months?.join(','),
                doy: p.doy?.center,
                half: p.doy?.half,
            },
        });
        if (req !== _castsRequest) return; // a newer period was picked meanwhile
        const casts = p.diel === 'all' ? r.data.casts
            : r.data.casts.filter((c: ShipCast) => matchesTime(p, Date.parse(c.time), c.lat, c.lon));
        mainStore.setCasts({ ...r.data, casts, total: r.data.total - (r.data.casts.length - casts.length) });
        const detach = addCastLayer(map, casts, (id) => mainStore.selectCast(id), openCastSpiderfy);
        if (detach) _castsDetach = detach;
        setSelectedCast(map, mainStore.selectedCastId);
        setCastLayerVisibility(map, mainStore.showCastLayer);
    }

    // Keyed on what the API is asked, so a map-date step only refetches when the
    // period follows it; debounced for playback and for dragging the year brush.
    let _castsTimer: ReturnType<typeof setTimeout> | null = null;
    watch(() => {
        const p = mainStore.obsResolved;
        return JSON.stringify([p.from, p.to, p.months, p.doy, p.diel]);
    }, () => {
        if (_castsTimer) clearTimeout(_castsTimer);
        _castsTimer = setTimeout(() => loadCasts().catch((e) => console.warn('loadCasts failed:', e)), 300);
    });
    watch(() => mainStore.selectedCastId, (id) => setSelectedCast(getMap(), id));
    watch(() => mainStore.showCastLayer, (visible: boolean) => setCastLayerVisibility(getMap(), visible));

    /** Removes the layer's event handlers. */
    function detach() {
        _castsDetach?.();
        _castsDetach = null;
    }

    return { addCasts, detach };
}
