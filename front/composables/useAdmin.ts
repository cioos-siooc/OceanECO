import axios from 'axios'
import { computed, reactive } from 'vue'

/** State and API calls for the admin dashboard (pages/admin.vue, components/admin/).
 *  One module-level instance: the page and its sections share it. */

export interface AdminSensor {
  id: string
  name: string
  organization: string
  latitude: number
  longitude: number
  depth: number
  active: boolean
  auto_harvest: boolean
  note: string
  api: string
  source: { api?: string, link?: string, constraints?: string, archive?: boolean, site?: string }
  variables: Record<string, { name?: string, unit?: string, conversion_factor?: number }>
  /** variable → [first, last, rows] */
  coverage: Record<string, [string, string, number]>
  updated_at: string
}

export type Change =
  | { kind: 'sensor', id: string, field: SensorField, value: unknown, summary: string }
  | { kind: 'sensor_new', value: Record<string, unknown>, summary: string }

/** Sensor status by the age of its newest value. shortcut: fixed here; make them a setting if they need tuning. */
export const FRESHNESS_LIMITS = { live_hours: 24, lagging_days: 7, stale_days: 90 }

export type SensorField = 'active' | 'auto_harvest' | 'name' | 'organization' | 'depth' | 'note' | 'variables'

export type Freshness = 'live' | 'lag' | 'stale' | 'silent' | 'none'
export const FRESHNESS: Record<Freshness, { label: string, color: string }> = {
  live: { label: 'Live', color: 'var(--adm-live)' },
  lag: { label: 'Lagging', color: 'var(--adm-lag)' },
  stale: { label: 'Stale', color: 'var(--adm-warn)' },
  silent: { label: 'Silent', color: 'var(--adm-bad)' },
  none: { label: 'No data', color: 'var(--ui-text-dimmed)' },
}

const UNLOCK_MS = 15 * 60e3

const state = reactive({
  status: 'loading' as 'loading' | 'signedOut' | 'denied' | 'ready',
  message: '',
  email: '',
  prefect: false,
  logoutPath: null as string | null,
  unlockedUntil: 0,
  now: Date.now(),
  sensors: [] as AdminSensor[],
  pending: new Map<string, Change>(),
  applying: false,
  /** Bumped after every write so sections refetch what they show. */
  revision: 0,
})

function client() {
  return axios.create({ baseURL: `${useRuntimeConfig().public.apiBaseUrl}/manage`, withCredentials: true })
}

export function errorText(e: any): string {
  const d = e?.response?.data?.detail
  return typeof d === 'string' ? d : e?.message ?? String(e)
}

function changeKey(c: Change): string {
  if (c.kind === 'sensor') return `sensor:${c.id}:${c.field}`
  return `new:${(c.value as any)._key}`
}

