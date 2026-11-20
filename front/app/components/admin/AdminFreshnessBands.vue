<template>
  <div>
    <div class="bands" role="img" :aria-label="order.map(f => `${FRESHNESS[f].label} ${counts[f]}`).join(', ')">
      <span v-for="f in order" :key="f" :style="{ flex: counts[f], background: FRESHNESS[f].color }" :title="`${FRESHNESS[f].label}: ${counts[f]}`" />
    </div>
    <div class="legend">
      <span v-for="f in order" :key="f">
        <i class="adm-dot" :style="{ background: FRESHNESS[f].color }" />{{ FRESHNESS[f].label }}
        <b class="adm-num">{{ counts[f] }}</b> <span class="text-dimmed">{{ ranges[f] }}</span>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAdmin, FRESHNESS, FRESHNESS_LIMITS, type AdminSensor, type Freshness } from '~~/composables/useAdmin'

const props = defineProps<{ sensors: AdminSensor[] }>()
const { freshness } = useAdmin()

const order: Freshness[] = ['live', 'lag', 'stale', 'silent', 'none']
const counts = computed(() => {
  const c: Record<Freshness, number> = { live: 0, lag: 0, stale: 0, silent: 0, none: 0 }
  for (const s of props.sensors) c[freshness(s)]++
  return c
})
const ranges = (() => {
  const f = FRESHNESS_LIMITS
  return {
    live: `under ${f.live_hours} h`, lag: `under ${f.lagging_days} d`, stale: `under ${f.stale_days} d`,
    silent: `over ${f.stale_days} d`, none: 'never reported',
  }
})()
</script>

<style scoped>
.bands { display: flex; height: 10px; gap: 2px; margin-bottom: 10px; }
.bands span { min-width: 0; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--ui-text-toned); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
</style>
