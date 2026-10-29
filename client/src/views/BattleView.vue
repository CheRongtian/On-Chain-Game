<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import AppIcon from '../components/AppIcon.vue';
import CurrentAccount from '../components/CurrentAccount.vue';
import UpdateStatus from '../components/UpdateStatus.vue';
import BattlefieldBoard from '../components/BattlefieldBoard.vue';
import UnitActionDrawer from '../components/UnitActionDrawer.vue';
import RoundControls from '../components/RoundControls.vue';
import type { BattlefieldFrame } from '../battlefield/bridge';
import { actionNames, draftLabel, emptyDrafts, unitCodes, unitNames } from '../lib/battle';
import { outcomes, parseRoomId, phases, reasons } from '../lib/format';
import { useArenaStore } from '../stores/arena';
import { useBattleStore } from '../stores/battle';
import { useUpdatesStore } from '../stores/updates';

const route = useRoute();
const router = useRouter();
const arena = useArenaStore();
const battle = useBattleStore();
const updates = useUpdatesStore();
const board = ref<InstanceType<typeof BattlefieldBoard>>();
const lastUnit = ref<number>();
const id = computed(() => parseRoomId(String(route.params.matchId ?? '')));
const players = [0, 1] as const;
const roundLabel = computed(() => {
  if (battle.room?.phase === 2) return battle.committed ? 'Waiting for opponent' : 'Planning';
  if (battle.room?.phase === 3 || battle.room?.phase === 4) return 'Processing';
  return phases[battle.room?.phase ?? 0];
});
const frame = computed<BattlefieldFrame | undefined>(() =>
  battle.field
    ? {
        ...battle.field,
        drafts: battle.hasPlans ? battle.preview : emptyDrafts(),
        unitCells: battle.unitCells,
        playerIndex: battle.playerIndex,
        selectedUnit: battle.selectedId ?? -1,
        legalCells: battle.highlighted,
        resolutions: battle.resolutions,
      }
    : undefined,
);
const squad = computed(
  () =>
    battle.field?.state.units
      .map((unit, unitId) => ({ unit, unitId }))
      .filter(
        ({ unitId }) =>
          battle.playerIndex === undefined || Math.floor(unitId / 3) === battle.playerIndex,
      ) ?? [],
);
const status = computed(() => {
  if (battle.error) return 'Chain refresh failed. Use Refresh to retry.';
  if (!battle.snapshot) return arena.error || 'Loading chain state…';
  if (battle.room?.outcome)
    return `${outcomes[battle.room.outcome]} · ${reasons[battle.room.reason]}`;
  if (battle.playerIndex === undefined) return 'Spectator · select a unit to inspect.';
  if (battle.animating) return 'Playing confirmed round result…';
  if (battle.progressPaused) return 'Round processing paused. Retry to continue.';
  if (battle.committed)
    return battle.room?.phase === 2
      ? 'Orders confirmed · waiting for your opponent.'
      : 'Processing your confirmed orders…';
  if (!battle.editable) return 'Planning is closed in this phase.';
  return battle.canonicalActions
    ? `Local draft ready · ${battle.energySpent}/${battle.availableEnergy} Energy`
    : 'Select a unit to plan its order.';
});
const targetMessage = computed(
  () =>
    battle.feedback ||
    battle.proposalIssue ||
    (battle.proposal ? draftLabel(battle.proposal) : 'Choose a highlighted tile.'),
);
let timer: ReturnType<typeof setInterval> | undefined;
watch(
  [id, () => arena.epoch, () => arena.address],
  () => {
    battle.open(arena.connection?.deployment, id.value, arena.address);
  },
  { immediate: true },
);
watch(
  () => battle.snapshot,
  (snapshot) => {
    if (snapshot?.room.round === 0)
      void router.replace({ name: 'room', params: { matchId: route.params.matchId } });
  },
);
watch(
  () => battle.selectedId,
  (unitId) => {
    if (unitId !== undefined) lastUnit.value = unitId;
  },
);
function focusBoard() {
  void nextTick(() => board.value?.focusUnit(lastUnit.value));
}
function escape(event: KeyboardEvent) {
  if (event.key === 'Escape' && battle.interaction === 'target') {
    event.preventDefault();
    battle.cancel();
  }
}
onMounted(() => {
  timer = setInterval(() => {
    if ((!updates.live || battle.error) && !battle.busy) void battle.refresh();
  }, 4_000);
  document.addEventListener('keydown', escape);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  document.removeEventListener('keydown', escape);
  battle.release();
});
</script>

