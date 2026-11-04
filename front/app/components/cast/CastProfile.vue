<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="flex items-center mb-2" style="gap:8px;">
      <!-- Explore's own sub-view switch, passed in so it stays in one place. -->
      <slot name="views" />
      <SegmentedControl v-if="varItems.length" v-model="castVar" :items="varItems" size="xs" aria-label="Cast variable" />
      <UIcon v-if="loading" name="i-mdi-loading" class="animate-spin size-[14px] text-primary" />
      <div class="grow" />
      <DownloadButton :datasets="csvDatasets" size="xs" class="shrink-0" />
      <span v-if="cast" class="range-label oe-num">{{ kindLabel }} · {{ timeLabel }}</span>
    </div>

    <UAlert v-if="loadError" color="error" variant="subtle" class="mb-2 shrink-0" :description="loadError" />

    <template v-else>
      <ChartContextBar :items="contextItems" />
      <div ref="chartEl" class="cast-chart" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import axios from 'axios'
import moment from 'moment-timezone'
import * as echarts from 'echarts'
import { useRuntimeConfig } from '#app'
import { useMainStore, type CastVariableMeta } from '~/stores/main'
import { APP_TIMEZONE } from '@/config/app'
import { chart as palette } from '@/config/palette'
import { useVariableRegistry } from '~~/composables/useVariableRegistry'
import { registerEchartsDarkTheme } from '~~/composables/useEchartsTheme'
import { csvMeta, csvTimestamp, provideCsvExport, type CsvContext, type CsvDataset } from '~~/composables/useCsvExport'
import ChartContextBar, { type ContextItem } from '../ChartContextBar.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import DownloadButton from '../ui/DownloadButton.vue'

/**
 * One DFO IOS ship cast: a variable's observed profile (value against depth),
 * with the model's profile at the nearest cell and time overlaid when the
 * variable is modelled and the model has data there. Casts reach back to 1930
 * and well past the model's domain, so the model line is a bonus, never a
 * condition: when it's absent the context bar says why.
 *
 * A modelled variable is picked through the map's field (as glider and sensor
 * views follow it); an observation-only one (nutrients, chlorophyll) stays a
 * local choice, since the map has no layer for it.
 */
interface Profile { depth: number[], value: number[] }
interface CastProfileResponse {
  cast: { id: string, dataset: string, kind: 'ctd' | 'bottle', mission: string, time: string, lat: number, lon: number, area: string, maxDepth: number }
  profiles: Record<string, Profile>
  model: (Profile & { source: string, binMode: 'hourly' | 'daily' }) | null
  modelError: { code: string, message: string } | null
}

const ERDDAP = 'https://data.cioospacific.ca/erddap/tabledap'

const mainStore = useMainStore()
const config = useRuntimeConfig()
const { toDisplayValue, displayUnit, formatDisplayValue } = useVariableRegistry()

const data = ref<CastProfileResponse | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
const cast = computed(() => data.value?.cast ?? null)

// ── Variable ────────────────────────────────────────────────────────────────
const metaOf = (v: string): CastVariableMeta | undefined => mainStore.castVariables[v]
const available = computed(() => {
  const present = new Set(Object.keys(data.value?.profiles ?? {}))
  // Registry order (model variables first), so every cast lists them alike.
  return Object.keys(mainStore.castVariables).filter(v => present.has(v))
})
const localVar = ref<string | null>(null)
const castVar = computed<string>({
  get: () => {
    const vars = available.value
    if (localVar.value && vars.includes(localVar.value)) return localVar.value
    const field = mainStore.selected_variable.var
    if (vars.includes(field)) return field
    return vars[0] ?? ''
  },
  set: (v: string) => {
    if (metaOf(v)?.modelled) {
      localVar.value = null
      if (v !== mainStore.selected_variable.var) mainStore.selectVariable(v)
    } else {
      localVar.value = v
    }
  },
})
const varItems = computed(() => available.value.map(v => ({ value: v, label: metaOf(v)?.short ?? v, title: metaOf(v)?.name })))
const modelled = computed(() => !!metaOf(castVar.value)?.modelled)

