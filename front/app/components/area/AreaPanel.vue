<template>
  <div class="area-panel flex flex-col h-full p-3">
    <!-- No circle yet: the whole view is keyed off the drawn box. -->
    <div v-if="!area" class="flex flex-col items-center justify-center grow text-center px-6">
      <UIcon name="i-mdi-circle-outline" class="size-[56px] text-gray-500" />
      <div class="text-gray-500 mt-2">
        Press and drag on the map to draw a circle: every visible sensor, glider, Argo float and ship cast inside it,
        within the depth range and observation period, comes together here. A click places a 5 km circle.
      </div>
    </div>

    <template v-else>
      <div class="flex items-center flex-wrap mb-2" style="gap:8px;">
        <USelect v-model="variable" :items="variableItems" size="xs" class="w-44" aria-label="Variable" />
        <label class="area-field">
          <span>Radius</span>
          <UInputNumber
:model-value="area.radiusKm" :min="0.1" :max="200" :step="1" :step-snapping="false"
            :format-options="{ maximumFractionDigits: 1 }" size="xs" class="w-24" aria-label="Radius (km)"
            @update:model-value="(v) => patch({ radiusKm: v ?? area!.radiusKm })" />
          <span class="text-muted">km</span>
        </label>
        <label class="area-field">
          <span>Depth</span>
          <UInputNumber
:model-value="area.depthMin" :min="0" :max="12000" :step="5" size="xs" class="w-22"
            aria-label="Depth from (m)" @update:model-value="(v) => patch({ depthMin: v ?? 0 })" />
          <span class="text-muted">–</span>
          <UInputNumber
:model-value="area.depthMax" :min="0" :max="12000" :step="5" size="xs" class="w-22"
            aria-label="Depth to (m)" @update:model-value="(v) => patch({ depthMax: v ?? area!.depthMax })" />
          <span class="text-muted">m</span>
        </label>
        <SegmentedControl v-model="view" :items="viewItems" size="xs" aria-label="Area view" />
        <USelect v-model="bin" :items="binItems" size="xs" class="w-28" aria-label="Time bin" />
        <UIcon v-if="loading" name="i-mdi-loading" class="animate-spin size-[14px] text-primary" />
        <div class="grow" />
        <UButton
size="xs" variant="outline" color="neutral" :class="tilted ? 'oe-on' : ''" :aria-pressed="tilted"
          title="Tilt the map to see the box and its observations in 3D (or flatten it)"
          @click="mainStore.toggleObsAreaTilt()">3D</UButton>
        <UButton
size="xs" variant="outline" color="neutral" :class="mainStore.showSeafloor ? 'oe-on' : ''"
          :aria-pressed="mainStore.showSeafloor" title="Show the seafloor around the circle when the map is tilted"
          @click="mainStore.setShowSeafloor(!mainStore.showSeafloor)">Seafloor</UButton>
        <UButton
variant="subtle" size="xs" leading-icon="i-mdi-circle-outline"
          title="Press and drag on the map for a new circle" @click="mainStore.requestObsAreaRedraw()">
          Redraw
        </UButton>
        <DownloadButton :datasets="csvDatasets" size="xs" class="shrink-0" />
      </div>

      <UAlert v-if="loadError" color="error" variant="subtle" class="mb-2 shrink-0" :description="loadError" />

      <ChartContextBar :items="contextItems" />

      <div class="area-chart-wrap">
        <div ref="chartEl" class="area-chart" />
        <div v-if="!loading && data && !data.points.time.length" class="area-empty">
          {{ emptyMessage }}
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * The Area tab: every observation of one variable inside a 4D box — the
 * circle drawn on the map, a depth range, and the observation period — from
 * the sources the map is showing (POST /obsArea; api/modules/obs_area.py).
 *
 * "Points" plots what the API returns: one point per platform per time bin
 * (a sensor or glider's bin mean) and one per ship cast (its values in the
 * depth range averaged). "Mean" averages across platforms per bin, each
 * platform once (all casts of a kind in a bin count as one), so an hourly
 * mooring doesn't outweigh a monthly cast; the band spans the platforms'
 * means and the tooltip says how many went in.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import axios from 'axios'
