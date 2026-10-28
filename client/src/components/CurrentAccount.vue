<script setup lang="ts">
import { computed } from 'vue';
import { shortAddress } from '../lib/format';
import { useArenaStore } from '../stores/arena';

const arena = useArenaStore();
const name = computed(() => {
  const index =
    arena.connection?.accounts.findIndex((account) => account.address === arena.address) ?? -1;
  return index >= 0 ? `Account ${index + 1}` : 'Current account';
});
</script>

<template>
  <span
    class="current-account"
    role="group"
    aria-label="Current local account"
    :title="arena.address"
  >
    <strong>{{ arena.address ? name : 'Waiting for account…' }}</strong>
    <span v-if="arena.address" class="account-address">
      <span aria-hidden="true">{{ shortAddress(arena.address) }}</span>
      <span class="sr-only">{{ arena.address }}</span>
    </span>
  </span>
</template>

<style scoped>
.current-account {
  display: grid;
  gap: 2px;
  min-width: 0;
  max-width: 42%;
  text-align: right;
}
strong {
  color: var(--text);
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
}
.account-address {
  color: var(--text-muted);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
  white-space: nowrap;
}
</style>
