<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { zeroAddress } from 'viem';
import AppIcon from '../components/AppIcon.vue';
import CurrentAccount from '../components/CurrentAccount.vue';
import UpdateStatus from '../components/UpdateStatus.vue';
import { readRoom, requireHostStart } from '../lib/arena';
import type { Room } from '../lib/arena';
import { errorMessage } from '../lib/errors';
import { chainDate, parseRoomId, phases } from '../lib/format';
import { useArenaStore } from '../stores/arena';
import { useTransactionStore } from '../stores/transaction';
import { useUpdatesStore } from '../stores/updates';

const route = useRoute();
const router = useRouter();
const arena = useArenaStore();
const transaction = useTransactionStore();
const updates = useUpdatesStore();
const matchId = computed(() => parseRoomId(String(route.params.matchId ?? '')));
const room = shallowRef<Room>();
const error = ref('');
const copyStatus = ref('');
const reading = ref(false);
const isHost = computed(
  () => !!arena.address && room.value?.players[0].toLowerCase() === arena.address.toLowerCase(),
);
const isGuest = computed(
  () => !!arena.address && room.value?.players[1].toLowerCase() === arena.address.toLowerCase(),
);
const opponentJoined = computed(() => !!room.value && room.value.players[1] !== zeroAddress);
const waiting = computed(() => room.value?.phase === 1);
const expired = computed(
  () => !!room.value && !!arena.connection && arena.connection.timestamp > room.value.joinDeadline,
);
const mayStart = computed(
  () =>
    isHost.value &&
    waiting.value &&
    opponentJoined.value &&
    !expired.value &&
    !error.value &&
    !transaction.busy,
);
const mayJoin = computed(
  () =>
    waiting.value &&
    !isHost.value &&
    !opponentJoined.value &&
    !!arena.selected &&
    !expired.value &&
    !error.value &&
    !transaction.busy,
);
const starting = computed(() => transaction.busy && transaction.operation === 'start');
const joining = computed(() => transaction.busy && transaction.operation === 'join');
const roomStatus = computed(() =>
  !waiting.value
    ? phases[room.value?.phase ?? 0]
    : opponentJoined.value
      ? 'Ready for the host'
      : 'Waiting for opponent',
);
let requestId = 0;
let refreshQueued = false;
let startVerified = false;
let timer: ReturnType<typeof setInterval> | undefined;

async function readState(clear = false) {
  if (reading.value && !clear) return;
  const request = ++requestId;
  if (clear) {
    room.value = undefined;
    error.value = '';
    copyStatus.value = '';
    startVerified = false;
  }
  const deployment = arena.connection?.deployment;
  const id = matchId.value;
  const account = arena.address;
  if (!deployment || id === undefined) {
    reading.value = false;
    return;
  }
  reading.value = true;
  try {
    const latest = await readRoom(deployment, id);
    if (request !== requestId) return;
    if (latest.round > 0 && !startVerified) {
      await requireHostStart(deployment, id, latest);
      if (request !== requestId) return;
      startVerified = true;
    }
    room.value = latest;
    error.value = '';
    if (
      startVerified &&
      (isHost.value || isGuest.value) &&
      arena.address === account &&
      route.name === 'room'
    ) {
      void router.replace({ name: 'battlefield', params: { matchId: id.toString() } });
    }
  } catch (cause) {
    if (request === requestId) error.value = errorMessage(cause);
  } finally {
    if (request === requestId) {
      reading.value = false;
      if (refreshQueued) {
        refreshQueued = false;
        void readState();
      }
    }
  }
}
watch(
  [matchId, () => arena.epoch],
  () => {
    void readState(true);
  },
  { immediate: true },
);
watch(
  () => arena.address,
  (account, previous) => {
    if (account && !previous) void readState(true);
  },
);
onMounted(() => {
  timer = setInterval(() => {
    if (!updates.live || error.value) void readState();
  }, 1_000);
});
onBeforeUnmount(() => {
  stopUpdates();
  requestId++;
  clearInterval(timer);
});
const stopUpdates = updates.listen((update) => {
  if (update.kind === 'unavailable') return;
  if (
    update.kind === 'change' &&
    update.matches.length &&
    !update.matches.includes(String(matchId.value))
  )
    return;
  if (update.kind === 'reorg' || update.kind === 'reset') {
    refreshQueued = false;
    void readState(true);
  } else if (reading.value) refreshQueued = true;
  else void readState();
});

async function startGame() {
  if (!mayStart.value || matchId.value === undefined) return;
  const started = await transaction.startGame(matchId.value);
  if (started !== undefined) await readState(true);
}
async function joinRoom() {
  if (!mayJoin.value || matchId.value === undefined) return;
  const joined = await transaction.joinRoom(matchId.value);
  if (joined !== undefined) await readState(true);
}
async function copyInvitation() {
  const path = router.resolve({
    name: 'room',
    params: { matchId: String(route.params.matchId) },
  }).href;
  try {
    await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
    copyStatus.value = 'Invitation copied. Open it in another tab or paste it into Find a room.';
  } catch {
    copyStatus.value = 'Copy this room address from your browser.';
  }
}
</script>