<template>
  <main id="main-content" class="game-screen" tabindex="-1">
    <header class="toolbar">
      <RouterLink to="/" class="lobby-link" aria-label="Back to lobby"
        ><AppIcon name="back" /><span>Lobby</span></RouterLink
      >
      <div class="identity">
        <h1>Room #{{ route.params.matchId }}</h1>
        <span v-if="battle.room">Round {{ battle.room.round }} · {{ roundLabel }}</span>
        <UpdateStatus />
      </div>
      <CurrentAccount />
      <button
        class="refresh"
        :disabled="battle.loading || battle.busy || !arena.online"
        aria-label="Refresh chain state"
        @click="battle.refresh()"
      >
        <AppIcon name="refresh" />
      </button>
    </header>

    <RoundControls v-if="battle.field" />
    <div v-else />

    <section v-if="battle.field && frame" class="battlefield" aria-label="Confirmed battlefield">
      <div class="scoreline">
        <div v-for="player in players" :key="player" :class="player === 0 ? 'side-a' : 'side-b'">
          <strong
            >{{ player === 0 ? 'A · Host' : 'B · Opponent'
            }}{{ battle.playerIndex === player ? ' · You' : '' }}</strong
          ><span>{{ battle.field.state.players[player].energy }} E</span
          ><span>{{ battle.field.state.players[player].victoryPoints }} VP</span>
          <small v-if="battle.roundStatus">{{
            battle.room?.outcome
              ? 'Finished'
              : battle.roundStatus.committed[player]
                ? 'Ready'
                : 'Planning'
          }}</small>
        </div>
      </div>
      <div class="board-space">
        <BattlefieldBoard
          :key="battle.boardRevision"
          ref="board"
          :frame="frame"
          @choose="battle.pick"
          @resolved="battle.animationComplete"
        />
        <div v-if="battle.room?.outcome && !battle.animating" class="result" role="status">
          <strong>{{ outcomes[battle.room.outcome] }}</strong
          ><span>{{ reasons[battle.room.reason] }}</span>
        </div>
      </div>
    </section>
    <section
      v-else
      class="game-message"
      :role="battle.error || id === undefined ? 'alert' : 'status'"
    >
      <h2>
        {{
          id === undefined
            ? 'Invalid room ID'
            : battle.error
              ? 'Battlefield unavailable'
              : !arena.online
                ? 'Waiting for the backend'
                : 'Reading battlefield…'
        }}
      </h2>
      <p>{{ battle.error || arena.error || 'Loading the confirmed room, map, and units.' }}</p>
      <button
        v-if="battle.error"
        class="button secondary"
        :disabled="battle.loading"
        @click="battle.refresh()"
      >
        Retry
      </button>
    </section>

    <footer class="order-dock" :class="{ 'extended-squad': squad.length > 3 }">
      <div
        v-if="battle.interaction === 'target' && battle.proposal && battle.selected"
        class="targeting"
        aria-label="Confirm target selection"
      >
        <div>
          <strong
            >{{ unitNames[battle.selected.unitType] }} ·
            {{ actionNames[battle.proposal.kind] }}</strong
          >
          <p role="status">{{ targetMessage }}</p>
        </div>
        <div class="target-buttons">
          <span>{{ battle.proposedEnergy }}/{{ battle.availableEnergy }} E</span
          ><button class="cancel" @click="battle.cancel()">Cancel</button
          ><button class="confirm" :disabled="!battle.canConfirm" @click="battle.confirm()">
            Confirm
          </button>
        </div>
      </div>
      <div v-else-if="squad.length" class="squad">
        <button
          v-for="entry in squad"
          :key="entry.unitId"
          :aria-pressed="battle.selectedId === entry.unitId"
          :aria-label="`${unitNames[entry.unit.unitType]}, ${entry.unit.hp} HP`"
          @click="battle.inspect(entry.unitId)"
        >
          <span class="role" :class="entry.unitId < 3 ? 'side-a' : 'side-b'">{{
            unitCodes[entry.unit.unitType]
          }}</span
          ><span
            ><strong>{{ unitNames[entry.unit.unitType] }}</strong
            ><small>{{
              battle.hasPlans && battle.playerIndex !== undefined
                ? draftLabel(battle.drafts[entry.unitId % 3])
                : `${entry.unit.hp} HP`
            }}</small></span
          >
        </button>
      </div>
      <div class="dock-status">
        <p role="status">{{ status }}</p>
        <RouterLink v-if="battle.room?.outcome" :to="`/history/${route.params.matchId}`"
          >View replay</RouterLink
        >
        <button v-if="battle.canUndo" @click="battle.undo()">Undo</button
        ><span class="legend">△ Energy · C Control · Pink: draft</span>
      </div>
    </footer>
    <UnitActionDrawer :open="battle.drawerOpen" @dismiss="battle.dismiss()" @closed="focusBoard" />
  </main>
