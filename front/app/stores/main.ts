import type moment from 'moment';
import { defineStore } from 'pinia'
import { chart as chartPalette } from '@/config/palette';
import { trackEvent } from '~~/composables/useAnalytics';
import { mergeSensors, resolveMergedId, type MergeableSensor } from '@/utils/sensorMerge';
import { NO_OBS_FILTER, clipTrack, matchingIntervals, monthMatches, pathKm, resolveObsFilter, type ObsFilter, type ResolvedObsFilter } from '@/utils/obsFilter';

// Depths are plain numbers (the WebP filename stem too, e.g. 18.0 -> "18.0.webp")
// — -1 is the synthetic bottom-layer sentinel ("bottom.webp").
export type ExploreView = 'series' | 'model-depth' | 'sensor-depth' | 'glider'

/** A sensor as `GET /sensors` returns it, or a display-time merge of several (`members`). */
export type Sensor = MergeableSensor

/** Footer panes (explore, crossSection, area) and fullscreen workspaces (analysis, comparison). */
export type BottomTab = 'explore' | 'analysis' | 'comparison' | 'crossSection' | 'area'

/**
 * The Area tab's 4D box: a circle drawn on the map and a depth range. The
 * fourth dimension is the observation period (`obsFilter`), shared with the
 * map's layers.
 */
export interface ObsArea {
    lat: number
    lng: number
    radiusKm: number
    depthMin: number
    depthMax: number
}

/** One DFO IOS ship cast (CTD or rosette bottle), as `GET /casts` lists it. */
export interface ShipCast {
    id: string
    kind: 'ctd' | 'bottle'
    time: string
    lat: number
    lon: number
    mission: string
    area: string
    maxDepth: number
    variables: string[]
}

/** Labels for a cast variable, from the registry's model or observation-only section. */
export interface CastVariableMeta {
    name: string
    short: string
    unit: string
    precision: number | null
    /** In the model registry: has a model counterpart and a display unit preference. */
    modelled: boolean
}

/** One C-PROOF glider deployment, as `GET /gliders` returns it. */
export interface GliderDeployment {
    id: string
    glider: string
    platformType: string
    summary: string
    station: string
    start: string
    end: string
    bbox: [number, number, number, number]
    profiles: number
    distanceKm: number
    variables: string[]
    fileUrl: string
    variant: string
    active: boolean
    /** [lon, lat, unix seconds], simplified to the track's shape. */
    track: [number, number, number][]
}

/** A glider deployment's track cut to the observation period. */
export interface GliderClip {
    segments: [number, number][][]
    /** Along-track distance inside the period, scaled to the full-resolution `distanceKm`. */
    km: number
}

export function formatDepthLabel(depth: number): string {
    return depth === -1 ? 'bottom' : depth.toFixed(1);
}

