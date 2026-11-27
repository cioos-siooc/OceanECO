<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="flex items-center" style="height: 38px; gap: 4px;">
      <div class="gp-header grow">
        <div class="gp-title truncate">{{ name }} · {{ variableLabel(varId) }}</div>
        <div class="gp-subtitle truncate">{{ subtitle }}</div>
      </div>
      <UIcon v-if="loading" name="i-mdi-loading" class="animate-spin size-[14px] text-primary shrink-0" />
      <DownloadButton :datasets="csvDatasets" size="xs" class="shrink-0" />
      <UButton
variant="ghost" color="neutral" size="xs" icon="i-mdi-close" class="shrink-0"
        aria-label="Close profiles" @click="mainStore.setIsVerticalProfileOpen(false)" />
    </div>

    <div v-if="pins.length" class="gp-pins">
      <span v-for="p in pins" :key="p.profile" class="gp-pin oe-num" :title="pinTitle(p)">
        <span class="gp-dot" :style="{ background: p.color }" />
        {{ pinLabel(p) }}
        <UButton
variant="link" color="neutral" size="xs" icon="i-mdi-close" class="gp-x"
          :aria-label="`Remove ${pinLabel(p)}`" @click="mainStore.unpinGliderProfile(p.profile)" />
      </span>
      <UButton v-if="pins.length > 1" variant="ghost" color="neutral" size="xs" @click="mainStore.clearGliderPins()">Clear</UButton>
    </div>
    <div class="gp-hint truncate">
      <template v-if="hover">Preview · {{ hover.label }}</template>
      <template v-else>Click the section to pin a profile · Shift-click to compare</template>
    </div>

    <UAlert v-if="loadError" color="error" variant="subtle" class="mb-2 shrink-0" :description="loadError" />
    <ChartContextBar v-if="pins.length" :items="contextItems" />
    <div ref="chartEl" class="gp-chart" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from '@/utils/echarts'
import { useMainStore, type GliderPin } from '~/stores/main'
import { chart as palette } from '@/config/palette'
import { useVariableRegistry } from '~~/composables/useVariableRegistry'
import { registerEchartsDarkTheme } from '~~/composables/useEchartsTheme'
import { fetchGliderProfile, type GliderProfileResponse } from '~~/composables/useGliderSectionFetch'
import { csvMeta, csvTimestamp, provideCsvExport, type CsvContext, type CsvDataset } from '~~/composables/useCsvExport'
import ChartContextBar, { type ContextItem } from '../ChartContextBar.vue'
import DownloadButton from '../ui/DownloadButton.vue'

/**
 * The profile drawer while a glider or Argo float is selected: the profiles
 * pinned from its section (GliderSection; click replaces, Shift-click adds),
 * each in its pin's colour at full resolution, the model's profile at the
 * latest pin where the model has one, and a dashed preview of the section
 * column under the cursor. The variable is the map's field, as the section's.
 */
const mainStore = useMainStore()
const { variableLabel, displayUnit, toDisplayValue, formatDisplayValue } = useVariableRegistry()

const glider = computed(() => mainStore.gliders.find(g => g.id === mainStore.selectedGliderId) ?? null)
const name = computed(() => (glider.value?.kind === 'argo' ? `Float ${glider.value.glider}` : glider.value?.id ?? ''))
const varId = computed(() => mainStore.selected_variable.var)
const source = computed(() => mainStore.selected_variable.source)
const pins = computed(() => mainStore.gliderPins)
const hover = computed(() => mainStore.gliderHover)

// ── Fetch ───────────────────────────────────────────────────────────────────
const profiles = ref<Record<number, GliderProfileResponse>>({})
const loading = ref(false)
const loadError = ref<string | null>(null)

/** The model overlays the latest pin only: one comparison stays readable. */
const latest = computed(() => pins.value[pins.value.length - 1] ?? null)