// Modelled variables follow the user's unit preference; observation-only ones
// have a single unit, straight from the registry's observed section.
const unitOf = (v: string) => (metaOf(v)?.modelled ? displayUnit(v) : metaOf(v)?.unit ?? '')
const show = (v: string, x: number) => (metaOf(v)?.modelled ? toDisplayValue(v, x) : x)
function fmt(v: string, x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return '—'
  if (metaOf(v)?.modelled) return formatDisplayValue(v, x, { unit: true })
  const step = metaOf(v)?.precision ?? 0.01
  const decimals = Math.min(3, Math.max(0, Math.ceil(-Math.log10(step))))
  return `${x.toFixed(decimals)}${unitOf(v) ? ` ${unitOf(v)}` : ''}`
}

// ── Fetch ───────────────────────────────────────────────────────────────────
// Every variable's profile comes in one response; the model half only for the
// one asked about, so a variable change refetches (cheap, and cached here).
const cache = new Map<string, CastProfileResponse>()
let request = 0
async function load() {
  const id = mainStore.selectedCastId
  if (!id) { data.value = null; return }
  // The variable on show once this cast's data is in; before that, the map's field.
  const shown = data.value?.cast.id === id ? castVar.value : mainStore.selected_variable.var
  const modelVar = metaOf(shown)?.modelled ? shown : null
  const body = { castId: id, source: modelVar ? mainStore.selected_variable.source : null, modelVar }
  const key = JSON.stringify(body)
  const req = ++request
  loadError.value = null
  if (cache.has(key)) { data.value = cache.get(key)!; return }
  loading.value = true
  try {
    const r = await axios.post(`${config.public.apiBaseUrl}/castProfile`, body)
    if (req !== request) return
    cache.set(key, r.data)
    data.value = r.data
  } catch (e) {
    if (req !== request) return
    loadError.value = (axios.isAxiosError(e) && e.response?.data?.detail) || 'Could not load this cast.'
  } finally {
    if (req === request) loading.value = false
  }
}
watch(() => mainStore.selectedCastId, () => { localVar.value = null; load() }, { immediate: true })
watch([castVar, () => mainStore.selected_variable.source], () => load())

// ── Labels ──────────────────────────────────────────────────────────────────
const kindLabel = computed(() => (cast.value?.kind === 'bottle' ? 'Bottle cast' : 'CTD cast'))
const timeLabel = computed(() => (cast.value ? moment.utc(cast.value.time).tz(APP_TIMEZONE).format('YYYY-MM-DD HH:mm z') : ''))
const coordLabel = computed(() => {
  const c = cast.value
  if (!c) return ''
  return `${Math.abs(c.lat).toFixed(3)}${c.lat >= 0 ? 'N' : 'S'} ${Math.abs(c.lon).toFixed(3)}${c.lon >= 0 ? 'E' : 'W'}`
})
const model = computed(() => (modelled.value ? data.value?.model ?? null : null))
const modelLabel = computed(() => (model.value ? `${model.value.source}${model.value.binMode === 'daily' ? ' · daily mean' : ' · nearest hour'}` : ''))

const contextItems = computed<ContextItem[]>(() => {
  const c = cast.value
  if (!c) return []
  const items: ContextItem[] = [
    { label: 'Cast', value: `${kindLabel.value} · ${c.mission || c.id}`, title: `IOS profile ${c.id}${c.area ? ` · ${c.area}` : ''}` },
    { label: 'Point', value: coordLabel.value },
    { label: 'Range', value: `0–${Math.round(c.maxDepth)} m` },
  ]
  if (!modelled.value) items.push({ label: 'Model', value: 'not modelled', tone: 'muted' })
  else if (model.value) items.push({ label: 'Model', value: modelLabel.value })
  else items.push({ label: 'Model', value: 'no data here', tone: 'muted', title: data.value?.modelError?.message })
  return items
})

// ── Chart ───────────────────────────────────────────────────────────────────
const chartEl = ref<HTMLElement | null>(null)
let chart: echarts.ECharts | null = null
let resizeObserver: ResizeObserver | null = null

