<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import AppIcon from './components/AppIcon.vue';
import TransactionNotice from './components/TransactionNotice.vue';
import { balanceLabel, shortAddress } from './lib/format';
import { useArenaStore } from './stores/arena';
import { useTransactionStore } from './stores/transaction';
import { useUpdatesStore } from './stores/updates';

const arena = useArenaStore();
const transaction = useTransactionStore();
const updates = useUpdatesStore();
const router = useRouter();
const route = useRoute();
const isSessionView = computed(
  () => route.name === 'battlefield' || route.name === 'room' || route.name === 'replay',
);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  updates.start();
  void arena.refresh();
  timer = setInterval(() => {
    void arena.refresh();
  }, 4_000);
});
onBeforeUnmount(() => {
  updates.stop();
  clearInterval(timer);
});
watch([() => arena.address, () => arena.epoch], ([address], [previousAddress]) => {
  transaction.reset();
  // Keep direct invitations on first load; later account changes start at the lobby.
  if (
    previousAddress &&
    address !== previousAddress &&
    route.name !== 'history' &&
    route.name !== 'replay'
  )
    void router.replace({ name: 'lobby' });
});
function changeAccount(event: Event) {
  arena.selectAccount((event.target as HTMLSelectElement).value);
}
</script>

<template>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <RouterView v-if="isSessionView" />
  <div v-else class="app-shell">
    <header class="site-header">
      <RouterLink to="/" class="brand" aria-label="Tactical Arena lobby"
        ><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span
        ><span>TACTICAL<span class="brand-light"> ARENA</span></span></RouterLink
      >
      <nav aria-label="Main navigation">
        <RouterLink to="/" class="nav-link">Lobby</RouterLink
        ><RouterLink to="/history" class="nav-link">History</RouterLink>
        <RouterLink to="/chain" class="nav-link">Chain</RouterLink>
      </nav>
      <span class="local-tag">LOCAL</span>
    </header>

    <section v-if="route.name === 'lobby'" class="account-bar" aria-label="Current local account">
      <div class="account-field">
        <label for="active-account">Active account</label
        ><select
          id="active-account"
          :value="arena.selected?.address ?? ''"
          :disabled="!arena.online || !arena.connection?.accounts.length || transaction.busy"
          @change="changeAccount"
        >
          <option v-if="!arena.connection?.accounts.length" value="">
            Waiting for local wallets…
          </option>
          <option
            v-for="(account, index) in arena.connection?.accounts"
            :key="account.address"
            :value="account.address"
          >
            Account {{ index + 1 }} · {{ shortAddress(account.address) }}
          </option>
        </select>
      </div>
      <div class="account-balance">
        <span class="eyebrow">Local balance</span
        ><strong>{{ arena.selected ? balanceLabel(arena.selected.balance) : '—' }}</strong>
      </div>
      <div class="chain-indicator">
        <span class="status-dot" :class="{ online: arena.online }" aria-hidden="true"></span>
        <div>
          <strong>{{ arena.online ? 'Local Arena online' : 'Local Arena offline' }}</strong
          ><span class="small muted">{{
            arena.connection
              ? `Chain ${arena.connection.deployment.chainId}`
              : 'Waiting for the backend'
          }}</span>
        </div>
      </div>
    </section>

    <div class="workspace" :class="{ 'history-workspace': route.name !== 'lobby' }">
      <main id="main-content" tabindex="-1">
        <div v-if="arena.error && route.name === 'lobby'" class="connection-alert" role="alert">
          <div>
            <strong>Local chain unavailable</strong>
            <p>{{ arena.error }}</p>
          </div>
          <button class="button secondary" :disabled="arena.refreshing" @click="arena.refresh()">
            <AppIcon name="refresh" />{{ arena.refreshing ? 'Connecting…' : 'Retry' }}
          </button>
        </div>
        <TransactionNotice v-if="route.name === 'lobby'" /><RouterView />
      </main>
      <aside v-if="route.name === 'lobby'" class="side-column" aria-label="Local session details">
        <section class="panel session-panel" aria-labelledby="session-title">
          <div class="panel-heading">
            <h2 id="session-title">Your session</h2>
            <span class="chip" :class="arena.online ? 'chip-green' : 'chip-amber'">{{
              arena.online ? 'Connected' : 'Waiting'
            }}</span>
          </div>
          <p class="small muted">
            Choose a local test wallet above. Your browser signs transactions; each tab keeps its
            own selection. Balances are fictitious ETH.
          </p>
          <dl class="session-facts">
            <div>
              <dt>Network</dt>
              <dd>Local Anvil</dd>
            </div>
            <div>
              <dt>Block</dt>
              <dd>{{ arena.connection?.blockNumber.toString() ?? '—' }}</dd>
            </div>
          </dl>
          <div v-if="arena.selected" class="current-address">
            <span class="eyebrow">Current address</span>
            <p class="address">{{ arena.selected.address }}</p>
          </div>
          <details v-if="arena.connection" class="connection-details">
            <summary>Connection details</summary>
            <p class="small address">{{ arena.connection.deployment.rpcUrl }}</p>
            <p class="small address">{{ arena.connection.deployment.arenaAddress }}</p>
            <RouterLink to="/chain" class="inline-link">Deployment and transactions</RouterLink>
          </details>
          <button class="text-button" :disabled="arena.refreshing" @click="arena.refresh()">
            {{ arena.refreshing ? 'Refreshing…' : 'Refresh connection' }}
          </button>
        </section>
        <section class="squad-panel" aria-labelledby="squad-title">
          <p class="eyebrow">Your starting squad</p>
          <h2 id="squad-title">Three roles.<br />One shared battlefield.</h2>
          <ul>
            <li>
              <span class="unit-code">G</span>
              <div><strong>Guardian</strong><span class="small muted">Hold the line.</span></div>
            </li>
            <li>
              <span class="unit-code">R</span>
              <div>
                <strong>Ranger</strong><span class="small muted">Control the distance.</span>
              </div>
            </li>
            <li>
              <span class="unit-code">S</span>
              <div><strong>Scout</strong><span class="small muted">Find the opening.</span></div>
            </li>
          </ul>
        </section>
      </aside>
    </div>
    <footer class="site-footer">
      <span>On-chain Tactical Arena</span
      ><span>Local games are saved across backend restarts. Balances use fictitious ETH.</span>
    </footer>
  </div>
</template>