import moment from 'moment-timezone'
import * as echarts from '@/utils/echarts'
import { useRuntimeConfig } from '#app'
import { useMainStore, type ObsArea, type ObsAreaMarker } from '~/stores/main'
import { APP_TIMEZONE } from '@/config/app'
import { chart as palette } from '@/config/palette'
import { describeObsFilter, isoDay } from '@/utils/obsFilter'
import { haversineM } from '@/utils/sensorMerge'
import { useObsVariable } from '~~/composables/useObsVariable'
import { registerEchartsDarkTheme } from '~~/composables/useEchartsTheme'
import { csvMeta, csvTimestamp, provideCsvExport, type CsvContext, type CsvDataset } from '~~/composables/useCsvExport'
import ChartContextBar, { type ContextItem } from '../ChartContextBar.vue'
import DownloadButton from '../ui/DownloadButton.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'

type PlatformType = 'sensor' | 'glider' | 'argo' | 'ctd' | 'bottle'
type Bin = 'hour' | 'day' | 'week' | 'month' | 'year'
interface Platform {
  id: string, type: PlatformType, name: string, lat?: number, lon?: number, depth?: number | null, distanceKm?: number
  samples?: [number, number, number][]   // a glider's or float's (lon, lat, depth) fixes in the box
}
interface AreaResponse {
  variable: string
  bin: Bin
  platforms: Platform[]
  points: { platform: number[], time: string[], value: number[], min: number[], max: number[], n: number[], depth: number[] }
  castsTruncated: boolean
  castsTotal: number
}

const props = defineProps<{ active: boolean }>()

const mainStore = useMainStore()
const config = useRuntimeConfig()
const { nameOf, unitOf, show, fmt } = useObsVariable()

const area = computed(() => mainStore.obsArea)
function patch(p: Partial<ObsArea>) {
  if (area.value) mainStore.setObsArea({ ...area.value, ...p })
}

// ── Controls ────────────────────────────────────────────────────────────────
const FALLBACK_VARIABLES = ['temperature', 'salinity', 'dissolved_oxygen']
const variableItems = computed(() => {
  const ids = Object.keys(mainStore.castVariables)
  return (ids.length ? ids : FALLBACK_VARIABLES).map(v => ({ value: v, label: nameOf(v) }))
})
const variable = computed({
  get: () => mainStore.obsAreaVariable,
  set: (v: string) => mainStore.setObsAreaVariable(v),
})

const view = ref<'points' | 'mean'>('points')
const viewItems = [
  { value: 'points' as const, label: 'Points', title: 'Every platform\'s values, as recorded (binned per platform)' },
  { value: 'mean' as const, label: 'Mean', title: 'Mean across platforms per time bin, each platform counted once' },
]
const bin = ref<'auto' | Bin>('auto')
const binItems = [
  { value: 'auto', label: 'Auto bin' },
  { value: 'hour', label: 'Hourly' },
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
  { value: 'year', label: 'Yearly' },
]

// ── Fetch ───────────────────────────────────────────────────────────────────
const data = ref<AreaResponse | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)

/** Visible sources, with sensors already cut to the circle (the API checks again). */
const sources = computed(() => {
  const a = area.value
  const vis = mainStore.visibleObsSources
  if (!a) return vis
  const reach = a.radiusKm * 1000
  const byId = new Map(mainStore.rawSensors.map(s => [s.id, s]))
  const sensorIds = vis.sensorIds.filter((id) => {
    const s = byId.get(id)
    return !s || haversineM(a.lat, a.lng, s.latitude, s.longitude) <= reach
  })
  return { ...vis, sensorIds }
})

