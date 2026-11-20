<template>
  <UModal v-model:open="open" title="Add sensor" :ui="{ content: 'max-w-[760px]' }">
    <template #body>
      <div class="flex flex-col gap-4">
        <SegmentedControl v-model="type" :items="typeItems" size="sm" :disabled="!!found" aria-label="Source type" />
        <label class="adm-field">{{ type === 'erddap' ? 'tabledap URL' : 'Location code' }}
          <UInput v-model="source" :disabled="!!found"
            :placeholder="type === 'erddap' ? 'https://…/erddap/tabledap/DatasetID' : 'e.g. SCVIP'" />
        </label>
        <label v-if="type === 'erddap'" class="adm-field">Row filter (optional, for datasets holding several stations)
          <UInput v-model="constraints" :disabled="!!found" placeholder='STN_ID="C46146"' />
        </label>
        <div v-if="!found" class="flex gap-2 items-center">
          <UButton :loading="looking" :disabled="!source.trim()" @click="lookup">Look up</UButton>
          <span class="text-muted text-xs">Reads the source's metadata only. ONC lookups can take a minute.</span>
        </div>
        <UAlert v-if="error" color="error" variant="subtle" :description="error" />

        <template v-if="found">
          <UAlert v-if="found.duplicates.length" color="warning" variant="subtle" title="Already a sensor"
            :description="`This source is already used by: ${found.duplicates.join(', ')}`" />
          <div class="kv">
            <span>Position</span><span class="adm-num">{{ found.latitude.toFixed(4) }}, {{ found.longitude.toFixed(4) }}</span>
            <span>Depth</span><span>{{ found.depth < 0 ? 'variable depth (profiler)' : `${found.depth} m` }}</span>
            <span>Link</span><span class="adm-num break-all">{{ found.source.link || '—' }}</span>
          </div>

          <table class="adm-table">
            <thead><tr><th>App variable</th><th>Source</th><th>Unit</th><th class="num">× factor</th><th>Use</th></tr></thead>
            <tbody>
              <tr v-for="(v, key) in found.variables" :key="key">
                <td>{{ variableLabel(String(key)) }}</td>
                <td class="adm-num text-muted">{{ v.name || sourcesOf(String(key)) }}</td>
                <td><UInput v-model="v.unit" size="xs" class="w-24" /></td>
                <td><UInput v-model="v.conversion_factor" size="xs" class="w-24" /></td>
                <td><UCheckbox v-model="use[String(key)]" :aria-label="`Use ${key}`" /></td>
              </tr>
            </tbody>
          </table>
          <p class="adm-note">Matched by name and unit. A factor other than 1 converts to the app's unit at harvest time.</p>

          <label class="adm-field">Display name<UInput v-model="name" /></label>
          <div class="grid grid-cols-2 gap-3">
            <label class="adm-field">Organization<UInput v-model="organization" /></label>
            <label class="adm-field">Note shown in the app (optional)<UInput v-model="note" /></label>
          </div>
          <div class="flex gap-6 text-sm">
            <label class="inline-flex items-center gap-2"><USwitch v-model="onMap" />On map</label>
            <label class="inline-flex items-center gap-2"><USwitch v-model="autoHarvest" :disabled="!onMap" />Auto-harvest</label>
          </div>
          <p class="adm-note">With auto-harvest on, the next hourly run fetches the whole record. Add it to
            <span class="adm-num">sensors/catalog_*.yml</span> too, or a rebuilt database won't have it.</p>
        </template>
      </div>
    </template>
    <template #footer>
      <div class="flex gap-2">
        <UButton v-if="found" color="primary" :disabled="!canStage" @click="stageIt">Stage new sensor</UButton>
        <UButton v-if="found" variant="outline" @click="found = null">Change source</UButton>
        <UButton variant="ghost" @click="open = false">Cancel</UButton>
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import SegmentedControl from '~/components/ui/SegmentedControl.vue'
import { useVariableRegistry } from '~~/composables/useVariableRegistry'
import { useAdmin, errorText } from '~~/composables/useAdmin'

const open = defineModel<boolean>('open', { default: false })
const { api, stage } = useAdmin()
const { variableLabel } = useVariableRegistry()

const typeItems = [{ value: 'erddap', label: 'ERDDAP dataset' }, { value: 'onc', label: 'ONC location' }]
const type = ref<'erddap' | 'onc'>('erddap')
const source = ref('')
const constraints = ref('')
const looking = ref(false)
const error = ref('')
const found = ref<any>(null)
const name = ref('')
const organization = ref('')
const note = ref('')
const onMap = ref(true)
const autoHarvest = ref(true)
const use = ref<Record<string, boolean>>({})

watch(open, o => { if (o) { found.value = null; error.value = ''; source.value = ''; constraints.value = '' } })

async function lookup() {
  looking.value = true
  error.value = ''
  try {
    const r = (await api.post('/sensors/lookup', { type: type.value, source: source.value, constraints: constraints.value }, { timeout: 180_000 })).data
    found.value = r
    name.value = r.name
    organization.value = r.organization
    note.value = ''
    use.value = Object.fromEntries(Object.keys(r.variables).map(k => [k, true]))
  } catch (e) {
    error.value = errorText(e)
  } finally {
    looking.value = false
  }
}

function sourcesOf(key: string) {
  return (found.value?.device_config?.sources?.[key] ?? [])
    .map((s: any) => `${s.locationCode}/${s.deviceCategoryCode}/${s.sensorCategoryCode}`).join(', ')
}

const chosen = computed(() => Object.fromEntries(Object.entries(found.value?.variables ?? {})
  .filter(([k]) => use.value[k])
  .map(([k, v]: [string, any]) => [k, { ...v, conversion_factor: Number(v.conversion_factor) }])))
const canStage = computed(() => name.value.trim() && Object.keys(chosen.value).length)

function stageIt() {
  const f = found.value
  const sources = f.device_config?.sources
  stage({
    kind: 'sensor_new',
    summary: `Add sensor: ${name.value.trim()}`,
    value: {
      _key: crypto.randomUUID(),
      name: name.value.trim(), organization: organization.value.trim(), note: note.value.trim(),
      latitude: f.latitude, longitude: f.longitude, depth: f.depth,
      variables: chosen.value,
      device_config: sources ? { ...f.device_config, sources: Object.fromEntries(Object.entries(sources).filter(([k]) => use.value[k])) } : f.device_config,
      source: f.source, active: onMap.value, auto_harvest: onMap.value && autoHarvest.value,
    },
  })
  open.value = false
}
</script>

<style scoped>
.kv { display: grid; grid-template-columns: 90px 1fr; gap: 4px 10px; font-size: 12px; }
.kv > span:nth-child(odd) { color: var(--ui-text-muted); }
</style>