// Pulled out (rather than inlined in `state:`) so its return type can be
// named via `ReturnType<>` below — Pinia's `this` typing inside `actions`
// collapses to just the actions' own shape once the inline state literal
// gets complex enough (this store is right at that edge), silently losing
// access to every state property. Naming the type keeps `this.<state>` working.
function createInitialState() {
    return {
        // Series colours for the Explore chart; values come from the v2 chart
        // palette so model/sensor match the snapshot and the sensor list.
        colors: {
            model: {
                line: chartPalette.model,
                shadow: 'transparent',
                shadowBlur: 0
            },
            observation: {
                line: chartPalette.sensor,
                shadow: 'transparent',
                shadowBlur: 0
            },
            stats: chartPalette.clim,
            instruments: [...chartPalette.instruments],
        },

        dfnDays: 14, // days from now for climate timeseries
        variables: [] as Array<{ var: string, name: string, short?: string, source: string, dts: number[], colormap: string | null, colormapMin: number, colormapMax: number, depths: number[], precision: number, bounds: [number, number, number, number], alt_units?: Array<{ unit: string, scale: number, offset?: number }> }>,
        selected_variable: { var: '', source: '', dt: null as moment.Moment | null, depth: null as string | null, depth_nc: null as number | null, precision: null as number | null, colormap: null as string | null, colormapMin: null as number | null, colormapMax: null as number | null, colormapStops: [null, null, null] as (number | null)[] },

        // var -> chosen display unit. Absent means "show the canonical unit"
        // (variable_config.yml's `unit`) — only variables with `alt_units`
        // ever get an entry. Display-only: canonical values in ClickHouse,
        // colormapMin/Max, and rendered tiles are never touched by this.
        unitPreference: {} as Record<string, string>,
        showBathymetryContours: false,

        // Map-layer visibility toggles (Overlay rail). These hide the layer on the
        // map only — the left panel's selectors and every chart keep working, so
        // the model raster can be hidden while the Explore chart still plots it.
        showModelLayer: true,
        showSensorLayer: true,
        // The style's built-in "water names" and "Place labels" text layers
        // are visible by default (part of the base Mapbox style), so this
        // defaults to true — matching what's on screen until toggled off.
        showMapLabels: false,
        // Satellite imagery in place of the flat land/water fills.
        showSatellite: false,
        colormaps: {} as Record<string, any>,
        autoRangeDisabled: false,

        /**
         * The midDate is used to determine the middle point of the time range the footer chart displays. It is set to now initially.
         */
        midDate: null as moment.Moment | null,

        // Sensors as stored (`GET /sensors`), and the list every view reads:
        // `rawSensors` with redeployments joined under `sensorMerge`
        // (utils/sensorMerge.ts). Rebuilt by `setSensors`/`setSensorMerge`.
        rawSensors: [] as Sensor[],
        sensors: [] as Sensor[],
        // Display-time merge tolerance: deployments of one operator and dataset
        // within `distanceM` and ±`depthM` of a group's reference are shown as
        // one sensor. distanceM 0 shows every deployment on its own.
        sensorMerge: { distanceM: 500, depthM: 5 },
        selectedSensor: {} as { id: string, depth: number } | null,
        // Sensor under the pointer in the sensor list; the map highlights its marker.
        hoveredSensorId: null as string | null,

        // C-PROOF glider deployments (`GET /gliders`). Kept apart from `sensors`:
        // a deployment moves, so it has a track rather than one position.
        gliders: [] as GliderDeployment[],
        selectedGliderId: null as string | null,
        hoveredGliderId: null as string | null,
        // Profile-number window [first, last] the glider section is zoomed to;
        // null = the whole deployment. The map highlights that stretch of the
        // track and the curtain shows only it.
        gliderRange: null as [number, number] | null,
        showGliderLayer: true,
        // Bumped by GliderSection's 3D button: index.vue (which holds the map)
        // tilts onto the selected track, or flattens the map if already tilted.
        gliderTiltToken: 0,
        // 3D seafloor under the curtain (useGliderCurtain.ts).
        showSeafloor: true,
        // With a glider selected, the other tracks are faded; false hides them.
        showOtherGliders: true,
        // DFO IOS ship casts (`GET /casts`): those matching the observation
        // period, latest first; the archive (124k casts since 1930) is capped
        // at the API's MAX_CASTS, and `castsTotal` says how many matched.
        casts: [] as ShipCast[],
        castsTruncated: false,
        castsTotal: 0,
        castVariables: {} as Record<string, CastVariableMeta>,
        castYears: [] as Array<{ year: number, ctd: number, bottle: number }>,
        selectedCastId: null as string | null,

        // Observation-period filter (utils/obsFilter.ts): one date selection
        // for every observation layer — sensors, gliders and casts. Model
        // layers follow the map date instead.
        obsFilter: { ...NO_OBS_FILTER } as ObsFilter,
        // Sensor id -> YYYYMM months with data (`GET /sensors/coverage`), so a
        // sensor shows only when it has data in the period.
        sensorCoverage: {} as Record<string, number[]>,
        showCastLayer: true,

        // Sensor panel filters — shared with the map so markers stay in sync with the sensor list.
        sensorSearchQuery: '' as string,
        sensorOrganizationFilter: [] as string[],
        sensorVariableFilter: [] as string[],

        lastClickedMapPoint: null as { lat: number, lng: number } | null,

        /**
         * Whether the currently selected point has any model coverage, as last
         * reported by the API (ExplorePanel owns the write; see
         * `setModelDomainStatus`). Lives here rather than in the panel because
         * selectedInfo.vue — the map-corner box, a sibling of the panel, not a
         * child — has to say "no model data here" too: it describes the raster
         * layer, and the raster layer is just as empty at a deep-ocean point
         * as the chart is.
         *
         * `null` means "not established yet" (nothing fetched, or a failure
         * for some unrelated reason), which reads as in-domain everywhere —
         * absence of evidence must not paint the normal case as broken.
         */
        modelDomain: null as { inDomain: boolean, distanceKm: number | null } | null,

        // Raster layer is still fetching its image past index.vue's show delay
        // (drives selectedInfo.vue's spinner). Transient UI state, not shared.
        mapLayerLoading: false as boolean,
        // TimeControls playback is running; index.vue lengthens the spinner
        // delay so animation frames don't flash it.
        timePlaying: false as boolean,

        mapCenter: null as { lat: number, lng: number } | null,

        snackMessages: [] as Array<{ color: string, text: string }>,

        controlPanel_width: 300,
        isControlPanelOpen: true,

        showColorbarSettings: false,

        queryMode: 'point' as 'point' | 'area',

        showCursorCoords: false,
        showCursorValue: false,

        isVerticalProfileOpen: true,

        // 'explore' and 'crossSection' are the footer panes that read the map's
        // own state (coordinate/clock, and a drawn line, respectively).
        // 'analysis'/'comparison' are fullscreen workspaces: they take a
        // coordinate as input and then have nothing more to say to the map, so
        // showing the map behind them is wasted space.
        activeBottomTab: 'explore' as BottomTab,

        // The polyline drawn on the map for the Cross-Section tab, in vertex
        // order. Null until the user finishes drawing a line.
        crossSectionLine: null as { lat: number, lng: number }[] | null,

        // Bumped by CrossSectionPanel's "New line" button to ask index.vue (the
        // only place holding the MapboxDraw instance) to clear the map and
        // re-arm line-drawing mode — a plain counter rather than a boolean so a
        // click while already mid-redraw still fires the watcher.
        crossSectionRedrawToken: 0,

        // Area tab: the drawn circle and depth range, the variable it reads,
        // and a counter its "Redraw" button bumps to re-arm drawing (index.vue
        // owns the map, as for the cross-section line).
        obsArea: null as ObsArea | null,
        obsAreaVariable: 'temperature',
        obsAreaDrawToken: 0,

        // Which record the Analysis tab runs against. Was a whole separate tab
        // ("Sensor Analysis") until the two were merged behind one surface.
        analysisSource: 'model' as 'model' | 'sensor',

        // Which of Explore's sub-views is showing: the single-depth timeseries,
        // or a full-water-column section for the model or a profiler sensor.
        // Lives in the store (not a local ExplorePanel ref) because the footer's
        // nav rail in index.vue is what drives it now, one level up from the panel.
        exploreView: 'series' as ExploreView,

        // Explore's time-depth window anchor (`useTimeDepthWindow`'s `windowEnd`),
        // mirrored out of the panel purely so a share link can carry "which
        // window was I looking at" — the panel remains the owner and the only
        // writer. Epoch ms; null until the panel has published one.
        exploreWindowEnd: null as number | null,

        // Which sub-tab/season each fullscreen workspace is on. Promoted out of
        // AnalysisWorkspace/ComparisonWorkspace local refs for the same reason
        // `exploreView` was promoted out of ExplorePanel: something outside the
        // component (here, the share link) has to read and restore them.
        analysisTab: 'builder' as string,
        analysisSeason: 'full_year' as string,
        comparisonTab: 'overview' as string,
        comparisonSeason: 'all' as string,

        // Per-view control state that only the owning component cares about —
        // an Extreme Events threshold, a Correlation pair, a chart's zoom
        // extent. Promoting each of these into a named store field the way
        // `analysisTab` was would add dozens of fields nothing else reads, so
        // they live in one namespaced bag instead, written through
        // `composables/useViewState.ts`'s writable refs. Share capture takes
        // the bag wholesale, which is what lets a shared analysis tab arrive
        // with the sender's parameters rather than the defaults.
        viewState: {} as Record<string, Record<string, unknown>>,

        // The map camera, republished on every `moveend` by index.vue (which
        // owns the Mapbox instance). Share capture runs from the header, far
        // outside the map's component, so the camera has to be readable from
        // the store rather than off `map` itself.
        mapView: null as { center: [number, number], zoom: number, bearing: number, pitch: number } | null,

        // ── SHARED-LINK RESTORE ──────────────────────────────────────────────
        // A decoded `#s=` payload is applied in two passes: everything that
        // stands on its own is written straight onto this store by
        // `applyShareState`, while these one-shot slots hold the parts whose
        // consumer only exists later (the map is not built yet at decode time;
        // Explore's window is reset by its own composable on first data). Each
        // consumer takes its value and nulls the slot.
        pendingShare: null as any,
        pendingMapView: null as { center: [number, number], zoom: number, bearing: number, pitch: number } | null,
        pendingWindowEnd: null as number | null,
        // Set synchronously the moment a share hash is seen, before the async
        // decode finishes, so index.vue's bootstrap click waits for the shared
        // coordinate instead of racing it with the hardcoded default point.
        shareRestorePending: false,

        // ExplorePanel's own bin-mode toggle (1H/1D/1M), mirrored here so the
        // vertical profile drawer — a sibling of ExplorePanel under index.vue,
        // not a child of it — can request a profile aggregated the same way
        // the depth section currently on screen is.
        exploreBinMode: 'hourly' as 'hourly' | 'daily' | 'monthly',
    };
}

