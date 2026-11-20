<template>
  <USlideover :open="true" :title="sensor.name" side="right" :ui="{ content: 'max-w-[620px]' }" @update:open="v => !v && emit('close')">
    <template #description>
      <span class="inline-flex items-center gap-2">
        <i class="adm-dot" :style="{ background: FRESHNESS[freshness(sensor)].color }" />
        {{ FRESHNESS[freshness(sensor)].label }} · last value {{ ageText(lastValue(sensor), state.now) }} ago
        · {{ sensor.active ? 'on the map' : 'hidden' }}
      </span>
    </template>

    <template #body>
      <div class="flex flex-col gap-6">
        <div class="flex gap-2">
          <UButton size="sm" icon="i-mdi-refresh" :disabled="!unlocked || !sensor.active || !state.prefect" @click="harvest">Harvest now</UButton>
        </div>

        <section>
          <h2 class="sec">Record, {{ startYear }} → today</h2>
          <p v-if="!coverage.length" class="text-muted text-sm">No values ingested yet.</p>
          <div v-for="c in coverage" :key="c.variable" class="cov">
            <span>{{ variableLabel(c.variable) }}</span>
            <i><b :style="c.style" /></i>
            <span class="adm-num text-muted">{{ fmtDay(c.first) }} → {{ fmtDay(c.last) }} · {{ c.rows.toLocaleString('en-CA') }}</span>
          </div>
        </section>

        <section class="flex flex-col gap-3">
          <h2 class="sec">Details</h2>
          <label class="adm-field">Display name<UInput v-model="form.name" :disabled="!unlocked" /></label>
          <div class="grid grid-cols-2 gap-3">
            <label class="adm-field">Organization<UInput v-model="form.organization" :disabled="!unlocked" /></label>
            <label class="adm-field">Nominal depth (m, −1 = profiler)<UInput v-model="form.depth" :disabled="!unlocked" /></label>
          </div>
          <label class="adm-field">Note shown in the app<UTextarea v-model="form.note" :rows="2" :disabled="!unlocked"
            placeholder="e.g. Instrument recovered for servicing until spring" /></label>
          <p class="adm-note">Renaming here doesn't change <span class="adm-num">sensors/catalog_*.yml</span>: a later
            <span class="adm-num">manage_sensors.py import</span> matches by name and would add the old name again. Rename it there too.</p>
          <div><UButton size="sm" variant="outline" :disabled="!unlocked || !detailsChanged" @click="stageDetails">Stage changes</UButton></div>
        </section>

        <section class="flex flex-col gap-2">
          <h2 class="sec">Variable mapping</h2>
          <table class="adm-table">
            <thead><tr><th>App variable</th><th>Source name</th><th>Unit</th><th class="num">× factor</th></tr></thead>
            <tbody>
              <tr v-for="(v, key) in vars" :key="key">
                <td>{{ variableLabel(String(key)) }}</td>
                <td><UInput v-model="v.name" size="xs" :disabled="!unlocked || sensor.api === 'ONC'" /></td>
                <td><UInput v-model="v.unit" size="xs" :disabled="!unlocked" /></td>
                <td><UInput v-model="v.conversion_factor" size="xs" class="w-24" :disabled="!unlocked" /></td>
              </tr>
            </tbody>
          </table>
          <p class="adm-note">A new factor applies to values harvested from now on. To convert what's stored, delete the data below
            and harvest again. ONC sources are listed in device_config, so only unit and factor are editable for them.</p>
          <div><UButton size="sm" variant="outline" :disabled="!unlocked || !varsChanged" @click="stageVars">Stage mapping</UButton></div>
        </section>

        <section class="kv">
          <span>Source</span><span class="adm-num">{{ sensor.api }}{{ sensor.source.link ? ` · ${sensor.source.link}` : '' }}</span>
          <template v-if="sensor.source.constraints"><span>Row filter</span><span class="adm-num">{{ sensor.source.constraints }}</span></template>
          <span>Position</span><span class="adm-num">{{ sensor.latitude.toFixed(4) }}, {{ sensor.longitude.toFixed(4) }}</span>
          <span>Id</span><span class="adm-num">{{ sensor.id }}</span>
          <span>Updated</span><span class="adm-num">{{ fmtTime(sensor.updated_at) }}</span>
        </section>

        <section class="adm-confirm">
          <b>Delete this sensor's data</b>
          <span class="text-muted text-sm">Removes its rows from sensor_timeseries now, not on Apply, and hides the sensor. It can't
            be undone; a harvest refetches what the source still has. Type the sensor's name to confirm.</span>
          <div class="flex gap-2">
            <UInput v-model="confirmName" size="sm" class="grow" :disabled="!unlocked" :placeholder="sensor.name" aria-label="Type the sensor name" />
            <UButton size="sm" color="error" :disabled="!unlocked || confirmName.trim() !== sensor.name" @click="deleteData">Delete data</UButton>
          </div>
        </section>
      </div>
    </template>
  </USlideover>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useVariableRegistry } from '~~/composables/useVariableRegistry'