export function useAdmin() {
  const toast = useToast()
  const api = client()

  const unlocked = computed(() => state.unlockedUntil > state.now)
  const unlockLeft = computed(() => Math.max(0, Math.ceil((state.unlockedUntil - state.now) / 1000)))

  function noteLocked(e: any) {
    if (e?.response?.status === 423) state.unlockedUntil = 0
  }

  async function init() {
    state.status = 'loading'
    try {
      const me = (await api.get('/me')).data
      state.email = me.email
      state.prefect = me.prefect
      state.logoutPath = me.logoutPath
      state.unlockedUntil = me.unlockedFor ? Date.now() + me.unlockedFor * 1000 : 0
      await loadSensors()
      state.status = 'ready'
    } catch (e: any) {
      const code = e?.response?.status
      // No response at all is what an Access redirect looks like to fetch: not signed in.
      state.status = code === 403 || code === 503 ? 'denied' : 'signedOut'
      state.message = code ? errorText(e) : ''
    }
  }

  async function loadSensors() {
    state.sensors = (await api.get('/sensors')).data
  }

  function signInUrl() {
    return `${useRuntimeConfig().public.apiBaseUrl}/manage/login?next=${encodeURIComponent(location.href)}`
  }

  function signOutUrl() {
    return state.logoutPath ? `${useRuntimeConfig().public.apiBaseUrl}${state.logoutPath}` : null
  }

  async function unlock() {
    const r = (await api.post('/unlock')).data
    state.unlockedUntil = Date.now() + r.unlockedFor * 1000
  }

  async function lock() {
    await api.post('/lock')
    state.unlockedUntil = 0
  }

  // ── Staged changes ──
  function stage(c: Change) {
    const key = changeKey(c)
    // Staging a value back to what's stored drops the change instead.
    if (c.kind === 'sensor') {
      const s = state.sensors.find(x => x.id === c.id)
      if (s && JSON.stringify(s[c.field]) === JSON.stringify(c.value)) { state.pending.delete(key); return }
    }
    state.pending.set(key, c)
  }

  function unstage(key: string) { state.pending.delete(key) }
  function discard() { state.pending.clear() }

  /** A sensor field as it will be once staged changes apply. */
  function sensorValue<F extends SensorField>(s: AdminSensor, field: F): AdminSensor[F] {
    const c = state.pending.get(`sensor:${s.id}:${field}`)
    return (c ? c.value : s[field]) as AdminSensor[F]
  }

  function isStaged(s: AdminSensor, field: SensorField) {
    return state.pending.has(`sensor:${s.id}:${field}`)
  }

  async function apply() {
    if (!state.pending.size) return
    state.applying = true
    try {
      const changes = [...state.pending.values()].map(c =>
        c.kind === 'sensor_new' ? { ...c, value: { ...c.value, _key: undefined } } : c)
      const r = (await api.post('/apply', { changes })).data
      state.unlockedUntil = Date.now() + r.unlockedFor * 1000
      state.pending.clear()
      toast.add({ title: `Applied ${r.applied} change${r.applied === 1 ? '' : 's'}`, color: 'success' })
    } catch (e) {
      noteLocked(e)
      toast.add({ title: 'Apply stopped', description: `${errorText(e)}. Changes before the failing one were applied; reload to see them.`, color: 'error' })
    } finally {
      state.applying = false
      await loadSensors().catch(() => {})
      state.revision++
    }
  }

  /** An immediate (not staged) write: harvest, job control, delete, drop, undo, cache. */
  async function act(label: string, fn: (a: typeof api) => Promise<unknown>, reload = false) {
    try {
      await fn(api)
      if (unlocked.value) state.unlockedUntil = Math.max(state.unlockedUntil, Date.now() + UNLOCK_MS)
      toast.add({ title: label, color: 'success' })
      if (reload) await loadSensors()
      state.revision++
      return true
    } catch (e) {
      noteLocked(e)
      toast.add({ title: `${label} failed`, description: errorText(e), color: 'error' })
      return false
    }
  }

  // ── Freshness ──
  function lastValue(s: AdminSensor): number | null {
    const ends = Object.values(s.coverage).map(c => Date.parse(c[1]))
    return ends.length ? Math.max(...ends) : null
  }

  function freshness(s: AdminSensor): Freshness {
    const last = lastValue(s)
    if (last == null) return 'none'
    const f = FRESHNESS_LIMITS
    const h = (state.now - last) / 36e5
    return h < f.live_hours ? 'live' : h < f.lagging_days * 24 ? 'lag' : h < f.stale_days * 24 ? 'stale' : 'silent'
  }

  return {
    state, api, unlocked, unlockLeft,
    init, loadSensors, signInUrl, signOutUrl, unlock, lock,
    stage, unstage, discard, apply, act, sensorValue, isStaged,
    lastValue, freshness,
  }
}

export function ageText(ms: number | null, now = Date.now()): string {
  if (ms == null) return '—'
  const h = (now - ms) / 36e5
  return h < 1 ? 'now' : h < 48 ? `${Math.round(h)} h` : h < 24 * 60 ? `${Math.round(h / 24)} d`
    : h < 24 * 730 ? `${Math.round(h / 24 / 30.4)} mo` : `${(h / 24 / 365).toFixed(1)} y`
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
    .toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export function fmtBytes(b: number): string {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++ }
  return `${b < 10 && i ? b.toFixed(1) : Math.round(b)} ${u[i]}`
}
