<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import AppIcon from '../components/AppIcon.vue';
import BattlefieldBoard from '../components/BattlefieldBoard.vue';
import ReplayUnitDrawer from '../components/ReplayUnitDrawer.vue';
import VerificationBadge from '../components/VerificationBadge.vue';
import SyncStatus from '../components/SyncStatus.vue';
import { useHistoryStore } from '../stores/history';
import { frameLabel, publicOrderLabel, replaySpeeds } from '../lib/history';
import { cellLabel, unitCodes, unitNames } from '../lib/battle';
import { outcomes, parseRoomId, reasons, shortAddress } from '../lib/format';

const route = useRoute(),
  router = useRouter();
const history = useHistoryStore();
const board = ref<InstanceType<typeof BattlefieldBoard>>();
const lastUnit = ref<number>();
const id = computed(() => parseRoomId(String(route.params.matchId ?? ''))?.toString());
const players = [0, 1] as const;
const slots = [0, 1, 2, 3, 4, 5];
const selectedRound = computed(() =>
  history.current?.kind === 'MatchStarted'
    ? undefined
    : history.replay?.rounds.find((round) => round.round === history.current?.round),
);
const verification = computed(() => history.replay?.verification);
const timelineProgress = computed(() =>
  history.last ? `${((history.target ?? history.position) / history.last) * 100}%` : '0%',
);
const description = computed(() =>
  history.current?.state.outcome
    ? `${outcomes[history.current.state.outcome]} · ${reasons[history.current.state.reason]}`
    : 'Read-only replay · Click a unit to inspect',
);
function requestedFrame() {
  const value = Number(route.query.frame ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
watch(
  id,
  (value) => {
    if (value) history.open(value, requestedFrame());
    else history.release();
  },
  { immediate: true },
);
watch(
  () => route.query.frame,
  () => {
    if (!history.loading && history.replay && requestedFrame() !== history.position)
      history.seek(requestedFrame());
  },
);
watch(
  () => history.position,
  (index) => {
    if (history.replay && !history.loading && requestedFrame() !== index)
      void router.replace({
        name: 'replay',
        params: { matchId: id.value },
        query: index ? { frame: String(index) } : {},
      });
  },
);
watch(
  () => history.selectedUnit,
  (value) => {
    if (value !== undefined) lastUnit.value = value;
  },
);
onBeforeUnmount(history.release);
function changeFrame(event: Event) {
  history.seek(Number((event.target as HTMLInputElement).value));
}
function changeSpeed(event: Event) {
  history.setSpeed(Number((event.target as HTMLSelectElement).value));
}
function order(unit: number) {
  return history.current?.kind === 'MatchStarted'
    ? 'Initial deployment'
    : publicOrderLabel(selectedRound.value?.reveals[Math.floor(unit / 3)]?.actions[unit % 3]);
}
function inspect(unit: number) {
  history.pause();
  history.selectedUnit = unit;
}
function closeUnit() {
  history.selectedUnit = undefined;
}
function restoreFocus() {
  void nextTick(() => board.value?.focusUnit(lastUnit.value));
}
function locateDifference() {
  const round = verification.value?.difference?.round;
  const index =
    history.replay?.items.findIndex(
      (frame) => frame.round === round && frame.kind !== 'MatchStarted',
    ) ?? -1;
  history.seek(Math.max(0, index));
}
const valueText = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));
</script>

