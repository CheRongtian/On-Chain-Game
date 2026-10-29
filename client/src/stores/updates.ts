import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';

export interface UpdateNotice {
  kind: 'change' | 'reorg' | 'reset' | 'connected' | 'unavailable';
  matches: string[];
  chainId?: number;
  arena?: string;
  deploymentHash?: string;
  block?: number;
  blockHash?: string;
}
export interface UpdateHealth {
  database: string;
  rpc: string;
  indexer: string;
  ready: boolean;
  error?: string;
}

export const useUpdatesStore = defineStore('updates', () => {
  const state = ref<'connecting' | 'live' | 'reconnecting' | 'offline'>('connecting');
  const health = shallowRef<UpdateHealth>();
  const live = computed(() => state.value === 'live' && !!health.value?.ready);
  const label = computed(() => {
    if (state.value !== 'live')
      return state.value === 'connecting'
        ? 'Connecting live updates…'
        : 'Live updates reconnecting';
    if (health.value?.database === 'unavailable') return 'History temporarily unavailable';
    if (health.value?.rpc === 'unavailable') return 'Chain connection interrupted';
    if (!health.value?.ready) return 'Resyncing chain history';
    return 'Live updates connected';
  });
  const listeners = new Set<(notice: UpdateNotice) => void>();
  let source: EventSource | undefined;
  let lastId = '';
  let changes: UpdateNotice | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;

  function emit(notice: UpdateNotice) {
    for (const listener of listeners) listener(notice);
  }
  function listen(listener: (notice: UpdateNotice) => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
  function stop() {
    source?.close();
    source = undefined;
    clearTimeout(timer);
    clearTimeout(reconnect);
    timer = undefined;
    reconnect = undefined;
    changes = undefined;
    lastId = '';
    state.value = 'offline';
    health.value = undefined;
  }
  function start() {
    if (source) return;
    state.value = 'connecting';
    const connection = new EventSource(
      lastId ? `/api/events?after=${encodeURIComponent(lastId)}` : '/api/events',
    );
    source = connection;
    connection.onopen = () => {
      state.value = 'connecting';
    };
    connection.onerror = () => {
      if (source !== connection) return;
      if (state.value !== 'reconnecting') {
        state.value = 'reconnecting';
        clearTimeout(timer);
        timer = undefined;
        changes = undefined;
        emit({ kind: 'unavailable', matches: [] });
      }
      // HTTP errors such as 503 close EventSource without a native retry.
      if (connection.readyState === EventSource.CLOSED && reconnect === undefined)
        reconnect = setTimeout(() => {
          reconnect = undefined;
          if (source !== connection) return;
          connection.close();
          source = undefined;
          start();
        }, 3_000);
    };
    connection.addEventListener('status', (event) => {
      try {
        const next = JSON.parse((event as MessageEvent<string>).data) as UpdateHealth;
        const wasReady = live.value;
        const previous = health.value;
        health.value = next;
        state.value = 'live';
        if (!next.ready) {
          if (wasReady || previous?.ready !== false) emit({ kind: 'unavailable', matches: [] });
        } else if (!wasReady) emit({ kind: 'connected', matches: [] });
      } catch {
        state.value = 'reconnecting';
        emit({ kind: 'unavailable', matches: [] });
      }
    });
    for (const kind of ['change', 'reorg', 'reset'] as const) {
      connection.addEventListener(kind, (event) => {
        try {
          const message = event as MessageEvent<string>;
          const [deployment, sequence] = message.lastEventId.split(':');
          const [previousDeployment, previousSequence] = lastId.split(':');
          if (
            kind !== 'reset' &&
            deployment === previousDeployment &&
            Number(sequence) <= Number(previousSequence)
          )
            return;
          const notice = JSON.parse(message.data) as UpdateNotice;
          if (!Array.isArray(notice.matches) || !notice.deploymentHash) return;
          lastId = message.lastEventId;
          notice.kind = kind;
          if (kind !== 'change') {
            clearTimeout(timer);
            timer = undefined;
            changes = undefined;
            emit(notice);
          } else {
            changes = changes
              ? { ...notice, matches: [...new Set([...changes.matches, ...notice.matches])] }
              : notice;
            if (!timer)
              timer = setTimeout(() => {
                const pending = changes;
                changes = undefined;
                timer = undefined;
                if (pending) emit(pending);
              }, 150);
          }
        } catch {
          state.value = 'reconnecting';
          emit({ kind: 'unavailable', matches: [] });
        }
      });
    }
  }
  return { state, health, live, label, start, stop, listen };
});
