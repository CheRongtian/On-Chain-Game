<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { encryptSecret } from '../lib/secrets';
import { errorMessage } from '../lib/errors';
import { useBattleStore } from '../stores/battle';
import { useTransactionStore } from '../stores/transaction';
import { useArenaStore } from '../stores/arena';
import AppIcon from './AppIcon.vue';

const battle = useBattleStore();
const transaction = useTransactionStore();
const route = useRoute();
const arena = useArenaStore();
const dialog = ref<HTMLDialogElement>();
const confirmation = ref<HTMLDialogElement>();
const confirmTrigger = ref<HTMLButtonElement>();
const skipConfirmation = ref(false);
const rememberChoice = ref(false);
const preferenceKey = computed(() =>
  arena.address ? `arena-order-confirmation:${arena.address.toLowerCase()}` : undefined,
);
const password = ref('');
const fileInput = ref<HTMLInputElement>();
const file = ref<File>();
const processing = ref(false);
const backupError = ref('');
const backupMessage = ref('');
const timer = setInterval(battle.tick, 1_000);
const countdown = computed(() => {
  const seconds = battle.remainingSeconds;
  return seconds === undefined
    ? 'No phase deadline'
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} remaining`;
});
const deadline = computed(() =>
  battle.room?.phaseDeadline
    ? new Date(Number(battle.room.phaseDeadline) * 1_000).toLocaleTimeString('en-GB', {
        hour12: false,
        timeZone: 'UTC',
      }) + ' UTC'
    : '',
);
const heading = computed(() => {
  if (battle.room?.outcome) return 'Match finished';
  if (battle.phaseExpired) return 'Deadline reached · confirm timeout on chain';
  if (battle.playerIndex === undefined) return 'Spectating this match';
  if (battle.progressPaused) return 'Round processing paused';
  if (battle.room?.phase === 3 || battle.room?.phase === 4) return 'Processing this round';
  if (battle.committed) return 'Waiting for your opponent';
  return battle.secret
    ? 'Saved orders ready · retry confirmation'
    : 'Plan your squad, then confirm your orders';
});
const roundOperation = computed(
  () =>
    transaction.roomId === String(route.params.matchId) &&
    ['commit', 'reveal', 'settle', 'timeout'].includes(transaction.operation ?? ''),
);
const feedback = computed(
  () =>
    battle.actionError ||
    battle.secretError ||
    battle.actionMessage ||
    (roundOperation.value
      ? transaction.status === 'sending'
        ? 'Sending transaction…'
        : transaction.status === 'pending'
          ? 'Waiting for confirmation…'
          : transaction.message
      : ''),
);
const failed = computed(
  () =>
    !!battle.actionError ||
    !!battle.secretError ||
    (roundOperation.value && transaction.status === 'failed'),
);
watch(
  preferenceKey,
  (key) => {
    closeConfirmation();
    skipConfirmation.value = false;
    try {
      skipConfirmation.value = !!key && localStorage.getItem(key) === 'skip';
    } catch {
      /* Keep the reminder when browser preferences are unavailable. */
    }
  },
  { immediate: true },
);
function requestConfirmation() {
  if (!battle.canCommit) return;
  if (skipConfirmation.value || battle.secret) {
    void battle.submit('commit');
    return;
  }
  battle.dismiss();
  rememberChoice.value = false;
  confirmation.value?.showModal();
}
function closeConfirmation() {
  confirmation.value?.close();
}
function restoreConfirmationFocus() {
  void nextTick(() => {
    if (confirmTrigger.value?.isConnected && !confirmTrigger.value.disabled)
      confirmTrigger.value.focus({ preventScroll: true });
  });
}
function confirmOrders() {
  if (!battle.canCommit) return;
  if (rememberChoice.value && preferenceKey.value) {
    try {
      localStorage.setItem(preferenceKey.value, 'skip');
      skipConfirmation.value = true;
    } catch {
      /* Order confirmation remains available when preferences cannot be saved. */
    }
  }
  closeConfirmation();
  void battle.submit('commit');
}
function openBackup() {
  battle.dismiss();
  password.value = '';
  file.value = undefined;
  if (fileInput.value) fileInput.value.value = '';
  backupError.value = '';
  backupMessage.value = '';
  dialog.value?.showModal();
}
function closeBackup() {
  if (processing.value) return;
  dialog.value?.close();
  password.value = '';
  file.value = undefined;
}
function chooseFile(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0];
}
async function downloadBackup() {
  if (!battle.secret || processing.value) return;
  const saved = battle.secret;
  processing.value = true;
  backupError.value = '';
  try {
    const blob = await encryptSecret(saved, password.value);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `arena-room-${saved.context.matchId}-round-${saved.context.round}-${saved.context.player.slice(-4)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    password.value = '';
    backupMessage.value =
      'Encrypted backup downloaded. Keep this file and password until the round is complete.';
  } catch (cause) {
    backupError.value = errorMessage(cause);
  } finally {
    processing.value = false;
  }
}
async function restoreBackup() {
  if (!file.value || processing.value) return;
  processing.value = true;
  backupError.value = '';
  try {
    if (await battle.restoreBackup(file.value, password.value)) {
      password.value = '';
      backupMessage.value = 'Original orders restored. Close this window to continue.';
    }
  } catch (cause) {
    backupError.value = errorMessage(cause);
  } finally {
    processing.value = false;
  }
}
watch(
  () => [battle.room?.round, battle.room?.phase, battle.playerIndex],
  () => {
    closeBackup();
    closeConfirmation();
  },
);
onBeforeUnmount(() => {
  clearInterval(timer);
  dialog.value?.close();
  confirmation.value?.close();
});
</script>

