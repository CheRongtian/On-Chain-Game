import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import {
  deploymentKey,
  HistoryError,
  historyRequest,
  readReplay,
  replayResolution,
  replaySpeeds,
} from '../lib/history';
import type { HistoryMeta, MatchPage, ReplayData } from '../lib/history';
import type { BattlefieldFrame } from '../battlefield/bridge';
import { emptyDrafts } from '../lib/battle';
import { useUpdatesStore } from './updates';

export const useHistoryStore = defineStore('history', () => {
  const updates = useUpdatesStore();
  const page = shallowRef<MatchPage>();
  const replay = shallowRef<ReplayData>();
  const loading = ref(false);
  const refreshing = ref(false);
  const available = ref(false);
  const error = ref('');
  const notice = ref('');
  const position = ref(0);
  const target = ref<number>();
  const playing = ref(false);
  const speed = ref(1);
  const revision = ref(0);
  const selectedUnit = ref<number>();
  const offset = ref(0);
  let matchId: string | undefined;
  let active = false;
  let wantedFrame = 0;
  let request: AbortController | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let advance: ReturnType<typeof setTimeout> | undefined;
  let continuous = false;
  let refreshQueued = false;
  const meta = computed<HistoryMeta | undefined>(() => replay.value?.meta ?? page.value?.meta);
  const current = computed(() => replay.value?.items[target.value ?? position.value]);
  const last = computed(() => Math.max(0, (replay.value?.items.length ?? 0) - 1));
  const canPlay = computed(
    () => available.value && !!replay.value?.verification.canonical && last.value > 0,
  );
  const board = computed<BattlefieldFrame | undefined>(() => {
    const data = replay.value,
      frame = current.value;
    if (!data || !frame) return undefined;
    return {
      state: frame.state,
      map: data.map,
      rules: data.rules,
      drafts: emptyDrafts(),
      unitCells: frame.state.units.map((unit) => unit.cell),
      selectedUnit: selectedUnit.value ?? -1,
      legalCells: [],
      resolutions:
        target.value === undefined ? [] : [replayResolution(data, position.value, target.value)],
      playback: { revision: revision.value, paused: !playing.value, speed: speed.value },
    };
  });
  function pause() {
    playing.value = false;
    clearTimeout(advance);
    advance = undefined;
  }
  function seek(index: number) {
    pause();
    continuous = false;
    target.value = undefined;
    position.value = Math.max(0, Math.min(last.value, index));
    revision.value++;
  }
  function step() {
    advance = undefined;
    if (!canPlay.value || position.value >= last.value) {
      pause();
      return;
    }
    target.value = position.value + 1;
    revision.value++;
  }
  function toggle() {
    if (playing.value) {
      pause();
      return;
    }
    if (!canPlay.value) return;
    continuous = true;
    playing.value = true;
    if (target.value !== undefined) return;
    if (position.value >= last.value) position.value = 0;
    step();
  }
  function next() {
    const from = target.value ?? position.value;
    if (!canPlay.value || from >= last.value) return;
    seek(from);
    playing.value = true;
    step();
  }
  function setSpeed(value: number) {
    if (!replaySpeeds.some((rate) => rate === value)) return;
    speed.value = value;
    if (advance !== undefined) {
      clearTimeout(advance);
      advance = setTimeout(step, 200 / value);
    }
  }
  function completed() {
    if (target.value === undefined) return;
    position.value = target.value;
    target.value = undefined;
    revision.value++;
    if (!continuous || position.value >= last.value) pause();
    else if (playing.value) advance = setTimeout(step, 200 / speed.value);
  }
  function pick(cell: number) {
    if (target.value !== undefined) return;
    const units = current.value?.state.units ?? [];
    const found = units
      .map((unit, id) => ({ unit, id }))
      .filter(({ unit }) => unit.hp > 0 && unit.cell === cell);
    if (!found.length) return;
    pause();
    const previous = found.findIndex(({ id }) => id === selectedUnit.value);
    selectedUnit.value = found[(previous + 1) % found.length]!.id;
  }
  async function refresh() {
    if (!active || refreshing.value) return;
    const controller = new AbortController();
    request = controller;
    refreshing.value = true;
    try {
      if (matchId) {
        const next = await readReplay(matchId, controller.signal);
        if (request !== controller || !active) return;
        const old = replay.value;
        const changed =
          !!old &&
          (deploymentKey(old.meta) !== deploymentKey(next.meta) ||
            next.meta.indexedBlock < old.meta.indexedBlock ||
            next.items.some(
              (frame, i) =>
                old.items[i] && old.items[i]!.source.blockHash !== frame.source.blockHash,
            ) ||
            (next.meta.indexedBlock === old.meta.indexedBlock &&
              next.meta.indexedHash !== old.meta.indexedHash) ||
            (next.verification.canonical && next.items.length < old.items.length));
        if (changed) {
          seek(0);
          selectedUnit.value = undefined;
          notice.value = 'The source chain changed. Replay has been reloaded and paused.';
        }
        if (!next.verification.canonical) pause();
        replay.value =
          !next.verification.canonical && old && !changed
            ? {
                ...old,
                meta: next.meta,
                verification: next.verification,
                confirmation: next.confirmation,
                match: next.match,
              }
            : next;
        if (!old) seek(wantedFrame);
        else if (position.value > last.value) seek(last.value);
      } else {
        let next = await historyRequest<MatchPage>(
          `/matches?limit=10&offset=${offset.value}`,
          controller.signal,
        );
        if (request !== controller || !active) return;
        if (page.value && deploymentKey(page.value.meta) !== deploymentKey(next.meta)) {
          const previousOffset = offset.value;
          offset.value = 0;
          page.value = undefined;
          notice.value = 'The local deployment changed. Showing its current history.';
          if (previousOffset !== 0)
            next = await historyRequest<MatchPage>('/matches?limit=10&offset=0', controller.signal);
          if (request !== controller || !active) return;
        }
        page.value = next;
      }
      available.value = true;
      error.value = '';
    } catch (cause) {
      if (controller.signal.aborted || request !== controller) return;
      available.value = false;
      pause();
      error.value =
        cause instanceof HistoryError
          ? cause.message
          : 'The history service is unavailable. Retry to reconnect.';
      if (cause instanceof HistoryError && cause.status === 404) {
        replay.value = undefined;
        seek(0);
        selectedUnit.value = undefined;
        error.value = 'This match is no longer present in the current indexed deployment.';
      }
    } finally {
      if (request === controller) {
        refreshing.value = false;
        loading.value = false;
        if (refreshQueued && active) {
          refreshQueued = false;
          void refresh();
        }
      }
    }
  }
  function release() {
    active = false;
    request?.abort();
    request = undefined;
    clearInterval(poll);
    refreshQueued = false;
    pause();
    refreshing.value = false;
    target.value = undefined;
    selectedUnit.value = undefined;
    page.value = undefined;
    replay.value = undefined;
    position.value = 0;
    available.value = false;
    loading.value = false;
    revision.value++;
  }
  function open(id?: string, frame = 0, pageOffset = 0) {
    release();
    matchId = id;
    wantedFrame = frame;
    offset.value = pageOffset;
    error.value = '';
    notice.value = '';
    available.value = false;
    loading.value = true;
    active = true;
    void refresh();
    poll = setInterval(() => {
      if (!updates.live) void refresh();
    }, 4_000);
  }
  updates.listen((update) => {
    if (!active) return;
    if (
      update.kind === 'change' &&
      matchId &&
      update.matches.length &&
      !update.matches.includes(matchId)
    ) {
      const old = replay.value;
      if (
        old &&
        update.block !== undefined &&
        update.blockHash &&
        update.deploymentHash === old.meta.deploymentHash &&
        update.block >= old.meta.indexedBlock
      ) {
        const observedBlock = Math.max(update.block, old.meta.observedBlock);
        replay.value = {
          ...old,
          meta: {
            ...old.meta,
            indexedBlock: update.block,
            indexedHash: update.blockHash,
            observedBlock,
            lag: observedBlock - update.block,
          },
        };
      }
      return;
    }
    if (update.kind === 'reorg' || update.kind === 'reset' || update.kind === 'unavailable') {
      request?.abort();
      request = undefined;
      refreshing.value = false;
      available.value = false;
      refreshQueued = false;
      const changedDeployment =
        !!replay.value &&
        !!update.deploymentHash &&
        update.deploymentHash !== replay.value.meta.deploymentHash;
      const from = update.kind === 'reorg' || changedDeployment ? 0 : position.value;
      if (replay.value) wantedFrame = from;
      seek(from);
      if (update.kind === 'reorg' || update.kind === 'reset') {
        loading.value = true;
        replay.value = undefined;
        page.value = undefined;
        selectedUnit.value = undefined;
        notice.value =
          'Chain history is being refreshed. Previous verification is being rechecked.';
      }
      if (update.kind === 'unavailable') {
        error.value = 'Live updates are interrupted. The page will keep checking for changes.';
        return;
      }
    }
    if (refreshing.value) refreshQueued = true;
    else void refresh();
  });

  return {
    page,
    replay,
    loading,
    refreshing,
    available,
    error,
    notice,
    position,
    target,
    playing,
    speed,
    selectedUnit,
    offset,
    meta,
    current,
    last,
    canPlay,
    board,
    open,
    refresh,
    release,
    pause,
    seek,
    toggle,
    next,
    setSpeed,
    completed,
    pick,
  };
});
