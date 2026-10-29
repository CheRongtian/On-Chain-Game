import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { Address } from 'viem';
import {
  advanceLocalClock,
  readBattleSnapshot,
  readResolutions,
  publicClient,
  requireHostStart,
} from '../lib/arena';
import type { BattleSnapshot, Deployment, RoundResolution } from '../lib/arena';
import {
  actionCost,
  actionIssue,
  availableActions,
  cellLabel,
  contains,
  emptyDrafts,
  encodeActions,
  hold,
  isAttack,
  isMovement,
  legalCells,
  movementPaths,
} from '../lib/battle';
import type { ActionDraft, ActionKind, DraftBundle } from '../lib/battle';
import { errorMessage } from '../lib/errors';
import {
  createSecret,
  decryptSecret,
  readSecret,
  saveSecret,
  secretContext,
  secretDrafts,
} from '../lib/secrets';
import type { OrderSecret } from '../lib/secrets';
import { useTransactionStore } from './transaction';
import { useUpdatesStore } from './updates';
import { useArenaStore } from './arena';

type Interaction = 'idle' | 'details' | 'target' | 'review';
export const useBattleStore = defineStore('battle', () => {
  const transaction = useTransactionStore();
  const updates = useUpdatesStore();
  const arena = useArenaStore();
  const snapshot = shallowRef<BattleSnapshot>();
  const drafts = shallowRef<DraftBundle>(emptyDrafts());
  const selectedId = ref<number>();
  const interaction = ref<Interaction>('idle');
  const proposal = shallowRef<ActionDraft>();
  const loading = ref(false);
  const error = ref('');
  const feedback = ref('');
  const secret = shallowRef<OrderSecret>();
  const secretReady = ref(false);
  const secretError = ref('');
  const working = ref(false);
  const actionError = ref('');
  const actionMessage = ref('');
  const progressPaused = ref(false);
  const resolutions = shallowRef<readonly RoundResolution[]>([]);
  const animating = ref(false);
  const boardRevision = ref(0);
  const localTime = ref(BigInt(Math.floor(Date.now() / 1_000)));
  const context = shallowRef<{ deployment: Deployment; id: bigint; account?: Address }>();
  let continuingFor: typeof context.value;
  const history = shallowRef<readonly { drafts: DraftBundle; unitId: number }[]>([]);
  let requestId = 0;
  let refreshPromise: Promise<void> | undefined;
  let refreshQueued = false;
  let hostChecked = false;
  let lastInspectedId: number | undefined;
  const field = computed(() => snapshot.value?.battlefield);
  const room = computed(() => snapshot.value?.room);
  const roundStatus = computed(() => snapshot.value?.roundStatus);
  const playerIndex = computed(() => {
    const account = context.value?.account?.toLowerCase();
    const index = room.value?.players.findIndex((player) => player.toLowerCase() === account);
    return index === 0 || index === 1 ? index : undefined;
  });
  const selected = computed(() =>
    selectedId.value === undefined ? undefined : field.value?.state.units[selectedId.value],
  );
  const ownUnit = computed(
    () =>
      selectedId.value !== undefined &&
      playerIndex.value !== undefined &&
      Math.floor(selectedId.value / 3) === playerIndex.value,
  );
  const busy = computed(() => working.value || transaction.busy);
  const committed = computed(
    () => playerIndex.value !== undefined && !!roundStatus.value?.committed[playerIndex.value],
  );
  const revealed = computed(
    () => playerIndex.value !== undefined && !!roundStatus.value?.revealed[playerIndex.value],
  );
  const secretMatches = computed(
    () =>
      !!secret.value &&
      playerIndex.value !== undefined &&
      secret.value.commitment.toLowerCase() ===
        roundStatus.value?.commitments[playerIndex.value].toLowerCase(),
  );
  const currentTime = computed(() =>
    snapshot.value && snapshot.value.timestamp > localTime.value
      ? snapshot.value.timestamp
      : localTime.value,
  );
  const phaseExpired = computed(
    () =>
      !!room.value &&
      (room.value.phase === 2 || room.value.phase === 3) &&
      currentTime.value > room.value.phaseDeadline,
  );
  const remainingSeconds = computed(() => {
    if (!room.value?.phaseDeadline) return undefined;
    const remaining = room.value.phaseDeadline - currentTime.value;
    return Number(remaining > 0n ? remaining : 0n);
  });
  const hasPlans = computed(
    () =>
      playerIndex.value !== undefined &&
      (room.value?.phase === 2 || room.value?.phase === 3 || room.value?.phase === 4),
  );
  const editable = computed(
    () =>
      !!field.value &&
      playerIndex.value !== undefined &&
      !error.value &&
      !busy.value &&
      !animating.value &&
      secretReady.value &&
      !secretError.value &&
      !secret.value &&
      !committed.value &&
      !phaseExpired.value &&
      room.value?.phase === 2 &&
      snapshot.value!.timestamp <= room.value.phaseDeadline,
  );
  const canEditUnit = computed(() => editable.value && ownUnit.value && !!selected.value?.hp);
  const drawerOpen = computed(
    () => interaction.value === 'details' || interaction.value === 'review',
  );
  const selectedDraft = computed(() =>
    ownUnit.value && selectedId.value !== undefined
      ? drafts.value[selectedId.value % 3]
      : undefined,
  );
  const availableEnergy = computed(() =>
    playerIndex.value === undefined
      ? 0
      : (field.value?.state.players[playerIndex.value].energy ?? 0),
  );
  function bundleWith(draft: ActionDraft): DraftBundle {
    const next: [ActionDraft, ActionDraft, ActionDraft] = [...drafts.value];
    next[selectedId.value! % 3] = draft;
    return next;
  }
  const preview = computed(() =>
    proposal.value && ownUnit.value ? bundleWith(proposal.value) : drafts.value,
  );
  // Only saved orders move the visual piece. Rule checks keep using the chain snapshot.
  const unitCells = computed(
    () =>
      field.value?.state.units.map((unit, unitId) => {
        if (!hasPlans.value || !unit.hp || Math.floor(unitId / 3) !== playerIndex.value)
          return unit.cell;
        const draft = drafts.value[unitId % 3];
        return isMovement(draft.kind) && draft.path.length
          ? draft.path[draft.path.length - 1]
          : unit.cell;
      }) ?? [],
  );
  function energy(bundle: DraftBundle): number {
    const data = field.value;
    const player = playerIndex.value;
    return data && player !== undefined
      ? bundle.reduce(
          (sum, draft, slot) =>
            sum + actionCost(draft, data.state.units[player * 3 + slot], data.rules),
          0,
        )
      : 0;
  }
  const energySpent = computed(() => energy(drafts.value));
  const proposedEnergy = computed(() => energy(preview.value));
  const proposalIssue = computed(() => {
    if (!proposal.value || selectedId.value === undefined || !field.value) return '';
    const data = field.value;
    return (
      actionIssue(proposal.value, selectedId.value, data.state, data.map, data.rules) ||
      (proposedEnergy.value > availableEnergy.value
        ? `Need ${proposedEnergy.value} Energy; ${availableEnergy.value} available.`
        : '')
    );
  });
  const canConfirm = computed(() => canEditUnit.value && !!proposal.value && !proposalIssue.value);
  const highlighted = computed(() =>
    interaction.value === 'target' &&
    proposal.value &&
    selectedId.value !== undefined &&
    field.value
      ? legalCells(
          proposal.value,
          selectedId.value,
          field.value.state,
          field.value.map,
          field.value.rules,
        )
      : [],
  );
  const canonicalActions = computed(() => {
    const data = field.value;
    const player = playerIndex.value;
    if (
      !editable.value ||
      proposal.value ||
      !data ||
      player === undefined ||
      energySpent.value > availableEnergy.value
    )
      return undefined;
    return drafts.value.every(
      (draft, slot) => !actionIssue(draft, player * 3 + slot, data.state, data.map, data.rules),
    )
      ? encodeActions(drafts.value)
      : undefined;
  });
  const canUndo = computed(() => editable.value && history.value.length > 0);
  const canCommit = computed(
    () =>
      arena.online &&
      !busy.value &&
      !loading.value &&
      !animating.value &&
      !error.value &&
      secretReady.value &&
      !secretError.value &&
      playerIndex.value !== undefined &&
      room.value?.phase === 2 &&
      !phaseExpired.value &&
      !committed.value &&
      (!!secret.value || !!canonicalActions.value),
  );
  const canReveal = computed(
    () =>
      arena.online &&
      !busy.value &&
      !loading.value &&
      !error.value &&
      !secretError.value &&
      room.value?.phase === 3 &&
      !phaseExpired.value &&
      committed.value &&
      !revealed.value &&
      secretMatches.value,
  );
  const canSettle = computed(
    () =>
      arena.online &&
      !busy.value &&
      !loading.value &&
      !error.value &&
      !!context.value?.account &&
      room.value?.phase === 4,
  );
  const canTimeout = computed(
    () =>
      arena.online &&
      !busy.value &&
      !loading.value &&
      !error.value &&
      !!context.value?.account &&
      phaseExpired.value,
  );
  const canRetryRound = computed(
    () => progressPaused.value && (canReveal.value || canSettle.value),
  );
  const missingSecret = computed(
    () =>
      secretReady.value && committed.value && !revealed.value && !secret.value && hasPlans.value,
  );
  function tick() {
    localTime.value = BigInt(Math.floor(Date.now() / 1_000));
  }
  function currentSecretContext() {
    const target = context.value;
    const summary = room.value;
    return target?.account && summary?.round && playerIndex.value !== undefined
      ? secretContext(
          target.deployment,
          target.id,
          summary.round,
          target.account,
          summary.rulesHash,
        )
      : undefined;
  }
  function dismiss() {
    interaction.value = 'idle';
    selectedId.value = undefined;
    proposal.value = undefined;
    feedback.value = '';
  }
  function clearOrders() {
    drafts.value = emptyDrafts();
    history.value = [];
    lastInspectedId = undefined;
    dismiss();
  }
  function release() {
    requestId++;
    context.value = undefined;
    snapshot.value = undefined;
    loading.value = false;
    error.value = '';
    hostChecked = false;
    refreshPromise = undefined;
    refreshQueued = false;
    secret.value = undefined;
    secretReady.value = false;
    secretError.value = '';
    actionError.value = '';
    actionMessage.value = '';
    progressPaused.value = false;
    continuingFor = undefined;
    working.value = false;
    resolutions.value = [];
    animating.value = false;
    tick();
    clearOrders();
  }
  function open(deployment?: Deployment, id?: bigint, account?: Address) {
    release();
    if (!deployment || id === undefined) return;
    context.value = { deployment, id, account };
    void refresh();
  }
  function refresh(): Promise<void> {
    if (refreshPromise) return refreshPromise;
    if (!context.value) return Promise.resolve();
    const pending: Promise<void> = loadSnapshot().finally(() => {
      if (refreshPromise !== pending) return;
      refreshPromise = undefined;
      if (refreshQueued && !busy.value) {
        refreshQueued = false;
        void refresh();
      } else if (!busy.value && !error.value) void continueRound();
    });
    refreshPromise = pending;
    return pending;
  }
  async function loadSnapshot() {
    if (!context.value) return;
    const target = context.value;
    const request = ++requestId;
    loading.value = true;
    try {
      const next = await readBattleSnapshot(target.deployment, target.id);
      if (request !== requestId) return;
      if (next.room.round > 0 && !hostChecked) {
        await requireHostStart(target.deployment, target.id, next.room);
        if (request !== requestId) return;
        hostChecked = true;
      }
      let previous = snapshot.value;
      if (previous) {
        const displaced =
          next.blockNumber < previous.blockNumber ||
          (await publicClient(target.deployment).getBlock({ blockNumber: previous.blockNumber }))
            .hash !== previous.blockHash;
        if (request !== requestId) return;
        if (displaced) {
          previous = undefined;
          resolutions.value = [];
          animating.value = false;
          boardRevision.value++;
          hostChecked = false;
          if (transaction.roomId === target.id.toString()) transaction.reset();
        }
      }
      const settled =
        previous && previous.room.stateHash !== next.room.stateHash
          ? await readResolutions(
              target.deployment,
              target.id,
              previous.blockNumber + 1n,
              next.blockNumber,
              next.room.players,
            )
          : [];
      if (request !== requestId) return;
      if (!previous || previous.room.round !== next.room.round) {
        clearOrders();
        secret.value = undefined;
        secretReady.value = false;
        secretError.value = '';
        actionMessage.value = '';
        actionError.value = '';
        progressPaused.value = false;
        if (transaction.roomId === target.id.toString() && !transaction.busy) transaction.reset();
      } else if (previous.room.stateHash !== next.room.stateHash) dismiss();
      snapshot.value = next;
      tick();
      if (settled.length) {
        resolutions.value = settled;
        animating.value = true;
      }
      const secretKey = currentSecretContext();
      if (secretKey) {
        try {
          const saved = await readSecret(secretKey);
          if (request !== requestId) return;
          if (
            saved &&
            committed.value &&
            saved.commitment.toLowerCase() !==
              roundStatus.value!.commitments[playerIndex.value!].toLowerCase()
          )
            throw new Error(
              'Saved orders do not match the chain commitment. Import the original backup.',
            );
          secret.value = saved;
          if (saved) drafts.value = secretDrafts(saved);
          secretError.value = '';
        } catch (cause) {
          if (request !== requestId) return;
          secret.value = undefined;
          secretError.value = errorMessage(cause);
        }
      }
      secretReady.value = true;
      error.value = '';
      if (!editable.value) {
        proposal.value = undefined;
        interaction.value = selectedId.value === undefined ? 'idle' : 'details';
      }
    } catch (cause) {
      if (request === requestId) {
        error.value = errorMessage(cause);
        dismiss();
      }
    } finally {
      if (request === requestId) loading.value = false;
    }
  }
  async function submit(action: 'commit' | 'reveal' | 'settle' | 'timeout'): Promise<boolean> {
    const allowed = {
      commit: canCommit.value,
      reveal: canReveal.value,
      settle: canSettle.value,
      timeout: canTimeout.value,
    };
    if (!allowed[action] || !context.value || !room.value) return false;
    const target = context.value;
    const expectedRound = room.value.round;
    const expectedPhase = room.value.phase;
    const actions = secret.value?.actions ?? canonicalActions.value;
    working.value = true;
    progressPaused.value = false;
    actionError.value = '';
    actionMessage.value = '';
    dismiss();
    try {
      await refresh();
      if (context.value !== target) return false;
      if (error.value) throw new Error(error.value);
      if (room.value.round !== expectedRound || room.value.phase !== expectedPhase) {
        if (transaction.status === 'failed') transaction.reset();
        return true;
      }
      let submitted: bigint | undefined;
      if (action === 'commit') {
        if (secretError.value) throw new Error(secretError.value);
        if (committed.value) {
          if (transaction.status === 'failed') transaction.reset();
          return true;
        }
        if (phaseExpired.value) throw new Error('The order confirmation deadline has passed.');
        const saved = secret.value ?? createSecret(currentSecretContext()!, actions!);
        actionMessage.value = 'Saving and confirming your squad…';
        await saveSecret(saved);
        if (context.value !== target || room.value.round !== expectedRound) return false;
        secret.value = saved;
        drafts.value = secretDrafts(saved);
        actionMessage.value = '';
        submitted = await transaction.commitOrders(target.id, expectedRound, saved.commitment);
      } else if (action === 'reveal') {
        if (!secretMatches.value || !secret.value)
          throw new Error('Import the original orders and Salt to Reveal.');
        if (revealed.value) {
          if (transaction.status === 'failed') transaction.reset();
          return true;
        }
        if (phaseExpired.value) throw new Error('The round processing deadline has passed.');
        submitted = await transaction.revealOrders(
          target.id,
          expectedRound,
          secret.value.actions,
          secret.value.salt,
        );
      } else if (action === 'settle') {
        submitted = await transaction.settleRound(target.id, expectedRound);
      } else {
        if (snapshot.value!.timestamp <= room.value.phaseDeadline) {
          actionMessage.value = 'Synchronizing local chain time for this timeout…';
          await advanceLocalClock(target.deployment, snapshot.value!.timestamp);
          if (context.value !== target) return false;
          await refresh();
          if (context.value !== target) return false;
          if (error.value) throw new Error(error.value);
        }
        if (room.value.round !== expectedRound || room.value.phase !== expectedPhase)
          throw new Error('The phase changed. Refresh before continuing.');
        if (snapshot.value!.timestamp <= room.value.phaseDeadline)
          throw new Error('The chain deadline has not passed yet. Wait and retry.');
        actionMessage.value = '';
        submitted = await transaction.finalizeTimeout(
          target.id,
          expectedRound,
          expectedPhase as 2 | 3,
        );
      }
      if (context.value === target) await refresh();
      if (context.value !== target) return false;
      if (error.value) return false;
      const completed =
        room.value.round !== expectedRound ||
        !!room.value.outcome ||
        (action === 'commit' && committed.value && secretMatches.value) ||
        (action === 'reveal' && revealed.value);
      if (submitted === undefined && !completed) {
        progressPaused.value = true;
        actionError.value = transaction.message || 'Round processing stopped. Retry to continue.';
        return false;
      }
      // Another tab or Keeper may have advanced the room while this request was in flight.
      if (completed && transaction.status === 'failed') transaction.reset();
      return true;
    } catch (cause) {
      if (context.value === target) {
        actionMessage.value = '';
        actionError.value = errorMessage(cause);
        progressPaused.value = true;
      }
      return false;
    } finally {
      if (context.value === target) {
        working.value = false;
        if (refreshQueued && !busy.value) {
          refreshQueued = false;
          void refresh();
        }
        if (action !== 'timeout' && !progressPaused.value && !error.value) void continueRound();
      }
    }
  }
  async function continueRound(): Promise<void> {
    const target = context.value;
    const round = room.value?.round;
    if (
      !target ||
      !round ||
      continuingFor ||
      busy.value ||
      loading.value ||
      error.value ||
      progressPaused.value
    )
      return;
    continuingFor = target;
    try {
      while (
        context.value === target &&
        room.value?.round === round &&
        !error.value &&
        !progressPaused.value
      ) {
        // Only a confirmed squad can reveal; the next round still waits for a new confirmation.
        if (canReveal.value) {
          if (!(await submit('reveal'))) break;
        } else if (
          canSettle.value &&
          revealed.value &&
          target.account?.toLowerCase() === snapshot.value?.settlementAccount?.toLowerCase()
        ) {
          if (!(await submit('settle'))) break;
        } else break;
      }
    } finally {
      if (continuingFor === target) continuingFor = undefined;
    }
  }
  async function retryRound() {
    if (!canRetryRound.value) return;
    progressPaused.value = false;
    actionError.value = '';
    const action = room.value?.phase === 4 ? 'settle' : 'reveal';
    await submit(action);
  }
  async function checkTransaction() {
    const target = context.value;
    const confirmed = await transaction.checkConfirmation();
    if (context.value !== target || confirmed === undefined) return;
    progressPaused.value = false;
    actionError.value = '';
    await refresh();
    if (context.value === target) await continueRound();
  }
  async function restoreBackup(file: File, password: string) {
    const target = context.value;
    const secretKey = currentSecretContext();
    if (!target || !secretKey || busy.value) return;
    working.value = true;
    try {
      const saved = await decryptSecret(file, password, secretKey);
      await refresh();
      if (context.value !== target || room.value?.round !== secretKey.round) return;
      if (error.value) throw new Error(error.value);
      if (room.value.phase !== 2 && room.value.phase !== 3)
        throw new Error('This phase no longer needs a secret import.');
      if (
        committed.value &&
        saved.commitment.toLowerCase() !==
          roundStatus.value!.commitments[playerIndex.value!].toLowerCase()
      )
        throw new Error('This backup does not match your on-chain commitment.');
      await saveSecret(saved, true);
      if (context.value !== target || room.value.round !== secretKey.round) return;
      secret.value = saved;
      drafts.value = secretDrafts(saved);
      history.value = [];
      secretError.value = '';
      actionError.value = '';
      progressPaused.value = false;
      actionMessage.value = 'Original orders restored. Continuing this round.';
      dismiss();
      return true;
    } finally {
      if (context.value === target) {
        working.value = false;
        void continueRound();
      }
    }
  }
  function animationComplete() {
    animating.value = false;
  }
  function inspect(unitId: number) {
    if (animating.value) return;
    if (!field.value?.state.units[unitId]) return;
    selectedId.value = unitId;
    lastInspectedId = unitId;
    proposal.value = undefined;
    feedback.value = '';
    interaction.value = 'details';
  }
  function choose(kind: ActionKind) {
    if (!canEditUnit.value || !selected.value || !availableActions(selected.value).includes(kind))
      return;
    const previous = selectedDraft.value;
    proposal.value =
      previous?.kind === kind ? { ...previous, path: [...previous.path] } : { kind, path: [] };
    feedback.value = '';
    interaction.value = isMovement(kind) || isAttack(kind) ? 'target' : 'review';
  }
  function pick(cell: number) {
    if (animating.value) return;
    const data = field.value;
    if (!data) return;
    if (
      interaction.value !== 'target' ||
      !proposal.value ||
      selectedId.value === undefined ||
      !editable.value
    ) {
      const visible = data.state.units
        .map((unit, unitId) => ({ unit, unitId }))
        .filter(({ unit, unitId }) => unit.hp > 0 && unitCells.value[unitId] === cell);
      if (visible.length) {
        // Legal orders can share an endpoint. Repeated selections cycle through that stack.
        const previous = visible.findIndex(({ unitId }) => unitId === lastInspectedId);
        inspect(visible[(previous + 1) % visible.length].unitId);
      } else {
        const unit = data.state.units.findIndex((entry) => entry.hp > 0 && entry.cell === cell);
        if (unit >= 0) inspect(unit);
      }
      return;
    }
    let candidate: ActionDraft;
    if (isMovement(proposal.value.kind)) {
      const path = movementPaths(
        proposal.value.kind,
        selectedId.value,
        data.state,
        data.map,
        data.rules,
      ).get(cell);
      if (!path) {
        feedback.value = contains(data.map.obstacles, cell)
          ? `${cellLabel(cell)} is a wall.`
          : data.state.units.some((unit) => unit.hp > 0 && unit.cell === cell)
            ? `${cellLabel(cell)} is occupied at round start.`
            : 'Choose a highlighted destination.';
        return;
      }
      candidate = { ...proposal.value, path };
    } else candidate = { ...proposal.value, target: cell };
    const issue = actionIssue(candidate, selectedId.value, data.state, data.map, data.rules);
    if (issue) feedback.value = issue;
    else {
      proposal.value = candidate;
      feedback.value = '';
    }
  }
  function save(draft: ActionDraft) {
    if (!editable.value || !ownUnit.value || selectedId.value === undefined) return;
    history.value = [...history.value, { drafts: drafts.value, unitId: selectedId.value }];
    drafts.value = bundleWith(draft);
    proposal.value = undefined;
    feedback.value = '';
    interaction.value = 'details';
  }
  function confirm() {
    if (canConfirm.value && proposal.value) save(proposal.value);
  }
  function cancel() {
    proposal.value = undefined;
    feedback.value = '';
    interaction.value = selectedId.value === undefined ? 'idle' : 'details';
  }
  function resetUnit() {
    save(hold());
  }
  function undo() {
    if (!canUndo.value) return;
    const previous = history.value[history.value.length - 1];
    history.value = history.value.slice(0, -1);
    drafts.value = previous.drafts;
    selectedId.value = previous.unitId;
    lastInspectedId = previous.unitId;
    proposal.value = undefined;
    feedback.value = '';
    interaction.value = 'details';
  }
  updates.listen((update) => {
    const target = context.value;
    if (!target || update.kind === 'unavailable') return;
    if (
      (update.kind === 'change' || update.kind === 'reorg') &&
      update.matches.length &&
      !update.matches.includes(target.id.toString())
    )
      return;
    if (update.kind === 'reorg' || update.kind === 'reset') {
      if (transaction.roomId === target.id.toString()) transaction.reset();
      // Reset transient rendering and requests; persisted orders and Salt remain in IndexedDB.
      open(target.deployment, target.id, target.account);
    } else if (refreshPromise || busy.value) refreshQueued = true;
    else void refresh();
  });
  return {
    snapshot,
    room,
    field,
    drafts,
    selectedId,
    selected,
    ownUnit,
    editable,
    canEditUnit,
    interaction,
    proposal,
    drawerOpen,
    selectedDraft,
    availableEnergy,
    energySpent,
    proposedEnergy,
    proposalIssue,
    canConfirm,
    highlighted,
    preview,
    unitCells,
    canonicalActions,
    canUndo,
    loading,
    error,
    feedback,
    playerIndex,
    roundStatus,
    committed,
    revealed,
    phaseExpired,
    remainingSeconds,
    hasPlans,
    busy,
    secret,
    secretReady,
    secretError,
    missingSecret,
    actionError,
    actionMessage,
    canCommit,
    canReveal,
    canSettle,
    canTimeout,
    canRetryRound,
    progressPaused,
    resolutions,
    animating,
    boardRevision,
    submit,
    retryRound,
    checkTransaction,
    restoreBackup,
    animationComplete,
    tick,
    open,
    release,
    refresh,
    inspect,
    choose,
    pick,
    dismiss,
    confirm,
    cancel,
    resetUnit,
    undo,
  };
});