</template>

<style scoped>
.game-screen {
  position: fixed;
  inset: 0;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  gap: 8px;
  padding: 10px 14px;
  background: var(--background);
  isolation: isolate;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.lobby-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  font-size: 0.8125rem;
  color: var(--text-muted);
}
.identity {
  min-width: 0;
  margin-right: auto;
}
h1 {
  font-size: 0.9375rem;
  margin: 0;
  letter-spacing: 0;
  overflow-wrap: anywhere;
}
.identity > span {
  display: block;
  color: var(--text-muted);
  font-size: 0.6875rem;
}
.refresh {
  width: 36px;
  height: 36px;
  padding: 6px;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 6px;
  flex-shrink: 0;
}
.battlefield {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface-input);
}
.scoreline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  font-size: 0.75rem;
}
.scoreline > div {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.side-a {
  color: var(--success);
}
.side-b {
  color: var(--amber);
}
.scoreline span {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.board-space {
  position: relative;
  min-height: 0;
  min-width: 0;
}
.scoreline small {
  color: var(--text-muted);
  font-size: 0.6875rem;
}
.result {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: grid;
  gap: 3px;
  padding: 12px 20px;
  max-width: calc(100% - 24px);
  background: var(--surface);
  border: 1px solid var(--success);
  border-radius: 8px;
  text-align: center;
  pointer-events: none;
}
.result strong {
  font-size: 1rem;
}
.result span {
  font-size: 0.75rem;
  color: var(--text-muted);
}
.order-dock {
  min-width: 0;
  display: grid;
  grid-template-rows: 64px 28px;
}
.order-dock.extended-squad {
  grid-template-rows: 104px 28px;
}
.squad {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  align-self: center;
}
.squad > button {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  min-width: 0;
  padding: 6px 10px;
  text-align: left;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--control-border);
  border-radius: 7px;
}
.squad > button[aria-pressed='true'] {
  border-color: var(--draft);
}
.role {
  flex-shrink: 0;
  width: 24px;
  text-align: center;
  font-size: 0.9375rem;
  font-weight: 700;
}
.squad > button > span:last-child {
  min-width: 0;
}
.squad strong {
  display: block;
  font-size: 0.75rem;
}
.squad small {
  display: block;
  font-size: 0.6875rem;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dock-status {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 28px;
  font-size: 0.6875rem;
  color: var(--text-muted);
}
.dock-status p {
  margin: 0;
  flex: 1;
}
.dock-status button {
  padding: 4px;
  min-height: 28px;
  font-size: inherit;
  color: var(--success);
  background: transparent;
  text-decoration: underline;
}
.legend {
  font-size: 0.625rem;
  white-space: nowrap;
}
.targeting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
}
.targeting > div:first-child {
  min-width: 0;
}
.targeting strong {
  font-size: 0.8125rem;
}
.targeting p {
  margin: 3px 0 0;
  font-size: 0.75rem;
  color: var(--draft);
  overflow-wrap: anywhere;
}
.target-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.target-buttons span {
  font-size: 0.6875rem;
  color: var(--text-muted);
}
.target-buttons button {
  min-height: 44px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 0.8125rem;
}
.cancel {
  color: var(--text);
  background: var(--surface-raised);
  border: 1px solid var(--control-border);
}
.confirm {
  color: white;
  background: var(--primary);
}
button:disabled {
  opacity: 0.5;
}
.game-message {
  padding: 24px;
  align-self: center;
  justify-self: center;
  max-width: 640px;
}
.game-message h2 {
  font-size: 1.2rem;
}
.game-message p {
  color: var(--text-muted);
}
@media (max-width: 540px) {
  .game-screen {
    padding: 6px;
    gap: 6px;
  }
  .toolbar {
    gap: 8px;
  }
  .lobby-link span {
    display: none;
  }
  .scoreline {
    padding: 6px 8px;
    font-size: 0.6875rem;
  }
  .scoreline > div {
    gap: 6px;
  }
  .squad {
    gap: 6px;
  }
  .squad > button {
    padding: 6px;
    gap: 4px;
  }
  .role {
    width: 16px;
  }
  .squad strong {
    font-size: 0.6875rem;
  }
  .legend {
    display: none;
  }
  .targeting {
    flex-wrap: wrap;
    gap: 6px;
  }
  .target-buttons {
    margin-left: auto;
  }
  .order-dock {
    grid-template-rows: 104px 28px;
  }
}
</style>