<template>
  <main
    id="main-content"
    class="replay-screen"
    tabindex="-1"
    :data-frame-index="history.target ?? history.position"
    :data-state-hash="history.current?.computedHash"
    :data-playing="history.playing"
    :data-animating="history.target !== undefined"
    :data-playback-speed="history.speed"
  >
    <header class="replay-toolbar">
      <RouterLink to="/history" class="back"
        ><AppIcon name="back" /><span>History</span></RouterLink
      >
      <div class="identity">
        <p class="eyebrow">Match replay</p>
        <h1>Room #{{ route.params.matchId }}</h1>
      </div>
      <div class="replay-actions" role="group" aria-label="Replay verification and refresh">
        <VerificationBadge :verification="verification" :available="history.available" />
        <button
          class="refresh"
          :disabled="history.refreshing"
          :aria-busy="history.refreshing"
          aria-label="Refresh replay"
          title="Refresh replay"
          @click="history.refresh()"
        >
          <AppIcon name="refresh" />
        </button>
      </div>
    </header>
    <div class="replay-status">
      <SyncStatus
        :meta="history.meta"
        :available="history.available"
        :confirmation="history.replay?.confirmation"
      />
      <p v-if="history.error || history.notice" class="alert" role="status">
        {{ history.error || history.notice
        }}<span v-if="history.error && history.board">
          The loaded picture is retained; current verification is unavailable.</span
        >
      </p>
    </div>
    <section
      v-if="history.board && history.current"
      class="replay-field"
      aria-label="Historical battlefield"
    >
      <div class="scoreline">
        <div v-for="player in players" :key="player" :class="player === 0 ? 'side-a' : 'side-b'">
          <strong :title="history.replay!.match.players[player]"
            >{{ player === 0 ? 'A' : 'B' }} ·
            {{ shortAddress(history.replay!.match.players[player]) }}</strong
          >
          <span>{{ history.current.state.players[player].energy }} E</span
          ><span>{{ history.current.state.players[player].victoryPoints }} VP</span>
        </div>
      </div>
      <div class="board-space">
        <BattlefieldBoard
          ref="board"
          :frame="history.board"
          @choose="history.pick"
          @resolved="history.completed"
        />
      </div>
    </section>
    <section v-else class="empty-state" :role="history.error || !id ? 'alert' : 'status'">
      <h2>
        {{
          !id
            ? 'Invalid match ID'
            : history.loading
              ? 'Loading the replay…'
              : history.error
                ? 'Replay unavailable'
                : 'No battle to replay yet'
        }}
      </h2>
      <p>
        {{
          history.error ||
          verification?.message ||
          'A battle replay becomes available after the host starts the game.'
        }}
      </p>
      <button
        v-if="id"
        class="button secondary"
        :disabled="history.refreshing"
        @click="history.refresh()"
      >
        Retry
      </button>
    </section>
    <footer class="playback-dock">
      <div class="timeline-heading">
        <strong aria-live="polite">{{ frameLabel(history.current) }}</strong
        ><span>{{ description }}</span>
      </div>
      <label class="timeline" :style="{ '--timeline-progress': timelineProgress }"
        ><span class="sr-only">Replay timeline</span
        ><input
          type="range"
          min="0"
          :max="history.last"
          :value="history.target ?? history.position"
          :disabled="!history.replay?.items.length"
          :aria-valuetext="frameLabel(history.current)"
          @input="changeFrame"
      /></label>
      <div class="playback-buttons">
        <button
          aria-label="Return to initial state"
          :disabled="!history.replay?.items.length"
          @click="history.seek(0)"
        >
          Start
        </button>
        <button
          aria-label="Previous round"
          :disabled="history.position === 0 && history.target === undefined"
          @click="history.seek(Math.max(0, (history.target ?? history.position) - 1))"
        >
          ← Previous
        </button>
        <button
          class="play"
          :disabled="!history.canPlay"
          :aria-label="history.playing ? 'Pause replay' : 'Play replay'"
          @click="history.toggle()"
        >
          {{ history.playing ? 'Pause' : 'Play' }}
        </button>
        <button
          aria-label="Next round"
          :disabled="!history.canPlay || (history.target ?? history.position) >= history.last"
          @click="history.next()"
        >
          Next →
        </button>
        <label class="speed-control">
          <span>Speed</span>
          <select aria-label="Playback speed" :value="history.speed" @change="changeSpeed">
            <option v-for="speed in replaySpeeds" :key="speed" :value="speed">{{ speed }}×</option>
          </select>
        </label>
        <label class="jump"
          ><span class="sr-only">Jump to round</span
          ><select
            aria-label="Jump to round"
            :value="history.target ?? history.position"
            :disabled="!history.replay?.items.length"
            @change="changeFrame"
          >
            <option v-for="frame in history.replay?.items" :key="frame.index" :value="frame.index">
              {{ frameLabel(frame) }}
            </option>
          </select></label
        >
      </div>
      <div class="details-row">
        <details class="round-details">
          <summary>Round details</summary>
          <div class="round-content">
            <p v-if="history.current?.summary" class="round-summary">
              Energy spent {{ history.current.summary.energySpent.join(' / ') }} · Energy gained
              {{ history.current.summary.energyGained.join(' / ') }} · Points gained
              {{ history.current.summary.victoryPointsGained.join(' / ') }}
              <span class="muted">(A / B)</span>
            </p>
            <div class="unit-list">
              <button
                v-for="unitId in slots"
                :key="unitId"
                :disabled="!history.current"
                @click="inspect(unitId)"
              >
                <span :class="unitId < 3 ? 'side-a' : 'side-b'"
                  >{{ unitId < 3 ? 'A' : 'B' }}·{{ unitCodes[(unitId % 3) + 1] }}</span
                ><span
                  ><strong>{{ order(unitId) }}</strong
                  ><small
                    >{{ history.current?.state.units[unitId]?.hp ?? '—' }} HP ·
                    {{
                      history.current?.state.units[unitId]?.hp
                        ? cellLabel(history.current.state.units[unitId]!.cell)
                        : 'Defeated'
                    }}</small
                  ></span
                ><span class="sr-only"
                  >Inspect {{ unitId < 3 ? 'A' : 'B' }} {{ unitNames[(unitId % 3) + 1] }}</span
                >
              </button>
            </div>
          </div>
        </details>
        <details class="verification-details">
          <summary>Verification details</summary>
          <div class="verification-content">
            <p>
              {{
                history.available
                  ? verification?.message
                  : 'Current verification is unavailable. Reconnect to check this history again.'
              }}
            </p>
            <template v-if="verification?.difference && history.available"
              ><strong
                >Round {{ verification.difference.round }} ·
                {{ verification.difference.field }}</strong
              >
              <p>
                Expected: <code>{{ valueText(verification.difference.expected) }}</code>
              </p>
              <p>
                Actual: <code>{{ valueText(verification.difference.actual) }}</code>
              </p>
              <button @click="locateDifference">Go to difference</button></template
            >
            <dl>
              <div>
                <dt>Completed rounds checked</dt>
                <dd>{{ history.available ? verification?.verifiedRounds : '—' }}</dd>
              </div>
              <div>
                <dt>Checked through block</dt>
                <dd>{{ verification?.throughBlock ?? '—' }}</dd>
              </div>
              <div>
                <dt>Chain state hash</dt>
                <dd>{{ history.current?.stateHash ?? '—' }}</dd>
              </div>
              <div>
                <dt>Computed state hash</dt>
                <dd>{{ history.current?.computedHash ?? '—' }}</dd>
              </div>
              <div>
                <dt>Source block hash</dt>
                <dd>{{ history.current?.source.blockHash ?? '—' }}</dd>
              </div>
              <div>
                <dt>Source transaction</dt>
                <dd>{{ history.current?.source.transactionHash ?? '—' }}</dd>
              </div>
            </dl>
          </div>
        </details>
      </div>
    </footer>
    <ReplayUnitDrawer
      :unit-id="history.selectedUnit"
      :frame="history.current"
      :rules="history.replay?.rules"
      :order="history.selectedUnit === undefined ? '' : order(history.selectedUnit)"
      @dismiss="closeUnit"
      @closed="restoreFocus"
    />
  </main>
