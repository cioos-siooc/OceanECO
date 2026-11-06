<template>
    <UPopover v-model:open="open" :content="{ side: 'bottom', align: 'start' }">
        <UButton
variant="outline" color="neutral" size="xs" icon="i-mdi-calendar-range"
            class="w-full justify-start min-w-0" :class="active ? 'oe-on' : ''"
            :title="`Observation period: ${summary}. Applies to sensors, gliders and ship casts; the model follows the map date.`"
            aria-label="Observation period">
            <span class="truncate">{{ summary }}</span>
        </UButton>

        <template #content>
            <div class="obs-period">
                <div class="flex items-center justify-between">
                    <span class="oe-label">Observation period</span>
                    <UButton variant="ghost" size="xs" :disabled="!active" @click="reset">Reset</UButton>
                </div>
                <p class="text-xs text-muted">
                    Which sensors, glider stretches and ship casts the map and list show. The model follows the map date.
                </p>

                <!-- Data per year, one row per kind; drag across it to pick years. -->
                <div
ref="stripEl" class="obs-period__strip" role="img"
                    :aria-label="`Observations per year, ${years[0]}–${years[years.length - 1]}`" />

                <div class="obs-period__row">
                    <USelect
v-model="fromYear" :items="fromItems" size="xs" class="grow" :disabled="followsMapDate"
                        aria-label="First year" />
                    <span class="text-xs text-muted">to</span>
                    <USelect
v-model="toYear" :items="toItems" size="xs" class="grow" :disabled="followsMapDate"
                        aria-label="Last year" />
                </div>
                <div class="obs-period__row">
                    <UButton
v-for="p in RELATIVE" :key="p.label" size="xs" variant="outline" color="neutral"
                        :disabled="followsMapDate" @click="setRelative(p.days)">{{ p.label }}</UButton>
                </div>

                <USeparator />

                <div class="flex flex-col gap-1.5" :class="{ 'opacity-50': aroundOn }">
                    <span class="oe-label">Months</span>
                    <div class="obs-period__months" role="group" aria-label="Months">
                        <UButton
v-for="(abbr, i) in MONTH_ABBR" :key="abbr" size="xs" color="neutral"
                            :variant="monthSet.has(i + 1) ? 'solid' : 'outline'" :aria-pressed="monthSet.has(i + 1)"
                            :disabled="aroundOn" class="justify-center" @click="toggleMonth(i + 1)">{{ abbr }}</UButton>
                    </div>
                    <div class="obs-period__seasons" role="group" aria-label="Seasons">
                        <UButton
v-for="s in SEASONS" :key="s.id" size="xs" color="neutral"
                            :variant="isSeason(s.months) ? 'solid' : 'outline'" :aria-pressed="isSeason(s.months)"
                            :disabled="aroundOn" class="justify-center"
                            :title="s.months.map(m => MONTH_ABBR[m - 1]).join(', ')" @click="toggleSeason(s.months)">{{ s.label }}</UButton>
                    </div>
                </div>

                <USeparator />

                <div class="flex flex-col gap-1.5">
                    <USwitch v-model="aroundOn" size="sm" :label="`Around the map date${mapDateLabel ? ` (${mapDateLabel})` : ''}`" />
                    <div class="obs-period__row" :class="{ 'opacity-50': !aroundOn }">
                        <span class="text-xs text-muted">±</span>
                        <UInputNumber
v-model="aroundDays" :min="0" :max="182" :step="1" size="xs" class="w-24"
                            :disabled="!aroundOn" aria-label="Days either side of the map date" />
                        <span class="text-xs text-muted">days</span>
                        <UCheckbox v-model="aroundEveryYear" :disabled="!aroundOn" size="sm" label="in every year" class="ms-auto" />
                    </div>
                </div>

                <USeparator />

                <div class="flex items-center justify-between gap-2">
                    <span class="oe-label">Time of day</span>
                    <SegmentedControl v-model="diel" :items="DIEL_ITEMS" size="xs" aria-label="Time of day" />
                </div>

                <div class="text-xs text-muted oe-num">
                    {{ mainStore.castsTotal.toLocaleString('en-CA') }} casts · {{ mainStore.filteredSensors.length }} sensors ·
                    {{ mainStore.filteredGliders.length }} gliders
                </div>
            </div>
        </template>
    </UPopover>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import * as echarts from 'echarts'
import { useMainStore } from '@/stores/main'
import { chart as chartPalette } from '@/config/palette'
import SegmentedControl from '../ui/SegmentedControl.vue'
import {
    DAY_MS, MONTH_ABBR, SEASONS, describeObsFilter, isObsFilterActive, isoDay, NO_OBS_FILTER,
    type Diel, type ObsFilter,
} from '@/utils/obsFilter'

/**
 * The observation-period filter (utils/obsFilter.ts) as a chip that opens its
 * controls: a per-year coverage strip to drag a year range on, relative
 * presets, months and seasons, a window around the map date, and day/night.
 */
const mainStore = useMainStore()
const open = ref(false)

