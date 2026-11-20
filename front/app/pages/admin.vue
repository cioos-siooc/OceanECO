<template>
  <div class="admin">
    <div v-if="state.status !== 'ready'" class="admin__gate">
      <div class="admin__gate-card">
        <h1 class="text-lg font-semibold">OceanECO admin</h1>
        <template v-if="state.status === 'loading'">
          <p class="text-muted">Checking your sign-in…</p>
        </template>
        <template v-else-if="state.status === 'signedOut'">
          <p class="text-muted">Sign in with your email. You'll get a one-time code; only listed admin emails get in.</p>
          <UButton :href="signInUrl()" icon="i-mdi-login">Sign in</UButton>
        </template>
        <template v-else>
          <p>{{ state.message || "You can't use the admin dashboard." }}</p>
          <UButton v-if="signOutUrl()" :href="signOutUrl()!" variant="outline">Sign in as someone else</UButton>
        </template>
      </div>
    </div>

    <template v-else>
      <aside class="admin__rail">
        <div class="lockbox" :class="{ 'lockbox--open': unlocked }">
          <template v-if="unlocked">
            <b>Editing unlocked</b>
            <span class="adm-num">Locks in {{ Math.floor(unlockLeft / 60) }}:{{ String(unlockLeft % 60).padStart(2, '0') }}</span>
            <UButton size="xs" variant="outline" @click="lock">Lock now</UButton>
          </template>
          <template v-else>
            <b>Read-only</b>
            <span>Look around freely. Unlock to change anything.</span>
            <UButton size="xs" variant="outline" icon="i-mdi-lock-open-variant-outline" @click="unlockOpen = true">Unlock…</UButton>
          </template>
        </div>

        <nav class="admin__nav" aria-label="Admin sections">
          <button v-for="v in views" :key="v.id" type="button" :class="{ on: view === v.id }"
            :aria-current="view === v.id ? 'page' : undefined" @click="go(v.id)">
            {{ v.label }}<span v-if="v.count" class="count adm-num">{{ v.count }}</span>
          </button>
        </nav>

        <div class="admin__who">
          <span class="truncate" :title="state.email">{{ state.email }}</span>
          <UButton v-if="signOutUrl()" size="xs" variant="ghost" :href="signOutUrl()!">Sign out</UButton>
        </div>
      </aside>

      <main class="admin__main">
        <AdminOverview v-if="view === 'overview'" @go="go" />
        <AdminSensors v-else-if="view === 'sensors'" :initial-filter="sensorFilter" />
        <AdminModel v-else-if="view === 'model'" />
        <AdminJobs v-else-if="view === 'jobs'" />
        <AdminStorage v-else-if="view === 'storage'" />
        <AdminAudit v-else-if="view === 'audit'" />
      </main>

      <div v-if="state.pending.size" class="pending">
        <UPopover>
          <UButton variant="ghost" trailing-icon="i-mdi-chevron-up">
            {{ state.pending.size }} staged change{{ state.pending.size === 1 ? '' : 's' }}
          </UButton>
          <template #content>
            <ul class="pending__list">
              <li v-for="[key, c] in state.pending" :key="key">
                <span>{{ c.summary }}</span>
                <UButton size="xs" variant="ghost" icon="i-mdi-close" :aria-label="`Drop: ${c.summary}`" @click="unstage(key)" />
              </li>
            </ul>
          </template>
        </UPopover>
        <span class="text-muted text-sm grow">Nothing changes until you apply. Every applied change goes to the audit log.</span>
        <UButton variant="ghost" @click="discard">Discard</UButton>
        <UButton :loading="state.applying" color="primary" @click="unlocked ? apply() : (unlockOpen = true)">
          {{ unlocked ? 'Apply' : 'Unlock to apply' }}
        </UButton>
      </div>
    </template>

    <UModal v-model:open="unlockOpen" title="Unlock editing"
      description="Editing locks itself again after 15 minutes without a change, or when you press Lock now.">
      <template #footer>
        <div class="flex gap-2">
          <UButton color="primary" @click="doUnlock">Unlock</UButton>
          <UButton variant="ghost" @click="unlockOpen = false">Cancel</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAdmin, errorText } from '~~/composables/useAdmin'

useHead({ title: 'OceanECO admin' })

const { state, unlocked, unlockLeft, init, unlock, lock, apply, discard, unstage, signInUrl, signOutUrl } = useAdmin()
const toast = useToast()

type View = 'overview' | 'sensors' | 'model' | 'jobs' | 'storage' | 'audit'
const route = useRoute()
const router = useRouter()
const view = ref<View>((route.hash.slice(1) as View) || 'overview')
const sensorFilter = ref<string>('all')

function go(id: View, filter?: string) {
  sensorFilter.value = filter ?? 'all'
  view.value = id
  router.replace({ hash: `#${id}` })
}

