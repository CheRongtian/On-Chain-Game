<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import {
  actionHelp,
  actionNames,
  availableActions,
  cellLabel,
  draftLabel,
  unitNames,
} from '../lib/battle';
import { useBattleStore } from '../stores/battle';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ dismiss: []; closed: [] }>();
const battle = useBattleStore();
const dialog = ref<HTMLDialogElement>();
const plannedCell = computed(() =>
  battle.selectedId === undefined ? undefined : battle.unitCells[battle.selectedId],
);
const moved = computed(() => !!battle.selected && plannedCell.value !== battle.selected.cell);
function sync() {
  if (!dialog.value) return;
  if (props.open && !dialog.value.open) dialog.value.showModal();
  else if (!props.open && dialog.value.open) dialog.value.close();
}
watch(() => props.open, sync, { flush: 'post' });
onMounted(sync);
onBeforeUnmount(() => dialog.value?.close());
async function choose(kind: Parameters<typeof battle.choose>[0]) {
  battle.choose(kind);
  await nextTick();
  if (!battle.drawerOpen) sync();
}
</script>

<template>
  <dialog
    ref="dialog"
    aria-labelledby="unit-drawer-title"
    aria-modal="true"
    @cancel.prevent="emit('dismiss')"
    @click.self="emit('dismiss')"
    @close="emit('closed')"
  >
    <section
      v-if="battle.selected && battle.field"
      class="drawer-panel"
      :class="{ 'drawer-left': battle.selectedId! < 3 }"
    >
      <header>
        <div>
          <span class="unit-owner"
            >{{ battle.selectedId! < 3 ? 'Player A' : 'Player B' }} · {{ moved ? 'Start' : '' }}
            {{ cellLabel(battle.selected.cell) }}</span
          >
          <h2 id="unit-drawer-title">{{ unitNames[battle.selected.unitType] }}</h2>
        </div>
        <button class="dismiss" aria-label="Close unit details" autofocus @click="emit('dismiss')">
          <AppIcon name="close" />
        </button>
      </header>
      <p v-if="moved && plannedCell !== undefined" class="planned-position">
        Draft position · {{ cellLabel(plannedCell) }}
      </p>
      <dl class="stats">
        <div>
          <dt>HP</dt>
          <dd>
            {{ battle.selected.hp }}/{{ battle.field.rules.maxHp[battle.selected.unitType - 1] }}
          </dd>
        </div>
        <div>
          <dt>Move</dt>
          <dd>{{ battle.field.rules.moveRange[battle.selected.unitType - 1] }}</dd>
        </div>
        <div>
          <dt>Range</dt>
          <dd>{{ battle.field.rules.attackRange[battle.selected.unitType - 1] }}</dd>
        </div>
        <div>
          <dt>Damage</dt>
          <dd>{{ battle.field.rules.attackDamage[battle.selected.unitType - 1] }}</dd>
        </div>
      </dl>
      <template v-if="battle.canEditUnit">
        <div class="actions" role="group" aria-label="Choose an order">
          <button
            v-for="kind in availableActions(battle.selected)"
            :key="kind"
            :aria-pressed="(battle.proposal?.kind ?? battle.selectedDraft?.kind) === kind"
            @click="choose(kind)"
          >
            <strong>{{ actionNames[kind] }}</strong
            ><span
              >{{
                kind >= 3 ? battle.field.rules.skillCost[battle.selected.unitType - 1] : 0
              }}
              E</span
            >
          </button>
        </div>
        <template v-if="battle.interaction === 'review' && battle.proposal">
          <p class="description">
            {{ actionHelp(battle.proposal.kind, battle.selected, battle.field.rules) }}
          </p>
          <p v-if="battle.proposalIssue" class="issue" role="status">{{ battle.proposalIssue }}</p>
          <button class="confirm" :disabled="!battle.canConfirm" @click="battle.confirm()">
            Confirm order</button
          ><button class="minor" @click="battle.cancel()">Cancel</button>
        </template>
        <template v-else>
          <p class="current">
            <span>Current order</span
            >{{ battle.selectedDraft ? draftLabel(battle.selectedDraft) : 'Hold' }}
          </p>
          <p class="energy">
            Squad: {{ battle.energySpent }} / {{ battle.availableEnergy }} Energy
          </p>
          <button class="minor" @click="battle.resetUnit()">Reset to Hold</button
          ><button class="minor" :disabled="!battle.canUndo" @click="battle.undo()">
            Undo last order
          </button>
        </template>
      </template>
      <p v-else class="description">
        {{
          !battle.selected.hp
            ? 'Defeated. This slot must Hold.'
            : battle.ownUnit
              ? 'Confirmed state. Planning is closed.'
              : 'Opponent unit. Information only.'
        }}
      </p>
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
  margin: 0;
  padding: 0;
  border: 0;
  overflow: hidden;
  background: transparent;
  color: var(--text);
}
dialog::backdrop {
  background: rgb(0 0 0 / 62%);
}
.drawer-panel {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 11rem;
  max-width: 22%;
  max-height: calc(100% - 24px);
  overflow: auto;
  padding: 12px;
  background: var(--surface);
  border: 1px solid var(--control-border);
  border-radius: 10px;
  box-shadow: 0 12px 32px #0006;
}
.drawer-panel.drawer-left {
  left: 12px;
  right: auto;
}
.planned-position {
  color: var(--draft);
  font-size: 0.75rem;
  margin: 8px 0 0;
}
header {
  position: sticky;
  top: 0;
  background: var(--surface);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
}
header > div {
  min-width: 0;
}
h2 {
  font-size: 0.9375rem;
  margin: 3px 0 0;
  overflow-wrap: anywhere;
}
.unit-owner {
  font-size: 0.6875rem;
  color: var(--text-muted);
}
.dismiss {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: grid;
  place-content: center;
  padding: 0;
  background: var(--surface-raised);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 5px;
}
.dismiss .icon {
  width: 16px;
  height: 16px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 12px 0;
  margin: 0;
}
dt {
  font-size: 0.6875rem;
}
dd {
  font-size: 0.8125rem;
  font-weight: 600;
}
.actions {
  display: grid;
  gap: 6px;
}
.actions button {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 3px;
  min-height: 44px;
  padding: 8px;
  border: 1px solid var(--control-border);
  border-radius: 6px;
  background: var(--surface-input);
  color: var(--text);
  text-align: left;
}
.actions button[aria-pressed='true'] {
  border-color: var(--draft);
}
.actions strong {
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}
.actions span {
  font-size: 0.6875rem;
  color: var(--text-muted);
  white-space: nowrap;
}
.current {
  margin: 12px 0 0;
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}
.current span {
  display: block;
  color: var(--text-muted);
  font-size: 0.6875rem;
}
.energy,
.description,
.issue {
  font-size: 0.75rem;
  margin: 10px 0 0;
  overflow-wrap: anywhere;
}
.energy,
.description {
  color: var(--text-muted);
}
.issue {
  color: var(--amber);
}
.confirm {
  width: 100%;
  min-height: 44px;
  margin-top: 10px;
  padding: 8px;
  border-radius: 6px;
  color: white;
  background: var(--primary);
  font-size: 0.75rem;
}
.minor {
  min-height: 32px;
  width: 100%;
  padding: 4px;
  margin-top: 4px;
  background: transparent;
  color: var(--success);
  font-size: 0.75rem;
  text-decoration: underline;
}
button:disabled {
  opacity: 0.5;
}
</style>