function render() {
  if (!chartEl.value || !data.value) return
  if (!chart) chart = echarts.init(chartEl.value, 'dark', { renderer: 'canvas' })
  const v = castVar.value
  const obs = data.value.profiles[v]
  const isBottle = cast.value?.kind === 'bottle'
  const label = metaOf(v)?.name ?? v
  const unit = unitOf(v)
  const series: echarts.SeriesOption[] = []
  if (obs) {
    series.push({
      name: kindLabel.value, type: 'line', data: obs.depth.map((d, i) => [show(v, obs.value[i]!), d]),
      showSymbol: isBottle, symbolSize: 6,
      lineStyle: { width: 1.5, color: palette.sensor }, itemStyle: { color: palette.sensor },
    })
  }
  if (model.value) {
    const m = model.value
    series.push({
      name: modelLabel.value, type: 'line', data: m.depth.map((d, i) => [show(v, m.value[i]!), d]),
      showSymbol: true, symbolSize: 3,
      lineStyle: { width: 1.5, color: palette.model }, itemStyle: { color: palette.model },
    })
  }
  chart.setOption({
    animation: false,
    legend: { top: 0, right: 8 },
    grid: { left: 56, right: 24, top: 28, bottom: 40 },
    tooltip: {
      trigger: 'item',
      formatter: (p: unknown) => {
        const { seriesName, value } = p as { seriesName: string, value: [number, number] }
        return `${seriesName}<br/>${label}: ${fmt(v, value?.[0])}<br/>${Number(value?.[1]).toFixed(1)} m below surface`
      },
    },
    xAxis: {
      type: 'value', scale: true, name: unit ? `${label} (${unit})` : label,
      nameLocation: 'middle', nameGap: 26, axisLabel: { hideOverlap: true },
    },
    yAxis: { type: 'value', inverse: true, name: 'Depth (m)', nameLocation: 'middle', nameGap: 40, min: 0 },
    series,
  }, true)
}

watch([data, castVar, () => mainStore.unitPreference[castVar.value]], () => nextTick(render))

onMounted(() => {
  registerEchartsDarkTheme()
  resizeObserver = new ResizeObserver(() => chart?.resize())
  if (chartEl.value) resizeObserver.observe(chartEl.value)
  nextTick(render)
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  chart?.dispose()
  chart = null
})

// ── CSV ─────────────────────────────────────────────────────────────────────
const csvContext = computed<CsvContext | null>(() => {
  const c = cast.value
  if (!c || !castVar.value) return null
  return {
    source: 'sensor',
    sourceLabel: `DFO IOS ${c.kind === 'bottle' ? 'bottle' : 'CTD'} cast ${c.id}`,
    sourceUrl: `${ERDDAP}/${c.dataset}.html`,
    variable: castVar.value,
    variableName: metaOf(castVar.value)?.name ?? castVar.value,
    unit: unitOf(castVar.value),
    depth: null,
    locationLabel: c.id,
    latitude: c.lat,
    longitude: c.lon,
    timeRange: [csvTimestamp(c.time), csvTimestamp(c.time)],
  }
})
const csvExport = provideCsvExport(csvContext)
const csvDatasets = csvExport.datasets
csvExport.register((): CsvDataset[] => {
  const ctx = csvContext.value
  const v = castVar.value
  const obs = data.value?.profiles[v]
  if (!ctx || !obs) return []
  const u = unitOf(v) || null
  const files: CsvDataset[] = [{
    label: kindLabel.value, slug: 'cast',
    columns: [{ header: 'depth', accessorKey: 'depth', unit: 'm' }, { header: 'value', accessorKey: 'value', unit: u }],
    rows: obs.depth.map((d, i) => ({ depth: d, value: show(v, obs.value[i]!) })),
    meta: csvMeta(ctx, [['mission', cast.value?.mission], ['area', cast.value?.area]]),
  }]
  const m = model.value
  if (m) {
    files.push({
      label: `Model (${modelLabel.value})`, slug: 'cast-model',
      columns: [{ header: 'depth', accessorKey: 'depth', unit: 'm' }, { header: 'value', accessorKey: 'value', unit: u }],
      rows: m.depth.map((d, i) => ({ depth: d, value: show(v, m.value[i]!) })),
      meta: csvMeta({ ...ctx, source: 'model', sourceLabel: `${m.source} model, nearest cell to cast ${cast.value?.id}`, sourceUrl: null },
        [['bin', m.binMode === 'daily' ? 'daily mean' : 'nearest hour']]),
    })
  }
  return files
})
</script>

<style scoped>
.cast-chart {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
}
</style>
