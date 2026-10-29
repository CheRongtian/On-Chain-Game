<script setup lang="ts">
import { useUpdatesStore } from '../stores/updates';
const updates = useUpdatesStore();
</script>

<template>
  <small v-if="!updates.live" class="update-status" role="status">
    {{ updates.label }} · The page keeps checking for changes.
  </small>
</template>

<style scoped>
.update-status {
  display: block;
  color: var(--text-muted);
  font-size: 0.75rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
</style>
