<template>
  <div>
    <div class="adm-head">
      <div>
        <h1>Overview</h1>
        <p>What needs a decision today, then the state of each part of the app.</p>
      </div>
    </div>

    <section class="adm-panel">
      <h2>Needs attention</h2>
      <p v-if="!attention.length" class="text-muted text-sm">Nothing right now.</p>
      <ul class="attn">
        <li v-for="a in attention" :key="a.text">
          <span class="attn__sev" :style="{ background: a.color }" />
          <div class="grow">
            <p>{{ a.text }}</p>
            <small>{{ a.detail }}</small>
          </div>
          <UButton size="xs" variant="outline" @click="emit('go', a.view, a.filter)">Review</UButton>
        </li>
      </ul>
    </section>

    <div class="adm-grid adm-grid--4">
      <div class="adm-panel adm-stat">
        <span class="k">Sensors on the map</span>
        <span class="v">{{ visible.length }}</span>
        <span class="n">of {{ state.sensors.length }} · {{ state.sensors.length - visible.length }} hidden</span>
      </div>
      <div class="adm-panel adm-stat">
        <span class="k">Reporting within the live threshold</span>
        <span class="v" style="color: var(--adm-live)">{{ counts.live }}</span>
        <span class="n">{{ visible.length ? Math.round(counts.live / visible.length * 100) : 0 }}% of the sensors on the map</span>
      </div>
      <div class="adm-panel adm-stat">
        <span class="k">Latest model day in the app</span>
        <span class="v">{{ latestModelDay ? fmtDay(latestModelDay) : '—' }}</span>
        <span class="n">from SalishSeaCast_sync_log</span>
      </div>
      <div class="adm-panel adm-stat">
        <span class="k">ClickHouse on disk</span>
        <span class="v">{{ storage ? fmtBytes(totalBytes) : '—' }}</span>
        <span class="n">{{ storage ? `${fmtBytes(unusedBytes)} in tables the app doesn't use` : '' }}</span>
      </div>
    </div>

    <div class="adm-grid adm-grid--2">
      <section class="adm-panel">
        <h2>Sensor freshness</h2>
        <AdminFreshnessBands :sensors="visible" />
        <p class="adm-note">Age of each visible sensor's newest value.</p>
      </section>
      <section class="adm-panel">
        <h2>Recent admin actions</h2>
        <p v-if="!audit.length" class="text-muted text-sm">None yet.</p>
        <div class="adm-list">
          <div v-for="a in audit" :key="a.id">
            <p>{{ a.label ? `${a.label}: ` : '' }}{{ a.summary }}<small>{{ fmtTime(a.at) }} · {{ a.email }}</small></p>
            <UBadge variant="outline" color="neutral">{{ a.kind }}</UBadge>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useAdmin, fmtBytes, fmtDay, fmtTime, FRESHNESS, type Freshness } from '~~/composables/useAdmin'

const emit = defineEmits<{ go: [view: any, filter?: string] }>()
const { state, api, freshness } = useAdmin()

const visible = computed(() => state.sensors.filter(s => s.active))
const counts = computed(() => {
  const c: Record<Freshness, number> = { live: 0, lag: 0, stale: 0, silent: 0, none: 0 }
  for (const s of visible.value) c[freshness(s)]++
  return c
})

const model = ref<any>(null)
const storage = ref<any[] | null>(null)
const audit = ref<any[]>([])

async function load() {
  const [m, st, au] = await Promise.allSettled([api.get('/model'), api.get('/storage'), api.get('/audit', { params: { limit: 5 } })])
  if (m.status === 'fulfilled') model.value = m.value.data
  if (st.status === 'fulfilled') storage.value = st.value.data
  if (au.status === 'fulfilled') audit.value = au.value.data
}
onMounted(load)
watch(() => state.revision, load)

const latestModelDay = computed(() =>
  model.value?.sync?.SalishSeaCast_sync_log?.find((r: any) => r.status === 'success')?.date ?? null)
const totalBytes = computed(() => (storage.value ?? []).reduce((a, t) => a + t.bytes, 0))
const unusedBytes = computed(() => (storage.value ?? []).filter(t => t.group === 'unused').reduce((a, t) => a + t.bytes, 0))

const attention = computed(() => {
  const out: Array<{ text: string, detail: string, color: string, view: string, filter?: string }> = []
  const polledSilent = visible.value.filter(s => s.auto_harvest && ['silent', 'none'].includes(freshness(s)))
  if (polledSilent.length) out.push({
    text: `${polledSilent.length} sensor${polledSilent.length === 1 ? '' : 's'} silent or never reported, but still polled every hour`,
    detail: `They stay on the map either way. Turning off auto-harvest saves about ${polledSilent.length * 24} source requests a day; Harvest now still works.`,
    color: FRESHNESS.silent.color, view: 'sensors', filter: 'silent',
  })
  if (counts.value.lag) out.push({
    text: `${counts.value.lag} sensor${counts.value.lag === 1 ? ' is' : 's are'} lagging`,
    detail: 'Still harvested hourly. Some sources deliver late, so this may clear on its own.',
    color: FRESHNESS.lag.color, view: 'sensors', filter: 'lag',
  })
  const failed = (model.value?.sync?.SalishSeaCast_sync_log ?? []).filter((r: any) => r.status === 'failed')
  if (failed.length) out.push({
    text: `Model sync failed for ${failed.length} day${failed.length === 1 ? '' : 's'}`,
    detail: `Latest: ${fmtDay(failed[0].date)}. PROCESS retries on its next run.`,
    color: FRESHNESS.silent.color, view: 'model',
  })
  if (latestModelDay.value && state.now - Date.parse(`${latestModelDay.value}T00:00:00Z`) > 3 * 864e5) out.push({
    text: `The newest model day in the app is ${fmtDay(latestModelDay.value)}`,
    detail: 'SalishSeaCast usually runs a day behind; more than three days means the pipeline or sync is stuck.',
    color: FRESHNESS.stale.color, view: 'model',
  })
  if (unusedBytes.value > 1024 ** 3) out.push({
    text: `${fmtBytes(unusedBytes.value)} of tables the app doesn't use are still in ClickHouse`,
    detail: 'Leftovers such as the removed LiveOcean tables.',
    color: FRESHNESS.stale.color, view: 'storage',
  })
  return out
})
</script>

<style scoped>
.attn { display: flex; flex-direction: column; }
.attn li { display: flex; gap: 12px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--ui-border-muted); font-size: 13px; }
.attn li:last-child { border-bottom: 0; }
.attn small { color: var(--ui-text-muted); font-size: 12px; }
.attn__sev { width: 3px; align-self: stretch; flex-shrink: 0; }
</style>
