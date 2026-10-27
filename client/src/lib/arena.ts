import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  parseEventLogs,
} from 'viem';
import type { Address, ContractFunctionReturnType, TransactionReceipt } from 'viem';
import { arenaAbi } from '../generated/arena';

export const localChain = defineChain({
  id: 31337,
  name: 'Local Arena',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
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
export type BattleMap = ContractFunctionReturnType<typeof arenaAbi, 'view', 'getMap'>;
export type BattleRules = ContractFunctionReturnType<typeof arenaAbi, 'view', 'getRules'>;

export interface BattleSnapshot {
  room: Room;
  blockNumber: bigint;
  timestamp: bigint;
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

export function accountClient(deployment: Deployment, account: Address) {
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
    data.rpcUrl !== localChain.rpcUrls.default.http[0] ||
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
  const node = createWalletClient({
    chain: localChain,
    transport: http(deployment.rpcUrl, { retryCount: 0, timeout: 8_000 }),
  });
  const [chainId, block, addresses] = await Promise.all([
    client.getChainId(),
    client.getBlock(),
    node.getAddresses(),
  ]);
  if (chainId !== localChain.id)
    throw new Error('The RPC is serving a different chain. Restart the local backend.');
  const accounts = await Promise.all(
    addresses.map(async (address) => ({ address, balance: await client.getBalance({ address }) })),
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
  const snapshot: BattleSnapshot = { room, blockNumber: block.number, timestamp: block.timestamp };
  if (room.round === 0) return snapshot;
  const [state, map, rules] = await Promise.all([
    client.readContract({ ...request, functionName: 'getBattleState', args: [matchId] }),
    client.readContract({ ...request, functionName: 'getMap', args: [room.mapId] }),
    client.readContract({ ...request, functionName: 'getRules' }),
  ]);
  return { ...snapshot, battlefield: { state, map, rules } };
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