<template>
  <main id="main-content" class="room-screen" tabindex="-1">
    <nav aria-label="Room navigation">
      <RouterLink to="/" class="lobby"><AppIcon name="back" />Lobby</RouterLink>
      <CurrentAccount />
    </nav>
    <header>
      <div>
        <p class="eyebrow">Preparation room</p>
        <h1>Room #{{ route.params.matchId }}</h1>
        <UpdateStatus />
      </div>
      <span v-if="room" class="chip chip-amber">{{ roomStatus }}</span>
    </header>
    <section v-if="matchId === undefined" class="notice" role="alert">
      <h2>Invalid room ID</h2>
    </section>
    <section v-else-if="!arena.online" class="notice" role="status">
      <h2>Waiting for the backend</h2>
      <p>Start the backend and wait for its ready message.</p>
    </section>
    <template v-else>
      <p v-if="error" class="failure" role="alert">{{ error }}</p>
      <template v-if="room">
        <section
          v-if="waiting && isHost"
          class="host-controls"
          aria-labelledby="host-controls-title"
        >
          <div>
            <span class="host-label">Host controls</span>
            <h2 id="host-controls-title">Start the game</h2>
            <p>
              {{
                expired
                  ? 'This room has expired.'
                  : opponentJoined
                    ? 'Both players are here. Click Start game to begin.'
                    : 'Invite your opponent, then click Start game.'
              }}
            </p>
            <span class="seat-count">{{
              opponentJoined ? '2 / 2 players joined' : '1 / 2 players joined'
            }}</span>
          </div>
          <button
            type="button"
            class="start-button"
            :disabled="!mayStart"
            :aria-busy="starting"
            @click="startGame"
          >
            {{ starting ? 'Confirming start…' : 'Start game' }}<AppIcon name="arrow" />
          </button>
        </section>
        <section v-else-if="waiting" class="guest-controls">
          <div>
            <h2>{{ isGuest ? 'Waiting for the host' : 'Join this room' }}</h2>
            <p>
              {{
                expired
                  ? 'This room has expired.'
                  : isGuest
                    ? 'The game begins when the host clicks Start game.'
                    : opponentJoined
                      ? 'Both seats are occupied.'
                      : 'Take the open seat and wait for the host to click Start game.'
              }}
            </p>
          </div>
          <button
            v-if="!opponentJoined"
            type="button"
            class="button primary"
            :disabled="!mayJoin"
            @click="joinRoom"
          >
            {{ joining ? 'Joining…' : 'Join room' }}
          </button>
        </section>
        <p v-if="transaction.status === 'failed'" class="failure" role="alert">
          {{ transaction.message }}
        </p>
        <div class="seats">
          <article v-for="player in [0, 1] as const" :key="player">
            <h3>
              <span :class="player === 0 ? 'mark-a' : 'mark-b'">{{ player === 0 ? 'A' : 'B' }}</span
              >{{ player === 0 ? 'Host' : 'Opponent' }}
            </h3>
            <p class="address">
              {{ room.players[player] === zeroAddress ? 'Open seat' : room.players[player] }}
            </p>
            <small>Guardian · Ranger · Scout</small>
          </article>
        </div>
        <footer>
          <button type="button" class="button secondary" @click="copyInvitation">
            <AppIcon name="copy" />Copy invitation</button
          ><span v-if="waiting" class="small muted"
            >Room expires {{ chainDate(room.joinDeadline) }}</span
          ><RouterLink
            v-else-if="room.round > 0"
            :to="{ name: 'battlefield', params: { matchId: route.params.matchId } }"
            class="button primary"
            >View battlefield</RouterLink
          >
        </footer>
        <p v-if="copyStatus" class="small feedback" role="status">{{ copyStatus }}</p>
      </template>
      <p v-else-if="!error" class="muted" role="status">Reading room state…</p>
      <button
        v-if="error"
        type="button"
        class="button secondary"
        :disabled="reading"
        @click="readState()"
      >
        Retry
      </button>
    </template>
  </main>
</template>

<style scoped>
.room-screen {
  max-width: 960px;
  margin: 0 auto;
  padding: 16px 24px;
}
nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}
.lobby {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  color: var(--text-muted);
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}
header .eyebrow {
  margin-bottom: 6px;
}
h1 {
  margin: 0;
  font-size: 1.9rem;
  overflow-wrap: anywhere;
}
.host-controls,
.guest-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 24px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  margin-bottom: 20px;
}
.host-controls {
  border-color: var(--primary);
}
.host-label {
  display: block;
  font-size: 0.75rem;
  color: var(--success);
  margin-bottom: 6px;
}
h2 {
  font-size: 1.2rem;
  margin: 0 0 8px;
}
.host-controls p,
.guest-controls p {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.875rem;
}
.seat-count {
  display: block;
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-top: 12px;
}
.start-button {
  min-height: 52px;
  min-width: 170px;
  padding: 12px 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-shrink: 0;
  background: var(--primary);
  color: white;
  border: 1px solid var(--success);
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 650;
}
.start-button:disabled {
  background: var(--surface-raised);
  color: var(--text-muted);
  border-color: var(--control-border);
}
.seats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.seats article {
  padding: 20px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
}
h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9375rem;
  margin-bottom: 16px;
}
h3 > span {
  display: grid;
  place-content: center;
  width: 28px;
  height: 28px;
  border-radius: 4px;
}
.address {
  font-size: 0.8125rem;
}
small {
  color: var(--text-muted);
}
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 20px;
}
.failure {
  padding: 12px;
  border: 1px solid var(--error);
  border-radius: 7px;
  color: var(--error);
  font-size: 0.875rem;
}
.notice {
  padding: 24px;
  border: 1px solid var(--line);
  border-radius: 10px;
}
@media (max-width: 560px) {
  .host-controls,
  .guest-controls {
    flex-direction: column;
    align-items: stretch;
    padding: 18px;
  }
  .seats {
    grid-template-columns: 1fr;
  }
}
</style>
