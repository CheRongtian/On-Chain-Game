<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useTransactionStore } from '../stores/transaction';
import AppIcon from './AppIcon.vue';

const transaction = useTransactionStore();
const labels = {
  idle: '',
  sending: 'Sending your transaction',
  pending: 'Waiting for confirmation',
  unconfirmed: 'Confirmation needs checking',
  confirmed: 'Confirmed on the local chain',
  failed: 'Transaction unsuccessful',
} as const;
const detail = computed(() =>
  transaction.status === 'sending'
    ? 'The local node is preparing and submitting your request.'
    : transaction.status === 'pending'
      ? 'Your transaction has been submitted. Waiting for its receipt.'
      : transaction.message,
);
</script>

<template>
  <section
    v-if="transaction.status !== 'idle'"
    class="transaction-notice"
    :class="`transaction-${transaction.status}`"
    aria-labelledby="transaction-title"
  >
    <div class="notice-heading">
      <span
        class="notice-icon"
        :class="{ spinning: transaction.status === 'pending' || transaction.status === 'sending' }"
        ><AppIcon
          :name="
            transaction.status === 'confirmed'
              ? 'check'
              : transaction.status === 'failed' || transaction.status === 'unconfirmed'
                ? 'clock'
                : 'refresh'
          "
      /></span>
      <h2 id="transaction-title">{{ labels[transaction.status] }}</h2>
      <button v-if="!transaction.busy" class="text-button" @click="transaction.reset">
        Dismiss
      </button>
    </div>
    <p
      :role="
        transaction.status === 'failed' || transaction.status === 'unconfirmed' ? 'alert' : 'status'
      "
    >
      {{ detail }}
    </p>
    <button
      v-if="transaction.status === 'unconfirmed'"
      class="button secondary"
      @click="transaction.checkConfirmation()"
    >
      Check confirmation
    </button>
    <RouterLink
      v-if="transaction.hash"
      class="address transaction-hash inline-link"
      :to="`/transactions/${transaction.hash}`"
      target="_blank"
      rel="noopener"
      >{{ transaction.hash }} · View receipt</RouterLink
    >
    <RouterLink v-if="transaction.roomId" class="inline-link" :to="`/rooms/${transaction.roomId}`"
      >Open room #{{ transaction.roomId }} <AppIcon name="arrow"
    /></RouterLink>
  </section>
</template>
