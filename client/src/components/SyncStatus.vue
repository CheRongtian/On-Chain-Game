<script setup lang="ts">
import type { Confirmation, HistoryMeta } from '../lib/history';
defineProps<{ meta?: HistoryMeta; available: boolean; confirmation?: Confirmation }>();
</script>
<template>
  <div class="sync-status" role="status">
    <span
      class="status-dot"
      :class="{ online: available && meta?.ready }"
      aria-hidden="true"
    ></span>
    <template v-if="meta">
      <span>{{
        available
          ? meta.blocked
            ? 'Recovering chain history'
            : meta.ready
              ? 'History up to date'
              : 'Syncing history'
          : 'History service unavailable'
      }}</span>
      <span class="numbers">Indexed {{ meta.indexedBlock }} / Chain {{ meta.observedBlock }}</span>
      <span v-if="confirmation" class="confirmation">{{
        available && !meta.error ? confirmation.status : 'unknown'
      }}</span>
    </template>
    <span v-else>{{ available ? 'History connected' : 'Connecting to history…' }}</span>
  </div>
</template>
<style scoped>
.sync-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  color: var(--text-muted);
  font-size: 0.75rem;
}
.status-dot {
  flex-shrink: 0;
}
.numbers {
  font-variant-numeric: tabular-nums;
}
.confirmation {
  text-transform: capitalize;
  padding-left: 10px;
  border-left: 1px solid var(--line);
}
</style>