const views = computed(() => [
  { id: 'overview' as const, label: 'Overview', count: '' },
  { id: 'sensors' as const, label: 'Sensors', count: state.sensors.filter(s => s.active).length },
  { id: 'model' as const, label: 'Model runs', count: '' },
  { id: 'jobs' as const, label: 'Scheduled jobs', count: '' },
  { id: 'storage' as const, label: 'Storage', count: '' },
  { id: 'audit' as const, label: 'Audit log', count: '' },
])

const unlockOpen = ref(false)
async function doUnlock() {
  try {
    await unlock()
    unlockOpen.value = false
  } catch (e) {
    toast.add({ title: "Couldn't unlock", description: errorText(e), color: 'error' })
  }
}

let timer: ReturnType<typeof setInterval> | null = null
watch(unlocked, (on, was) => {
  if (was && !on) toast.add({ title: 'Editing locked again', description: 'Staged changes are kept; unlock to apply them.' })
})
onMounted(() => {
  init()
  timer = setInterval(() => { state.now = Date.now() }, 1000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.admin {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  position: relative;
}

.admin__gate {
  grid-column: 1 / -1;
  display: grid;
  place-items: center;
}

.admin__gate-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-start;
  max-width: 380px;
  padding: 24px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}

.admin__rail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 14px 12px;
  border-right: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  min-height: 0;
}

.lockbox {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 10px;
  font-size: 12px;
  color: var(--ui-text-muted);
  border: 1px solid var(--ui-border);
}

.lockbox b { color: var(--ui-text); font-size: 13px; }
.lockbox--open { border-color: var(--ui-primary); }

.admin__nav { display: flex; flex-direction: column; gap: 1px; }

.admin__nav button {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  font-size: 13px;
  text-align: left;
  color: var(--ui-text-toned);
}

.admin__nav button:hover { background: var(--ui-bg-elevated); color: var(--ui-text); }
.admin__nav button.on { background: var(--ui-bg-elevated); color: var(--ui-text); box-shadow: inset 2px 0 0 var(--ui-primary); }
.admin__nav .count { font-size: 11px; color: var(--ui-text-muted); }

.admin__who {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}

.admin__main {
  overflow-y: auto;
  padding: 20px 24px 96px;
  min-height: 0;
}

.pending {
  position: absolute;
  left: 220px;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 24px;
  border-top: 1px solid var(--ui-primary);
  background: var(--ui-bg-elevated);
}

.pending__list {
  max-height: 50vh;
  overflow-y: auto;
  padding: 8px;
  font-size: 13px;
}

.pending__list li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 2px 4px; }
</style>

<style>
/* Shared by the admin sections (components/admin/). Status colours live here: main has no app-wide tokens for them,
   and on :root because the drawer and dialogs are teleported outside .admin. */
:root { --adm-live: #5cc28a; --adm-lag: #d6c25f; --adm-warn: #e2a336; --adm-bad: #d16a5c; --adm-sensor: #5fb3d6; }
.adm-num { font-family: var(--font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
.adm-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 16px; }
.adm-head h1 { font-size: 18px; font-weight: 600; }
.adm-head p { color: var(--ui-text-muted); font-size: 13px; max-width: 70ch; margin-top: 4px; }
.adm-panel { border: 1px solid var(--ui-border); background: var(--ui-bg-muted); padding: 14px; margin-bottom: 14px; }
.adm-panel h2 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--ui-text-muted); margin-bottom: 10px; }
.adm-grid { display: grid; gap: 14px; }
.adm-grid--4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.adm-grid--2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.adm-stat { display: flex; flex-direction: column; gap: 4px; }
.adm-stat .k { font-size: 12px; color: var(--ui-text-muted); }
.adm-stat .v { font-size: 22px; font-family: var(--font-mono, ui-monospace); }
.adm-stat .n { font-size: 12px; color: var(--ui-text-dimmed); }
.adm-note { font-size: 12px; color: var(--ui-text-muted); margin-top: 8px; }
.adm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.adm-table th { text-align: left; font-weight: 500; font-size: 12px; color: var(--ui-text-muted); padding: 6px 8px; border-bottom: 1px solid var(--ui-border); position: sticky; top: -20px; background: var(--ui-bg); }
.adm-table td { padding: 5px 8px; border-bottom: 1px solid var(--ui-border-muted); vertical-align: middle; }
.adm-table tr.row { cursor: pointer; }
.adm-table tr.row:hover td { background: var(--ui-bg-elevated); }
.adm-table .num { text-align: right; font-family: var(--font-mono, ui-monospace); }
.adm-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.adm-staged { outline: 1px dashed var(--ui-primary); outline-offset: 2px; }
.adm-list > div { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--ui-border-muted); }
.adm-list > div:last-child { border-bottom: 0; }
.adm-list small { display: block; color: var(--ui-text-muted); font-size: 12px; }
.adm-confirm { border: 1px solid var(--adm-bad); padding: 12px; display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.adm-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ui-text-muted); }
</style>
