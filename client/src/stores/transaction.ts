import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { Hash } from 'viem';
import { arenaAbi } from '../generated/arena';
import { accountClient, createdRoomId, publicClient } from '../lib/arena';
import { errorMessage } from '../lib/errors';
import { useArenaStore } from './arena';

type Status = 'idle' | 'sending' | 'pending' | 'confirmed' | 'failed';

export const useTransactionStore = defineStore('transaction', () => {
  const status = ref<Status>('idle');
  const hash = ref<Hash>();
  const roomId = ref<string>();
  const message = ref('');
  const busy = computed(() => status.value === 'sending' || status.value === 'pending');
  let sequence = 0;

  function reset() {
    sequence++;
    status.value = 'idle';
    hash.value = undefined;
    roomId.value = undefined;
    message.value = '';
  }

  async function submit(kind: 'create' | 'join', target?: bigint): Promise<bigint | undefined> {
    if (busy.value) return;
    const arena = useArenaStore();
    const deployment = arena.connection?.deployment;
    const account = arena.selected?.address;
    if (!deployment || !account || (kind === 'join' && target === undefined)) return;
    reset();
    const current = sequence;
    const epoch = arena.epoch;
    const active = () => current === sequence && arena.epoch === epoch && arena.address === account;
    status.value = 'sending';
    try {
      const client = publicClient(deployment);
      const sender = accountClient(deployment, account);
      const contract = { abi: arenaAbi, address: deployment.arenaAddress, account } as const;
      let submitted: Hash;
      if (kind === 'create') {
        const { request } = await client.simulateContract({
          ...contract,
          functionName: 'createMatch',
          args: [1],
        });
        if (!active()) return;
        submitted = await sender.writeContract(request);
      } else {
        const { request } = await client.simulateContract({
          ...contract,
          functionName: 'joinMatch',
          args: [target!],
        });
        if (!active()) return;
        submitted = await sender.writeContract(request);
      }
      if (!active()) return;
      hash.value = submitted;
      status.value = 'pending';
      const receipt = await client.waitForTransactionReceipt({
        hash: submitted,
        confirmations: 1,
        timeout: 120_000,
        onReplaced: ({ transaction }) => {
          if (active()) hash.value = transaction.hash;
        },
      });
      if (!active()) return;
      if (receipt.status !== 'success')
        throw new Error('The transaction reverted. Refresh the room before retrying.');
      const id = kind === 'create' ? createdRoomId(deployment, receipt) : target!;
      hash.value = receipt.transactionHash;
      roomId.value = id.toString();
      message.value =
        kind === 'create'
          ? 'Room created. Share its ID or open another tab with a different account.'
          : 'Room joined. Both players are now registered on the chain.';
      status.value = 'confirmed';
      void arena.refresh();
      return id;
    } catch (cause) {
      if (active()) {
        status.value = 'failed';
        message.value = errorMessage(cause);
      }
    }
  }

  return { status, hash, roomId, message, busy, reset, submit };
});
