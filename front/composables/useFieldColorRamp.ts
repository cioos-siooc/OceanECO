import { computed } from 'vue';
import { useMainStore } from '~/stores/main';
import { resolveColormap } from './useColormapResolver';
import { useVariableRegistry } from './useVariableRegistry';

export function hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lerpRgb(a: number[], b: number[], t: number) { return [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t]; }
function rgbCss(c: number[]) { return `rgb(${c.map(v => Math.round(v)).join(',')})`; }
function colorFromStops(stops: [number, string][], t: number): number[] {
    const clamped = Math.max(0, Math.min(1, t));
    const first = stops[0]!;
    if (clamped <= first[0]) return hexToRgb(first[1]);
    for (let i = 0; i < stops.length - 1; i++) {
        const [p0, c0] = stops[i]!;
        const [p1, c1] = stops[i + 1]!;
        if (clamped <= p1) return lerpRgb(hexToRgb(c0), hexToRgb(c1), p1 === p0 ? 0 : (clamped - p0) / (p1 - p0));
    }
    return hexToRgb(stops[stops.length - 1]![1]);
}

const SEQ = [hexToRgb('#0d366b'), hexToRgb('#3987e5'), hexToRgb('#cde2fb')];

/**
 * The map's own colorbar for the selected field — palette and min/max both —
 * as a value → colour function. Sections are renderings of the same field the
 * map paints, so they read off this rather than a second scale: two
 * independent scales for one variable made identical values look different.
 *
 * Values must be in the current display unit (bounds are converted to it).
 * `rgbFn` returns `[r, g, b]` (0–255) for WebGL; `colorFn` a CSS colour. Both
 * are `computed`, so their identity changes with the palette or the range —
 * that is what makes TimeDepthHeatmap repaint cells whose values did not change.
 */
export function useFieldColorRamp() {
    const mainStore = useMainStore();
    const { toDisplayValue } = useVariableRegistry();

    const varId = computed(() => mainStore.selected_variable.var);
    const varMeta = computed(() => mainStore.variables.find(v => v.source === mainStore.selected_variable.source && v.var === varId.value) ?? null);
    const stops = computed(() => resolveColormap(mainStore.colormaps, mainStore.selected_variable.colormap)?.stops ?? null);

    // With the variable's configured defaults as a fallback for the moment
    // before the map has published its own.
    const lo = computed(() => toDisplayValue(varId.value, mainStore.selected_variable.colormapMin ?? varMeta.value?.colormapMin ?? 0) ?? 0);
    const hi = computed(() => {
        const h = toDisplayValue(varId.value, mainStore.selected_variable.colormapMax ?? varMeta.value?.colormapMax ?? 1) ?? 1;
        return h > lo.value ? h : lo.value + 1;
    });

    const rgbFn = computed(() => {
        const s = stops.value;
        const min = lo.value, max = hi.value;
        return (v: number): number[] => {
            const t = max === min ? 0.5 : Math.max(0, Math.min(1, (v - min) / (max - min)));
            if (s && s.length) return colorFromStops(s, t);
            return t < 0.5 ? lerpRgb(SEQ[0]!, SEQ[1]!, t * 2) : lerpRgb(SEQ[1]!, SEQ[2]!, (t - 0.5) * 2);
        };
    });

    const colorFn = computed(() => {
        const f = rgbFn.value;
        return (v: number) => rgbCss(f(v));
    });

    return { rgbFn, colorFn };
}