import { useAdmin, ageText, fmtDay, fmtTime, FRESHNESS, type AdminSensor } from '~~/composables/useAdmin'

const props = defineProps<{ sensor: AdminSensor }>()
const emit = defineEmits<{ close: [] }>()
const { state, unlocked, freshness, lastValue, sensorValue, stage, act } = useAdmin()
const { variableLabel } = useVariableRegistry()

const form = reactive({ name: '', organization: '', depth: '', note: '' })
const vars = ref<Record<string, { name?: string, unit?: string, conversion_factor?: number | string }>>({})
const confirmName = ref('')

function reset() {
  const s = props.sensor
  form.name = sensorValue(s, 'name')
  form.organization = sensorValue(s, 'organization')
  form.depth = String(Math.round(sensorValue(s, 'depth') * 100) / 100)
  form.note = sensorValue(s, 'note')
  vars.value = JSON.parse(JSON.stringify(sensorValue(s, 'variables')))
  confirmName.value = ''
}
watch(() => [props.sensor, state.revision], reset, { immediate: true })

const detailsChanged = computed(() => {
  const s = props.sensor
  return form.name !== sensorValue(s, 'name') || form.organization !== sensorValue(s, 'organization')
    || Number(form.depth) !== Math.round(sensorValue(s, 'depth') * 100) / 100 || form.note !== sensorValue(s, 'note')
})

function stageDetails() {
  const s = props.sensor
  const fields = [
    ['name', form.name.trim(), 'Rename'], ['organization', form.organization.trim(), 'Set organization'],
    ['depth', Number(form.depth), 'Set depth'], ['note', form.note.trim(), 'Set note'],
  ] as const
  for (const [field, value, what] of fields) {
    const stored = field === 'depth' ? Math.round(sensorValue(s, 'depth') * 100) / 100 : sensorValue(s, field)
    if (JSON.stringify(value) !== JSON.stringify(stored)) {
      stage({ kind: 'sensor', id: s.id, field, value, summary: `${what}: ${s.name}${field === 'name' ? ` → ${value}` : ''}` })
    }
  }
}

function normalisedVars() {
  return Object.fromEntries(Object.entries(vars.value).map(([k, v]) => [k, { ...v, conversion_factor: Number(v.conversion_factor) }]))
}
const varsChanged = computed(() => JSON.stringify(normalisedVars()) !== JSON.stringify(sensorValue(props.sensor, 'variables')))

function stageVars() {
  stage({ kind: 'sensor', id: props.sensor.id, field: 'variables', value: normalisedVars(), summary: `Edit variable mapping: ${props.sensor.name}` })
}

function harvest() {
  act(`Harvest started for ${props.sensor.name}`, a => a.post(`/sensors/${props.sensor.id}/harvest`))
}

async function deleteData() {
  const ok = await act(`Deleted ${props.sensor.name}'s data`,
    a => a.post(`/sensors/${props.sensor.id}/delete-data`, { confirm: confirmName.value }), true)
  if (ok) confirmName.value = ''
}

const START = Date.UTC(2005, 0, 1)
const coverage = computed(() => {
  const now = state.now
  return Object.entries(props.sensor.coverage).map(([variable, [first, last, rows]]) => {
    const a = Math.max(0, (Date.parse(first) - START) / (now - START) * 100)
    const b = Math.min(100, (Date.parse(last) - START) / (now - START) * 100)
    return { variable, first, last, rows, style: { left: `${a}%`, width: `${Math.max(0.5, b - a)}%` } }
  })
})
const startYear = new Date(START).getUTCFullYear()
</script>

<style scoped>
.sec { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--ui-text-muted); margin-bottom: 8px; }
.cov { display: grid; grid-template-columns: 140px 1fr; gap: 2px 10px; align-items: center; font-size: 12px; margin-bottom: 6px; }
.cov i { position: relative; height: 6px; background: var(--ui-bg-accented); }
.cov b { position: absolute; top: 0; bottom: 0; background: var(--adm-sensor); }
.cov > span:last-child { grid-column: 2; font-size: 11px; }
.kv { display: grid; grid-template-columns: 90px 1fr; gap: 4px 10px; font-size: 12px; }
.kv > span:nth-child(odd) { color: var(--ui-text-muted); }
.kv > span:nth-child(even) { word-break: break-all; }
</style>