<template>
  <section class="round-controls" aria-label="Round controls">
    <div class="control-row">
      <div class="phase-summary">
        <strong>{{ heading }}</strong
        ><span
          >{{ countdown }}<span v-if="deadline"> · ends {{ deadline }}</span></span
        >
      </div>
      <div class="round-actions">
        <button
          v-if="battle.playerIndex !== undefined && !battle.room?.outcome"
          class="secondary-action"
          :disabled="battle.busy || processing"
          @click="openBackup"
        >
          Orders backup
        </button>
        <button
          v-if="battle.room?.phase === 2 && battle.playerIndex !== undefined"
          ref="confirmTrigger"
          class="primary-action"
          :disabled="!battle.canCommit"
          @click="requestConfirmation"
        >
          {{
            battle.committed
              ? 'Orders confirmed'
              : battle.busy
                ? 'Confirming…'
                : battle.secret
                  ? 'Retry confirmation'
                  : 'Confirm orders'
          }}
        </button>
        <button
          v-else-if="battle.canRetryRound"
          class="primary-action"
          @click="battle.retryRound()"
        >
          Retry
        </button>
        <span
          v-else-if="
            (battle.room?.phase === 3 || battle.room?.phase === 4) &&
            battle.playerIndex !== undefined &&
            !battle.phaseExpired &&
            !battle.progressPaused &&
            !battle.missingSecret &&
            !battle.secretError &&
            !battle.error
          "
          class="processing-status"
          role="status"
          ><AppIcon name="refresh" />Processing round…</span
        >
        <button
          v-if="battle.phaseExpired"
          class="timeout-action"
          :disabled="!battle.canTimeout"
          @click="battle.submit('timeout')"
        >
          Finalize timeout
        </button>
      </div>
    </div>
    <p v-if="battle.missingSecret" class="feedback failed" role="alert">
      Original orders are missing. Import your backup to continue this round. Without it, the game
      may end by timeout.
    </p>
    <p
      v-else-if="feedback"
      class="feedback"
      :class="{ failed }"
      :role="failed ? 'alert' : 'status'"
    >
      {{ feedback }}
    </p>
    <p v-else-if="!battle.room?.outcome" class="feedback">
      Confirm orders locks your squad for this round. Keep this page open while the round is
      processed.
    </p>
    <p v-if="battle.phaseExpired" class="timeout-hint">
      Countdown uses local time and the chain deadline. Your click updates idle local-chain time if
      needed; the contract confirms expiry.
    </p>
  </section>

  <dialog
    ref="confirmation"
    class="confirmation-dialog"
    aria-labelledby="confirm-title"
    aria-describedby="confirm-description"
    @cancel.prevent="closeConfirmation"
    @click.self="closeConfirmation"
    @close="restoreConfirmationFocus"
  >
    <section class="confirmation-panel">
      <header>
        <h2 id="confirm-title">Confirm orders?</h2>
        <button type="button" aria-label="Keep editing" @click="closeConfirmation">
          <AppIcon name="close" />
        </button>
      </header>
      <p id="confirm-description">
        Your squad's orders will be locked for this round. You won't be able to change them after
        confirmation.
      </p>
      <label class="remember-choice"
        ><input v-model="rememberChoice" type="checkbox" /><span>Don't show this again</span></label
      >
      <div class="confirmation-actions">
        <button type="button" class="secondary-action" autofocus @click="closeConfirmation">
          Keep editing</button
        ><button
          type="button"
          class="primary-action"
          :disabled="!battle.canCommit"
          @click="confirmOrders"
        >
          Confirm
        </button>
      </div>
    </section>
  </dialog>

  <dialog
    ref="dialog"
    aria-labelledby="backup-title"
    @cancel.prevent="closeBackup"
    @click.self="closeBackup"
  >
    <section class="backup-panel">
      <header>
        <h2 id="backup-title">Orders backup</h2>
        <button type="button" :disabled="processing" aria-label="Close backup" @click="closeBackup">
          <AppIcon name="close" />
        </button>
      </header>
      <p>
        Round {{ battle.room?.round }}. Backups belong to this deployment, room, round, and selected
        account.
      </p>
      <p>
        Local orders survive refresh. Clearing site data removes them. Keep an encrypted copy and
        its password until the round is complete.
      </p>
      <label for="backup-password">Backup password</label
      ><input
        id="backup-password"
        v-model="password"
        type="password"
        autocomplete="off"
        :disabled="processing"
      />
      <button
        class="primary-action"
        :disabled="!battle.secret || !password || processing"
        @click="downloadBackup"
      >
        Export encrypted backup
      </button>
      <p v-if="!battle.secret" class="hint">
        Confirm your orders to save the squad, or import the original backup below.
      </p>
      <label for="backup-file">Encrypted backup file</label
      ><input
        id="backup-file"
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        :disabled="processing"
        @change="chooseFile"
      />
      <button
        class="secondary-action"
        :disabled="!file || !password || processing || battle.busy"
        @click="restoreBackup"
      >
        {{ processing ? 'Processing…' : 'Import original orders' }}
      </button>
      <p v-if="backupError" class="failed" role="alert">{{ backupError }}</p>
      <p v-else-if="backupMessage" role="status">{{ backupMessage }}</p>
    </section>
  </dialog>
