<template>
  <div>
    <div class="adm-head">
      <div>
        <h1>Model runs <UBadge variant="outline" color="neutral">SalishSeaCast</UBadge></h1>
        <p>What this API serves. PROCESS runs the pipeline and syncs each finished day here; this page only shows the result.</p>
      </div>
      <UButton variant="ghost" icon="i-mdi-refresh" :loading="loading" @click="load">Refresh</UButton>
    </div>
    <UAlert v-if="error" color="error" variant="subtle" :description="error" class="mb-4" />

    <template v-if="data">
      <div class="adm-grid adm-grid--4">
        <div class="adm-panel adm-stat">
          <span class="k">Latest day in the app</span>
          <span class="v">{{ latest ? fmtDay(latest.date) : '—' }}</span>
          <span class="n">{{ latest ? `synced ${fmtTime(latest.updated_at)}` : 'nothing synced yet' }}</span>
        </div>
        <div class="adm-panel adm-stat">
          <span class="k">Hourly table</span>
          <span class="v">{{ fmtDay(data.bounds.SalishSeaCast_hourly.first) }}</span>
          <span class="n">→ {{ fmtTime(data.bounds.SalishSeaCast_hourly.last) }} · {{ rowsText(data.bounds.SalishSeaCast_hourly.rows) }}</span>
        </div>
        <div class="adm-panel adm-stat">
          <span class="k">Daily table</span>
          <span class="v">{{ fmtDay(data.bounds.SalishSeaCast_daily.first) }}</span>
          <span class="n">→ {{ fmtDay(data.bounds.SalishSeaCast_daily.last) }} · {{ rowsText(data.bounds.SalishSeaCast_daily.rows) }}</span>
        </div>
        <div class="adm-panel adm-stat">
          <span class="k">Failed syncs, last 120 days</span>
          <span class="v" :style="{ color: failed.length ? 'var(--adm-bad)' : undefined }">{{ failed.length }}</span>
          <span class="n">{{ failed.length ? `latest ${fmtDay(failed[0].date)}` : 'none' }}</span>
        </div>
      </div>

      <section v-for="log in logs" :key="log.table" class="adm-panel">
        <h2>{{ log.title }}</h2>
        <p v-if="!log.rows.length" class="text-muted text-sm">No syncs recorded.</p>
        <div v-else class="strip">
          <span v-for="r in log.rows" :key="r.date" class="cell" :style="{ background: STATUS[r.status]?.color ?? 'var(--ui-text-dimmed)' }"
            :title="`${fmtDay(r.date)} · ${r.status} · ${fmtTime(r.updated_at)}`" />
        </div>
        <div class="legend">
          <span v-for="(s, k) in STATUS" :key="k"><i class="adm-dot" :style="{ background: s.color }" />{{ s.label }}</span>
          <span class="text-dimmed">oldest left, newest right</span>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAdmin, errorText, fmtDay, fmtTime } from '~~/composables/useAdmin'

const { api } = useAdmin()
const data = ref<any>(null)
const loading = ref(false)
const error = ref('')

const STATUS: Record<string, { label: string, color: string }> = {
  success: { label: 'Synced', color: 'var(--adm-live)' },
  in_progress: { label: 'Syncing', color: 'var(--adm-sensor)' },
  failed: { label: 'Failed', color: 'var(--adm-bad)' },
  superseded: { label: 'Superseded', color: 'var(--ui-text-dimmed)' },
}

async function load() {
  loading.value = true
  try {
    data.value = (await api.get('/model')).data
    error.value = ''
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)

const hourly = computed(() => data.value?.sync?.SalishSeaCast_sync_log ?? [])
const latest = computed(() => hourly.value.find((r: any) => r.status === 'success') ?? null)
const failed = computed(() => [...hourly.value, ...(data.value?.sync?.SalishSeaCast_daily_sync_log ?? [])]
  .filter((r: any) => r.status === 'failed').sort((a: any, b: any) => b.date.localeCompare(a.date)))
const logs = computed(() => [
  { table: 'hourly', title: 'Hourly syncs', rows: [...hourly.value].reverse() },
  { table: 'daily', title: 'Daily syncs', rows: [...(data.value?.sync?.SalishSeaCast_daily_sync_log ?? [])].reverse() },
])

function rowsText(n: number) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} B rows` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} M rows` : `${n.toLocaleString('en-CA')} rows`
}
</script>

<style scoped>
.strip { display: flex; gap: 2px; flex-wrap: wrap; margin-bottom: 10px; }
.cell { width: 10px; height: 18px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--ui-text-toned); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
</style>