</template>

<style scoped>
.replay-screen {
  position: fixed;
  inset: 0;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  gap: 8px;
  padding: 12px 16px;
  background: var(--background);
  isolation: isolate;
}
.replay-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}
.back {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 44px;
  font-size: 0.8125rem;
  color: var(--text-muted);
}
.identity {
  margin-right: auto;
  min-width: 0;
}
.identity .eyebrow {
  font-size: 0.5625rem;
  margin: 0 0 2px;
}
h1 {
  font-size: 1rem;
  margin: 0;
  letter-spacing: 0;
}
.replay-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.replay-actions :deep(.verification-badge) {
  min-height: 36px;
}
.refresh {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  padding: 0;
  line-height: 1;
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text-muted);
}
.refresh :deep(.icon) {
  display: block;
  width: 18px;
  height: 18px;
}
.refresh[aria-busy='true'] :deep(.icon) {
  animation: spin 1s linear infinite;
}
.replay-status {
  min-width: 0;
}
.alert {
  color: var(--amber);
  font-size: 0.75rem;
  margin: 6px 0 0;
}
.replay-field {
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
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  font-size: 0.75rem;
}
.scoreline > div {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.scoreline span {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.side-a {
  color: var(--success);
}
.side-b {
  color: var(--amber);
}
.board-space {
  position: relative;
  min-width: 0;
  min-height: 0;
}
.empty-state {
  display: grid;
  place-content: center;
  text-align: center;
  color: var(--text-muted);
  padding: 16px;
}
.empty-state h2 {
  color: var(--text);
}
.playback-dock {
  min-width: 0;
}
.timeline-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-size: 0.75rem;
}
.timeline-heading span {
  color: var(--text-muted);
  font-size: 0.6875rem;
}
.timeline {
  display: block;
  margin: 2px 0;
}
.timeline input {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  height: 28px;
  min-height: 28px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  cursor: pointer;
  margin: 0;
}
.timeline input::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--success) 0 var(--timeline-progress),
    var(--line) var(--timeline-progress) 100%
  );
}
.timeline input::-webkit-slider-thumb {
  appearance: none;
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  margin-top: -5px;
  border: 0;
  border-radius: 50%;
  background: var(--success);
}
.timeline input::-moz-range-track {
  height: 6px;
  border-radius: 999px;
  background: var(--line);
}
.timeline input::-moz-range-progress {
  height: 6px;
  border-radius: 999px;
  background: var(--success);
}
.timeline input::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border: 0;
  border-radius: 50%;
  background: var(--success);
}
.timeline input:disabled {
  opacity: 0.45;
}
.playback-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}
.playback-buttons > button,
.verification-content button {
  min-height: 40px;
  padding: 6px 12px;
  color: var(--text);
  border: 1px solid var(--control-border);
  border-radius: 6px;
  background: var(--surface);
  font-size: 0.75rem;
}
.playback-buttons .play {
  min-width: 72px;
  background: var(--primary);
  color: white;
  border-color: var(--primary);
}
.speed-control {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 0.75rem;
  color: var(--text-muted);
  flex-shrink: 0;
}
.speed-control select {
  width: auto;
  min-height: 40px;
  padding: 6px 28px 6px 8px;
  font-size: 0.75rem;
}
.jump {
  margin: 0 0 0 auto;
  max-width: 44%;
}
.jump select {
  min-height: 40px;
  padding: 6px 10px;
  margin: 0;
  font-size: 0.75rem;
}
.details-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0 24px;
  margin-top: 5px;
}
details {
  min-width: 0;
  font-size: 0.6875rem;
}
details summary {
  color: var(--text-muted);
  min-height: 28px;
  display: list-item;
  padding: 4px 0;
}
details[open] {
  flex-basis: 100%;
}
.round-content,
.verification-content {
  max-height: min(25dvh, 180px);
  overflow: auto;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
}
.round-summary {
  margin: 0 0 8px;
}
.unit-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}
.unit-list button {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 44px;
  min-width: 0;
  text-align: left;
  padding: 6px 8px;
  background: var(--surface-input);
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--text);
  font-size: 0.6875rem;
}
.unit-list button > span:nth-child(2) {
  min-width: 0;
}
.unit-list strong,
.unit-list small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.unit-list small {
  color: var(--text-muted);
  font-size: 0.625rem;
}
.verification-content {
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}
.verification-content p {
  margin-bottom: 8px;
}
.verification-content dl {
  margin: 10px 0 0;
  display: grid;
  gap: 8px;
}
.verification-content dt {
  color: var(--text-muted);
  font-size: 0.6875rem;
}
.verification-content dd {
  margin: 0;
  font-family: ui-monospace, monospace;
  font-size: 0.6875rem;
}
button:disabled {
  opacity: 0.45;
}
@media (pointer: coarse) {
  .refresh {
    width: 44px;
    height: 44px;
  }
}
@media (max-width: 640px) {
  .replay-screen {
    padding: 8px;
    gap: 6px;
  }
  .replay-toolbar {
    gap: 8px;
  }
  .scoreline {
    padding: 6px 8px;
    gap: 8px;
    font-size: 0.6875rem;
  }
  .scoreline > div {
    gap: 3px 7px;
  }
  .scoreline strong {
    flex-basis: 100%;
  }
  .timeline-heading span {
    max-width: 48%;
    text-align: right;
  }
  .playback-buttons {
    gap: 5px;
    flex-wrap: wrap;
  }
  .playback-buttons > button {
    padding: 6px 9px;
  }
  .jump {
    max-width: none;
    flex: 1;
  }
  .jump select {
    width: 100%;
  }
  .unit-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