</template>

<style scoped>
.round-controls {
  min-width: 0;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
}
.control-row,
.round-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.control-row {
  justify-content: space-between;
}
.phase-summary {
  min-width: 0;
  margin-right: auto;
}
.phase-summary strong {
  display: block;
  font-size: 0.8125rem;
}
.phase-summary > span {
  font-size: 0.75rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
button {
  min-height: 40px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 0.75rem;
}
button:disabled {
  opacity: 0.5;
}
.primary-action {
  color: var(--on-primary);
  background: var(--primary);
}
.primary-action:hover:not(:disabled) {
  background: var(--primary-hover);
}
.secondary-action {
  color: var(--text);
  background: var(--surface-input);
  border: 1px solid var(--control-border);
}
.timeout-action {
  color: var(--amber);
  background: var(--surface-input);
  border: 1px solid var(--amber);
}
.feedback,
.timeout-hint {
  margin: 4px 0 0;
  font-size: 0.75rem;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
.failed {
  color: var(--error);
}
.processing-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 8px 12px;
  color: var(--text-muted);
  font-size: 0.75rem;
}
.processing-status .icon {
  width: 16px;
  height: 16px;
}
.confirmation-dialog {
  width: min(380px, calc(100% - 32px));
}
.confirmation-panel {
  padding: 20px;
}
.confirmation-panel > p {
  margin: 16px 0;
  font-size: 0.875rem;
  color: var(--text-muted);
}
.remember-choice {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  font-size: 0.8125rem;
  cursor: pointer;
}
.remember-choice input {
  width: 16px;
  height: 16px;
  min-height: 16px;
  margin: 0;
  padding: 0;
  flex-shrink: 0;
  accent-color: var(--primary);
}
.confirmation-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.confirmation-actions button {
  min-height: 44px;
}
dialog {
  width: min(420px, calc(100% - 32px));
  max-height: calc(100dvh - 32px);
  margin: auto;
  padding: 0;
  overflow: auto;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--control-border);
  border-radius: 12px;
}
dialog::backdrop {
  background: rgb(0 0 0 / 62%);
}
.backup-panel {
  padding: 20px;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
h2 {
  margin: 0;
  font-size: 1.125rem;
}
header button {
  color: var(--text);
  background: var(--surface-raised);
  padding: 8px;
}
.backup-panel p {
  font-size: 0.8125rem;
  color: var(--text-muted);
}
.backup-panel label {
  display: block;
  margin-top: 16px;
  font-size: 0.8125rem;
}
.backup-panel input {
  width: 100%;
  margin: 6px 0 10px;
}
.backup-panel > button {
  min-height: 44px;
  width: 100%;
}
.backup-panel .failed {
  color: var(--error);
}
.backup-panel .hint {
  font-size: 0.75rem;
}
@media (max-width: 540px) {
  .round-controls {
    padding: 6px 8px;
  }
  .round-actions button {
    padding: 6px 8px;
  }
}
</style>