type MainStoreState = ReturnType<typeof createInitialState>;

export const useMainStore = defineStore('main', {
    state: (): MainStoreState => createInitialState(),

    getters: {
        // A *profiler* sensor (registry depth === -1) is the only kind that casts
        // through the whole water column, so it's the only kind with a "Sensor
        // depth" section to show. Centralised here rather than re-derived per
        // component (ExplorePanel's section fetch, index.vue's nav rail) so both
        // agree on the exact same definition of "profiler selected".
        selectedProfilerSensorId(state): string | null {
            const sel = state.selectedSensor;
            if (!sel?.id) return null;
            return state.sensors.find((s) => s.id === sel.id)?.depth === -1 ? sel.id : null;
        },

        /** The observation-period filter with the map date applied. */
        obsResolved(state): ResolvedObsFilter {
            // Reads the map date only when the period follows it, so stepping
            // the map leaves every filtered list alone otherwise.
            const f = state.obsFilter;
            return resolveObsFilter(f, f.around ? state.selected_variable.dt?.valueOf() ?? null : null);
        },

        filteredSensors(state): Sensor[] {
            const q = state.sensorSearchQuery.trim().toLowerCase();
            const period: ResolvedObsFilter = this.obsResolved;
            const t = (iso: string | null) => (iso ? Date.parse(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`) : NaN);
            const inPeriod = (s: Sensor) => {
                if (!period.active) return true;
                // A cheap, exact cut on the data's own span first.
                if (period.from != null && !(t(s.latest_data_at) >= period.from)) return false;
                if (period.to != null && !(t(s.first_data_at) < period.to)) return false;
                return (s.members ?? [s]).some(m => state.sensorCoverage[m.id]?.some(ym => monthMatches(period, ym)));
            };
            return state.sensors.filter((sensor) => {
                if (!inPeriod(sensor)) return false;
                if (q && !sensor.name.toLowerCase().includes(q) && !(sensor.organization ?? '').toLowerCase().includes(q)) {
                    return false;
                }
                if (state.sensorOrganizationFilter.length && !state.sensorOrganizationFilter.includes(sensor.organization)) {
                    return false;
                }
                if (state.sensorVariableFilter.length) {
                    const sensorVars = Object.keys(sensor.variables ?? {});
                    if (!state.sensorVariableFilter.some(v => sensorVars.includes(v))) return false;
                }
                return true;
            });
        },

        /**
         * Each glider track cut to the observation period, by id; null while
         * the filter is off (every track shows whole). A deployment with no
         * matching stretch is absent.
         */
        gliderClips(state): Record<string, GliderClip> | null {
            const period: ResolvedObsFilter = this.obsResolved;
            if (!period.active) return null;
            const out: Record<string, GliderClip> = {};
            for (const g of state.gliders) {
                if (g.track.length < 2) continue;
                const t0 = g.track[0]![2] * 1000, t1 = g.track[g.track.length - 1]![2] * 1000;
                const mid = g.track[g.track.length >> 1]!;
                const segments = clipTrack(g.track, matchingIntervals(period, t0, t1, mid[1], mid[0]));
                if (!segments.length) continue;
                const whole = pathKm(g.track);
                const km = whole > 0 ? g.distanceKm * segments.reduce((a, s) => a + pathKm(s), 0) / whole : 0;
                out[g.id] = { segments, km };
            }
            return out;
        },

        filteredGliders(state): GliderDeployment[] {
            const clips: Record<string, GliderClip> | null = this.gliderClips;
            return clips ? state.gliders.filter(g => clips[g.id]) : state.gliders;
        },

        /** What the map shows, as the Area tab's query names it: stored
         *  sensor ids (a merge's members), glider deployments, and casts. */
        visibleObsSources(state): { sensorIds: string[], gliderIds: string[], casts: boolean } {
            const sensors: Sensor[] = this.filteredSensors;
            const gliders: GliderDeployment[] = this.filteredGliders;
            return {
                sensorIds: state.showSensorLayer ? sensors.flatMap(s => (s.members ? s.members.map(m => m.id) : [s.id])) : [],
                gliderIds: state.showGliderLayer ? gliders.map(g => g.id) : [],
                casts: state.showCastLayer && state.castYears.length > 0,
            };
        },
    },

    actions: {
        setVariables(vars: Array<{ var: string, name: string, source: string, dts: number[], colormap: string | null, colormapMin: number, colormapMax: number, depths: number[], precision: number, bounds: [number, number, number, number] }>) {
            this.variables = vars;
        },

        /** Switch the active field, carrying its colormap and precision over
         *  from `/variables` (Field dropdown and point snapshot share this). */
        selectVariable(varId: string) {
            const meta = this.variables.find(v => v.source === this.selected_variable.source && v.var === varId);
            this.updateSelectedVariable({
                var: varId,
                colormap: meta?.colormap ?? null,
                colormapMin: meta?.colormapMin ?? null,
                colormapMax: meta?.colormapMax ?? null,
                precision: meta?.precision ?? null,
            });
        },

        updateSelectedVariable(partial: Partial<MainStoreState['selected_variable']>) {
            // Use individual property assignment to ensure Pinia tracks mutations properly
            for (const [key, value] of Object.entries(partial)) {
                (this.selected_variable as any)[key] = value;
            }
        },

        setShowModelLayer(value: boolean) {
            this.showModelLayer = value;
        },

        setShowSensorLayer(value: boolean) {
            this.showSensorLayer = value;
        },

        setShowBathymetryContours(value: boolean) {
            this.showBathymetryContours = value;
        },

        setShowMapLabels(value: boolean) {
            this.showMapLabels = value;
        },

        setShowSatellite(value: boolean) {
            this.showSatellite = value;
        },

        setUnitPreference(varId: string, unit: string) {
            this.unitPreference[varId] = unit;
        },

        setShowCursorCoords(value: boolean) {
            this.showCursorCoords = value;
        },

        setShowCursorValue(value: boolean) {
            this.showCursorValue = value;
        },

        setColormaps(colormaps: Record<string, any>) {
            this.colormaps = colormaps;
        },

        setAutoRangeDisabled(value: boolean) {
            this.autoRangeDisabled = value;
        },

        setMidDate(date: moment.Moment) {
            this.midDate = date;
        },

        setSensors(sensors: Sensor[]) {
            this.rawSensors = sensors;
            this.rebuildSensors();
        },
        setSensorMerge(merge: { distanceM: number, depthM: number }) {
            this.sensorMerge = { distanceM: Math.max(0, merge.distanceM), depthM: Math.max(0, merge.depthM) };
            this.rebuildSensors();
        },
        /** Re-merge `rawSensors`, carrying the selection over to whichever entry now holds it. */
        rebuildSensors() {
            this.sensors = mergeSensors(this.rawSensors, this.sensorMerge);
            // Before the list first arrives a selection (e.g. from a share link)
            // can't be resolved yet; leave it for the next rebuild.
            if (!this.sensors.length) return;
            const sel = this.selectedSensor;
            if (sel?.id) {
                const id = resolveMergedId(this.sensors, sel.id);
                if (id !== sel.id) {
                    const s = id ? this.sensors.find(x => x.id === id) : null;
                    this.selectedSensor = s ? { id: s.id, depth: s.depth } : null;
                }
            }
            if (this.hoveredSensorId && !this.sensors.some(s => s.id === this.hoveredSensorId)) {
                this.hoveredSensorId = null;
            }
        },
        setSelectedSensor(sensor: { id: string, depth: number } | null) {
            this.selectedSensor = sensor;
            // One observation selected at a time: a sensor replaces the glider or cast.
            if (sensor && this.selectedGliderId) this.selectGlider(null);
            if (sensor && this.selectedCastId) this.selectCast(null);
        },
        setCasts(payload: { casts: ShipCast[], truncated: boolean, total?: number, variables: Record<string, CastVariableMeta> }) {
            this.casts = payload.casts;
            this.castsTruncated = payload.truncated;
            this.castsTotal = payload.total ?? payload.casts.length;
            this.castVariables = payload.variables;
        },
        setCastYears(years: Array<{ year: number, ctd: number, bottle: number }>) {
            this.castYears = years;
        },
        setObsFilter(filter: ObsFilter) {
            const f = { ...filter, months: [...filter.months].sort((a, b) => a - b) };
            if (f.from && f.to && f.to <= f.from) [f.from, f.to] = [f.to, f.from];
            if (JSON.stringify(f) !== JSON.stringify(this.obsFilter)) trackEvent('obs_filter_changed', { filter: JSON.stringify(f) });
            this.obsFilter = f;
        },
        setSensorCoverage(coverage: Record<string, number[]>) {
            this.sensorCoverage = coverage;
        },
        setShowCastLayer(value: boolean) {
            this.showCastLayer = value;
        },
        /**
         * Select a ship cast (or clear with null). Its profiles take over the
         * right-hand vertical-profile drawer, where the model's profiles live.
         */
        selectCast(id: string | null) {
            if (id && id !== this.selectedCastId) trackEvent('cast_selected', { cast: id });
            this.selectedCastId = id;
            if (id) {
                if (this.selectedSensor?.id) this.selectedSensor = null;
                if (this.selectedGliderId) this.selectGlider(null);
                this.isVerticalProfileOpen = true;
            }
        },
        setGliders(gliders: GliderDeployment[]) {
            this.gliders = gliders;
        },
        /** Select a glider deployment (or clear with null) and show its section. */
        selectGlider(id: string | null) {
            if (id && id !== this.selectedGliderId) trackEvent('glider_selected', { deployment: id });
            if (id !== this.selectedGliderId) this.gliderRange = null;
            this.selectedGliderId = id;
            if (id) {
                if (this.selectedCastId) this.selectedCastId = null;
                this.setExploreView('glider');
                if (this.activeBottomTab !== 'explore') this.setActiveBottomTab('explore');
            }
            else if (this.exploreView === 'glider') this.setExploreView('series');
        },
        setGliderRange(range: [number, number] | null) {
            this.gliderRange = range;
        },
        setShowGliderLayer(value: boolean) {
            this.showGliderLayer = value;
        },
        toggleGliderTilt() {
            this.gliderTiltToken++;
        },
        setShowSeafloor(value: boolean) {
            this.showSeafloor = value;
        },
        setShowOtherGliders(value: boolean) {
            this.showOtherGliders = value;
        },
        setSensorSearchQuery(query: string) {
            this.sensorSearchQuery = query;
        },
        setSensorOrganizationFilter(orgs: string[]) {
            this.sensorOrganizationFilter = orgs;
        },
        setSensorVariableFilter(vars: string[]) {
            this.sensorVariableFilter = vars;
        },
        /**
         * Select a sensor: snap to closest available depth and set as active sensor.
         * Can be called from any component (sensorInfo, map click handler, etc.)
         */
        selectSensor(sensor_id: string, depth: number) {
            console.log("Selecting sensor", sensor_id, "at depth", depth);
            // depth === -1 here is the sensor registry's "profiles the water column"
            // sentinel (see sensorComparison.vue's isVariableDepth) — a different meaning
            // than the model's own -1 "bottom" pseudo-level in `depthsArray` below. There's
            // no single fixed depth to snap the model view to for a profiler, so skip it;
            // the model's currently-selected depth is left untouched.
            if (depth !== -1) {
                const variable = this.selected_variable.var;
                const depthsArray = this.variables.find((v) => v.var === variable)?.depths;
                const closestDepth = depthsArray
                    ? [...depthsArray].sort((a, b) => Math.abs(a - depth) - Math.abs(b - depth))
                    : [];
                if (closestDepth.length > 0) {
                    const newDepthNc = closestDepth[0] ?? null;
                    const newDepth = newDepthNc !== null ? formatDepthLabel(newDepthNc) : null;
                    if (newDepth && newDepth !== this.selected_variable.depth) {
                        // Name both numbers and what moved. "Switched to closest
                        // available depth: 441.5m" left the user staring at a
                        // sensor card reading 1257 m and a map box reading
                        // 441.5 m with nothing connecting them — and never said
                        // it was the *map layer* that moved, not the sensor.
                        this.snackMessages.push({
                            color: 'warning',
                            // Rounded as `composables/useSensorFormat.ts`'s `depth2txt` rounds it:
                            // this line exists to be compared against the sensor
                            // card, and the raw float (1256.830810546875) reads
                            // as a third, unrelated number.
                            text: `Map layer moved to ${newDepth} m — the nearest model level to this sensor's ${depth.toFixed(0)} m`,
                        });
                        this.updateSelectedVariable({ depth: newDepth, depth_nc: newDepthNc });
                    }
                }
            }
            // Deliberately does not navigate. The sensor's series appears overlaid
            // on Explore's timeseries, which is the map-synced answer to "what did
            // I just click"; opening a fullscreen workspace would cover the map the
            // user is still working with.
            this.setSelectedSensor({ id: sensor_id, depth: depth });
        },

        setLastClickedMapPoint(point: { lat: number, lng: number } | null) {
            this.lastClickedMapPoint = point;
            // A new point knows nothing about its coverage until something
            // fetches for it; leaving the old verdict up would label the new
            // click with the previous one's domain status.
            this.modelDomain = null;
        },

        setModelDomainStatus(status: { inDomain: boolean, distanceKm: number | null } | null) {
            this.modelDomain = status;
        },

        setMapLayerLoading(loading: boolean) {
            this.mapLayerLoading = loading;
        },

        setTimePlaying(playing: boolean) {
            this.timePlaying = playing;
        },

        setCrossSectionLine(line: { lat: number, lng: number }[] | null) {
            this.crossSectionLine = line;
        },

        requestCrossSectionRedraw() {
            this.crossSectionLine = null;
            this.crossSectionRedrawToken++;
        },

        setObsArea(area: ObsArea | null) {
            if (area) {
                const depthMin = Math.max(0, Math.min(area.depthMin, area.depthMax));
                area = { ...area, radiusKm: Math.min(200, Math.max(0.1, area.radiusKm)), depthMin, depthMax: Math.max(depthMin, area.depthMax) };
                if (!this.obsArea) trackEvent('obs_area_drawn', { radius_km: Math.round(area.radiusKm) });
            }
            this.obsArea = area;
        },

        setObsAreaVariable(variable: string) {
            this.obsAreaVariable = variable;
        },

        requestObsAreaRedraw() {
            this.obsAreaDrawToken++;
        },

        setMapCenter(center: { lat: number, lng: number } | null) {
            this.mapCenter = center;
        },

        pushSnack(message: { color: string, text: string }) {
            this.snackMessages.push(message);
        },

        toggleIsControlPanelOpen() {
            this.isControlPanelOpen = !this.isControlPanelOpen;
        },

        setShowColorbarSettings(value: boolean) {
            this.showColorbarSettings = value;
        },

        setIsVerticalProfileOpen(value: boolean) {
            this.isVerticalProfileOpen = value;
        },

        toggleIsVerticalProfileOpen() {
            this.isVerticalProfileOpen = !this.isVerticalProfileOpen;
        },

        setQueryMode(mode: 'point' | 'area') {
            if (mode !== this.queryMode) {
                trackEvent('query_mode_changed', { mode });
            }
            this.queryMode = mode;
        },

        setActiveBottomTab(tab: BottomTab) {
            if (tab !== this.activeBottomTab) {
                trackEvent('tab_switched', { from_tab: this.activeBottomTab, to_tab: tab });
            }
            this.activeBottomTab = tab;
        },

        setAnalysisSource(source: 'model' | 'sensor') {
            if (source !== this.analysisSource) {
                trackEvent('analysis_source_changed', { source });
            }
            this.analysisSource = source;
        },

        setExploreView(view: ExploreView) {
            if (view !== this.exploreView) {
                trackEvent('explore_view_changed', { view });
            }
            this.exploreView = view;
        },

        // No analytics event here, unlike the setters above — this fires on
        // every bin-mode toggle click, a display-density choice rather than a
        // discrete user action worth counting (same reasoning as the other
        // exclusions for high-frequency, non-navigational state changes).
        setExploreBinMode(mode: 'hourly' | 'daily' | 'monthly') {
            this.exploreBinMode = mode;
        },

        setExploreWindowEnd(ms: number | null) {
            this.exploreWindowEnd = ms;
        },

        setViewStateField(scope: string, key: string, value: unknown) {
            const bag = this.viewState[scope] ?? (this.viewState[scope] = {});
            bag[key] = value;
        },

        /** Wholesale replace — restore only; normal writes go field by field. */
        setViewState(bags: Record<string, Record<string, unknown>>) {
            this.viewState = bags;
        },

        setAnalysisTab(tab: string) {
            this.analysisTab = tab;
        },

        setAnalysisSeason(season: string) {
            this.analysisSeason = season;
        },

        setComparisonTab(tab: string) {
            this.comparisonTab = tab;
        },

        setComparisonSeason(season: string) {
            this.comparisonSeason = season;
        },

        setMapView(view: { center: [number, number], zoom: number, bearing: number, pitch: number } | null) {
            this.mapView = view;
        },

        setPendingShare(state: any) {
            this.pendingShare = state;
        },

        clearPendingShare() {
            this.pendingShare = null;
            this.shareRestorePending = false;
        },

        takePendingMapView() {
            const v = this.pendingMapView;
            this.pendingMapView = null;
            return v;
        },

        takePendingWindowEnd() {
            const v = this.pendingWindowEnd;
            this.pendingWindowEnd = null;
            return v;
        },
    }
})