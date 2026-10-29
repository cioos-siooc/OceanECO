import axios from 'axios';
import { useRuntimeConfig } from '#app';
import { createRequestCache } from './useRequestCache';

export type GliderSectionResponse = {
    profiles: number[];
    time: string[];
    lat: number[];
    lon: number[];
    distanceKm: number[];
    depths: number[];               // bin centres (metres), ascending
    values: (number | null)[][];    // [depth][profile], canonical unit
};

// A live deployment's file is re-harvested every few hours; 10 min keeps the
// Explore section and the map curtain on one request without going stale.
const cache = createRequestCache<GliderSectionResponse>(600_000);

/** POSTs to /gliderSection — one variable of one deployment, depth x profile. */
export function fetchGliderSection(deployment: string, variable: string): Promise<GliderSectionResponse> {
    const apiBaseUrl = useRuntimeConfig().public.apiBaseUrl;
    return cache.fetch(`${deployment}|${variable}`, async () => {
        const response = await axios.post(`${apiBaseUrl}/gliderSection`, { deployment, var: variable });
        return response.data;
    });
}
