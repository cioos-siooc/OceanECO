<template>
  <div class="gsc-panel">
    <!-- Hatch, then the cells (transparent where empty), then ECharts' axes and zoom. -->
    <div class="gsc-plot" :style="plotInset" />
    <canvas ref="cellsRef" class="gsc-cells" :style="cellsStyle" />
    <div ref="chartRef" class="gsc-chart" />
    <!-- eslint-disable-next-line vue/no-v-html -- built by the parent from numbers and dates -->
    <div v-if="tip" class="gsc-tip" :style="{ left: `${tip.x}px`, top: `${tip.y}px` }" v-html="tip.html" />
    <span v-if="label" class="gsc-label">{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import * as echarts from 'echarts'
import { registerEchartsDarkTheme } from '~~/composables/useEchartsTheme'

/**
 * A glider section: profile number across x, depth (sqrt scale, as in
 * TimeDepthHeatmap) down y, with zoom sliders on both axes.
 *
 * A long deployment has thousands of profiles, too many cells for
 * TimeDepthHeatmap's one-rect-per-cell series, so the cells are painted
 * straight into a canvas under the chart, one pass per pixel, and ECharts only
 * draws the axes and zoom. The parent hands in the whole-deployment `overview`
 * and, once zoomed, a finer `detail` for the window; the detail wins wherever
 * it covers. Both share the same depth rows (`/gliderSection` keeps them fixed
 * per deployment), so only the columns differ.
 *
 * A click (not a drag) picks the profile under the cursor (`pick`, with
 * whether Shift was held); moving over the cells reports the column under the
 * cursor (`hover`, null on leaving). `marks` draws a tick per pinned profile.
 */

export type SectionLayer = {
  profiles: number[]              // first profile number of each column
  profileEnd: number[]            // last profile number of each column
  depths: number[]                // row centres (m), ascending, evenly spaced
  values: (number | null)[][]     // [row][column], in the display unit `rgbFn` takes
}

const props = defineProps<{
  overview: SectionLayer
  detail?: SectionLayer | null
  /** First and last profile number of the deployment. */
  extent: [number, number]
  /** Zoom window in profile numbers, or null for all of it. */
  range: [number, number] | null
  rgbFn: (v: number) => number[]
  /** Profile number -> x-axis text. */
  xLabel: (profile: number) => string
  tooltipFormatter: (layer: SectionLayer, col: number, row: number, value: number | null) => string
  label?: string
  marks?: { profile: number, color: string }[]
}>()

const emit = defineEmits<{
  range: [range: [number, number] | null]
  pick: [profile: number, add: boolean]
  hover: [cell: { layer: SectionLayer, col: number } | null]
}>()

const GRID = { left: 44, right: 26, top: 6, bottom: 44 }
const X_SLIDER = 0
const RANGE_EMIT_MS = 250

const chartRef = ref<HTMLDivElement | null>(null)
const cellsRef = ref<HTMLCanvasElement | null>(null)
let chart: echarts.ECharts | null = null

const plotInset = { left: `${GRID.left}px`, right: `${GRID.right}px`, top: `${GRID.top}px`, bottom: `${GRID.bottom}px` }
// A canvas keeps its intrinsic size between left/right insets, so size it outright.
const cellsStyle = {
  left: `${GRID.left}px`, top: `${GRID.top}px`,
  width: `calc(100% - ${GRID.left + GRID.right}px)`, height: `calc(100% - ${GRID.top + GRID.bottom}px)`,
}

// ── DEPTH ROWS — evenly spaced; the y axis is sqrt(depth / bottom), so the
// shallow rows get more height. ──────────────────────────────────────────────
const rows = computed(() => {
  const d = props.overview.depths
  const step = d.length > 1 ? d[1]! - d[0]! : 1
  const top = Math.max(0, d[0]! - step / 2)
  return { step, top, bottom: d[d.length - 1]! + step / 2 }
})
const fracToDepth = (f: number) => f * f * rows.value.bottom
const depthLabel = (f: number) => { const d = fracToDepth(f); return d.toFixed(d < 10 ? 1 : 0) + 'm' }

// ── CELL COLOURS — packed RGBA per cell, computed once per layer and palette. ─
let colourCache = new WeakMap<SectionLayer, Uint32Array>()
watch(() => props.rgbFn, () => { colourCache = new WeakMap(); schedulePaint() })

function coloursOf(layer: SectionLayer): Uint32Array {
  let out = colourCache.get(layer)
  if (out) return out
  const n = layer.profiles.length
  out = new Uint32Array(layer.values.length * n)
  layer.values.forEach((row, r) => row.forEach((v, c) => {
    if (v == null || !Number.isFinite(v)) return
    const [red, green, blue] = props.rgbFn(v)
    out![r * n + c] = (255 << 24 | blue! << 16 | green! << 8 | red!) >>> 0 // ImageData is little-endian RGBA
  }))
  colourCache.set(layer, out)
  return out
}

/** The layer and column drawn at profile number `x`, or null for a gap. */
function cellAt(x: number): { layer: SectionLayer, col: number } | null {
  const d = props.detail
  const layer = d && d.profiles.length && x >= d.profiles[0]! && x < d.profileEnd[d.profileEnd.length - 1]! + 1 ? d : props.overview
  const starts = layer.profiles
  let lo = 0, hi = starts.length - 1
  if (hi < 0 || x < starts[0]!) return null
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= x) lo = mid
    else hi = mid - 1
  }
  return x < layer.profileEnd[lo]! + 1 ? { layer, col: lo } : null
}

