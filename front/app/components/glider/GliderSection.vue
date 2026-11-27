<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="flex items-center mb-2" style="gap:8px;">
      <!-- Explore's own sub-view switch, passed in so it stays in one place. -->
      <slot name="views" />
      <SegmentedControl v-model="xAxis" :items="xAxisItems" size="xs" aria-label="Horizontal axis" />
      <UButton size="xs" variant="outline" color="neutral" :class="tilted ? 'oe-on' : ''"
        :aria-pressed="tilted" title="Tilt the map onto this track to see the section hanging under it, or back to flat"
        @click="mainStore.toggleGliderTilt()">3D</UButton>
      <UButton size="xs" variant="outline" color="neutral" :class="mainStore.showSeafloor ? 'oe-on' : ''"
        :aria-pressed="mainStore.showSeafloor" title="Show the seafloor around the track when the map is tilted"
        @click="mainStore.setShowSeafloor(!mainStore.showSeafloor)">Seafloor</UButton>
      <UButton v-if="mainStore.gliderRange" size="xs" variant="ghost" color="neutral" icon="i-mdi-arrow-expand-horizontal"
        title="Zoom back out to the whole deployment" @click="mainStore.setGliderRange(null)">Whole track</UButton>
      <UIcon v-if="loading" name="i-mdi-loading" class="animate-spin size-[14px] text-primary" />
      <div class="grow" />
      <span v-if="glider" class="range-label oe-num">{{ name }} · {{ rangeLabel }}</span>
    </div>

    <UAlert v-if="loadError" color="error" variant="subtle" class="mb-2 shrink-0" :description="loadError" />

    <!-- A glider measures a handful of fields; anything else gets a pointer to what it does have. -->
    <div v-else-if="glider && !gliderHasVar" class="flex flex-col items-center justify-center grow text-center gap-2">
      <div class="text-muted text-sm">{{ name }} doesn't measure {{ variableLabel(varId) }}.</div>
      <div class="flex gap-1">
        <UButton v-for="v in glider.variables" :key="v" size="xs" variant="outline" @click="mainStore.selectVariable(v)">
          {{ variableLabel(v) }}
        </UButton>
      </div>
    </div>

    <template v-else>
      <ChartContextBar :items="contextItems" />
      <div class="hm-slot">
        <GliderSectionChart v-if="overview" :key="glider!.id" :label="`${glider!.kind === 'argo' ? 'ARGO FLOAT' : 'GLIDER'} · ${xAxis === 'time' ? 'BY TIME' : 'ALONG TRACK'}`"
          :overview="overview" :detail="detail" :extent="section!.extent" :range="mainStore.gliderRange"
          :rgb-fn="rgbFn" :x-label="xLabel" :tooltip-formatter="cellTooltip" :marks="mainStore.gliderPins"
          @range="mainStore.setGliderRange($event)" @pick="(p, add) => mainStore.pinGliderProfile(p, add)" @hover="onHover" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useMainStore } from '~/stores/main'
import { useVariableRegistry } from '~~/composables/useVariableRegistry'
import { useFieldColorRamp } from '~~/composables/useFieldColorRamp'
import { fetchGliderSection, sectionInPeriod, type GliderSectionResponse } from '~~/composables/useGliderSectionFetch'
import GliderSectionChart, { type SectionLayer } from './GliderSectionChart.vue'
import ChartContextBar, { type ContextItem } from '../ChartContextBar.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'

/**
 * One C-PROOF glider deployment or Argo float (its cycles as profiles) as a depth x profile section. The x-axis runs
 * over profile numbers, labelled with their time or their distance along the
 * track — the glider moves, which is why this isn't Explore's time-binned view.
 * The whole deployment comes averaged to panel resolution; zooming in (the
 * x slider, or the wheel) asks again for just the window, down to single
 * profiles, and the map highlights that stretch of the track. Colours follow
 * the map's colorbar for the selected field.
 */
const mainStore = useMainStore()
const { variableLabel, toDisplayValue, formatDisplayValue } = useVariableRegistry()
const { rgbFn } = useFieldColorRamp()
const glider = computed(() => mainStore.gliders.find(g => g.id === mainStore.selectedGliderId) ?? null)
const varId = computed(() => mainStore.selected_variable.var)
const name = computed(() => (glider.value?.kind === 'argo' ? `Float ${glider.value.glider}` : glider.value?.id ?? ''))
const gliderHasVar = computed(() => !!glider.value?.variables.includes(varId.value))
// Any tilt counts, however it got there: the button then flattens the map.
const tilted = computed(() => (mainStore.mapView?.pitch ?? 0) > 10)

const xAxis = ref<'time' | 'distance'>('time')
const xAxisItems = [
  { value: 'time', label: 'Time' },
  { value: 'distance', label: 'Distance' },
]

const section = ref<GliderSectionResponse | null>(null)
const detailSection = ref<GliderSectionResponse | null>(null)
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

// The zoomed window at finer resolution; the overview fills in until it lands.
// Not needed when the overview is already one profile per column.
let detailSeq = 0
watch([section, () => mainStore.gliderRange], async ([s, range]) => {
  const seq = ++detailSeq
  if (!s || !range || s.perColumn === 1) { detailSection.value = null; return }
  try {
    const data = await fetchGliderSection(glider.value!.id, varId.value, range)
    if (seq === detailSeq) detailSection.value = data
  } catch (e) {
    console.warn('glider section window failed:', e)
  }
}, { immediate: true })