let seq = 0
// Keyed on the pin numbers, not the pins: recording a pin's fix mustn't refetch.
watch(() => [glider.value?.id, pins.value.map(p => p.profile).join(','), varId.value, source.value] as const, async ([id]) => {
  const req = ++seq
  loadError.value = null
  if (!id || !pins.value.length) { profiles.value = {}; loading.value = false; return }
  loading.value = true
  const last = latest.value!.profile
  try {
    const got = await Promise.all(pins.value.map(p =>
      fetchGliderProfile(id, p.profile, varId.value, p.profile === last ? source.value : null)))
    if (req !== seq) return
    profiles.value = Object.fromEntries(pins.value.map((p, i) => [p.profile, got[i]!]))
    for (const p of pins.value) {
      const r = profiles.value[p.profile]!
      if (p.fix?.time !== r.time) mainStore.setGliderPinFix(p.profile, { lon: r.lon, lat: r.lat, time: r.time })
    }
  } catch (e: any) {
    if (req === seq) loadError.value = e?.response?.data?.detail ?? 'Could not load this profile.'
  } finally {
    if (req === seq) loading.value = false
  }
}, { immediate: true })

// ── Labels ──────────────────────────────────────────────────────────────────
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-CA', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
})
const pinLabel = (p: GliderPin) => {
  const r = profiles.value[p.profile]
  return r ? r.time.slice(0, 10) : `#${p.profile}`
}
const pinTitle = (p: GliderPin) => {
  const r = profiles.value[p.profile]
  return r ? `Profile ${r.profile} · ${fmtTime(r.time)} UTC · ${r.lat.toFixed(3)}°, ${r.lon.toFixed(3)}°` : `Profile ${p.profile}`
}
const subtitle = computed(() => {
  const n = pins.value.length
  if (!n) return 'No profile pinned'
  const r = latest.value && profiles.value[latest.value.profile]
  return n === 1 && r ? `${fmtTime(r.time)} UTC` : `${n} profiles`
})

const model = computed(() => (latest.value ? profiles.value[latest.value.profile]?.model ?? null : null))
const modelLabel = computed(() => (model.value ? `${model.value.source}${model.value.binMode === 'daily' ? ' · daily mean' : ' · nearest hour'}` : ''))

const contextItems = computed<ContextItem[]>(() => {
  const r = latest.value && profiles.value[latest.value.profile]
  if (!r) return []
  const items: ContextItem[] = [{ label: 'Latest', value: `${r.lat.toFixed(3)}°, ${r.lon.toFixed(3)}°`, title: `Profile ${r.profile}` }]
  if (model.value) items.push({ label: 'Model', value: modelLabel.value })
  else items.push({ label: 'Model', value: 'no data here', tone: 'muted', title: r.modelError?.message })
  return items
})

// ── Chart ───────────────────────────────────────────────────────────────────
const chartEl = ref<HTMLElement | null>(null)
let chart: echarts.ECharts | null = null
let resizeObserver: ResizeObserver | null = null

function render() {
  if (!chartEl.value) return
  if (!chart) chart = echarts.init(chartEl.value, 'dark', { renderer: 'canvas' })
  const v = varId.value
  const series: echarts.SeriesOption[] = []
  for (const p of pins.value) {
    const r = profiles.value[p.profile]
    if (!r) continue
    series.push({
      name: pinTitle(p), type: 'line', data: r.depth.map((d, i) => [toDisplayValue(v, r.value[i]!), d]),
      showSymbol: false, lineStyle: { width: 1.5, color: p.color }, itemStyle: { color: p.color },
    })
  }
  const m = model.value
  if (m) {
    series.push({
      name: `Model · ${modelLabel.value}`, type: 'line', data: m.depth.map((d, i) => [toDisplayValue(v, m.value[i]!), d]),
      showSymbol: true, symbolSize: 3, lineStyle: { width: 1.5, color: palette.model }, itemStyle: { color: palette.model },
    })
  }
  const h = hover.value
  if (h) {
    series.push({
      name: `Preview · ${h.label}`, type: 'line',
      data: h.depths.flatMap((d, i) => (h.values[i] == null ? [] : [[h.values[i]!, d]])),
      showSymbol: false, silent: true, lineStyle: { width: 1.5, type: 'dashed', color: palette.text },
    })
  }
  const unit = displayUnit(v)
  chart.setOption({
    animation: false,
    grid: { left: 40, right: 14, top: 10, bottom: 40 },
    tooltip: {
      trigger: 'item',
      formatter: (p: unknown) => {
        const { seriesName, value } = p as { seriesName: string, value: [number, number] }
        return `${seriesName}<br/>${variableLabel(v)}: ${formatDisplayValue(v, value?.[0], { unit: true })}<br/>${Number(value?.[1]).toFixed(1)} m below surface`
      },
    },
    xAxis: {
      type: 'value', scale: true, name: unit ? `${variableLabel(v)} (${unit})` : variableLabel(v),
      nameLocation: 'middle', nameGap: 26, splitNumber: 4,
      axisLabel: { hideOverlap: true, formatter: (x: number) => formatDisplayValue(v, x) },
    },
    yAxis: { type: 'value', inverse: true, name: 'Depth (m)', nameLocation: 'middle', nameGap: 28, min: 0 },
    series,
  }, true)
}

