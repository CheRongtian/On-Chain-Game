<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { formatEther } from 'viem';
import type { Deployment } from '../lib/arena';
import { historyRequest } from '../lib/history';
import type { Confirmation, HistoryMeta } from '../lib/history';

interface DeploymentDetails extends Deployment {
  transactionHash: string;
  deploymentHash: string;
  rulesHash: string;
  compiler: string;
  optimizer: { enabled: boolean; runs: number };
  evmVersion: string;
  verification: { status: string; checkedAt: string };
}
interface ReceiptDetails {
  hash: string;
  status: string;
  from: string;
  to: string | null;
  nonce: number;
  valueWei: string;
  blockNumber?: string;
  blockHash?: string;
  blockTime?: string;
  gasLimit: number;
  gasUsed?: number;
  effectiveGasPriceWei?: string;
  feeWei?: string;
  confirmation?: Confirmation;
}
const route = useRoute();
const router = useRouter();
const deployment = ref<DeploymentDetails>();
const sync = ref<HistoryMeta>();
const receipt = ref<ReceiptDetails>();
const hash = ref('');
const loading = ref(false);
const error = ref('');
let controller: AbortController | undefined;
async function load() {
  controller?.abort();
  const request = new AbortController();
  controller = request;
  loading.value = true;
  error.value = '';
  deployment.value = undefined;
  sync.value = undefined;
  receipt.value = undefined;
  try {
    const details = await historyRequest<{ meta: HistoryMeta; deployment: DeploymentDetails }>(
      '/deployment',
      request.signal,
    );
    if (request.signal.aborted) return;
    deployment.value = details.deployment;
    sync.value = details.meta;
    hash.value = typeof route.params.hash === 'string' ? route.params.hash : '';
    if (hash.value) {
      const result = await historyRequest<{ transaction: ReceiptDetails }>(
        `/transactions/${encodeURIComponent(hash.value)}`,
        request.signal,
      );
      if (!request.signal.aborted) receipt.value = result.transaction;
    }
  } catch (failure) {
    if (!request.signal.aborted)
      error.value =
        failure instanceof Error ? failure.message : 'Chain details could not be loaded.';
  } finally {
    if (!request.signal.aborted) loading.value = false;
  }
}
function findTransaction() {
  if (!/^0x[\da-f]{64}$/i.test(hash.value.trim())) {
    error.value = 'Enter a 32-byte transaction hash.';
    return;
  }
  if (route.params.hash === hash.value.trim()) void load();
  else void router.push(`/transactions/${hash.value.trim()}`);
}
watch(() => route.params.hash, load, { immediate: true });
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <div class="chain-details">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">Local chain</p>
        <h1>Deployment &amp; transactions</h1>
      </div>
      <button class="button secondary" :disabled="loading" @click="load">
        {{ loading ? 'Loading…' : 'Refresh' }}
      </button>
    </div>
    <p class="muted">
      Inspect the saved Arena deployment and transaction receipts. All balances and fees use
      fictitious local ETH.
    </p>
    <p v-if="error" class="connection-alert" role="alert">{{ error }}</p>
    <p v-if="sync?.error" class="connection-alert" role="alert">
      Chain indexing unavailable: {{ sync.error }}
    </p>
    <p v-if="loading" role="status">Loading chain details…</p>
    <section v-if="deployment" class="panel" aria-labelledby="deployment-title">
      <h2 id="deployment-title">Arena deployment</h2>
      <dl class="detail-grid">
        <dt>Startup code and rules</dt>
        <dd>
          {{ deployment.verification.status }} · checked
          {{ new Date(deployment.verification.checkedAt).toLocaleString() }}
        </dd>
        <dt>Contract</dt>
        <dd class="address">{{ deployment.arenaAddress }}</dd>
        <dt>Chain</dt>
        <dd>{{ deployment.chainId }} · {{ deployment.rpcUrl }}</dd>
        <dt>Deployed</dt>
        <dd>{{ new Date(deployment.deployedAt).toLocaleString() }}</dd>
        <dt>Deployment block</dt>
        <dd>{{ deployment.deploymentBlock }}</dd>
        <dt>Block hash</dt>
        <dd class="address">{{ deployment.deploymentHash }}</dd>
        <dt>Deployment transaction</dt>
        <dd class="address">
          <RouterLink :to="`/transactions/${deployment.transactionHash}`" class="inline-link">{{
            deployment.transactionHash
          }}</RouterLink>
        </dd>
        <dt>Rules hash</dt>
        <dd class="address">{{ deployment.rulesHash }}</dd>
        <dt>Compiler</dt>
        <dd>
          Solidity {{ deployment.compiler }} · {{ deployment.evmVersion }} · optimizer
          {{ deployment.optimizer.enabled ? deployment.optimizer.runs + ' runs' : 'disabled' }}
        </dd>
      </dl>
    </section>
    <form class="panel transaction-search" @submit.prevent="findTransaction">
      <label for="transaction-lookup">Transaction hash</label>
      <div>
        <input
          id="transaction-lookup"
          v-model="hash"
          placeholder="0x…"
          autocomplete="off"
          spellcheck="false"
          required
        /><button class="button" type="submit" :disabled="loading">View receipt</button>
      </div>
    </form>
    <section v-if="receipt" class="panel" aria-labelledby="receipt-title">
      <h2 id="receipt-title">Transaction receipt · {{ receipt.status }}</h2>
      <dl class="detail-grid">
        <dt>Hash</dt>
        <dd class="address">{{ receipt.hash }}</dd>
        <dt>From</dt>
        <dd class="address">{{ receipt.from }}</dd>
        <dt>To</dt>
        <dd class="address">{{ receipt.to || 'Contract creation' }}</dd>
        <dt>Nonce</dt>
        <dd>{{ receipt.nonce }}</dd>
        <dt>Value</dt>
        <dd>{{ formatEther(BigInt(receipt.valueWei)) }} fictitious ETH</dd>
        <dt>Gas limit</dt>
        <dd>{{ receipt.gasLimit }}</dd>
        <template v-if="receipt.blockNumber">
          <dt>Source block</dt>
          <dd>{{ receipt.blockNumber }}</dd>
          <dt>Block hash</dt>
          <dd class="address">{{ receipt.blockHash }}</dd>
          <dt>Block time</dt>
          <dd>{{ receipt.blockTime ? new Date(receipt.blockTime).toLocaleString() : '—' }}</dd>
          <dt>Gas used</dt>
          <dd>{{ receipt.gasUsed }}</dd>
          <dt>Gas price</dt>
          <dd>{{ receipt.effectiveGasPriceWei }} wei</dd>
          <dt>Fee</dt>
          <dd>{{ formatEther(BigInt(receipt.feeWei!)) }} fictitious ETH</dd>
          <dt>Confirmation</dt>
          <dd>
            {{ receipt.confirmation?.status }} · {{ receipt.confirmation?.confirmations }} block(s)
          </dd>
        </template>
      </dl>
    </section>
  </div>
</template>

<style scoped>
.chain-details {
  display: grid;
  gap: 1.25rem;
  min-width: 0;
}
.chain-details .panel {
  padding: 1.25rem;
}
.detail-grid {
  display: grid;
  grid-template-columns: minmax(7rem, 10rem) minmax(0, 1fr);
  gap: 0.8rem 1rem;
  margin-top: 1rem;
}
.detail-grid dt {
  color: var(--text-muted);
}
.detail-grid dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.transaction-search {
  display: grid;
  gap: 0.75rem;
}
.transaction-search > div {
  display: flex;
  gap: 0.75rem;
}
.transaction-search input {
  flex: 1;
  min-width: 0;
}
@media (max-width: 600px) {
  .detail-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.4rem;
  }
  .detail-grid dd {
    margin-bottom: 0.6rem;
  }
  .transaction-search > div {
    flex-direction: column;
  }
}
</style>
