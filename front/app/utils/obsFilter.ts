/**
 * The observation-period filter: one date selection shared by every
 * observation layer (sensors, gliders, ship casts). Model layers follow the
 * map date and ignore it.
 *
 * A filter combines, all optional:
 *  - a date window `[from, to)`;
 *  - calendar months (a season is just a set of months);
 *  - a window of ±N days around the map date, either that one stretch or the
 *    same days of the year in every year (a climatological sample); while it
 *    is on it replaces the date window or the months respectively;
 *  - day or night, by the sun at the observation.
 *
 * `api/modules/ship_casts.py`'s `cast_filter_sql` mirrors everything but
 * day/night, which needs the sun and is applied here.
 */
import SunCalc from 'suncalc'

export type Diel = 'all' | 'day' | 'night'

export interface ObsFilter {
    /** First day kept (YYYY-MM-DD, UTC), or null for no lower bound. */
    from: string | null
    /** First day no longer kept (exclusive), or null. */
    to: string | null
    /** Calendar months kept (1-12); empty keeps every month. */
    months: number[]
    /** ±days around the map date; `everyYear` repeats it in every year. */
    around: { days: number, everyYear: boolean } | null
    diel: Diel
}

export const NO_OBS_FILTER: ObsFilter = Object.freeze({ from: null, to: null, months: [], around: null, diel: 'all' }) as ObsFilter

/** The filter with the map date applied, as every consumer reads it. */
export interface ResolvedObsFilter {
    from: number | null
    to: number | null
    months: number[] | null
    /** Day-of-year window, wrapping across New Year. */
    doy: { center: number, half: number } | null
    /** Months a sensor's monthly coverage must fall in: `months`, or those the `doy` window touches. */
    monthSet: boolean[] | null
    diel: Diel
    active: boolean
}

export const DAY_MS = 86_400_000
const MAX_AROUND_DAYS = 182
// Sunrise/sunset: the sun's upper limb on the horizon, as SunCalc's getTimes.
const HORIZON = -0.833 * Math.PI / 180

export const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const SEASONS: Array<{ id: string, label: string, months: number[] }> = [
    { id: 'winter', label: 'Winter', months: [12, 1, 2] },
    { id: 'spring', label: 'Spring', months: [3, 4, 5] },
    { id: 'summer', label: 'Summer', months: [6, 7, 8] },
    { id: 'fall', label: 'Fall', months: [9, 10, 11] },
]

const utcDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`)

export function isoDay(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10)
}

/** 1-based UTC day of the year. */
export function dayOfYear(ms: number): number {
    const d = new Date(ms)
    return Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS) + 1
}

/** Days between two days of the year, the short way round (365-day year, as the API). */
function doyDistance(a: number, b: number): number {
    const d = Math.abs(a - b)
    return Math.min(d, 365 - d)
}

export function isObsFilterActive(f: ObsFilter): boolean {
    return !!(f.from || f.to || (f.months.length && f.months.length < 12) || f.around || f.diel !== 'all')
}

export function resolveObsFilter(f: ObsFilter, mapDateMs: number | null): ResolvedObsFilter {
    let from = f.from ? utcDay(f.from) : null
    let to = f.to ? utcDay(f.to) : null
    let months = f.months.length && f.months.length < 12 ? [...new Set(f.months)].sort((a, b) => a - b) : null
    let doy: ResolvedObsFilter['doy'] = null
    if (f.around && mapDateMs != null) {
        const half = Math.max(0, Math.min(MAX_AROUND_DAYS, Math.round(f.around.days)))
        if (f.around.everyYear) {
            doy = { center: dayOfYear(mapDateMs), half }
            months = null
        } else {
            const d0 = Math.floor(mapDateMs / DAY_MS) * DAY_MS
            from = d0 - half * DAY_MS
            to = d0 + (half + 1) * DAY_MS
            months = null
        }
    }
    let monthSet: boolean[] | null = null
    if (months) {
        monthSet = Array(13).fill(false)
        for (const m of months) monthSet[m] = true
    } else if (doy) {
        // Which months the window touches, in a non-leap year.
        monthSet = Array(13).fill(false)
        for (let d = 1; d <= 365; d++) {
            if (doyDistance(d, doy.center) <= doy.half) monthSet[new Date(Date.UTC(2001, 0, d)).getUTCMonth() + 1] = true
        }
    }
    const diel = f.diel ?? 'all'
    return { from, to, months, doy, monthSet, diel, active: from != null || to != null || !!monthSet || diel !== 'all' }
}

export function isDaylight(ms: number, lat: number, lon: number): boolean {
    return SunCalc.getPosition(new Date(ms), lat, lon).altitude > HORIZON
}

/** Does an observation at `ms` (and position, for day/night) pass the filter? */
export function matchesTime(r: ResolvedObsFilter, ms: number, lat?: number, lon?: number): boolean {
    if (!r.active) return true
    if (r.from != null && ms < r.from) return false
    if (r.to != null && ms >= r.to) return false
    if (r.months && !r.months.includes(new Date(ms).getUTCMonth() + 1)) return false
    if (r.doy && doyDistance(dayOfYear(ms), r.doy.center) > r.doy.half) return false
    if (r.diel !== 'all' && lat != null && lon != null && isDaylight(ms, lat, lon) !== (r.diel === 'day')) return false
    return true
}

/**
 * Could a month of data (YYYYMM) hold matching observations? Sensor coverage
 * is monthly, so a day-of-year window counts every month it touches, and
 * day/night is ignored (a month of hourly data has both).
 */
export function monthMatches(r: ResolvedObsFilter, yyyymm: number): boolean {
    if (!r.active) return true
    const y = Math.floor(yyyymm / 100)
    const m = yyyymm % 100
    if (r.monthSet && !r.monthSet[m]) return false
    if (r.from != null && Date.UTC(y, m, 1) <= r.from) return false
    if (r.to != null && Date.UTC(y, m - 1, 1) >= r.to) return false
    return true
}

type Interval = [number, number]

function intersect(a: Interval[], b: Interval[]): Interval[] {
    const out: Interval[] = []
    let i = 0, j = 0
    while (i < a.length && j < b.length) {
        const lo = Math.max(a[i]![0], b[j]![0])
        const hi = Math.min(a[i]![1], b[j]![1])
        if (lo < hi) out.push([lo, hi])
        if (a[i]![1] < b[j]![1]) i++
        else j++
    }
    return out
}

function merge(iv: Interval[]): Interval[] {
    const sorted = iv.filter(([a, b]) => a < b).sort((x, y) => x[0] - y[0])
    const out: Interval[] = []
    for (const [a, b] of sorted) {
        const last = out[out.length - 1]
        if (last && a <= last[1]) last[1] = Math.max(last[1], b)
        else out.push([a, b])
    }
    return out
}

function monthIntervals(t0: number, t1: number, months: number[]): Interval[] {
    const out: Interval[] = []
    const d = new Date(t0)
    let y = d.getUTCFullYear(), m = d.getUTCMonth()
    while (Date.UTC(y, m, 1) < t1) {
        if (months.includes(m + 1)) out.push([Date.UTC(y, m, 1), Date.UTC(y, m + 1, 1)])
        if (++m === 12) { m = 0; y++ }
    }
    return merge(out)
}

function doyIntervals(t0: number, t1: number, doy: { center: number, half: number }): Interval[] {
    const out: Interval[] = []
    for (let y = new Date(t0).getUTCFullYear() - 1; y <= new Date(t1).getUTCFullYear() + 1; y++) {
        const jan1 = Date.UTC(y, 0, 1)
        out.push([jan1 + (doy.center - 1 - doy.half) * DAY_MS, jan1 + (doy.center + doy.half) * DAY_MS])
    }
    return merge(out)
}

// Past this span day/night intervals stop being worth computing (and drawing).
export const MAX_DIEL_DAYS = 1000

function dielIntervals(t0: number, t1: number, lat: number, lon: number, diel: 'day' | 'night'): Interval[] {
    const days: Interval[] = []
    for (let d = Math.floor(t0 / DAY_MS) * DAY_MS - DAY_MS; d < t1 + DAY_MS; d += DAY_MS) {
        const noon = d + DAY_MS / 2 - (lon / 15) * 3_600_000
        const { sunrise, sunset } = SunCalc.getTimes(new Date(noon), lat, lon)
        const rise = sunrise?.getTime(), set = sunset?.getTime()
        if (Number.isFinite(rise) && Number.isFinite(set)) days.push([rise!, set!])
        // Polar day or night: no sunrise; the sun at noon says which.
        else if (isDaylight(noon, lat, lon)) days.push([noon - DAY_MS / 2, noon + DAY_MS / 2])
    }
    const day = merge(days)
    if (diel === 'day') return day
    const night: Interval[] = []
    let cursor = t0 - DAY_MS
    for (const [a, b] of day) {
        night.push([cursor, a])
        cursor = b
    }
    night.push([cursor, t1 + DAY_MS])
    return merge(night)
}

/** The stretches of `[t0, t1]` the filter keeps (day/night taken at `lat`, `lon`). */
export function matchingIntervals(r: ResolvedObsFilter, t0: number, t1: number, lat?: number, lon?: number): Interval[] {
    let iv: Interval[] = [[Math.max(t0, r.from ?? -Infinity), Math.min(t1, r.to ?? Infinity)]]
    iv = iv.filter(([a, b]) => a < b)
    if (!r.active || !iv.length) return iv
    if (r.months) iv = intersect(iv, monthIntervals(t0, t1, r.months))
    if (r.doy) iv = intersect(iv, doyIntervals(t0, t1, r.doy))
    if (r.diel !== 'all' && lat != null && lon != null && (t1 - t0) / DAY_MS <= MAX_DIEL_DAYS) {
        iv = intersect(iv, dielIntervals(t0, t1, lat, lon, r.diel))
    }
    return iv
}

/**
 * Longest step between track vertices that isn't a gap in the data (the API
 * keeps vertices that close; api/modules/gliders.py TRACK_MAX_STEP_S).
 */
export const TRACK_GAP_S = 12 * 3600
/** The same for an Argo float, which surfaces every ~10 days (longer under ice). */
export const ARGO_GAP_S = 30 * 86400

/**
 * The pieces of a timed track ([lon, lat, unix seconds], in time order) inside
 * the intervals. An interval's ends are interpolated between the vertices
 * either side, except across a gap in the data, where the piece stops at the
 * last real fix instead; a gap inside an interval splits its piece. A piece of
 * one fix is kept as two equal points so a brief match still shows.
 */
export function clipTrack(track: number[][], intervals: Interval[], gapS = TRACK_GAP_S): [number, number][][] {
    const n = track.length
    if (n < 2) return []
    const ts = track.map(p => p[2]! * 1000)
    const gap = gapS * 1000
    const at = (i: number): [number, number] => [track[i]![0]!, track[i]![1]!]
    // Position at time t, between vertices i-1 and i.
    const lerp = (i: number, t: number): [number, number] => {
        const f = (t - ts[i - 1]!) / (ts[i]! - ts[i - 1]!)
        return [track[i - 1]![0]! + (track[i]![0]! - track[i - 1]![0]!) * f, track[i - 1]![1]! + (track[i]![1]! - track[i - 1]![1]!) * f]
    }
    const firstAtOrAfter = (t: number) => {
        let lo = 0, hi = n
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (ts[mid]! < t) lo = mid + 1
            else hi = mid
        }
        return lo
    }
    const out: [number, number][][] = []
    const flush = (seg: [number, number][]) => {
        if (seg.length === 1) out.push([seg[0]!, seg[0]!])
        else if (seg.length > 1) out.push(seg)
    }
    for (const [a, b] of intervals) {
        if (b < ts[0]! || a > ts[n - 1]!) continue
        let i = firstAtOrAfter(a)
        let seg: [number, number][] = []
        if (i > 0 && ts[i - 1]! < a && ts[i]! - ts[i - 1]! <= gap) {
            if (ts[i]! > b) { // the whole interval falls between two fixes
                flush([lerp(i, a), lerp(i, b)])
                continue
            }
            seg.push(lerp(i, a))
        }
        for (; i < n && ts[i]! <= b; i++) {
            if (seg.length && i > 0 && ts[i]! - ts[i - 1]! > gap) {
                flush(seg)
                seg = []
            }
            seg.push(at(i))
        }
        if (i < n && i > 0 && ts[i - 1]! < b && ts[i]! - ts[i - 1]! <= gap && seg.length) seg.push(lerp(i, b))
        flush(seg)
    }
    return out
}

export function pathKm(coords: number[][]): number {
    let km = 0
    for (let i = 1; i < coords.length; i++) {
        const [lon1, lat1] = coords[i - 1]!, [lon2, lat2] = coords[i]!
        const p1 = lat1! * Math.PI / 180, p2 = lat2! * Math.PI / 180
        const dp = p2 - p1, dl = (lon2! - lon1!) * Math.PI / 180
        const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
        km += 2 * 6371 * Math.asin(Math.sqrt(h))
    }
    return km
}

function monthsLabel(months: number[]): string {
    const set = new Set(months)
    const season = SEASONS.find(s => s.months.length === set.size && s.months.every(m => set.has(m)))
    if (season) return season.label
    // Contiguous runs, wrapping Dec -> Jan: "Jun–Aug", "Nov–Feb", "Jan, Mar".
    const next = (m: number) => (m % 12) + 1
    const starts = MONTH_ABBR.map((_, i) => i + 1).filter(m => set.has(m) && !set.has(m === 1 ? 12 : m - 1))
    return starts.map((s) => {
        let e = s
        while (set.has(next(e)) && next(e) !== s) e = next(e)
        return s === e ? MONTH_ABBR[s - 1] : `${MONTH_ABBR[s - 1]}–${MONTH_ABBR[e - 1]}`
    }).join(', ')
}

function rangeLabel(from: string | null, to: string | null): string {
    const yFrom = from?.endsWith('-01-01') ? +from.slice(0, 4) : null
    const yTo = to?.endsWith('-01-01') ? +to.slice(0, 4) - 1 : null
    if ((from == null || yFrom != null) && (to == null || yTo != null)) {
        if (yFrom != null && yTo != null) return yFrom === yTo ? `${yFrom}` : `${yFrom}–${yTo}`
        return yFrom != null ? `${yFrom} on` : `to ${yTo}`
    }
    const last = to ? isoDay(utcDay(to) - DAY_MS) : null
    if (from && last) return from === last ? from : `${from} – ${last}`
    return from ? `from ${from}` : `to ${last}`
}

/** Short summary for the filter's chip, e.g. "1990–2024 · Summer · night". */
export function describeObsFilter(f: ObsFilter): string {
    const parts: string[] = []
    if (f.around) {
        parts.push(`Map date ±${f.around.days} d`)
        if (f.around.everyYear) {
            parts.push('every year')
            if (f.from || f.to) parts.push(rangeLabel(f.from, f.to))
        }
    } else {
        if (f.from || f.to) parts.push(rangeLabel(f.from, f.to))
        if (f.months.length && f.months.length < 12) parts.push(monthsLabel(f.months))
    }
    if (f.diel !== 'all') parts.push(f.diel === 'day' ? 'daytime' : 'night-time')
    return parts.length ? parts.join(' · ') : 'All dates'
}

/** A share-link or stored value as a filter, or null when it isn't one. */
export function parseObsFilter(raw: unknown): ObsFilter | null {
    if (!raw || typeof raw !== 'object') return null
    const v = raw as Record<string, unknown>
    const day = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
    const months = Array.isArray(v.months) ? v.months.filter((m): m is number => Number.isInteger(m) && m >= 1 && m <= 12) : []
    const a = v.around as { days?: unknown, everyYear?: unknown } | null | undefined
    const around = a && typeof a.days === 'number' && Number.isFinite(a.days)
        ? { days: Math.max(0, Math.min(MAX_AROUND_DAYS, Math.round(a.days))), everyYear: !!a.everyYear }
        : null
    const diel: Diel = v.diel === 'day' || v.diel === 'night' ? v.diel : 'all'
    return { from: day(v.from), to: day(v.to), months, around, diel }
}