const requestBody = computed(() => {
  const a = area.value
  if (!a) return null
  const p = mainStore.obsResolved
  return {
    variable: variable.value,
    lat: a.lat, lon: a.lng, radiusKm: a.radiusKm, depthMin: a.depthMin, depthMax: a.depthMax,
    period: {
      from: p.from != null ? isoDay(p.from) : undefined,
      to: p.to != null ? isoDay(p.to) : undefined,
      months: p.months ?? undefined,
      doy: p.doy?.center,
      half: p.doy?.half,
    },
    diel: p.diel,
    ...sources.value,
    bin: bin.value,
  }
})
const requestKey = computed(() => JSON.stringify(requestBody.value))

let request = 0
let fetchedKey: string | null = null
async function load() {
  const body = requestBody.value
  if (!body) { data.value = null; return }
  const key = requestKey.value
  if (key === fetchedKey) return
  const req = ++request
  loading.value = true
  loadError.value = null
  try {
    const r = await axios.post(`${config.public.apiBaseUrl}/obsArea`, body)
    if (req !== request) return
    data.value = r.data
    fetchedKey = key
  } catch (e) {
    if (req !== request) return
    loadError.value = (axios.isAxiosError(e) && e.response?.data?.detail) || 'Could not load the observations in this area.'
  } finally {
    if (req === request) loading.value = false
  }
}

// Debounced for typing a radius or dragging the period's year brush; a
// hidden pane waits until it's shown.
let timer: ReturnType<typeof setTimeout> | null = null
watch([requestKey, () => props.active], () => {
  if (!props.active) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(load, 300)
}, { immediate: true })

// ── Derived series ──────────────────────────────────────────────────────────
const TYPE_LABEL: Record<PlatformType, string> = {
  sensor: 'Moorings & sensors', glider: 'Gliders', argo: 'Argo floats', ctd: 'CTD casts', bottle: 'Bottle casts',
}
// As in the observation-period strip: sensors, gliders, Argo, then casts.
const TYPE_COLOR: Record<PlatformType, string> = {
  sensor: palette.instruments[1], glider: palette.instruments[2], argo: palette.instruments[4], ctd: palette.sensor, bottle: palette.instruments[3],
}
const TYPES: PlatformType[] = ['sensor', 'glider', 'argo', 'ctd', 'bottle']

const tilted = computed(() => (mainStore.mapView?.pitch ?? 0) > 10)

// Where the observations sit, for the 3D box under the circle (index.vue):
// a sensor or cast at its position and mean depth in the range, a glider at
// a sample of its fixes.
watch(data, (d) => {
  const markers: ObsAreaMarker[] = []
  if (d) {
    const depthSum = new Map<number, [number, number]>()
    d.points.platform.forEach((pi, i) => {
      const a = depthSum.get(pi) ?? [0, 0]
      a[0] += d.points.depth[i]!; a[1]++
      depthSum.set(pi, a)
    })
    d.platforms.forEach((p, pi) => {
      const color = TYPE_COLOR[p.type]
      if (p.samples) {
        for (const [lon, lat, depth] of p.samples) markers.push({ lon, lat, depth, color })
        return
      }
      const s = depthSum.get(pi)
      if (p.lat == null || p.lon == null || !s) return
      markers.push({ lon: p.lon, lat: p.lat, depth: p.depth ?? s[0] / s[1], color })
    })
  }
  mainStore.setObsAreaMarkers(markers)
})
onBeforeUnmount(() => mainStore.setObsAreaMarkers([]))

const counts = computed(() => {
  const c: Record<PlatformType, number> = { sensor: 0, glider: 0, argo: 0, ctd: 0, bottle: 0 }
  for (const p of data.value?.platforms ?? []) c[p.type]++
  return c
})