function rowAt(frac: number): number {
  const { top, step } = rows.value
  const r = Math.floor((fracToDepth(frac) - top) / step)
  return r >= 0 && r < props.overview.depths.length ? r : -1
}

/** Visible axis windows: [x0, x1] in profile numbers, [y0, y1] in depth fraction. */
function visible() {
  const el = chartRef.value!
  const xa = chart!.convertFromPixel({ xAxisIndex: 0 }, GRID.left) as number
  const xb = chart!.convertFromPixel({ xAxisIndex: 0 }, el.clientWidth - GRID.right) as number
  const ya = chart!.convertFromPixel({ yAxisIndex: 0 }, GRID.top) as number
  const yb = chart!.convertFromPixel({ yAxisIndex: 0 }, el.clientHeight - GRID.bottom) as number
  return { x: [xa, xb] as const, y: [ya, yb] as const }
}

function paint() {
  const cv = cellsRef.value
  if (!chart || !cv || !cv.clientWidth || !cv.clientHeight) return
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr)
  if (cv.width !== w) cv.width = w
  if (cv.height !== h) cv.height = h
  const { x: [x0, x1], y: [y0, y1] } = visible()

  const rowOf = new Int32Array(h)
  for (let py = 0; py < h; py++) rowOf[py] = rowAt(y0 + (py + 0.5) / h * (y1 - y0))

  const img = new ImageData(w, h)
  const out = new Uint32Array(img.data.buffer)
  for (let px = 0; px < w; px++) {
    const cell = cellAt(x0 + (px + 0.5) / w * (x1 - x0))
    if (!cell) continue
    const colours = coloursOf(cell.layer)
    const n = cell.layer.profiles.length
    for (let py = 0; py < h; py++) {
      const r = rowOf[py]!
      if (r >= 0) out[py * w + px] = colours[r * n + cell.col]!
    }
  }
  cv.getContext('2d')!.putImageData(img, 0, 0)
}

let paintFrame = 0
function schedulePaint() {
  if (paintFrame) return
  paintFrame = requestAnimationFrame(() => { paintFrame = 0; paint() })
}

// ── ZOOM WINDOW ⇄ `range` ────────────────────────────────────────────────────
let emitted: string = JSON.stringify(props.range)
let emitTimer: ReturnType<typeof setTimeout> | undefined

