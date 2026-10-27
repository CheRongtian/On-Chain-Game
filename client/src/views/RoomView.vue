<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { zeroAddress } from 'viem';
import AppIcon from '../components/AppIcon.vue';
import { readRoom } from '../lib/arena';
import type { Room } from '../lib/arena';
import { errorMessage } from '../lib/errors';
import { chainDate, outcomes, parseRoomId, phases, reasons } from '../lib/format';
import { useArenaStore } from '../stores/arena';
import { useTransactionStore } from '../stores/transaction';

const route = useRoute();
const arena = useArenaStore();
const transaction = useTransactionStore();
const id = computed(() => parseRoomId(String(route.params.matchId ?? '')));
const room = shallowRef<Room>();
const loading = ref(false);
const error = ref('');
const invitationMessage = ref('');
let requestVersion = 0;
let timer: ReturnType<typeof setInterval> | undefined;

async function refreshRoom(clear = false) {
  if (loading.value && !clear) return;
  const version = ++requestVersion;
  if (clear) {
    room.value = undefined;
    error.value = '';
    invitationMessage.value = '';
  }
  const deployment = arena.connection?.deployment;
  const matchId = id.value;
  if (!deployment || matchId === undefined) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const latest = await readRoom(deployment, matchId);
    if (version === requestVersion) {
      room.value = latest;
      error.value = '';
    }
  } catch (cause) {
    if (version === requestVersion) error.value = errorMessage(cause);
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}

watch(
  [() => route.params.matchId, () => arena.epoch],
  () => {
    void refreshRoom(true);
  },
  { immediate: true },
);
onMounted(() => {
  timer = setInterval(() => {
    void refreshRoom();
  }, 4_000);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  requestVersion++;
});

const creator = computed(
  () => !!arena.address && room.value?.players[0].toLowerCase() === arena.address.toLowerCase(),
);
const expired = computed(
  () => !!room.value && !!arena.connection && arena.connection.timestamp > room.value.joinDeadline,
);
const canJoin = computed(
  () =>
    arena.online &&
    !!arena.selected &&
    !!room.value &&
    !error.value &&
    room.value.phase === 1 &&
    !expired.value &&
    !creator.value &&
    !transaction.busy,
);
const joinHint = computed(() => {
  if (!room.value || room.value.phase !== 1) return '';
  if (expired.value) return 'The join window has closed.';
  if (creator.value)
    return 'You created this room. Switch accounts, then open its invitation again to join.';
  if (!arena.selected) return 'Choose a local account to take the open seat.';
  return 'Joining registers the current account as Player B and starts the first round.';
});

async function joinRoom() {
  if (!canJoin.value || id.value === undefined) return;
  const joined = await transaction.submit('join', id.value);
  if (joined !== undefined) await refreshRoom(true);
}

async function copyInvitation() {
  try {
    await navigator.clipboard.writeText(window.location.href);
    invitationMessage.value =
      'Invitation copied. Paste it into Find a room, or open it in another tab.';
  } catch {
    invitationMessage.value = 'Copy this page address from your browser to share it.';
  }
}
</script>

