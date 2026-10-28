<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import SyncStatus from '../components/SyncStatus.vue';
import { useHistoryStore } from '../stores/history';
import { outcomes, phases, reasons, shortAddress } from '../lib/format';
const history = useHistoryStore();
const route = useRoute(),
  router = useRouter();
watch(
  () => route.query.page,
  (value) => {
    const page = Number(value ?? 1);
    history.open(undefined, 0, Number.isSafeInteger(page) && page > 0 ? (page - 1) * 10 : 0);
  },
  { immediate: true },
);
onBeforeUnmount(history.release);
watch(
  () => history.offset,
  (offset) => {
    const page = offset / 10 + 1;
    if (Number(route.query.page ?? 1) !== page)
      void router.replace({ name: 'history', query: { page: String(page) } });
  },
);
function paginate(offset: number) {
  void router.push({ name: 'history', query: { page: String(offset / 10 + 1) } });
}
</script>
<template>
  <div class="history-page">
    <header class="history-heading">
      <div>
        <p class="eyebrow">Tactical Arena / History</p>
        <h1>Every round tells a story.</h1>
        <p class="muted">Explore public matches and replay how the battle unfolded.</p>
      </div>
      <button class="button secondary" :disabled="history.refreshing" @click="history.refresh()">
        {{ history.refreshing ? 'Refreshing…' : 'Refresh history' }}
      </button>
    </header>
    <SyncStatus :meta="history.meta" :available="history.available" />
    <p v-if="history.error" class="history-alert" role="alert">
      {{ history.error }} <span v-if="history.page">The last loaded list is shown below.</span>
    </p>
    <p v-if="history.notice" class="muted" role="status">{{ history.notice }}</p>
    <section class="panel matches-panel" aria-label="Match history">
      <p v-if="history.loading" class="empty" role="status">Loading match history…</p>
      <div v-else-if="!history.page?.items.length" class="empty">
        <h2>
          {{ history.error ? 'History is temporarily unavailable' : 'The first story is yours.' }}
        </h2>
        <p class="muted">
          {{
            history.error
              ? 'Retry when the history service is available.'
              : 'Rooms appear here once their on-chain events have been indexed.'
          }}
        </p>
        <RouterLink to="/" class="button secondary">Back to lobby</RouterLink>
      </div>
      <div v-else class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Match</th>
              <th scope="col">Players</th>
              <th scope="col">Result</th>
              <th scope="col">Source</th>
              <th scope="col"><span class="sr-only">Open match</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in history.page.items" :key="item.match.id">
              <td>
                <strong>#{{ item.match.id }}</strong
                ><small
                  >{{ phases[item.match.phase] }} ·
                  {{ item.match.round ? `Round ${item.match.round}` : 'Waiting room' }}</small
                >
              </td>
              <td class="players">
                <span class="side-a" :title="item.match.players[0]"
                  >A · {{ shortAddress(item.match.players[0]) }}</span
                ><span class="side-b" :title="item.match.players[1]"
                  >B ·
                  {{
                    /^0x0+$/.test(item.match.players[1])
                      ? 'Open seat'
                      : shortAddress(item.match.players[1])
                  }}</span
                >
              </td>
              <td>
                <span>{{
                  item.match.outcome ? outcomes[item.match.outcome] : phases[item.match.phase]
                }}</span
                ><small>{{ reasons[item.match.reason] || 'Public room history' }}</small>
              </td>
              <td>
                <span>Block {{ item.match.source.block }}</span
                ><small>{{ history.available ? item.confirmation.status : 'unknown' }}</small>
              </td>
              <td>
                <RouterLink
                  :to="`/history/${item.match.id}`"
                  class="open-match"
                  :aria-label="`View match ${item.match.id}`"
                  >View replay <span aria-hidden="true">→</span></RouterLink
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <nav class="pagination" aria-label="History pagination">
      <button
        class="button secondary"
        :disabled="history.offset === 0 || history.loading"
        @click="paginate(history.offset - 10)"
      >
        Previous page
      </button>
      <span>Page {{ Math.floor(history.offset / 10) + 1 }}</span>
      <button
        class="button secondary"
        :disabled="!history.page?.hasMore || history.loading"
        @click="paginate(history.offset + 10)"
      >
        Next page
      </button>
    </nav>
  </div>
</template>
<style scoped>
.history-page {
  padding: 12px 0 36px;
}
.history-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 24px;
}
.history-heading h1 {
  font-size: clamp(1.6rem, 3vw, 2.5rem);
}
.history-heading p:last-child {
  margin-bottom: 0;
}
.history-heading button {
  flex-shrink: 0;
}
.matches-panel {
  margin-top: 20px;
  padding: 0;
  overflow: hidden;
}
.table-scroll {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 0.8125rem;
}
th {
  color: var(--text-muted);
  font-weight: 500;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
th,
td {
  padding: 20px;
  border-bottom: 1px solid var(--line);
}
tbody tr:last-child td {
  border-bottom: 0;
}
tbody tr:hover {
  background: var(--surface-raised);
}
td strong {
  font-size: 1rem;
}
td small {
  display: block;
  color: var(--text-muted);
  font-size: 0.6875rem;
  margin-top: 5px;
}
.players span {
  display: block;
  white-space: nowrap;
  line-height: 1.8;
}
.side-a,
.open-match {
  color: var(--success);
}
.side-b {
  color: var(--amber);
}
.open-match {
  display: inline-flex;
  gap: 10px;
  align-items: center;
  min-height: 44px;
  white-space: nowrap;
}
.pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 20px;
  font-size: 0.75rem;
  color: var(--text-muted);
}
.empty {
  text-align: center;
  padding: 64px 24px;
  margin: 0;
}
.history-alert {
  margin: 16px 0;
  padding: 12px;
  border: 1px solid var(--amber);
  border-radius: 8px;
  color: var(--amber);
  background: var(--amber-surface);
  font-size: 0.8125rem;
}
@media (max-width: 640px) {
  .history-heading {
    flex-direction: column;
    align-items: flex-start;
  }
  th,
  td {
    padding: 12px;
  }
  .pagination button {
    padding: 8px;
    font-size: 0.75rem;
  }
}
</style>
