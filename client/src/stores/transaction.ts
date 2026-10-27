import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { Hash } from 'viem';
import { arenaAbi } from '../generated/arena';
import { accountClient, createdRoomId, publicClient } from '../lib/arena';
import { errorMessage } from '../lib/errors';
import { useArenaStore } from './arena';

type Operation = 'create' | 'join' | 'start';
type Status = 'idle' | 'sending' | 'pending' | 'confirmed' | 'failed';

export const useTransactionStore = defineStore('transaction', () => {
  const status = ref<Status>('idle');
  const operation = ref<Operation>();
  const hash = ref<Hash>();
  const roomId = ref<string>();
  const message = ref('');
  const busy = computed(() => status.value === 'sending' || status.value === 'pending');
  let generation = 0;

  function reset() {
    generation++;
    status.value = 'idle';
    operation.value = undefined;
    hash.value = undefined;
    roomId.value = undefined;
    message.value = '';
  }

  async function send(action: Operation, matchId?: bigint): Promise<bigint | undefined> {
    if (busy.value || (action !== 'create' && matchId === undefined)) return;
    const arena = useArenaStore();
    const deployment = arena.connection?.deployment;
    const account = arena.selected?.address;
    if (!deployment || !account) return;
    reset();
    const token = generation;
    const epoch = arena.epoch;
    const current = () =>
      generation === token && arena.epoch === epoch && arena.address === account;
    operation.value = action;
    status.value = 'sending';
    try {
      const reader = publicClient(deployment);
      const writer = accountClient(deployment, account);
      const contract = { abi: arenaAbi, address: deployment.arenaAddress, account } as const;
      let submitted: Hash;
      if (action === 'create') {
        const { request } = await reader.simulateContract({
          ...contract,
          functionName: 'createMatch',
          args: [1],
        });
        if (!current()) return;
        submitted = await writer.writeContract(request);
      } else if (action === 'join') {
        const { request } = await reader.simulateContract({
          ...contract,
          functionName: 'joinMatch',
          args: [matchId!],
        });
        if (!current()) return;
        submitted = await writer.writeContract(request);
      } else {
        const { request } = await reader.simulateContract({
          ...contract,
          functionName: 'startMatch',
          args: [matchId!],
        });
        if (!current()) return;
        submitted = await writer.writeContract(request);
      }
      if (!current()) return;
      hash.value = submitted;
      status.value = 'pending';
      const receipt = await reader.waitForTransactionReceipt({
        hash: submitted,
        confirmations: 1,
        timeout: 120_000,
        onReplaced: ({ transaction }) => {
          if (current()) hash.value = transaction.hash;
        },
      });
      if (!current()) return;
      if (receipt.status !== 'success')
        throw new Error('The transaction reverted. Refresh the room before retrying.');
      const id = action === 'create' ? createdRoomId(deployment, receipt) : matchId!;
      hash.value = receipt.transactionHash;
      roomId.value = id.toString();
      message.value =
        action === 'create'
          ? 'Room created. Invite your opponent.'
          : action === 'join'
            ? 'Joined. Waiting for the host to click Start game.'
            : 'Your start transaction is confirmed.';
      status.value = 'confirmed';
      void arena.refresh();
      return id;
    } catch (cause) {
      if (current()) {
        status.value = 'failed';
        message.value = errorMessage(cause);
      }
    }
  }

  function createRoom() {
    return send('create');
  }
  function joinRoom(matchId: bigint) {
    return send('join', matchId);
  }
  function startGame(matchId: bigint) {
    return send('start', matchId);
  }

  return { status, operation, hash, roomId, message, busy, reset, createRoom, joinRoom, startGame };
});