const BIN_MS: Record<Bin, number> = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 0, year: 0 }
/** Start of `ms`'s bin, as the API's ClickHouse bins (UTC; weeks start on Monday). */
function binStart(ms: number, unit: Bin): number {
  const d = new Date(ms)
  if (unit === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  if (unit === 'year') return Date.UTC(d.getUTCFullYear(), 0, 1)
  if (unit === 'week') {
    const day = Math.floor(ms / BIN_MS.day) * BIN_MS.day
    return day - ((d.getUTCDay() + 6) % 7) * BIN_MS.day
  }
  return Math.floor(ms / BIN_MS[unit]) * BIN_MS[unit]
}

const BINS: Bin[] = ['hour', 'day', 'week', 'month', 'year']
const APPROX_MS: Record<Bin, number> = { hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_629_800_000, year: 31_557_600_000 }
// Auto keeps the Mean line readable: bins widen until the span holds this many.
const MAX_MEAN_BINS = 300

/** The Mean view's bin: the chosen one, or on Auto the API's widened to fit MAX_MEAN_BINS. */
const meanUnit = computed<Bin>(() => {
  const d = data.value
  if (!d) return 'day'
  if (bin.value !== 'auto' || d.points.time.length < 2) return d.bin
  const span = Date.parse(d.points.time[d.points.time.length - 1]!) - Date.parse(d.points.time[0]!)
  return BINS.slice(BINS.indexOf(d.bin)).find(u => span / APPROX_MS[u] <= MAX_MEAN_BINS) ?? 'year'
})

interface MeanBin { t: number, mean: number, lo: number, hi: number, platforms: number }
/** Mean across platforms per bin: each sensor or glider once, all casts of a kind once. */
const meanBins = computed<MeanBin[]>(() => {
  const d = data.value
  if (!d) return []
  const unit = meanUnit.value
  const bins = new Map<number, Map<string, { sum: number, n: number }>>()
  d.points.time.forEach((iso, i) => {
    const p = d.platforms[d.points.platform[i]!]!
    const t = binStart(Date.parse(iso), unit)
    const group = p.type === 'ctd' || p.type === 'bottle' ? p.type : p.id
    let groups = bins.get(t)
    if (!groups) bins.set(t, (groups = new Map()))
    const g = groups.get(group) ?? { sum: 0, n: 0 }
    g.sum += d.points.value[i]!
    g.n += 1
    groups.set(group, g)
  })
  return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([t, groups]) => {
    const means = [...groups.values()].map(g => g.sum / g.n)
    return {
      t, platforms: means.length,
      mean: means.reduce((a, b) => a + b, 0) / means.length,
      lo: Math.min(...means), hi: Math.max(...means),
    }
  })
})

