import { useMainStore, type CastVariableMeta } from '~/stores/main'
import { useVariableRegistry } from '~~/composables/useVariableRegistry'

/**
 * Labels, units and formatting for an observed variable (`castVariables`,
 * from the registry's model and observation-only sections). A modelled
 * variable follows the user's unit preference; an observation-only one
 * (nutrients, chlorophyll) has the single unit its registry entry gives.
 */
export function useObsVariable() {
    const mainStore = useMainStore()
    const { toDisplayValue, displayUnit, formatDisplayValue } = useVariableRegistry()

    const metaOf = (v: string): CastVariableMeta | undefined => mainStore.castVariables[v]
    const nameOf = (v: string) => metaOf(v)?.name ?? v
    const unitOf = (v: string) => (metaOf(v)?.modelled ? displayUnit(v) : metaOf(v)?.unit ?? '')
    /** A stored value in the unit `unitOf` names. */
    const show = (v: string, x: number) => (metaOf(v)?.modelled ? toDisplayValue(v, x) : x)
    /** A value already in display units (`show`'s) as text, with its unit. */
    function fmt(v: string, x: number | null | undefined, opts: { unit?: boolean } = { unit: true }): string {
        if (x == null || !Number.isFinite(x)) return '—'
        if (metaOf(v)?.modelled) return formatDisplayValue(v, x, { unit: opts.unit })
        const step = metaOf(v)?.precision ?? 0.01
        const decimals = Math.min(3, Math.max(0, Math.ceil(-Math.log10(step))))
        return `${x.toFixed(decimals)}${opts.unit && unitOf(v) ? ` ${unitOf(v)}` : ''}`
    }
    return { metaOf, nameOf, unitOf, show, fmt }
}
