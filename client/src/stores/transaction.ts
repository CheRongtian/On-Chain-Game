import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { Hash } from 'viem';
import type { ActionBundle } from '../lib/battle';
import { arenaAbi } from '../generated/arena';
import { accountClient, createdRoomId, publicClient, readRoom } from '../lib/arena';
import { errorMessage } from '../lib/errors';
import { useArenaStore } from './arena';

type Command =
  | { action: 'create' }
  | { action: 'join' }
  | { action: 'start' }
  | { action: 'commit'; round: number; commitment: Hash }
  | { action: 'reveal'; round: number; actions: ActionBundle; salt: Hash }
  | { action: 'settle'; round: number }
  | { action: 'timeout'; round: number; phase: 2 | 3 };
type Operation = Command['action'];
const confirmations: Record<Operation, string> = {
  create: 'Room created. Invite your opponent.',
  join: 'Joined. Waiting for the host to click Start game.',
  start: 'Your start transaction is confirmed.',
  commit: 'Orders confirmed. Waiting for your opponent.',
  reveal: 'Orders accepted. Finishing the round.',
  settle: 'Round complete.',
  timeout: 'Timeout finalized on the chain.',
};
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

  async function send(command: Command, matchId?: bigint): Promise<bigint | undefined> {
    const action = command.action;
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
    roomId.value = matchId?.toString();
    status.value = 'sending';
    try {
      const reader = publicClient(deployment);
      const writer = accountClient(deployment, account);
      const contract = { abi: arenaAbi, address: deployment.arenaAddress, account } as const;
      let submitted: Hash;
      if (command.action === 'create') {
        const { request } = await reader.simulateContract({
          ...contract,
          functionName: 'createMatch',
          args: [1],
        });
        if (!current()) return;
        submitted = await writer.writeContract(request);
      } else if (command.action === 'join') {
        const { request } = await reader.simulateContract({
          ...contract,
          functionName: 'joinMatch',
          args: [matchId!],
        });
        if (!current()) return;
        submitted = await writer.writeContract(request);
      } else if (command.action === 'start') {
        const { request } = await reader.simulateContract({
          ...contract,
          functionName: 'startMatch',
          args: [matchId!],
        });
        if (!current()) return;
        submitted = await writer.writeContract(request);
      } else if (command.action === 'commit') {
        const { request } = await reader.simulateContract({
          ...contract,
          functionName: 'commitActions',
          args: [matchId!, command.round, command.commitment],
        });
        if (!current()) return;
        submitted = await writer.writeContract(request);
      } else if (command.action === 'reveal') {
        const { request } = await reader.simulateContract({
          ...contract,
          functionName: 'revealActions',
          args: [matchId!, command.round, command.actions, command.salt],
        });
        if (!current()) return;
        submitted = await writer.writeContract(request);
      } else if (command.action === 'settle') {
        const { request } = await reader.simulateContract({
          ...contract,
          functionName: 'settleRound',
          args: [matchId!, command.round],
        });
        if (!current()) return;
        submitted = await writer.writeContract(request);
      } else {
        const { request } = await reader.simulateContract({
          ...contract,
          functionName: 'advanceExpiredPhase',
          args: [matchId!, command.round, command.phase],
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
      message.value = confirmations[action];
      status.value = 'confirmed';
      void arena.refresh();
      return id;
    } catch (cause) {
      if (
        current() &&
        matchId !== undefined &&
        (command.action === 'settle' || command.action === 'timeout')
      ) {
        try {
          const room = await readRoom(deployment, matchId);
          const expectedPhase = command.action === 'settle' ? 4 : command.phase;
          if (current() && (room.round !== command.round || room.phase !== expectedPhase)) {
            hash.value = undefined;
            message.value = 'The room advanced on chain. Showing the latest state.';
            status.value = 'confirmed';
            void arena.refresh();
            return matchId;
          }
        } catch {
          // Keep the original transaction failure when the chain cannot be read.
        }
      }
      if (current()) {
        status.value = 'failed';
        message.value = errorMessage(cause);
      }
    }
  }

  function createRoom() {
    return send({ action: 'create' });
  }
  function joinRoom(matchId: bigint) {
    return send({ action: 'join' }, matchId);
  }
  function startGame(matchId: bigint) {
    return send({ action: 'start' }, matchId);
  }
  function commitOrders(matchId: bigint, round: number, commitment: Hash) {
    return send({ action: 'commit', round, commitment }, matchId);
  }
  function revealOrders(matchId: bigint, round: number, actions: ActionBundle, salt: Hash) {
    return send({ action: 'reveal', round, actions, salt }, matchId);
  }
  function settleRound(matchId: bigint, round: number) {
    return send({ action: 'settle', round }, matchId);
  }
  function finalizeTimeout(matchId: bigint, round: number, phase: 2 | 3) {
    return send({ action: 'timeout', round, phase }, matchId);
  }

  return {
    status,
    operation,
    hash,
    roomId,
    message,
    busy,
    reset,
    createRoom,
    joinRoom,
    startGame,
    commitOrders,
    revealOrders,
    settleRound,
    finalizeTimeout,
  };
});
