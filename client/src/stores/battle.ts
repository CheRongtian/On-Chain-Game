import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { Address } from 'viem';
import { readBattleSnapshot, requireHostStart } from '../lib/arena';
import type { BattleSnapshot, Deployment } from '../lib/arena';
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

type Interaction = 'idle' | 'details' | 'target' | 'review';
export const useBattleStore = defineStore('battle', () => {
  const snapshot = shallowRef<BattleSnapshot>();
  const drafts = shallowRef<DraftBundle>(emptyDrafts());
  const selectedId = ref<number>();
  const interaction = ref<Interaction>('idle');
  const proposal = shallowRef<ActionDraft>();
  const loading = ref(false);
  const error = ref('');
  const feedback = ref('');
  const context = shallowRef<{ deployment: Deployment; id: bigint; account?: Address }>();
  const history = shallowRef<readonly { drafts: DraftBundle; unitId: number }[]>([]);
  let requestId = 0;
  let hostChecked = false;
  let lastInspectedId: number | undefined;
  const field = computed(() => snapshot.value?.battlefield);
  const room = computed(() => snapshot.value?.room);
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
  const editable = computed(
    () =>
      !!field.value &&
      playerIndex.value !== undefined &&
      !error.value &&
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
        if (!editable.value || !unit.hp || Math.floor(unitId / 3) !== playerIndex.value)
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
    clearOrders();
  }
  function open(deployment?: Deployment, id?: bigint, account?: Address) {
    release();
    if (!deployment || id === undefined) return;
    context.value = { deployment, id, account };
    void refresh();
  }
  async function refresh() {
    if (loading.value || !context.value) return;
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
      const previous = snapshot.value;
      snapshot.value = next;
      if (
        !previous ||
        previous.room.round !== next.room.round ||
        previous.room.phase !== next.room.phase
      )
        clearOrders();
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
  function inspect(unitId: number) {
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
