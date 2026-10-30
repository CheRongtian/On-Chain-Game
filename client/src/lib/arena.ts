import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  parseEventLogs,
} from 'viem';
import type { Address, ContractFunctionReturnType, TransactionReceipt } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { arenaAbi } from '../generated/arena';

// Public Anvil development seed, shared with scripts/local-chain.sh.
const localWallets = [0, 1].map((addressIndex) =>
  mnemonicToAccount('test test test test test test test test test test test junk', {
    addressIndex,
  }),
);

export const localChain = defineChain({
  id: 31337,
  name: 'Local Arena',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:18545'] } },
  testnet: true,
});

export interface Deployment {
  chainId: number;
  rpcUrl: string;
  arenaAddress: Address;
  deploymentBlock: string;
  deployedAt: string;
}

export interface LocalAccount {
  address: Address;
  balance: bigint;
}
export interface Connection {
  deployment: Deployment;
  accounts: LocalAccount[];
  blockNumber: bigint;
  timestamp: bigint;
}
export type Room = ContractFunctionReturnType<typeof arenaAbi, 'view', 'getMatch'>;
export type BattleState = ContractFunctionReturnType<typeof arenaAbi, 'view', 'getBattleState'>;
export type BattleMap = ContractFunctionReturnType<typeof arenaAbi, 'pure', 'getMap'>;
export type BattleRules = ContractFunctionReturnType<typeof arenaAbi, 'pure', 'getRules'>;
export type RoundStatus = ContractFunctionReturnType<typeof arenaAbi, 'view', 'getRoundStatus'>;
export interface RoundResolution {
  blockNumber: bigint;
  round: number;
  before: BattleState;
  after: BattleState;
  paths: readonly (readonly number[])[];
}

export class HistoricalStateUnavailable extends Error {}

export interface BattleSnapshot {
  room: Room;
  blockNumber: bigint;
  blockHash: string;
  timestamp: bigint;
  roundStatus?: RoundStatus;
  settlementAccount?: Address;
  battlefield?: {
    state: BattleState;
    map: BattleMap;
    rules: BattleRules;
  };
}

export function publicClient(deployment: Deployment) {
  return createPublicClient({
    chain: localChain,
    pollingInterval: 1_000,
    transport: http(deployment.rpcUrl, { retryCount: 0, timeout: 8_000 }),
  });
}

export function accountClient(deployment: Deployment, address: Address) {
  const account = localWallets.find((wallet) => wallet.address === address);
  if (!account) throw new Error('Select an available local test wallet.');
  return createWalletClient({
    account,
    chain: localChain,
    transport: http(deployment.rpcUrl, { retryCount: 0, timeout: 8_000 }),
  });
}

export async function readConnection(): Promise<Connection> {
  const response = await fetch('/deployment.json', { cache: 'no-store' });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Start the backend and wait for the local Arena to be ready.');
  }
  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== 'object' ||
    !('chainId' in data) ||
    data.chainId !== localChain.id ||
    !('rpcUrl' in data) ||
    typeof data.rpcUrl !== 'string' ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(data.rpcUrl) ||
    !('arenaAddress' in data) ||
    typeof data.arenaAddress !== 'string' ||
    !isAddress(data.arenaAddress) ||
    !('deploymentBlock' in data) ||
    typeof data.deploymentBlock !== 'string' ||
    !/^\d+$/.test(data.deploymentBlock) ||
    !('deployedAt' in data) ||
    typeof data.deployedAt !== 'string'
  ) {
    throw new Error('Local deployment information is unavailable. Restart the backend.');
  }
  const deployment = data as Deployment;
  const client = publicClient(deployment);
  const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock()]);
  if (chainId !== localChain.id)
    throw new Error('The RPC is serving a different chain. Restart the local backend.');
  const accounts = await Promise.all(
    localWallets.map(async ({ address }) => ({
      address,
      balance: await client.getBalance({ address }),
    })),
  );
  return { deployment, accounts, blockNumber: block.number, timestamp: block.timestamp };
}

export function readRoom(deployment: Deployment, matchId: bigint) {
  return publicClient(deployment).readContract({
    address: deployment.arenaAddress,
    abi: arenaAbi,
    functionName: 'getMatch',
    args: [matchId],
  });
}

export async function requireHostStart(deployment: Deployment, matchId: bigint, room: Room) {
  const client = publicClient(deployment);
  const starts = await client.getContractEvents({
    address: deployment.arenaAddress,
    abi: arenaAbi,
    eventName: 'MatchStarted',
    args: { matchId },
    fromBlock: BigInt(deployment.deploymentBlock),
    toBlock: 'latest',
  });
  const hash = starts[0]?.transactionHash;
  if (!hash) throw new Error('The host start has not been confirmed. Refresh this room.');
  const transaction = await client.getTransaction({ hash });
  if (transaction.from.toLowerCase() !== room.players[0].toLowerCase()) {
    throw new Error(
      'This local Arena still starts games when a player joins. Restart the backend to deploy the host-controlled room flow.',
    );
  }
}