// The preview moves with the mouse: repaint on the next frame, not per event.
let frame = 0
const scheduleRender = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render() }) }
watch([profiles, hover, varId, () => mainStore.unitPreference[varId.value]], () => nextTick(scheduleRender))

onMounted(() => {
  registerEchartsDarkTheme()
  resizeObserver = new ResizeObserver(() => chart?.resize())
  if (chartEl.value) resizeObserver.observe(chartEl.value)
  nextTick(render)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  resizeObserver?.disconnect()
  chart?.dispose()
  chart = null
})

// ── CSV ─────────────────────────────────────────────────────────────────────
const csvContext = computed<CsvContext | null>(() => {
  const g = glider.value
  const rs = pins.value.map(p => profiles.value[p.profile]).filter(r => !!r)
  if (!g || !rs.length) return null
  const last = rs[rs.length - 1]!
  const times = rs.map(r => r.time).sort()
  return {
    source: 'sensor',
    sourceLabel: g.kind === 'argo' ? `Argo float ${g.glider}` : `C-PROOF glider ${g.id}`,
    sourceUrl: g.kind === 'argo' ? g.fileUrl : `https://cproof.uvic.ca/gliderdata/deployments/${g.glider}/${g.id}/`,
    variable: varId.value,
    variableName: variableLabel(varId.value),
    unit: displayUnit(varId.value),
    depth: null,
    locationLabel: name.value,
    latitude: last.lat,
    longitude: last.lon,
    timeRange: [csvTimestamp(times[0]!), csvTimestamp(times[times.length - 1]!)],
  }
})
const csvExport = provideCsvExport(csvContext)
const csvDatasets = csvExport.datasets
csvExport.register((): CsvDataset[] => {
  const ctx = csvContext.value
  if (!ctx) return []
  const v = varId.value
  const u = displayUnit(v) || null
  const columns = [{ header: 'depth', accessorKey: 'depth', unit: 'm' }, { header: 'value', accessorKey: 'value', unit: u }]
  const files: CsvDataset[] = pins.value.flatMap((p) => {
    const r = profiles.value[p.profile]
    if (!r) return []
    return [{
      label: `Profile ${r.profile} (${fmtTime(r.time)})`, slug: `profile-${r.profile}`, columns,
      rows: r.depth.map((d, i) => ({ depth: d, value: toDisplayValue(v, r.value[i]!) })),
      meta: csvMeta({ ...ctx, latitude: r.lat, longitude: r.lon, timeRange: [csvTimestamp(r.time), csvTimestamp(r.time)] },
        [['profile', String(r.profile)]]),
    }]
  })
  const m = model.value
  if (m && latest.value) {
    files.push({
      label: `Model (${modelLabel.value})`, slug: 'profile-model', columns,
      rows: m.depth.map((d, i) => ({ depth: d, value: toDisplayValue(v, m.value[i]!) })),
      meta: csvMeta({ ...ctx, source: 'model', sourceLabel: `${m.source} model, nearest cell to profile ${latest.value.profile}`, sourceUrl: null },
        [['bin', m.binMode === 'daily' ? 'daily mean' : 'nearest hour']]),
    })
  }
  return files
})
</script>

<style scoped>
.gp-header { min-width: 0; line-height: 1.25; }
.gp-title { font-weight: 500; font-size: 12.5px; color: var(--ui-text); }
.gp-subtitle { font-size: 11px; color: var(--ui-text-muted); }
.gp-pins { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-bottom: 4px; }
.gp-pin {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; padding: 1px 0 1px 6px; border-radius: 3px;
  border: 1px solid var(--ui-border); color: var(--ui-text);
}
.gp-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.gp-x { padding: 1px; }
.gp-hint { font-size: 11px; color: var(--ui-text-muted); margin-bottom: 4px; }
.gp-chart { flex: 1 1 auto; min-height: 0; width: 100%; }
</style>
