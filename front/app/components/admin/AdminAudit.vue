<template>
  <div>
    <div class="adm-head">
      <div>
        <h1>Audit log</h1>
        <p>Every applied change and action, newest first, signed by the email that made it. Undo applies the earlier value
          as a new change, so it shows up here too.</p>
      </div>
      <UButton variant="ghost" icon="i-mdi-refresh" :loading="loading" @click="load">Refresh</UButton>
    </div>
    <UAlert v-if="error" color="error" variant="subtle" :description="error" class="mb-4" />

    <table class="adm-table">
      <thead><tr><th>When</th><th>Who</th><th>What</th><th>Change</th><th>Before → after</th><th /></tr></thead>
      <tbody>
        <tr v-for="a in rows" :key="a.id">
          <td class="adm-num whitespace-nowrap">{{ fmtTime(a.at) }}</td>
          <td class="text-muted">{{ a.email }}</td>
          <td><UBadge variant="outline" color="neutral">{{ a.kind }}</UBadge> {{ a.label }}</td>
          <td>{{ a.summary }}</td>
          <td class="adm-num text-muted diff" :title="`${show(a.before)} → ${show(a.after)}`">{{ show(a.before) }} → {{ show(a.after) }}</td>
          <td>
            <UButton v-if="a.kind === 'sensor'" size="xs" variant="ghost" :disabled="!unlocked" @click="undo(a)">Undo</UButton>
          </td>
        </tr>
        <tr v-if="!rows.length && !loading"><td colspan="6" class="text-muted">Nothing yet.</td></tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useAdmin, errorText, fmtTime } from '~~/composables/useAdmin'

const { api, act, unlocked, state } = useAdmin()
const rows = ref<any[]>([])
const loading = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  try {
    rows.value = (await api.get('/audit', { params: { limit: 500 } })).data
    error.value = ''
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => state.revision, load)

function show(v: unknown) {
  if (v == null) return '—'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (typeof v === 'string') return v || '""'
  return JSON.stringify(v)
}

function undo(a: any) {
  act(`Undid: ${a.summary}`, x => x.post(`/undo/${a.id}`), true)
}
</script>

<style scoped>
.diff { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
