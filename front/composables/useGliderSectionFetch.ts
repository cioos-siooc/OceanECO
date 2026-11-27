import axios from 'axios';
import { useRuntimeConfig } from '#app';
import { createRequestCache } from './useRequestCache';
import { matchesTime, type ResolvedObsFilter } from '@/utils/obsFilter';

/**
 * One variable of a glider deployment, or of a profile-number window of it,
 * averaged server-side into at most ~600 columns x ~256 depth rows. Each
 * column averages `perColumn` consecutive profiles; its time and position are
 * those of its middle profile.
 */
export type GliderSectionResponse = {
    extent: [number, number];       // first and last profile number of the whole deployment
    perColumn: number;
    profiles: number[];             // first profile number of each column
    profileEnd: number[];           // last profile number of each column
    time: string[];
    lat: number[];
    lon: number[];
    distanceKm: number[];           // from the start of the deployment
    depths: number[];               // row centres (metres), ascending, evenly spaced; the same for every window
    values: (number | null)[][];    // [row][column], canonical unit
};

// A live deployment's file is re-harvested every few hours; 10 min keeps the
// Explore section and the map curtain on one request without going stale.
const cache = createRequestCache<GliderSectionResponse>(600_000);

/** POSTs to /gliderSection: the whole deployment, or `range` ([first, last] profile number). */
export function fetchGliderSection(deployment: string, variable: string, range?: [number, number] | null): Promise<GliderSectionResponse> {
    const apiBaseUrl = useRuntimeConfig().public.apiBaseUrl;
    return cache.fetch(`${deployment}|${variable}|${range?.join('-') ?? ''}`, async () => {
        const response = await axios.post(`${apiBaseUrl}/gliderSection`, {
            deployment, var: variable, ...(range ? { start: range[0], end: range[1] } : {}),
        });
        return response.data;
    });
}

/**
 * The section with every column outside the observation period blanked, so
 * the Explore section and the map curtain show only what the clipped track
 * does. A column is judged by its middle profile's time and position.
 */
export function sectionInPeriod(s: GliderSectionResponse, period: ResolvedObsFilter): GliderSectionResponse {
    if (!period.active) return s;
    const keep = s.time.map((t, i) => matchesTime(period, Date.parse(t), s.lat[i], s.lon[i]));
    if (keep.every(Boolean)) return s;
    return { ...s, values: s.values.map(row => row.map((v, c) => (keep[c] ? v : null))) };
}

/** One profile of one variable at full resolution, as `/gliderProfile` returns it. */
export type GliderProfileResponse = {
    deployment: string;
    profile: number;                // the nearest existing profile to the one asked for
    time: string;
    lat: number;
    lon: number;
    depth: number[];
    value: number[];                // canonical unit
    model: { source: string; binMode: 'hourly' | 'daily'; depth: number[]; value: number[] } | null;
    modelError: { code: string; message: string } | null;
};

const profileCache = createRequestCache<GliderProfileResponse>(600_000);

/** POSTs to /gliderProfile; with `source`, the model's profile at it too. */
export function fetchGliderProfile(deployment: string, profile: number, variable: string, source?: string | null): Promise<GliderProfileResponse> {
    const apiBaseUrl = useRuntimeConfig().public.apiBaseUrl;
    return profileCache.fetch(`${deployment}|${profile}|${variable}|${source ?? ''}`, async () => {
        const response = await axios.post(`${apiBaseUrl}/gliderProfile`, { deployment, profile, var: variable, source: source ?? null });
        return response.data;
    });
}
