<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '../components/AppIcon.vue';
import { parseRoomInvitation } from '../lib/format';
import { useArenaStore } from '../stores/arena';
import { useTransactionStore } from '../stores/transaction';

const arena = useArenaStore();
const transaction = useTransactionStore();
const router = useRouter();
const roomInput = ref('');
const inputError = ref('');
const roomField = ref<HTMLInputElement>();
const canCreate = computed(() => arena.online && !!arena.selected && !transaction.busy);

watch(
  () => arena.address,
  (address, previousAddress) => {
    if (!previousAddress || address === previousAddress) return;
    roomInput.value = '';
    inputError.value = '';
  },
);
watch(
  () => transaction.status,
  (status) => {
    if (status === 'confirmed' && transaction.operation === 'create' && transaction.roomId)
      void router.push(`/rooms/${transaction.roomId}`);
  },
);

async function createRoom() {
  await transaction.createRoom();
}

function findRoom() {
  const id = parseRoomInvitation(roomInput.value, window.location.origin);
  inputError.value =
    id === undefined ? 'Enter a positive room ID or a valid invitation link from this app.' : '';
  if (id === undefined) roomField.value?.focus();
  else void router.push(`/rooms/${id}`);
}
</script>

<template>
  <div>
    <header class="page-heading">
      <p class="eyebrow">Tactical Arena / Lobby</p>
      <h1>Find your next opponent.</h1>
      <p class="page-intro">
        Create a room or join an invitation. Your selected local account takes the seat.
      </p>
    </header>

    <div class="lobby-grid">
      <section class="panel create-panel" aria-labelledby="create-title">
        <div class="panel-topline">
          <span class="panel-icon"><AppIcon name="plus" /></span
          ><span class="eyebrow">New challenge</span>
        </div>
        <h2 id="create-title">Create a room</h2>
        <p class="muted">
          Choose your rival by sharing a room ID. A different account joins as your opponent.
        </p>
        <div class="map-preview">
          <div class="map-emblem" aria-hidden="true"><AppIcon name="grid" /></div>
          <div>
            <strong>Arena</strong>
            <p class="small muted">8 × 8 battlefield</p>
          </div>
          <span class="chip">2 players</span>
        </div>
        <div class="squad-line"><span>Guardian</span><span>Ranger</span><span>Scout</span></div>
        <button
          class="button primary full-width"
          :disabled="!canCreate"
          :aria-busy="transaction.busy"
          @click="createRoom"
        >
          <AppIcon name="plus" />{{ transaction.busy ? 'Transaction in progress…' : 'Create room' }}
        </button>
        <p class="field-hint">
          {{
            !arena.online
              ? 'Start the backend to open the local Arena.'
              : !arena.selected
                ? 'Choose a local account in the account bar.'
                : 'Created with the current account. Your opponent has 24 hours to join.'
          }}
        </p>
      </section>

      <section class="panel join-panel" aria-labelledby="join-title">
        <div class="panel-topline">
          <span class="panel-icon subtle"><AppIcon name="arrow" /></span
          ><span class="eyebrow">Have an invitation?</span>
        </div>
        <h2 id="join-title">Find a room</h2>
        <p class="muted">
          Paste an invitation link or enter an ID to see the room and its open seats.
        </p>
        <form @submit.prevent="findRoom">
          <label for="room-id">Room ID or invitation link</label>
          <input
            id="room-id"
            ref="roomField"
            v-model="roomInput"
            autocomplete="off"
            placeholder="Paste a link or enter an ID"
            :aria-invalid="!!inputError"
            aria-describedby="room-id-hint"
            @input="inputError = ''"
          />
          <p
            id="room-id-hint"
            class="field-hint"
            :class="{ 'inline-error': inputError }"
            :role="inputError ? 'alert' : undefined"
          >
            {{ inputError || 'Use a room ID or the link from Copy invitation.' }}
          </p>
          <button class="button secondary full-width" type="submit">
            View room <AppIcon name="arrow" />
          </button>
        </form>
        <p class="small muted join-note">
          Choose your account first, then open the invitation and join from the room page.
        </p>
      </section>
    </div>

    <section class="setup-note">
      <div class="setup-number" aria-hidden="true">A/B</div>
      <div>
        <h2>Play both sides locally.</h2>
        <p>
          Open two tabs and choose a different account in each. Account selections are independent;
          both tabs read the same chain.
        </p>
      </div>
    </section>
  </div>
</template>