export async function readBattleSnapshot(
  deployment: Deployment,
  matchId: bigint,
): Promise<BattleSnapshot> {
  const client = publicClient(deployment);
  const block = await client.getBlock();
  // Pin all getters to one block so a settlement cannot mix two rounds in one view.
  const request = {
    address: deployment.arenaAddress,
    abi: arenaAbi,
    blockNumber: block.number,
  } as const;
  const room = await client.readContract({
    ...request,
    functionName: 'getMatch',
    args: [matchId],
  });
  const snapshot: BattleSnapshot = {
    room,
    blockNumber: block.number,
    blockHash: block.hash,
    timestamp: block.timestamp,
  };
  if (room.round === 0) return snapshot;
  const [state, map, rules, roundStatus] = await Promise.all([
    client.readContract({ ...request, functionName: 'getBattleState', args: [matchId] }),
    client.readContract({ ...request, functionName: 'getMap', args: [room.mapId] }),
    client.readContract({ ...request, functionName: 'getRules' }),
    client.readContract({ ...request, functionName: 'getRoundStatus', args: [matchId] }),
  ]);
  const reveals =
    room.phase === 4
      ? await client.getContractEvents({
          address: deployment.arenaAddress,
          abi: arenaAbi,
          eventName: 'ActionRevealed',
          args: { matchId, round: room.round },
          fromBlock: BigInt(deployment.deploymentBlock),
          toBlock: block.number,
          strict: true,
        })
      : [];
  return {
    ...snapshot,
    roundStatus,
    battlefield: { state, map, rules },
    settlementAccount: reveals[reveals.length - 1]?.args.player,
  };
}

// Called only by the manual timeout action, never by refresh or startup.
export async function advanceLocalClock(deployment: Deployment, latestTimestamp: bigint) {
  const timestamp = BigInt(Math.floor(Date.now() / 1_000));
  if (timestamp <= latestTimestamp) return;
  const client = createTestClient({
    mode: 'anvil',
    chain: localChain,
    transport: http(deployment.rpcUrl, { retryCount: 0, timeout: 8_000 }),
  });
  await client.setNextBlockTimestamp({ timestamp });
  await client.mine({ blocks: 1 });
}

export async function readResolutions(
  deployment: Deployment,
  matchId: bigint,
  fromBlock: bigint,
  toBlock: bigint,
  players: Room['players'],
): Promise<RoundResolution[]> {
  if (fromBlock > toBlock) return [];
  const client = publicClient(deployment);
  const events = await client.getContractEvents({
    address: deployment.arenaAddress,
    abi: arenaAbi,
    eventName: 'RoundResolved',
    args: { matchId },
    fromBlock,
    toBlock,
    strict: true,
  });
  return Promise.all(
    events.map(async (event) => {
      const request = {
        address: deployment.arenaAddress,
        abi: arenaAbi,
        functionName: 'getBattleState',
        args: [matchId],
      } as const;
      const stateAt = (blockNumber: bigint) =>
        client.readContract({ ...request, blockNumber }).catch((error: unknown) => {
          if (error instanceof Error && error.message.includes('Required data unavailable'))
            throw new HistoricalStateUnavailable('The retained historical state has expired.');
          throw error;
        });
      const [before, after, reveals] = await Promise.all([
        stateAt(event.blockNumber - 1n),
        stateAt(event.blockNumber),
        client.getContractEvents({
          address: deployment.arenaAddress,
          abi: arenaAbi,
          eventName: 'ActionRevealed',
          args: { matchId, round: event.args.round },
          fromBlock: BigInt(deployment.deploymentBlock),
          toBlock: event.blockNumber,
          strict: true,
        }),
      ]);
      const paths = players.flatMap((player) => {
        const orders = reveals.find(
          (reveal) => reveal.args.player.toLowerCase() === player.toLowerCase(),
        )?.args.actions;
        return [0, 1, 2].map((slot) =>
          orders ? orders[slot].path.slice(0, orders[slot].pathLength) : [],
        );
      });
      return { blockNumber: event.blockNumber, round: event.args.round, before, after, paths };
    }),
  );
}

export function createdRoomId(deployment: Deployment, receipt: TransactionReceipt): bigint {
  const events = parseEventLogs({
    abi: arenaAbi,
    eventName: 'MatchCreated',
    logs: receipt.logs.filter(
      (log) => log.address.toLowerCase() === deployment.arenaAddress.toLowerCase(),
    ),
  });
  const id = events[0]?.args.matchId;
  if (id === undefined)
    throw new Error('No room was created by this transaction. Refresh before retrying.');
  return id;
}
