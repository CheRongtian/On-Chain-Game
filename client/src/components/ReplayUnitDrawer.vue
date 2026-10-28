<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import { cellLabel, unitNames } from '../lib/battle';
import type { BattleRules } from '../lib/arena';
import type { ReplayFrame } from '../lib/history';
const props = defineProps<{
  unitId?: number;
  frame?: ReplayFrame;
  rules?: BattleRules;
  order: string;
}>();
const emit = defineEmits<{ dismiss: []; closed: [] }>();
const dialog = ref<HTMLDialogElement>();
const unit = computed(() =>
  props.unitId === undefined ? undefined : props.frame?.state.units[props.unitId],
);
function sync() {
  if (props.unitId !== undefined && unit.value && !dialog.value?.open) dialog.value?.showModal();
  else if ((props.unitId === undefined || !unit.value) && dialog.value?.open) dialog.value.close();
}
watch([() => props.unitId, unit], sync, { flush: 'post' });
onMounted(sync);
onBeforeUnmount(() => dialog.value?.close());
</script>
<template>
  <dialog
    ref="dialog"
    aria-labelledby="replay-unit-title"
    @cancel.prevent="emit('dismiss')"
    @click.self="emit('dismiss')"
    @close="emit('closed')"
  >
    <section
      v-if="unit && rules && unitId !== undefined"
      class="unit-panel"
      :class="{ left: unitId < 3 }"
    >
      <header>
        <div>
          <span class="owner"
            >Player {{ unitId < 3 ? 'A' : 'B' }} ·
            {{ unit.hp ? cellLabel(unit.cell) : 'Defeated' }}</span
          >
          <h2 id="replay-unit-title">{{ unitNames[unit.unitType] }}</h2>
        </div>
        <button class="dismiss" aria-label="Close unit details" autofocus @click="emit('dismiss')">
          <AppIcon name="close" />
        </button>
      </header>
      <dl>
        <div>
          <dt>HP</dt>
          <dd>{{ unit.hp }}/{{ rules.maxHp[unit.unitType - 1] }}</dd>
        </div>
        <div>
          <dt>Move</dt>
          <dd>{{ rules.moveRange[unit.unitType - 1] }}</dd>
        </div>
        <div>
          <dt>Range</dt>
          <dd>{{ rules.attackRange[unit.unitType - 1] }}</dd>
        </div>
        <div>
          <dt>Damage</dt>
          <dd>{{ rules.attackDamage[unit.unitType - 1] }}</dd>
        </div>
      </dl>
      <p class="label">Public order</p>
      <p>{{ order }}</p>
      <p class="read-only">Historical snapshot · Read only</p>
    </section>
  </dialog>
</template>
<style scoped>
dialog {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  padding: 0;
  margin: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  overflow: hidden;
}
dialog::backdrop {
  background: rgb(0 0 0 / 62%);
}
.unit-panel {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 11rem;
  max-width: 22%;
  max-height: calc(100% - 24px);
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--control-border);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 12px 32px #0006;
  overflow-wrap: anywhere;
}
.unit-panel.left {
  left: 12px;
  right: auto;
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
}
header > div {
  min-width: 0;
}
.owner,
dt,
.label,
.read-only {
  font-size: 0.6875rem;
  color: var(--text-muted);
}
h2 {
  font-size: 0.9375rem;
  margin: 3px 0 0;
}
.dismiss {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: grid;
  place-content: center;
  color: var(--text);
  background: var(--surface-raised);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 0;
}
.dismiss .icon {
  width: 16px;
  height: 16px;
}
dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
  padding: 16px 0;
}
dd {
  margin: 0;
  font-size: 0.8125rem;
}
p {
  font-size: 0.75rem;
  margin: 0 0 10px;
}
.label {
  margin-bottom: 4px;
}
.read-only {
  margin-top: 16px;
}
</style>
