<script setup lang="ts">
defineProps<{
  name: 'plus' | 'arrow' | 'back' | 'copy' | 'refresh' | 'check' | 'grid' | 'clock';
}>();
const paths = {
  plus: 'M12 5v14M5 12h14',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  back: 'M20 12H4m6-6-6 6 6 6',
  copy: 'M9 9h11v11H9zM15 9V4H4v11h5',
  refresh: 'M20 8a8 8 0 0 0-13-2L4 9m0-5v5h5m-5 7a8 8 0 0 0 13 2l3-3m0 5v-5h-5',
  check: 'm5 12 4 4L19 6',
  grid: 'M4 4h16v16H4zM4 9h16M4 15h16M9 4v16M15 4v16',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
};
</script>

<template>
  <svg
    class="icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="paths[name]" />
  </svg>
</template>