function currentRange(): [number, number] | null {
  const [x0, x1] = visible().x
  const lo = Math.max(props.extent[0], Math.floor(x0))
  const hi = Math.min(props.extent[1], Math.ceil(x1) - 1)
  return lo <= props.extent[0] && hi >= props.extent[1] ? null : [lo, hi]
}

function onZoom() {
  schedulePaint()
  tip.value = null
  clearTimeout(emitTimer)
  emitTimer = setTimeout(() => {
    const r = currentRange()
    const key = JSON.stringify(r)
    if (key === emitted) return
    emitted = key
    emit('range', r)
  }, RANGE_EMIT_MS)
}

watch(() => props.range, (r) => {
  const key = JSON.stringify(r)
  if (!chart || key === emitted) return
  emitted = key
  chart.dispatchAction({
    type: 'dataZoom', dataZoomIndex: X_SLIDER,
    startValue: r ? r[0] : props.extent[0], endValue: r ? r[1] + 1 : props.extent[1] + 1,
  })
})

watch(() => props.marks, () => chart?.setOption({ series: [{ markLine: markLine() }] }), { deep: true })

/** A tick down the plot at each pinned profile, in its pin's colour. */
function markLine() {
  return {
    silent: true, symbol: 'none', label: { show: false }, animation: false,
    data: (props.marks ?? []).map(m => ({ xAxis: m.profile + 0.5, lineStyle: { color: m.color, width: 2, type: 'solid' as const } })),
  }
}

watch(() => props.detail, schedulePaint)
watch(() => props.overview, schedulePaint)
watch(() => props.xLabel, () => chart?.setOption({
  xAxis: { axisLabel: { formatter: (v: number) => props.xLabel(v) } },
  dataZoom: [{ labelFormatter: (v: number) => props.xLabel(v) }],
}))

// ── HOVER ────────────────────────────────────────────────────────────────────
const tip = ref<{ x: number, y: number, html: string } | null>(null)
const tipFlip = ref('none')

/** Profile number and cell under a pointer event, when it is over the cells. */
function pointAt(e: { offsetX: number, offsetY: number }) {
  const el = chartRef.value
  if (!chart || !el) return null
  const inPlot = e.offsetX >= GRID.left && e.offsetX <= el.clientWidth - GRID.right
    && e.offsetY >= GRID.top && e.offsetY <= el.clientHeight - GRID.bottom
  if (!inPlot) return null
  const [x, frac] = chart.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]) as [number, number]
  const cell = cellAt(x)
  return cell ? { x, frac, cell } : null
}

let hovered: { layer: SectionLayer, col: number } | null = null
function setHovered(cell: { layer: SectionLayer, col: number } | null) {
  if (cell?.layer === hovered?.layer && cell?.col === hovered?.col) return
  hovered = cell
  emit('hover', cell)
}

function onClick(e: { offsetX: number, offsetY: number, event?: MouseEvent }) {
  const pt = pointAt(e)
  if (!pt) return
  // Inside an averaged column, the profile under the cursor.
  const { layer, col } = pt.cell
  const p = Math.min(Math.max(Math.floor(pt.x), layer.profiles[col]!), layer.profileEnd[col]!)
  emit('pick', p, !!e.event?.shiftKey)
}

function onMouseMove(e: { offsetX: number, offsetY: number }) {
  const el = chartRef.value
  const pt = pointAt(e)
  setHovered(pt?.cell ?? null)
  const cell = pt?.cell
  const row = pt ? rowAt(pt.frac) : -1
  if (!el || !cell || row < 0) { tip.value = null; return }
  const v = cell.layer.values[row]?.[cell.col] ?? null
  // Keep the box inside the panel: flip to the cursor's other side past the middle.
  const flipX = e.offsetX > el.clientWidth / 2, flipY = e.offsetY > el.clientHeight / 2
  tip.value = {
    x: flipX ? e.offsetX - 12 : e.offsetX + 12,
    y: flipY ? e.offsetY - 12 : e.offsetY + 12,
    html: props.tooltipFormatter(cell.layer, cell.col, row, v),
  }
  tipFlip.value = `translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`
}