// Columns outside the observation period are blanked, as the map clips the track.
function toLayer(raw: GliderSectionResponse): SectionLayer {
  const s = sectionInPeriod(raw, mainStore.obsResolved)
  return {
    profiles: s.profiles,
    profileEnd: s.profileEnd,
    depths: s.depths,
    values: s.values.map(row => row.map(v => v == null ? null : toDisplayValue(varId.value, v))),
  }
}
const overview = computed(() => section.value ? toLayer(section.value) : null)
const detail = computed(() => detailSection.value ? toLayer(detailSection.value) : null)

/** The response a layer came from, for its columns' times and positions. */
const sourceOf = (layer: SectionLayer) => layer === detail.value ? detailSection.value! : section.value!

/** The finest column covering profile number `p` (clamped to the ends). */
function columnAt(p: number): { s: GliderSectionResponse, i: number } | null {
  const d = detailSection.value
  const s = d && p >= d.profiles[0]! && p <= d.profileEnd[d.profileEnd.length - 1]! ? d : section.value
  if (!s) return null
  let i = s.profiles.findIndex(start => start > p) - 1
  if (i < 0) i = p < s.profiles[0]! ? 0 : s.profiles.length - 1
  return { s, i }
}

const fmtDate = (iso: string, withTime = false) => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', timeZone: 'UTC',
  ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
})

/** Times at the ends of the zoom window (the whole deployment when not zoomed). */
const windowTimes = computed(() => {
  const s = section.value
  if (!s) return null
  const r = mainStore.gliderRange ?? s.extent
  const a = columnAt(r[0]), b = columnAt(r[1])
  return a && b ? [a.s.time[a.i]!, b.s.time[b.i]!] as const : null
})

const rangeLabel = computed(() => {
  const t = windowTimes.value
  return t ? `${fmtDate(t[0])} – ${fmtDate(t[1])}` : ''
})

// A new function per axis mode / window, so the chart relabels.
const xLabel = computed(() => {
  const mode = xAxis.value
  const t = windowTimes.value
  // Profiles come unevenly in time, so a few weeks' window can already put
  // two labels on one day: give them the hour.
  const withTime = !!t && Date.parse(t[1]) - Date.parse(t[0]) < 45 * 86_400_000
  return (p: number) => {
    const c = columnAt(p)
    if (!c) return ''
    return mode === 'distance' ? `${Math.round(c.s.distanceKm[c.i]!)} km` : fmtDate(c.s.time[c.i]!, withTime)
  }
})

function cellTooltip(layer: SectionLayer, col: number, row: number, value: number | null): string {
  const s = sourceOf(layer)
  const step = s.depths.length > 1 ? s.depths[1]! - s.depths[0]! : 1
  const d = s.depths[row]!
  const depth = step > 1.5 ? `${Math.max(0, d - step / 2).toFixed(0)}–${(d + step / 2).toFixed(0)} m` : `${d.toFixed(0)} m`
  const p0 = s.profiles[col]!, p1 = s.profileEnd[col]!
  const profiles = p1 > p0 ? `profiles ${p0}–${p1}, averaged` : `profile ${p0}`
  const valueStr = value == null ? 'no data' : formatDisplayValue(varId.value, value, { unit: true })
  return `<div style="opacity:.7;margin-bottom:2px;">${fmtDate(s.time[col]!, true)} UTC &middot; ${depth}</div>`
    + `<div style="opacity:.7;margin-bottom:2px;">${s.lat[col]!.toFixed(3)}°N ${Math.abs(s.lon[col]!).toFixed(3)}°W &middot; ${s.distanceKm[col]!.toFixed(1)} km along track &middot; ${profiles}</div>`
    + `<div>${variableLabel(varId.value)}: <b>${valueStr}</b></div>`
}

// The column under the cursor, previewed in the profile drawer from the
// section's own (averaged) values: no request, so it keeps up with the mouse.
function onHover(cell: { layer: SectionLayer, col: number } | null) {
  if (!cell) { mainStore.setGliderHover(null); return }
  const s = sourceOf(cell.layer)
  const p0 = s.profiles[cell.col]!, p1 = s.profileEnd[cell.col]!
  mainStore.setGliderHover({
    label: `${fmtDate(s.time[cell.col]!, true)} UTC · ${p1 > p0 ? `profiles ${p0}–${p1}` : `profile ${p0}`}`,
    lon: s.lon[cell.col]!,
    lat: s.lat[cell.col]!,
    depths: cell.layer.depths,
    values: cell.layer.values.map(row => row[cell.col] ?? null),
  })
}
onBeforeUnmount(() => mainStore.setGliderHover(null))

const contextItems = computed<ContextItem[]>(() => {
  const g = glider.value
  if (!g) return []
  const s = detailSection.value ?? section.value
  const step = s && s.depths.length > 1 ? Math.round(s.depths[1]! - s.depths[0]!) : 1
  const averaged = s && (s.perColumn > 1 || step > 1)
  return [
    { label: 'Field', value: variableLabel(varId.value) },
    { label: g.kind === 'argo' ? 'Argo' : 'Glider', value: `${name.value} · ${g.profiles} profiles · ${Math.round(g.distanceKm)} km` },
    ...(averaged ? [{ label: 'Cell', value: `${s!.perColumn} profile${s!.perColumn > 1 ? 's' : ''} × ${step} m, averaged`, tone: 'muted' as const }] : []),
    { label: 'Data', value: g.kind === 'argo' ? "Argo QC'd, adjusted where available" : g.variant === 'grid' ? 'C-PROOF real-time, unscreened' : 'C-PROOF delayed mode', tone: 'muted' },
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