// ── Labels ──────────────────────────────────────────────────────────────────
const BIN_LABEL: Record<Bin, string> = { hour: 'hourly', day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }
const coordLabel = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(3)}${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(3)}${lon >= 0 ? 'E' : 'W'}`
const periodLabel = computed(() => describeObsFilter(mainStore.obsFilter))
const sourcesLabel = computed(() => {
  const c = counts.value
  const parts: string[] = []
  if (c.sensor) parts.push(`${c.sensor} sensor${c.sensor === 1 ? '' : 's'}`)
  if (c.glider) parts.push(`${c.glider} glider${c.glider === 1 ? '' : 's'}`)
  if (c.argo) parts.push(`${c.argo} Argo float${c.argo === 1 ? '' : 's'}`)
  const casts = c.ctd + c.bottle
  if (casts) parts.push(`${casts.toLocaleString('en-CA')} cast${casts === 1 ? '' : 's'}`)
  return parts.join(' · ') || 'none'
})
const hiddenLayers = computed(() => {
  const off: string[] = []
  if (!mainStore.showSensorLayer) off.push('sensors')
  if (!mainStore.showGliderLayer) off.push('gliders')
  if (!mainStore.showArgoLayer) off.push('Argo floats')
  if (!mainStore.showCastLayer) off.push('casts')
  return off
})

const contextItems = computed<ContextItem[]>(() => {
  const a = area.value
  if (!a) return []
  const items: ContextItem[] = [
    { label: 'Centre', value: coordLabel(a.lat, a.lng) },
    { label: 'Period', value: periodLabel.value, title: 'The observation period, set in the sensor panel' },
    { label: 'Sources', value: sourcesLabel.value, title: 'Only what the map shows: layer toggles, sensor filters and the observation period apply' },
  ]
  if (hiddenLayers.value.length) items.push({ label: 'Hidden', value: hiddenLayers.value.join(', '), tone: 'muted', title: 'Layers switched off on the map are left out' })
  if (data.value) items.push({ label: 'Bin', value: BIN_LABEL[view.value === 'mean' ? meanUnit.value : data.value.bin] })
  if (data.value?.castsTruncated) {
    items.push({ label: 'Casts', value: `latest ${counts.value.ctd + counts.value.bottle} of ${data.value.castsTotal.toLocaleString('en-CA')}`, tone: 'muted', title: 'Narrow the circle or the observation period for the rest' })
  }
  return items
})

const emptyMessage = computed(() => (sources.value.sensorIds.length || sources.value.gliderIds.length || sources.value.casts
  ? `No ${nameOf(variable.value).toLowerCase()} observations in this circle, depth range and period.`
  : 'Every observation layer is hidden or filtered out on the map.'))

// ── Chart ───────────────────────────────────────────────────────────────────
const chartEl = ref<HTMLElement | null>(null)
let chart: echarts.ECharts | null = null
let resizeObserver: ResizeObserver | null = null

const timeFmt = (ms: number, unit: Bin) => {
  const m = moment.utc(ms).tz(APP_TIMEZONE)
  if (unit === 'hour') return m.format('YYYY-MM-DD HH:mm z')
  if (unit === 'month') return m.format('MMM YYYY')
  if (unit === 'year') return m.format('YYYY')
  return m.format('YYYY-MM-DD')
}

function platformLabel(p: Platform): string {
  if (p.type === 'ctd' || p.type === 'bottle') return `${p.type === 'ctd' ? 'CTD' : 'Bottle'} cast · ${p.name}`
  if (p.type === 'argo') return `Argo float ${p.name.replace('argo-', '')}`
  return p.name
}

function pointsSeries(d: AreaResponse, v: string): echarts.SeriesOption[] {
  const byType = new Map<PlatformType, number[][]>()
  d.points.time.forEach((iso, i) => {
    const pi = d.points.platform[i]!
    const type = d.platforms[pi]!.type
    const rows = byType.get(type) ?? []
    rows.push([Date.parse(iso), show(v, d.points.value[i]!) ?? NaN, i])
    byType.set(type, rows)
  })
  return TYPES.filter(t => byType.has(t)).map(t => ({
    name: TYPE_LABEL[t], type: 'scatter', data: byType.get(t)!,
    symbolSize: t === 'ctd' || t === 'bottle' ? 5 : 3.5,
    large: byType.get(t)!.length > 5000, largeThreshold: 5000,
    itemStyle: { color: TYPE_COLOR[t], opacity: 0.8 },
    encode: { x: 0, y: 1 },
  }))
}

function meanSeries(v: string): echarts.SeriesOption[] {
  const rows = meanBins.value
  // A run of empty bins breaks the line rather than bridging it.
  const gap = 1.5 * APPROX_MS[meanUnit.value]
  const lo: (number | null)[][] = []
  const span: (number | null)[][] = []
  const mean: (number | null)[][] = []
  rows.forEach((r, i) => {
    const prev = rows[i - 1]
    if (prev && r.t - prev.t > gap) {
      const mid = (prev.t + r.t) / 2
      lo.push([mid, null]); span.push([mid, null]); mean.push([mid, null, null])
    }
    lo.push([r.t, show(v, r.lo)])
    span.push([r.t, (show(v, r.hi) ?? 0) - (show(v, r.lo) ?? 0)])
    mean.push([r.t, show(v, r.mean), i])
  })
  return [
    { name: '_lo', type: 'line', data: lo, stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, silent: true, tooltip: { show: false } },
    { name: 'Platform range', type: 'line', data: span, stack: 'band', symbol: 'none', lineStyle: { opacity: 0 },
      areaStyle: { color: palette.sensor, opacity: 0.18 }, silent: true, tooltip: { show: false } },
    { name: 'Mean', type: 'line', data: mean, showSymbol: rows.length < 400, symbolSize: 4,
      lineStyle: { width: 1.5, color: palette.sensor }, itemStyle: { color: palette.sensor },
      connectNulls: false },
  ]
}

function render() {
  if (!chartEl.value) return
  if (!chart) chart = echarts.init(chartEl.value, 'dark', { renderer: 'canvas' })
  const d = data.value
  const v = variable.value
  const unit = unitOf(v)
  const name = nameOf(v)
  if (!d) { chart.clear(); return }
  const series = view.value === 'mean' ? meanSeries(v) : pointsSeries(d, v)
  chart.setOption({
    animation: false,
    legend: { top: 0, right: 4, itemWidth: 12, textStyle: { fontSize: 11 }, data: series.map(s => s.name as string).filter(n => !n.startsWith('_')) },
    grid: { left: 56, right: 18, top: 24, bottom: 46 },
    tooltip: {
      trigger: 'item',
      formatter: (p: unknown) => {
        const { seriesName, value } = p as { seriesName: string, value: number[] }
        if (seriesName === 'Mean') {
          const r = meanBins.value[value[2]!]!
          return `${timeFmt(r.t, meanUnit.value)} · mean of ${r.platforms} platform${r.platforms === 1 ? '' : 's'}<br/>`
            + `${name}: ${fmt(v, show(v, r.mean))}`
            + (r.platforms > 1 ? `<br/><span style="opacity:.7">range ${fmt(v, show(v, r.lo), { unit: false })} – ${fmt(v, show(v, r.hi))}</span>` : '')
        }
        const i = value[2]!
        const pl = d.platforms[d.points.platform[i]!]!
        const isCast = pl.type === 'ctd' || pl.type === 'bottle'
        const n = d.points.n[i]!
        const when = isCast ? moment.utc(d.points.time[i]).tz(APP_TIMEZONE).format('YYYY-MM-DD HH:mm z') : timeFmt(value[0]!, d.bin)
        return `${platformLabel(pl)}<br/>${when}<br/>${name}: ${fmt(v, value[1])}`
          + `<br/><span style="opacity:.7">${n > 1 ? `mean of ${n}, ${fmt(v, show(v, d.points.min[i]!), { unit: false })} – ${fmt(v, show(v, d.points.max[i]!))} · ` : ''}`
          + `${isCast || pl.depth == null ? 'mean depth ' : ''}${d.points.depth[i]} m</span>`
      },
    },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', scale: true, name: unit ? `${name} (${unit})` : name, nameLocation: 'middle', nameGap: 42 },
    dataZoom: [{ type: 'inside', filterMode: 'none' }, { type: 'slider', height: 14, bottom: 6, filterMode: 'none' }],
    series,
  }, true)
}

watch([data, view, variable, () => mainStore.unitPreference[variable.value]], () => nextTick(render))
// The pane is v-show'd: measure again once it's on screen.
watch(() => props.active, (on) => { if (on) nextTick(() => chart?.resize()) })
watch(area, (a, old) => { if (a && !old) nextTick(() => { observe(); render() }) })

function observe() {
  if (!chartEl.value || !resizeObserver) return
  resizeObserver.disconnect()
  resizeObserver.observe(chartEl.value)
}
onMounted(() => {
  registerEchartsDarkTheme()
  resizeObserver = new ResizeObserver(() => chart?.resize())
  observe()
  nextTick(render)
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  chart?.dispose()
  chart = null
  if (timer) clearTimeout(timer)
})

// ── CSV ─────────────────────────────────────────────────────────────────────
const csvContext = computed<CsvContext | null>(() => {
  const a = area.value
  const d = data.value
  if (!a || !d) return null
  const times = d.points.time
  return {
    source: 'sensor',
    sourceLabel: `Observations within ${a.radiusKm} km (${sourcesLabel.value})`,
    variable: variable.value,
    variableName: nameOf(variable.value),
    unit: unitOf(variable.value),
    depth: null,
    locationLabel: `${a.radiusKm}km-around-${coordLabel(a.lat, a.lng)}`,
    latitude: a.lat,
    longitude: a.lng,
    timeRange: times.length ? [csvTimestamp(times[0]!), csvTimestamp(times[times.length - 1]!)] : null,
  }
})
const csvExport = provideCsvExport(csvContext)
const csvDatasets = csvExport.datasets
csvExport.register((): CsvDataset[] => {
  const ctx = csvContext.value
  const d = data.value
  const a = area.value
  if (!ctx || !d || !a) return []
  const v = variable.value
  const u = unitOf(v) || null
  const meta = csvMeta(ctx, [
    ['radius_km', a.radiusKm], ['depth_range_m', `${a.depthMin}-${a.depthMax}`],
    ['observation_period', periodLabel.value],
    ['casts', d.castsTruncated ? `latest ${counts.value.ctd + counts.value.bottle} of ${d.castsTotal}` : undefined],
  ])
  return [
    {
      label: 'Points', slug: 'area-points',
      columns: [
        { header: 'platform_type', accessorKey: 'type' }, { header: 'platform', accessorKey: 'platform' },
        { header: 'latitude', accessorKey: 'lat' }, { header: 'longitude', accessorKey: 'lon' },
        { header: 'time', accessorKey: 'time' }, { header: 'depth', accessorKey: 'depth', unit: 'm' },
        { header: 'value', accessorKey: 'value', unit: u }, { header: 'min', accessorKey: 'min', unit: u },
        { header: 'max', accessorKey: 'max', unit: u }, { header: 'n', accessorKey: 'n' },
      ],
      rows: d.points.time.map((t, i) => {
        const p = d.platforms[d.points.platform[i]!]!
        return {
          type: p.type, platform: p.type === 'sensor' || p.type === 'glider' || p.type === 'argo' ? p.name : p.id,
          lat: p.lat, lon: p.lon, time: csvTimestamp(t), depth: d.points.depth[i],
          value: show(v, d.points.value[i]!), min: show(v, d.points.min[i]!), max: show(v, d.points.max[i]!), n: d.points.n[i],
        }
      }),
      meta: [...meta, ['bin', BIN_LABEL[d.bin]]],
    },
    {
      label: 'Mean across platforms', slug: 'area-mean',
      columns: [
        { header: 'time', accessorKey: 'time' }, { header: 'mean', accessorKey: 'mean', unit: u },
        { header: 'platform_min', accessorKey: 'lo', unit: u }, { header: 'platform_max', accessorKey: 'hi', unit: u },
        { header: 'platforms', accessorKey: 'platforms' },
      ],
      rows: meanBins.value.map(r => ({
        time: csvTimestamp(r.t), mean: show(v, r.mean), lo: show(v, r.lo), hi: show(v, r.hi), platforms: r.platforms,
      })),
      meta: [...meta, ['bin', BIN_LABEL[meanUnit.value]], ['averaging', 'each platform once per bin; all casts of a kind in a bin count as one']],
    },
  ]
})
</script>

<style scoped>
.area-field {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--ui-text-muted);
}
.area-chart-wrap {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}
.area-chart {
  position: absolute;
  inset: 0;
}
.area-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ui-text-muted);
  font-size: 12.5px;
  pointer-events: none;
}
</style>
