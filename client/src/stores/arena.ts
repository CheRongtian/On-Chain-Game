import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { Address } from 'viem';
import { readConnection } from '../lib/arena';
import type { Connection } from '../lib/arena';
import { errorMessage } from '../lib/errors';

export const useArenaStore = defineStore('arena', () => {
  const connection = shallowRef<Connection>();
  const address = ref<Address>();
  const refreshing = ref(false);
  const error = ref('');
  const online = computed(() => !!connection.value);
  const epoch = computed(() => connection.value?.deployment.deployedAt ?? 'offline');
  const selected = computed(() =>
    connection.value?.accounts.find((account) => account.address === address.value),
  );

  function selectAccount(value: string) {
    const account = connection.value?.accounts.find((entry) => entry.address === value);
    if (!account) return;
    address.value = account.address;
    sessionStorage.setItem('arena-account', account.address);
  }

  async function refresh() {
    if (refreshing.value) return;
    refreshing.value = true;
    try {
      const next = await readConnection();
      connection.value = next;
      if (!next.accounts.some((account) => account.address === address.value)) {
        const saved = sessionStorage.getItem('arena-account');
        selectAccount(
          next.accounts.find((account) => account.address === saved)?.address ??
            next.accounts[0]?.address ??
            '',
        );
      }
      error.value = '';
    } catch (cause) {
      connection.value = undefined;
      error.value = errorMessage(cause);
    } finally {
      refreshing.value = false;
    }
  }

  return {
    connection,
    address,
    refreshing,
    error,
    online,
    epoch,
    selected,
    selectAccount,
    refresh,
  };
});