<template>
  <div>
    <RouterLink class="back-link" to="/"><AppIcon name="back" />Back to lobby</RouterLink>
    <header class="page-heading room-heading">
      <p class="eyebrow">Tactical Arena / Room</p>
      <h1 class="room-title">Room #{{ route.params.matchId }}</h1>
      <p class="page-intro">
        The seats, phase, and result below come directly from the local chain.
      </p>
    </header>

    <section v-if="id === undefined" class="panel empty-state" role="alert">
      <h2>Invalid room ID</h2>
      <p class="muted">Open an invitation with a positive room ID.</p>
    </section>
    <section v-else-if="!arena.online" class="panel empty-state">
      <h2>Waiting for the Arena</h2>
      <p class="muted">
        Start the backend and wait for its ready message. This room will refresh automatically.
      </p>
    </section>
    <section v-else-if="error" class="panel empty-state" role="alert">
      <h2>Room unavailable</h2>
      <p class="muted">{{ error }}</p>
      <button class="button secondary" :disabled="loading" @click="refreshRoom()">
        <AppIcon name="refresh" />{{ loading ? 'Refreshing…' : 'Try again' }}
      </button>
    </section>
    <section v-else-if="!room" class="panel empty-state" aria-live="polite">
      <h2>Loading room…</h2>
      <p class="muted">Reading its current state from the contract.</p>
    </section>

    <section v-else class="panel room-panel" aria-labelledby="matchup-title">
      <div class="panel-heading">
        <h2 id="matchup-title">The matchup</h2>
        <span
          class="chip"
          :class="room.phase === 1 ? 'chip-amber' : room.phase <= 5 ? 'chip-green' : ''"
          >{{ phases[room.phase] }}</span
        >
      </div>
      <div class="players-grid">
        <div class="player-card">
          <div class="player-topline">
            <span class="player-mark mark-a">A</span><span class="eyebrow">Creator</span>
          </div>
          <h3>Player A</h3>
          <p class="address player-address">{{ room.players[0] }}</p>
          <span v-if="creator" class="you-label">Current account</span
          ><span v-else class="small muted">Guardian · Ranger · Scout</span>
        </div>
        <span class="versus" aria-hidden="true">VS</span>
        <div class="player-card" :class="{ 'empty-seat': room.players[1] === zeroAddress }">
          <div class="player-topline">
            <span class="player-mark mark-b">B</span><span class="eyebrow">Opponent</span>
          </div>
          <h3>{{ room.players[1] === zeroAddress ? 'Open seat' : 'Player B' }}</h3>
          <p v-if="room.players[1] !== zeroAddress" class="address player-address">
            {{ room.players[1] }}
          </p>
          <p v-else class="muted seat-invite">A challenger belongs here.</p>
          <span
            v-if="arena.address?.toLowerCase() === room.players[1].toLowerCase()"
            class="you-label"
            >Current account</span
          ><span v-else class="small muted">{{
            room.players[1] === zeroAddress
              ? 'Waiting for another account'
              : 'Guardian · Ranger · Scout'
          }}</span>
        </div>
      </div>

      <dl class="room-facts">
        <div>
          <dt>Map</dt>
          <dd>Arena · 8 × 8</dd>
        </div>
        <div>
          <dt>{{ room.phase === 1 ? 'Join deadline' : 'Round' }}</dt>
          <dd>{{ room.phase === 1 ? chainDate(room.joinDeadline) : room.round }}</dd>
        </div>
        <div v-if="room.phaseDeadline !== 0n && room.phase !== 1">
          <dt>Phase deadline</dt>
          <dd>{{ chainDate(room.phaseDeadline) }}</dd>
        </div>
        <div v-if="room.outcome !== 0">
          <dt>Result</dt>
          <dd>{{ outcomes[room.outcome] }} · {{ reasons[room.reason] }}</dd>
        </div>
      </dl>
      <div v-if="room.phase === 1" class="room-actions">
        <p class="muted">{{ joinHint }}</p>
        <div class="button-row">
          <button
            v-if="!creator"
            class="button primary"
            :disabled="!canJoin"
            :aria-busy="transaction.busy"
            @click="joinRoom"
          >
            {{ transaction.busy ? 'Transaction in progress…' : 'Join room'
            }}<AppIcon name="arrow" /></button
          ><button class="button secondary" @click="copyInvitation">
            <AppIcon name="copy" />Copy invitation
          </button>
        </div>
        <p v-if="invitationMessage" class="small feedback" role="status">{{ invitationMessage }}</p>
      </div>
      <div v-else-if="room.phase >= 2 && room.phase <= 4" class="room-ready">
        <AppIcon name="check" />
        <div>
          <strong>Both players are registered.</strong>
          <p class="muted">The contract is in {{ phases[room.phase].toLowerCase() }}.</p>
        </div>
      </div>
      <div class="room-refresh">
        <p class="small muted">
          {{ loading ? 'Refreshing chain state…' : 'Room state refreshes automatically.' }}
        </p>
        <button class="text-button" :disabled="loading" @click="refreshRoom()">Refresh</button>
      </div>
    </section>
  </div>
</template>
