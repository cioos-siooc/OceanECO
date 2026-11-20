<template>
  <div>
    <div class="adm-head">
      <div>
        <h1>Storage</h1>
        <p>ClickHouse tables by size on disk. Bar length is square-root scaled so small tables stay visible.</p>
      </div>
      <UButton variant="ghost" icon="i-mdi-refresh" :loading="loading" @click="load">Refresh</UButton>
    </div>
    <UAlert v-if="error" color="error" variant="subtle" :description="error" class="mb-4" />

    <section v-for="g in groups" :key="g.id" class="adm-panel">
      <h2>{{ g.title }} <span class="adm-num normal-case">· {{ fmtBytes(g.bytes) }}</span></h2>
      <p v-if="g.id === 'unused'" class="adm-note mb-2">Nothing in the app reads these. Dropping one is immediate and can't be undone.</p>
      <div v-for="t in g.tables" :key="t.name">
        <div class="bar">
          <span class="adm-num">{{ t.name }}</span>
          <i><b :style="{ width: `${Math.max(0.4, Math.sqrt(t.bytes / maxBytes) * 100)}%` }" :class="{ unused: g.id === 'unused' }" /></i>
          <span class="adm-num num">{{ fmtBytes(t.bytes) }}</span>
          <span class="text-muted text-xs">{{ t.rows.toLocaleString('en-CA') }} rows · {{ t.engine }}</span>
          <UButton v-if="g.id === 'unused'" size="xs" variant="ghost" color="error" :disabled="!unlocked"
            @click="dropping = dropping === t.name ? null : t.name">Drop…</UButton>
        </div>
        <div v-if="dropping === t.name" class="adm-confirm">
          <b>Drop {{ t.name }}, {{ fmtBytes(t.bytes) }}</b>
          <span class="text-sm">Type <span class="adm-num">drop {{ t.name }}</span> to confirm.</span>
          <div class="flex gap-2">
            <UInput v-model="confirmText" size="sm" class="grow" :aria-label="`Type drop ${t.name}`" />
            <UButton size="sm" color="error" :disabled="confirmText.trim() !== `drop ${t.name}`" @click="drop(t.name)">Drop</UButton>
            <UButton size="sm" variant="ghost" @click="dropping = null">Cancel</UButton>
          </div>
        </div>
      </div>
    </section>

    <section class="adm-panel">
      <h2>Caches</h2>
      <div class="adm-list">
        <div>
          <p>API response cache<small>Cached results for timeseries, profiles and snapshots. Applying changes here clears it too.</small></p>
          <UButton size="xs" variant="outline" :disabled="!unlocked" @click="act('Cleared the API response cache', a => a.post('/cache/clear'))">Clear</UButton>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAdmin, errorText, fmtBytes } from '~~/composables/useAdmin'

const { api, act, unlocked } = useAdmin()
const tables = ref<any[]>([])
const loading = ref(false)
const error = ref('')
const dropping = ref<string | null>(null)
const confirmText = ref('')

async function load() {
  loading.value = true
  try {
    tables.value = (await api.get('/storage')).data
    error.value = ''
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)

const TITLES: Record<string, string> = { model: 'Model', observations: 'Observations', admin: 'Admin dashboard', unused: 'Not used by the app' }
const groups = computed(() => Object.entries(TITLES).map(([id, title]) => {
  const ts = tables.value.filter(t => t.group === id)
  return { id, title, tables: ts, bytes: ts.reduce((a, t) => a + t.bytes, 0) }
}).filter(g => g.tables.length))
const maxBytes = computed(() => Math.max(1, ...tables.value.map(t => t.bytes)))

async function drop(name: string) {
  if (await act(`Dropped ${name}`, a => a.post(`/storage/drop/${encodeURIComponent(name)}`, { confirm: confirmText.value }))) {
    dropping.value = null
    confirmText.value = ''
    load()
  }
}
</script>

<style scoped>
.bar { display: grid; grid-template-columns: minmax(160px, 260px) 1fr 80px minmax(140px, 220px) 60px; gap: 10px; align-items: center; font-size: 12px; padding: 3px 0; }
.bar i { height: 8px; background: var(--ui-bg-accented); }
.bar b { display: block; height: 100%; background: var(--adm-sensor); }
.bar b.unused { background: var(--adm-warn); }
.bar .num { text-align: right; }
</style>
