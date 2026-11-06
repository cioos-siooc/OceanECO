import type mapboxgl from 'mapbox-gl'
import { chart } from '@/config/palette'
import { haversineM } from '@/utils/sensorMerge'

/**
 * The Area tab's circle on the map: drawn by pressing at the centre and
 * dragging out the radius (a plain click gives DEFAULT_RADIUS_KM), then shown
 * as a dashed ring while the tab is open. Drawing is armed only on request
 * (`arm(true)`), so with a circle in place the map pans as usual.
 */
const SOURCE = 'obs-area'
const FILL = 'obs-area-fill'
const LINE = 'obs-area-line'
const CENTRE = 'obs-area-centre'
const DEFAULT_RADIUS_KM = 5
const EARTH_KM = 6371

export interface AreaCircle { lat: number, lng: number, radiusKm: number }

/** A geodesic circle as a closed ring of `steps` vertices. */
export function circleRing(c: AreaCircle, steps = 96): [number, number][] {
    const φ1 = c.lat * Math.PI / 180, λ1 = c.lng * Math.PI / 180, δ = c.radiusKm / EARTH_KM
    const ring: [number, number][] = []
    for (let i = 0; i <= steps; i++) {
        const θ = (i / steps) * 2 * Math.PI
        const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
        const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
        ring.push([λ2 * 180 / Math.PI, φ2 * 180 / Math.PI])
    }
    return ring
}

function data(c: AreaCircle | null): GeoJSON.FeatureCollection {
    if (!c) return { type: 'FeatureCollection', features: [] }
    return {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circleRing(c)] } },
            { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [c.lng, c.lat] } },
        ],
    }
}

export function useObsAreaLayer(map: mapboxgl.Map, onDrawn: (c: AreaCircle) => void) {
    let armed = false
    let start: { lat: number, lng: number } | null = null
    function render(c: AreaCircle | null) {
        const src = map.getSource(SOURCE) as mapboxgl.GeoJSONSource | undefined
        if (src) { src.setData(data(c)); return }
        if (!map.isStyleLoaded()) return
        map.addSource(SOURCE, { type: 'geojson', data: data(c) })
        map.addLayer({ id: FILL, type: 'fill', source: SOURCE, filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'fill-color': chart.model, 'fill-opacity': 0.06 } })
        map.addLayer({ id: LINE, type: 'line', source: SOURCE, filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'line-color': chart.model, 'line-width': 1.6, 'line-dasharray': [3, 2] } })
        map.addLayer({ id: CENTRE, type: 'circle', source: SOURCE, filter: ['==', ['geometry-type'], 'Point'],
            paint: { 'circle-radius': 3, 'circle-color': chart.model, 'circle-stroke-width': 1, 'circle-stroke-color': '#13161a' } })
    }

    function arm(on: boolean) {
        armed = on
        map.getCanvas().style.cursor = on ? 'crosshair' : ''
    }

    const radiusTo = (e: mapboxgl.MapMouseEvent | mapboxgl.MapTouchEvent) =>
        haversineM(start!.lat, start!.lng, e.lngLat.lat, e.lngLat.lng) / 1000

    function onDown(e: mapboxgl.MapMouseEvent | mapboxgl.MapTouchEvent) {
        if (!armed) return
        if ('originalEvent' in e && e.originalEvent instanceof MouseEvent && e.originalEvent.button !== 0) return
        e.preventDefault()
        map.dragPan.disable()
        start = { lat: e.lngLat.lat, lng: e.lngLat.lng }
        render({ ...start, radiusKm: 0.01 })
    }
    function onMove(e: mapboxgl.MapMouseEvent | mapboxgl.MapTouchEvent) {
        if (start) render({ ...start, radiusKm: radiusTo(e) })
    }
    function onUp(e: mapboxgl.MapMouseEvent | mapboxgl.MapTouchEvent) {
        if (!start) return
        const r = radiusTo(e)
        // A click without a drag (under ~100 m on the ground) places the default circle.
        const c = { ...start, radiusKm: r < 0.1 ? DEFAULT_RADIUS_KM : r }
        start = null
        map.dragPan.enable()
        arm(false)
        render(c)
        onDrawn(c)
    }

    map.on('mousedown', onDown)
    map.on('mousemove', onMove)
    map.on('mouseup', onUp)
    map.on('touchstart', onDown)
    map.on('touchmove', onMove)
    map.on('touchend', onUp)

    return {
        arm,
        render,
    }
}