function option(): echarts.EChartsOption {
  const [p0, p1] = props.extent
  return {
    animation: false,
    grid: GRID,
    xAxis: {
      type: 'value', min: p0, max: p1 + 1, splitNumber: 6,
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.25)' } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { fontSize: 9.5, color: 'rgba(255,255,255,0.4)', hideOverlap: true, formatter: (v: number) => props.xLabel(v) },
    },
    yAxis: {
      type: 'value', min: 0, max: 1, inverse: true,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { fontSize: 9.5, color: 'rgba(255,255,255,0.4)', formatter: depthLabel },
    },
    dataZoom: [
      // X_SLIDER first: the `range` watcher dispatches to it by index.
      {
        type: 'slider', xAxisIndex: 0, filterMode: 'none', bottom: 4, height: 14,
        startValue: props.range ? props.range[0] : p0, endValue: props.range ? props.range[1] + 1 : p1 + 1,
        minValueSpan: 4, showDetail: 'auto', labelFormatter: (v: number) => props.xLabel(v),
      },
      { type: 'inside', xAxisIndex: 0, filterMode: 'none', minValueSpan: 4, zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false },
      {
        type: 'slider', yAxisIndex: 0, filterMode: 'none', right: 4, width: 14, start: 0, end: 100,
        showDetail: 'auto', labelFormatter: depthLabel,
      },
      // Shift + wheel zooms depth; the plain wheel is for the track.
      { type: 'inside', yAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'shift', moveOnMouseMove: true, moveOnMouseWheel: false },
    ],
    // Nothing to draw (the cells are on the canvas below); it gives the zoom a series to act on.
    series: [{
      type: 'custom', silent: true, renderItem: () => ({ type: 'group', children: [] }),
      data: [[p0, 0], [p1 + 1, 1]], encode: { x: 0, y: 1 },
      markLine: markLine(),
    }],
  }
}

let resizeObs: ResizeObserver | null = null

onMounted(() => {
  registerEchartsDarkTheme()
  if (!chartRef.value) return
  chart = echarts.init(chartRef.value, 'dark', { renderer: 'canvas' })
  chart.setOption(option())
  chart.on('datazoom', onZoom)
  chart.on('finished', schedulePaint)
  chart.getZr().on('mousemove', onMouseMove)
  // zrender fires click only when the pointer didn't move, so a pan never picks.
  chart.getZr().on('click', onClick)
  chart.getZr().on('globalout', () => { tip.value = null; setHovered(null) })
  if (typeof ResizeObserver !== 'undefined') {
    resizeObs = new ResizeObserver(() => { chart?.resize(); schedulePaint() })
    resizeObs.observe(chartRef.value)
  }
})

onBeforeUnmount(() => {
  clearTimeout(emitTimer)
  cancelAnimationFrame(paintFrame)
  resizeObs?.disconnect()
  chart?.dispose()
  chart = null
})
</script>

<style scoped>
.gsc-panel {
  position: relative;
  height: 100%;
  border-radius: 3px;
  background-color: #161e26;
}

/* Same hatch as TimeDepthHeatmap: shows through cells with no data. */
.gsc-plot {
  position: absolute;
  background-image: repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.22) 0, rgba(255, 255, 255, 0.22) 1px, transparent 1px, transparent 6px);
}

.gsc-cells { position: absolute; }

.gsc-chart { position: relative; width: 100%; height: 100%; cursor: crosshair; }

.gsc-tip {
  position: absolute; z-index: 3; pointer-events: none; white-space: nowrap;
  transform: v-bind(tipFlip);
  background: rgba(18, 24, 31, 0.92); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 4px;
  padding: 8px; font-size: 11px; color: #eef3f7;
}

.gsc-label {
  position: absolute; top: 5px; left: 7px;
  font-size: 9px; font-weight: 700; letter-spacing: 0.06em;
  color: #eef3f7; background: rgba(11, 17, 22, 0.55);
  padding: 2px 6px; border-radius: 3px; pointer-events: none; z-index: 2;
}
</style>
