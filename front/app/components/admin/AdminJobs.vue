<template>
  <div>
    <div class="adm-head">
      <div>
        <h1>Scheduled jobs</h1>
        <p>Our Prefect deployments on the shared CIOOS Pacific server. Run history and logs stay in Prefect. A pause lasts until
          the job's scheduler container restarts, which re-applies its <span class="adm-num">*_SCHEDULE_PAUSED</span> setting.</p>
      </div>
      <UButton variant="ghost" icon="i-mdi-refresh" :loading="loading" @click="load">Refresh</UButton>
    </div>
    <UAlert v-if="error" color="error" variant="subtle" :description="error" class="mb-4" />
    <UAlert v-if="data && !data.configured" color="neutral" variant="subtle" class="mb-4"
      description="PREFECT_API_URL isn't set on this API, so jobs can't be shown or started. Dev has no Prefect server." />

    <section v-if="data?.jobs.length" class="adm-panel">
      <div class="adm-list">
        <div v-for="j in data.jobs" :key="j.name">
          <p>
            <b>{{ j.name }}</b>
            <small>{{ j.what }}</small>
            <small v-if="j.error" style="color: var(--adm-bad)">{{ j.error }}</small>
            <small v-else class="adm-num">{{ j.cron ?? 'no schedule' }}{{ j.paused ? ' · paused' : j.next ? ` · next ${fmtTime(j.next)}` : '' }}</small>
          </p>
          <div v-if="!j.error" class="flex items-center gap-2">
            <span v-if="j.last" class="inline-flex items-center gap-2 text-sm" :title="j.last.message ?? undefined">
              <i class="adm-dot" :style="{ background: stateColor(j.last.state) }" />{{ j.last.name }}
              <span class="text-muted">{{ fmtTime(j.last.start) }}{{ j.last.seconds ? ` · ${duration(j.last.seconds)}` : '' }}</span>
            </span>
            <template v-if="j.controllable">
              <UButton size="xs" variant="outline" :disabled="!unlocked" @click="run(j.name, 'run')">Run now</UButton>
              <UButton size="xs" variant="outline" :disabled="!unlocked" @click="run(j.name, j.paused ? 'resume' : 'pause')">
                {{ j.paused ? 'Resume' : 'Pause' }}
              </UButton>
            </template>
            <UBadge v-else variant="outline" color="neutral" title="Run and paused from PROCESS">view only</UBadge>
            <UButton size="xs" variant="ghost" :href="j.url" target="_blank" trailing-icon="i-mdi-open-in-new">Prefect</UButton>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAdmin, errorText, fmtTime } from '~~/composables/useAdmin'

const { api, act, unlocked } = useAdmin()
const data = ref<any>(null)
const loading = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  try {
    data.value = (await api.get('/jobs')).data
    error.value = ''
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function run(name: string, action: 'run' | 'pause' | 'resume') {
  const label = { run: `Started ${name}`, pause: `Paused ${name}`, resume: `Resumed ${name}` }[action]
  if (await act(label, a => a.post(`/jobs/${name}`, { action }))) load()
}

function stateColor(s: string) {
  return s === 'COMPLETED' ? 'var(--adm-live)' : s === 'RUNNING' || s === 'PENDING' ? 'var(--adm-sensor)'
    : s === 'FAILED' || s === 'CRASHED' ? 'var(--adm-bad)' : 'var(--ui-text-dimmed)'
}

function duration(sec: number) {
  return sec < 60 ? `${Math.round(sec)} s` : `${Math.floor(sec / 60)} m ${Math.round(sec % 60)} s`
}
</script>
