/**
 * Display-time merging of sensor deployments.
 *
 * Some operators store a site as many short records: DFO IOS moorings are
 * redeployed every few months, each instrument a sensor of its own, usually
 * within metres of the last position but sometimes a few km away, and at a
 * slightly different depth. Storage keeps every deployment as it was
 * recorded; this joins them for display under a tolerance the user sets, so
 * the choice stays visible and adjustable instead of being baked into the data.
 *
 * Rule: sensors merge when they share an operator and source dataset, are
 * fixed-depth, and lie within `distanceM` (horizontal) and `depthM`
 * (vertical) of the group's reference deployment — the first one met, in
 * order of position then depth. Profilers never merge.
 *
 * A merged group becomes one synthetic sensor whose `id` is its members' ids
 * joined by commas. The API reads such an id as one fixed-depth sensor (every
 * member's rows, averaged where deployments overlap; see
 * api/modules/extractSensorTimeseries.py), so every view that takes a sensor
 * id works on a merge unchanged.
 */

export interface SensorMergeOptions {
    /** Horizontal tolerance, metres. 0 disables merging. */
    distanceM: number
    /** Vertical tolerance, metres. */
    depthM: number
}

export interface MergeableSensor {
    id: string
    name: string
    latitude: number
    longitude: number
    depth: number
    depth_min: number | null
    depth_max: number | null
    active: boolean
    first_data_at: string | null
    latest_data_at: string | null
    organization: string
    /** canonical variable id → source column, unit and conversion factor */
    variables: Record<string, SensorVariable>
    /** ONC only: per-variable instrument list, in priority order */
    device_config: { locationCode?: string, sources?: Record<string, Array<Record<string, string>>> }
    source: { api?: string, link?: string, description?: string, site?: string, archive?: boolean }
    /** Set on a merged group: the deployments it joins, in time order. */
    members?: MergeableSensor[]
}

export interface SensorVariable {
    name?: string
    unit?: string
    conversion_factor?: number
}

export const MERGE_ID_SEPARATOR = ','

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180
    const Δφ = (lat2 - lat1) * Math.PI / 180
    const Δλ = (lon2 - lon1) * Math.PI / 180
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** The stored sensor ids behind an id: itself, or a merge's members. */
export function memberIds(id: string): string[] {
    return id.split(MERGE_ID_SEPARATOR).filter(Boolean)
}

export function isMergedId(id: string | null | undefined): boolean {
    return !!id && id.includes(MERGE_ID_SEPARATOR)
}

function mergeKey(s: MergeableSensor): string | null {
    if (s.depth === -1) return null
    return `${s.organization}\u0000${s.source?.link ?? ''}`
}

const time = (t: string | null) => (t ? Date.parse(t) : NaN)

function combine<T extends MergeableSensor>(members: T[]): T {
    if (members.length === 1) return members[0]!
    const sorted = [...members].sort((a, b) => (time(a.first_data_at) || 0) - (time(b.first_data_at) || 0))
    const ref = sorted[0]!
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const firsts = sorted.map(m => m.first_data_at).filter(Boolean) as string[]
    const lasts = sorted.map(m => m.latest_data_at).filter(Boolean) as string[]
    const lows = sorted.map(m => m.depth_min ?? m.depth)
    const highs = sorted.map(m => m.depth_max ?? m.depth)
    const variables: Record<string, SensorVariable> = {}
    for (const m of sorted) for (const [k, v] of Object.entries(m.variables ?? {})) variables[k] ??= v
    // "IOS A1 99 m 2008-04" → "IOS A1 99 m": the date names one deployment.
    const base = ref.name.replace(/ \d{4}-\d{2}( \(.*\))?$/, '')
    return {
        ...ref,
        id: sorted.map(m => m.id).join(MERGE_ID_SEPARATOR),
        name: `${base} · ${sorted.length} deployments`,
        latitude: mean(sorted.map(m => m.latitude)),
        longitude: mean(sorted.map(m => m.longitude)),
        depth: Math.round(mean(sorted.map(m => m.depth)) * 10) / 10,
        depth_min: Math.min(...lows),
        depth_max: Math.max(...highs),
        active: sorted.some(m => m.active),
        first_data_at: firsts.length ? firsts.reduce((a, b) => (a < b ? a : b)) : null,
        latest_data_at: lasts.length ? lasts.reduce((a, b) => (a > b ? a : b)) : null,
        variables,
        device_config: {},
        members: sorted,
    }
}

/**
 * Merge `sensors` under `opts`. Order of the result follows the first member
 * of each group in the input, so the list doesn't reshuffle as the tolerance
 * changes.
 */
export function mergeSensors<T extends MergeableSensor>(sensors: T[], opts: SensorMergeOptions): T[] {
    if (!(opts.distanceM > 0)) return sensors
    const groups: { key: string | null, ref: T, members: T[] }[] = []
    const ordered = [...sensors].sort((a, b) =>
        a.latitude - b.latitude || a.longitude - b.longitude || a.depth - b.depth)
    for (const s of ordered) {
        const key = mergeKey(s)
        const g = key === null ? undefined : groups.find(g =>
            g.key === key
            && Math.abs(g.ref.depth - s.depth) <= opts.depthM
            && haversineM(g.ref.latitude, g.ref.longitude, s.latitude, s.longitude) <= opts.distanceM)
        if (g) g.members.push(s)
        else groups.push({ key, ref: s, members: [s] })
    }
    const position = new Map(sensors.map((s, i) => [s.id, i]))
    return groups
        .map(g => ({ first: Math.min(...g.members.map(m => position.get(m.id)!)), merged: combine(g.members) }))
        .sort((a, b) => a.first - b.first)
        .map(g => g.merged)
}

/**
 * The id in `sensors` that now holds `id`: itself, or the merge containing
 * any of its members. Keeps a selection alive across a tolerance change.
 */
export function resolveMergedId(sensors: MergeableSensor[], id: string): string | null {
    if (sensors.some(s => s.id === id)) return id
    const wanted = new Set(memberIds(id))
    return sensors.find(s => memberIds(s.id).some(m => wanted.has(m)))?.id ?? null
}
