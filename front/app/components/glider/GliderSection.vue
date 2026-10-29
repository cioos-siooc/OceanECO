<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="flex items-center mb-2" style="gap:8px;">
      <!-- Explore's own sub-view switch, passed in so it stays in one place. -->
      <slot name="views" />
      <SegmentedControl v-model="xAxis" :items="xAxisItems" size="xs" aria-label="Horizontal axis" />
      <UButton size="xs" variant="outline" color="neutral" :class="tilted ? 'oe-on' : ''"
        :aria-pressed="tilted" title="Tilt the map onto this track to see the section hanging under it, or back to flat"
        @click="mainStore.toggleGliderTilt()">3D</UButton>
      <UIcon v-if="loading" name="i-mdi-loading" class="animate-spin size-[14px] text-primary" />
      <div class="grow" />
      <span v-if="glider" class="range-label oe-num">{{ glider.id }} · {{ rangeLabel }}</span>
    </div>

    <UAlert v-if="loadError" color="error" variant="subtle" class="mb-2 shrink-0" :description="loadError" />

    <!-- A glider measures a handful of fields; anything else gets a pointer to what it does have. -->
    <div v-else-if="glider && !gliderHasVar" class="flex flex-col items-center justify-center grow text-center gap-2">
      <div class="text-muted text-sm">{{ glider.id }} doesn't measure {{ variableLabel(varId) }}.</div>
      <div class="flex gap-1">
        <UButton v-for="v in glider.variables" :key="v" size="xs" variant="outline" @click="mainStore.selectVariable(v)">
          {{ variableLabel(v) }}
        </UButton>
      </div>
    </div>

    <template v-else>
      <ChartContextBar :items="contextItems" />
      <div class="hm-slot">
        <!-- Keyed on the axis mode: the heatmap reads `xLabel` lazily and won't relabel on its own. -->
        <TimeDepthHeatmap v-if="section" :key="xAxis" :label="`GLIDER · ${xAxis === 'time' ? 'BY TIME' : 'ALONG TRACK'}`"
          :depths="section.depths" :values="displayValues" :bin-count="section.profiles.length"
          :color-fn="colorFn" :gridline-bins="gridlineBins" show-x-axis :x-label="xLabel"
          :tooltip-formatter="cellTooltip" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useMainStore } from '~/stores/main'
import { useVariableRegistry } from '~~/composables/useVariableRegistry'
import { fetchGliderSection, type GliderSectionResponse } from '~~/composables/useGliderSectionFetch'
import TimeDepthHeatmap from '../depth/TimeDepthHeatmap.vue'
import ChartContextBar, { type ContextItem } from '../ChartContextBar.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'

/**
 * One C-PROOF glider deployment as a depth x profile section. Every profile is
 * one column, so the x-axis is either its time or its distance along the
 * track — the glider moves, which is why this isn't Explore's time-binned view.
 * Colours follow the map's colorbar for the selected field (`colorFn`, in the
 * display unit).
 */
defineProps<{ colorFn: (v: number) => string }>()

const mainStore = useMainStore()
const { variableLabel, toDisplayValue, formatDisplayValue } = useVariableRegistry()
const glider = computed(() => mainStore.gliders.find(g => g.id === mainStore.selectedGliderId) ?? null)
const varId = computed(() => mainStore.selected_variable.var)
const gliderHasVar = computed(() => !!glider.value?.variables.includes(varId.value))
// Any tilt counts, however it got there: the button then flattens the map.
const tilted = computed(() => (mainStore.mapView?.pitch ?? 0) > 10)

const xAxis = ref<'time' | 'distance'>('time')
const xAxisItems = [
  { value: 'time', label: 'Time' },
  { value: 'distance', label: 'Distance' },
]

const section = ref<GliderSectionResponse | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)

let requestSeq = 0
watch([() => glider.value?.id, varId], async ([id, v]) => {
  section.value = null
  loadError.value = null
  if (!id || !gliderHasVar.value) return
  const seq = ++requestSeq
  loading.value = true
  try {
    const data = await fetchGliderSection(id, v)
    if (seq === requestSeq) section.value = data
  } catch (e: any) {
    if (seq === requestSeq) loadError.value = e?.response?.data?.detail ?? String(e)
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}, { immediate: true })

const displayValues = computed(() =>
  section.value?.values.map(row => row.map(v => v == null ? null : toDisplayValue(varId.value, v))) ?? [])

const gridlineBins = computed(() => Math.max(1, Math.round((section.value?.profiles.length ?? 1) / 8)))

const fmtDate = (iso: string, withTime = false) => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', timeZone: 'UTC',
  ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
})

const rangeLabel = computed(() => glider.value ? `${fmtDate(glider.value.start)} – ${fmtDate(glider.value.end)}` : '')

function xLabel(binIdx: number) {
  const s = section.value
  const i = Math.round(binIdx)
  if (!s || s.time[i] == null) return ''
  if (xAxis.value === 'distance') return `${Math.round(s.distanceKm[i]!)} km`
  // A short mission puts several gridlines in one day, so give them the hour.
  const spanDays = (Date.parse(s.time[s.time.length - 1]!) - Date.parse(s.time[0]!)) / 86_400_000
  return spanDays < 14 ? `${fmtDate(s.time[i]!, true)}` : fmtDate(s.time[i]!)
}

function cellTooltip(binIdx: number, depthIdx: number, value: number | null): string {
  const s = section.value
  if (!s) return ''
  const depth = s.depths[depthIdx]
  const valueStr = value == null ? 'no data' : formatDisplayValue(varId.value, value, { unit: true })
  return `<div style="opacity:.7;margin-bottom:2px;">${fmtDate(s.time[binIdx]!, true)} UTC &middot; ${depth?.toFixed(0)} m</div>`
    + `<div style="opacity:.7;margin-bottom:2px;">${s.lat[binIdx]!.toFixed(3)}°N ${Math.abs(s.lon[binIdx]!).toFixed(3)}°W &middot; ${s.distanceKm[binIdx]!.toFixed(1)} km along track</div>`
    + `<div>${variableLabel(varId.value)}: <b>${valueStr}</b></div>`
}

const contextItems = computed<ContextItem[]>(() => {
  const g = glider.value
  if (!g) return []
  return [
    { label: 'Field', value: variableLabel(varId.value) },
    { label: 'Glider', value: `${g.id} · ${g.profiles} profiles · ${Math.round(g.distanceKm)} km` },
    { label: 'Data', value: g.variant === 'grid' ? 'C-PROOF real-time, unscreened' : 'C-PROOF delayed mode', tone: 'muted' },
  ]
})
</script>

<style scoped>
.hm-slot {
  flex: 1 1 auto;
  min-height: 120px;
  position: relative;
}

.range-label {
  font-size: 11px;
  color: var(--ui-text-muted);
}
</style>
