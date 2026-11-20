<template>
  <div>
    <div class="adm-head">
      <div>
        <h1>Sensors</h1>
        <p>Every station the app knows about. <b>On map</b> shows it to visitors. <b>Auto-harvest</b> decides whether the hourly
          job polls it; a hidden sensor is never harvested. ↻ harvests one sensor now, even with auto-harvest off.</p>
      </div>
      <UButton icon="i-mdi-plus" :disabled="!unlocked" :title="unlocked ? undefined : 'Unlock to add a sensor'" @click="addOpen = true">Add sensor</UButton>
    </div>

    <section class="adm-panel"><AdminFreshnessBands :sensors="visible" /></section>

    <div class="toolbar">
      <SegmentedControl v-model="filter" :items="filterItems" size="xs" wrap aria-label="Filter by status" />
      <USelect v-model="org" :items="orgItems" size="xs" class="w-48" aria-label="Organization" />
      <UInput v-model="q" size="xs" icon="i-mdi-magnify" placeholder="Search name" aria-label="Search sensors" />
      <UButton v-if="bulkTargets.length" size="xs" variant="outline" :disabled="!unlocked" @click="stopBulk">
        Stop auto-harvest for these {{ bulkTargets.length }}
      </UButton>
    </div>

    <table class="adm-table">
      <thead>
        <tr>
          <th>Status</th><th>Name</th><th>Org</th><th>Source</th><th class="num">Depth</th><th>Variables</th>
          <th class="num">Last value</th><th>On map</th><th>Auto-harvest</th><th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in rows" :key="s.id" class="row" @click="selected = s.id">
          <td><span class="status"><i class="adm-dot" :style="{ background: FRESHNESS[freshness(s)].color }" />{{ FRESHNESS[freshness(s)].label }}</span></td>
          <td class="name" :title="s.name">{{ sensorValue(s, 'name') }}</td>
          <td class="text-muted">{{ sensorValue(s, 'organization') }}</td>
          <td class="text-muted adm-num">{{ s.api }}</td>
          <td class="num">{{ depthText(sensorValue(s, 'depth')) }}</td>
          <td class="text-muted vars">{{ Object.keys(s.variables).map(variableLabel).join(', ') }}</td>
          <td class="num">{{ ageText(lastValue(s), state.now) }}</td>
          <td @click.stop>
            <USwitch size="sm" :model-value="sensorValue(s, 'active')" :disabled="!unlocked" :class="{ 'adm-staged': isStaged(s, 'active') }"
              :aria-label="`On map: ${s.name}`" @update:model-value="v => toggle(s, 'active', v)" />
          </td>
          <td @click.stop>
            <USwitch size="sm" :model-value="sensorValue(s, 'active') && sensorValue(s, 'auto_harvest')"
              :disabled="!unlocked || !sensorValue(s, 'active')" :class="{ 'adm-staged': isStaged(s, 'auto_harvest') }"
              :title="sensorValue(s, 'active') ? undefined : 'Hidden sensors are not harvested'"
              :aria-label="`Auto-harvest: ${s.name}`" @update:model-value="v => toggle(s, 'auto_harvest', v)" />
          </td>
          <td @click.stop>
            <UButton size="xs" variant="ghost" icon="i-mdi-refresh" :disabled="!unlocked || !s.active || !state.prefect"
              :title="!state.prefect ? 'Prefect isn\'t configured on this API' : s.active ? 'Harvest this sensor now' : 'Hidden sensors are not harvested'"
              :aria-label="`Harvest now: ${s.name}`" @click="harvest(s)" />
          </td>
        </tr>
        <tr v-if="!rows.length"><td colspan="10" class="text-muted">No sensors match.</td></tr>
      </tbody>
    </table>

    <AdminSensorDrawer v-if="selectedSensor" :sensor="selectedSensor" @close="selected = null" />
    <AdminAddSensor v-model:open="addOpen" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import SegmentedControl from '~/components/ui/SegmentedControl.vue'
import { useVariableRegistry } from '~~/composables/useVariableRegistry'
import { useAdmin, ageText, FRESHNESS, type AdminSensor, type Freshness } from '~~/composables/useAdmin'

const props = defineProps<{ initialFilter?: string }>()
const { state, unlocked, freshness, lastValue, sensorValue, isStaged, stage, act } = useAdmin()
const { variableLabel } = useVariableRegistry()

const filter = ref(props.initialFilter ?? 'all')
watch(() => props.initialFilter, f => { filter.value = f ?? 'all' })
const org = ref('all')
const q = ref('')
const selected = ref<string | null>(null)
const addOpen = ref(false)

const visible = computed(() => state.sensors.filter(s => s.active))
const selectedSensor = computed(() => state.sensors.find(s => s.id === selected.value) ?? null)

const filterItems = computed(() => {
  const c = (f: Freshness) => visible.value.filter(s => freshness(s) === f).length
  return [
    { value: 'all', label: `On map ${visible.value.length}` },
    ...(['live', 'lag', 'stale', 'silent', 'none'] as Freshness[]).map(f => ({ value: f, label: `${FRESHNESS[f].label} ${c(f)}` })),
    { value: 'hidden', label: `Hidden ${state.sensors.length - visible.value.length}` },
  ]
})
const orgItems = computed(() => [
  { label: 'All organizations', value: 'all' },
  ...[...new Set(state.sensors.map(s => s.organization).filter(Boolean))].sort().map(o => ({ label: o, value: o })),
])

const rows = computed(() => {
  const needle = q.value.trim().toLowerCase()
  return state.sensors.filter(s =>
    (filter.value === 'hidden' ? !s.active : s.active && (filter.value === 'all' || freshness(s) === filter.value))
    && (org.value === 'all' || s.organization === org.value)
    && (!needle || s.name.toLowerCase().includes(needle)))
})

const bulkTargets = computed(() => ['stale', 'silent', 'none'].includes(filter.value)
  ? rows.value.filter(s => sensorValue(s, 'auto_harvest')) : [])

function toggle(s: AdminSensor, field: 'active' | 'auto_harvest', value: boolean) {
  const what = field === 'active' ? (value ? 'Show on map' : 'Hide from map') : (value ? 'Turn on auto-harvest' : 'Turn off auto-harvest')
  stage({ kind: 'sensor', id: s.id, field, value, summary: `${what}: ${s.name}` })
}

function stopBulk() {
  for (const s of bulkTargets.value) stage({ kind: 'sensor', id: s.id, field: 'auto_harvest', value: false, summary: `Turn off auto-harvest: ${s.name}` })
}

function harvest(s: AdminSensor) {
  act(`Harvest started for ${s.name}`, a => a.post(`/sensors/${s.id}/harvest`))
}

function depthText(d: number) {
  return d < 0 ? 'profile' : `${Math.round(d * 10) / 10} m`
}
</script>

<style scoped>
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
.status { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.name { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vars { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