const RELATIVE = [
    { label: 'Last 30 days', days: 30 },
    { label: 'Last 12 months', days: 365 },
    { label: 'Last 10 years', days: 3652 },
]
const DIEL_ITEMS = [
    { value: 'all', label: 'All' },
    { value: 'day', label: 'Day', title: 'Sun above the horizon at the observation' },
    { value: 'night', label: 'Night', title: 'Sun below the horizon at the observation' },
]
const AROUND_DEFAULT_DAYS = 15

const f = computed(() => mainStore.obsFilter)
const active = computed(() => isObsFilterActive(f.value))
const summary = computed(() => describeObsFilter(f.value))
const update = (patch: Partial<ObsFilter>) => mainStore.setObsFilter({ ...f.value, ...patch })
const reset = () => mainStore.setObsFilter({ ...NO_OBS_FILTER })

// ── years ─────────────────────────────────────────────────────────────
const thisYear = new Date().getUTCFullYear()
const years = computed(() => {
    const first = Math.min(
        mainStore.castYears[0]?.year ?? thisYear,
        ...Object.values(mainStore.sensorCoverage).map(ms => Math.floor((ms[0] ?? thisYear * 100) / 100)),
        ...mainStore.gliders.map(g => new Date(g.start).getUTCFullYear()),
    )
    return Array.from({ length: thisYear - first + 1 }, (_, i) => first + i)
})
const ANY = 0
const yearItems = (anyLabel: string) => [{ value: ANY, label: anyLabel }, ...[...years.value].reverse().map(y => ({ value: y, label: String(y) }))]
const fromItems = computed(() => yearItems('Any'))
const toItems = computed(() => yearItems('Now'))
const fromYear = computed({
    get: () => (f.value.from ? +f.value.from.slice(0, 4) : ANY),
    set: (y: number) => update({ from: y ? `${y}-01-01` : null }),
})
const toYear = computed({
    // `to` is exclusive: Jan 1 of the year after the last one kept.
    get: () => (f.value.to ? new Date(Date.parse(`${f.value.to}T00:00:00Z`) - DAY_MS).getUTCFullYear() : ANY),
    set: (y: number) => update({ to: y ? `${y + 1}-01-01` : null }),
})
function setRelative(days: number) {
    update({ from: isoDay(Date.now() - days * DAY_MS), to: null })
}

// ── months ────────────────────────────────────────────────────────────
const monthSet = computed(() => new Set(f.value.months))
function toggleMonth(m: number) {
    const s = new Set(monthSet.value)
    if (s.has(m)) s.delete(m)
    else s.add(m)
    update({ months: s.size === 12 ? [] : [...s] })
}
const isSeason = (months: number[]) => monthSet.value.size === months.length && months.every(m => monthSet.value.has(m))
const toggleSeason = (months: number[]) => update({ months: isSeason(months) ? [] : [...months] })

// ── around the map date ───────────────────────────────────────────────
const lastAroundDays = ref(AROUND_DEFAULT_DAYS)
const aroundOn = computed({
    get: () => !!f.value.around,
    set: (on: boolean) => update({ around: on ? { days: lastAroundDays.value, everyYear: true } : null }),
})
const aroundDays = computed({
    get: () => f.value.around?.days ?? lastAroundDays.value,
    set: (d: number | null) => {
        lastAroundDays.value = Math.max(0, Math.min(182, d ?? 0))
        if (f.value.around) update({ around: { ...f.value.around, days: lastAroundDays.value } })
    },
})
const aroundEveryYear = computed({
    get: () => f.value.around?.everyYear ?? true,
    set: (v: boolean | 'indeterminate') => { if (f.value.around) update({ around: { ...f.value.around, everyYear: v === true } }) },
})
// One stretch around the map date replaces the year range.
const followsMapDate = computed(() => !!f.value.around && !f.value.around.everyYear)
const mapDateLabel = computed(() => mainStore.selected_variable.dt?.clone().utc().format('YYYY-MM-DD') ?? '')

const diel = computed({
    get: () => f.value.diel,
    set: (d: string | number) => update({ diel: d as Diel }),
})

// ── coverage strip ────────────────────────────────────────────────────
const ROWS = ['Gliders', 'Sensors', 'Casts'] as const
const ROW_COLORS = [chartPalette.instruments[2], chartPalette.instruments[1], chartPalette.sensor]

const perYear = computed(() => {
    const idx = new Map(years.value.map((y, i) => [y, i]))
    const counts = ROWS.map(() => years.value.map(() => 0))
    for (const c of mainStore.castYears) {
        const i = idx.get(c.year)
        if (i != null) counts[2]![i] = c.ctd + c.bottle
    }
    for (const s of mainStore.sensors) {
        const ys = new Set<number>()
        for (const m of s.members ?? [s]) for (const ym of mainStore.sensorCoverage[m.id] ?? []) ys.add(Math.floor(ym / 100))
        for (const y of ys) { const i = idx.get(y); if (i != null) counts[1]![i]!++ }
    }
    for (const g of mainStore.gliders) {
        for (let y = new Date(g.start).getUTCFullYear(); y <= new Date(g.end).getUTCFullYear(); y++) {
            const i = idx.get(y)
            if (i != null) counts[0]![i]!++
        }
    }
    return counts
})

