<script setup lang="ts">
import { computed } from 'vue';
import type { Verification } from '../lib/history';
const props = defineProps<{ verification?: Verification; available: boolean }>();
const status = computed(() =>
  !props.available
    ? 'Unavailable'
    : props.verification?.status === 'Verified' &&
        (!props.verification.canonical || !props.verification.complete)
      ? 'Incomplete'
      : (props.verification?.status ?? 'Incomplete'),
);
</script>
<template>
  <span
    class="verification-badge"
    :class="status.toLowerCase()"
    :data-verification="status"
    :title="available ? verification?.message : 'Current verification is unavailable.'"
  >
    <span aria-hidden="true">{{
      status === 'Verified' ? '✓' : status === 'Mismatch' ? '!' : '○'
    }}</span
    >{{ status }}
  </span>
</template>
<style scoped>
.verification-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 0.75rem;
  font-weight: 650;
  white-space: nowrap;
}
.verified {
  color: var(--success);
  background: var(--success-surface);
  border-color: var(--success);
}
.mismatch {
  color: var(--error);
  background: var(--error-surface);
  border-color: var(--error);
}
.incomplete {
  color: var(--amber);
  background: var(--amber-surface);
}
</style>
