import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Hash } from 'viem';
import type { ActionBundle } from '../lib/battle';
import { arenaAbi } from '../generated/arena';
import { accountClient, createdRoomId, publicClient, readRoom } from '../lib/arena';
import type { Deployment } from '../lib/arena';
import { errorDetail, errorMessage } from '../lib/errors';
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
type Status = 'idle' | 'sending' | 'pending' | 'unconfirmed' | 'confirmed' | 'failed';
interface PendingTransaction {
  hash: Hash;
  operation: Operation;
  roomId?: string;
  reorganized?: true;
}

function pendingKey(deployment: Deployment, account: string) {
  return `arena-pending:${JSON.stringify([deployment.deployedAt, deployment.chainId, deployment.arenaAddress.toLowerCase(), account.toLowerCase()])}`;
}

export const useTransactionStore = defineStore('transaction', () => {
  const status = ref<Status>('idle');
  const operation = ref<Operation>();
  const hash = ref<Hash>();
  const roomId = ref<string>();
  const message = ref('');
  const diagnostic = ref('');
  const recoveryWarning = ref('');
  const busy = computed(() => ['sending', 'pending', 'unconfirmed'].includes(status.value));
  let generation = 0;
  let checkReceipt: ((wait: boolean) => Promise<bigint | undefined>) | undefined;

  function reset() {
    generation++;
    status.value = 'idle';
    operation.value = undefined;
    hash.value = undefined;
    roomId.value = undefined;
    message.value = '';
    diagnostic.value = '';
    recoveryWarning.value = '';
    checkReceipt = undefined;
  }

  function followReceipt(deployment: Deployment, account: string, pending: PendingTransaction) {
    const arena = useArenaStore();
    const token = generation;
    const key = pendingKey(deployment, account);
    const current = () =>
      generation === token && arena.epoch === deployment.deployedAt && arena.address === account;
    const reader = publicClient(deployment);
    function remember() {
      try {
        // Only public transaction metadata belongs here; orders and Salt stay in IndexedDB.
        sessionStorage.setItem(key, JSON.stringify(pending));
      } catch {
        recoveryWarning.value =
          'Transaction recovery cannot be saved in this tab. Keep it open and retain the transaction hash before refreshing.';
      }
    }
    function forget() {
      sessionStorage.removeItem(key);
    }
    hash.value = pending.hash;
    operation.value = pending.operation;
    roomId.value = pending.roomId;
    remember();
    checkReceipt = async (wait) => {
      if (!current() || status.value === 'pending') return;
      status.value = 'pending';
      message.value = '';
      try {
        if ((await reader.getChainId()) !== deployment.chainId)
          throw new Error(
            'The RPC is serving a different chain. Restore the correct local backend before checking this transaction.',
          );
        // Block polling can hide persistence errors from the first receipt read.
        const receipt = await reader
          .getTransactionReceipt({ hash: pending.hash })
          .catch((cause: unknown) => {
            if (!wait || !(cause instanceof TransactionReceiptNotFoundError)) throw cause;
            return reader.waitForTransactionReceipt({
              hash: pending.hash,
              confirmations: 1,
              timeout: 120_000,
              onReplaced: ({ transaction }) => {
                if (!current()) return;
                pending.hash = transaction.hash;
                hash.value = transaction.hash;
                remember();
              },
            });
          });
        if (!current()) return;
        if (receipt.status !== 'success') {
          try {
            forget();
          } catch {
            /* Retain the hash when browser storage is unavailable. */
          }
          checkReceipt = undefined;
          status.value = 'failed';
          message.value = 'The transaction reverted. Refresh the room before retrying.';
          diagnostic.value = message.value;
          return;
        }
        const id =
          pending.operation === 'create'
            ? createdRoomId(deployment, receipt)
            : BigInt(pending.roomId!);
        try {
          forget();
        } catch {
          /* A later check can safely read the same receipt again. */
        }
        checkReceipt = undefined;
        hash.value = receipt.transactionHash;
        roomId.value = id.toString();
        message.value = confirmations[pending.operation];
        diagnostic.value = '';
        recoveryWarning.value = '';
        status.value = 'confirmed';
        void arena.refresh();
        return id;
      } catch (cause) {
        if (!current()) return;
        if (pending.reorganized && cause instanceof TransactionReceiptNotFoundError) {
          try {
            await reader.getTransaction({ hash: pending.hash });
          } catch (lookup) {
            if (!current()) return;
            if (lookup instanceof TransactionNotFoundError) {
              try {
                forget();
              } catch {
                /* Keep recovery possible if storage is temporarily unavailable. */
              }
              checkReceipt = undefined;
              status.value = 'failed';
              message.value =
                'This transaction was removed by the reorganization and is no longer pending. Your saved orders are retained; review the current phase before retrying.';
              diagnostic.value = '';
              return;
            }
          }
        }
        if (!current()) return;
        status.value = 'unconfirmed';
        diagnostic.value = errorDetail(cause);
        message.value = `Transaction submitted. ${errorMessage(cause)} Check confirmation queries the original transaction without sending another one.`;
      }
    };
  }

  function restore() {
    reset();
    const arena = useArenaStore();
    const deployment = arena.connection?.deployment;
    const account = arena.address;
    if (!deployment || !account) return;
    try {
      const saved = sessionStorage.getItem(pendingKey(deployment, account));
      if (!saved) return;
      const pending = JSON.parse(saved) as PendingTransaction;
      if (
        !/^0x[0-9a-f]{64}$/i.test(pending.hash) ||
        !Object.hasOwn(confirmations, pending.operation) ||
        (pending.operation !== 'create' && !/^[1-9][0-9]*$/.test(pending.roomId ?? ''))
      )
        throw new Error(
          'The saved transaction record is unreadable. Keep its original hash and check its receipt before submitting again.',
        );
      followReceipt(deployment, account, pending);
      status.value = 'unconfirmed';
      message.value =
        'A submitted transaction was restored. Check its confirmation before sending another transaction.';
      void checkReceipt!(false);
    } catch (cause) {
      status.value = 'unconfirmed';
      message.value = errorMessage(cause);
      recoveryWarning.value =
        'Transaction recovery storage is unavailable. Restore browser storage access and reload before continuing.';
    }
  }

  function markReorganized() {
    if (hash.value) {
      generation++;
      status.value = 'unconfirmed';
      message.value =
        'The chain reorganized. Check the original transaction on the current branch before continuing.';
      const arena = useArenaStore();
      if (arena.connection && arena.address && operation.value)
        followReceipt(arena.connection.deployment, arena.address, {
          hash: hash.value,
          operation: operation.value,
          roomId: roomId.value,
          reorganized: true,
        });
    } else reset();
  }

  async function send(command: Command, matchId?: bigint): Promise<bigint | undefined> {
    const action = command.action;
    if (busy.value || (action !== 'create' && matchId === undefined)) return;
    const arena = useArenaStore();
    const deployment = arena.connection?.deployment;
    const account = arena.selected?.address;
    if (!arena.online || !deployment || !account) return;
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
      if ((await reader.getChainId()) !== deployment.chainId)
        throw new Error(
          'The RPC is serving a different chain. Restore the correct local backend before submitting.',
        );
      if (!current()) return;
      const writer = accountClient(deployment, account);
      const contract = {
        abi: arenaAbi,
        address: deployment.arenaAddress,
        account: writer.account,
      } as const;
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
      followReceipt(deployment, account, {
        hash: submitted,
        operation: action,
        roomId: matchId?.toString(),
      });
      return await checkReceipt!(true);
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
        diagnostic.value = errorDetail(cause);
      }
    }
  }

  function checkConfirmation() {
    if (status.value === 'unconfirmed') return checkReceipt?.(false);
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
    diagnostic,
    recoveryWarning,
    busy,
    reset,
    restore,
    markReorganized,
    checkConfirmation,
    createRoom,
    joinRoom,
    startGame,
    commitOrders,
    revealOrders,
    settleRound,
    finalizeTimeout,
  };
});