const stripEl = ref<HTMLElement | null>(null)
let strip: echarts.ECharts | null = null

function stripOption(): echarts.EChartsOption {
    // [year index, row, count, opacity]: a square-root scale per row, so a
    // few casts still show beside thousands.
    const data: number[][] = []
    perYear.value.forEach((row, r) => {
        const max = Math.max(1, ...row)
        row.forEach((n, i) => data.push([i, r, n, n ? 0.25 + 0.75 * Math.sqrt(n / max) : 0.05]))
    })
    const labels = years.value.map(String)
    return {
        animation: false,
        grid: { left: 52, right: 6, top: 4, bottom: 18 },
        tooltip: {
            backgroundColor: chartPalette.tooltipBg, borderColor: chartPalette.tooltipBorder,
            textStyle: { color: chartPalette.text, fontSize: 11 },
            formatter: (p) => {
                const [i, r, n] = (p as { value: number[] }).value
                return `${labels[i!]} · ${ROWS[r!]}: ${Number(n).toLocaleString('en-CA')}`
            },
        },
        xAxis: {
            type: 'category', data: labels,
            axisLine: { lineStyle: { color: chartPalette.axis } }, axisTick: { show: false },
            axisLabel: { color: chartPalette.text, fontSize: 10, interval: (i: number) => years.value[i]! % 20 === 0 },
        },
        yAxis: {
            type: 'category', data: [...ROWS], axisLine: { show: false }, axisTick: { show: false },
            axisLabel: { color: chartPalette.text, fontSize: 10 },
        },
        brush: {
            xAxisIndex: 0, brushType: 'lineX', brushMode: 'single', transformable: true,
            brushStyle: { color: 'rgba(226,163,54,0.18)', borderColor: chartPalette.model, borderWidth: 1 },
            throttleType: 'debounce', throttleDelay: 150,
        },
        toolbox: { show: false },
        series: [{
            type: 'custom',
            data,
            encode: { x: 0, y: 1 },
            renderItem: (_params, api) => {
                const [x, y] = api.coord([api.value(0), api.value(1)]) as [number, number]
                const [w, h] = api.size!([1, 1]) as [number, number]
                return {
                    type: 'rect',
                    shape: { x: x - w / 2, y: y - h / 2 + 1.5, width: Math.max(1, w - 0.5), height: h - 3 },
                    style: { fill: ROW_COLORS[api.value(1) as number], opacity: api.value(3) as number },
                }
            },
        }],
    }
}

/** Show the year range on the strip, or clear it when the range isn't whole years. */
function syncBrush() {
    if (!strip) return
    const { from, to } = f.value
    const yearly = (!from || from.endsWith('-01-01')) && (!to || to.endsWith('-01-01'))
    const ys = years.value
    if ((from || to) && yearly && !followsMapDate.value) {
        const i0 = from ? Math.max(0, ys.indexOf(+from.slice(0, 4))) : 0
        const iTo = to ? ys.indexOf(+to.slice(0, 4) - 1) : ys.length - 1
        strip.dispatchAction({ type: 'brush', areas: [{ brushType: 'lineX', xAxisIndex: 0, coordRange: [i0, iTo < 0 ? ys.length - 1 : iTo] }] })
    } else {
        strip.dispatchAction({ type: 'brush', areas: [] })
    }
}

function onBrushEnd(e: unknown) {
    const range = (e as { areas?: Array<{ coordRange?: [number, number] }> }).areas?.[0]?.coordRange
    if (!range) {
        update({ from: null, to: null })
        return
    }
    const ys = years.value
    const a = ys[Math.max(0, Math.round(range[0]))]!, b = ys[Math.min(ys.length - 1, Math.round(range[1]))]!
    update({ from: `${a}-01-01`, to: b === thisYear ? null : `${b + 1}-01-01` })
}

function renderStrip() {
    if (!stripEl.value) return
    if (!strip) {
        strip = echarts.init(stripEl.value, 'dark', { renderer: 'canvas' })
        strip.on('brushEnd', onBrushEnd)
    }
    strip.setOption(stripOption(), true)
    strip.dispatchAction({ type: 'takeGlobalCursor', key: 'brush', brushOption: { brushType: 'lineX', brushMode: 'single' } })
    syncBrush()
}

watch(open, async (isOpen) => {
    if (!isOpen) {
        strip?.dispose()
        strip = null
        return
    }
    await nextTick()
    renderStrip()
})
watch(perYear, () => { if (strip) renderStrip() })
watch(() => [f.value.from, f.value.to, followsMapDate.value], syncBrush)
onBeforeUnmount(() => strip?.dispose())
</script>

<style scoped>
.obs-period {
    width: 340px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.obs-period__strip {
    width: 100%;
    height: 78px;
}

.obs-period__row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
}

.obs-period__months {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 4px;
}

.obs-period__seasons {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
}
</style>
