import type { Address } from 'viem';
import type { BattleMap, BattleRules, BattleState, RoundResolution } from './arena';
import type { ActionBundle } from './battle';
import { actionNames, cellLabel } from './battle';

export const replaySpeeds = [0.5, 1, 2, 4] as const;

export interface HistorySource {
  block: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
}
export interface HistoryMeta {
  chainId: number;
  arena: string;
  deploymentHash: string;
  indexedBlock: number;
  indexedHash: string;
  observedBlock: number;
  lag: number;
  requiredDescendants: number;
  ready: boolean;
  blocked: boolean;
  error?: string;
}
export interface Confirmation {
  status: 'unknown' | 'observed' | 'provisional' | 'confirmed';
  confirmations: number;
  requiredDescendants: number;
}
export interface HistoricalMatch {
  id: string;
  players: readonly [Address, Address];
  phase: number;
  round: number;
  outcome: number;
  reason: number;
  stateHash: string;
  source: HistorySource;
}
export interface Verification {
  status: 'Verified' | 'Mismatch' | 'Incomplete';
  message: string;
  complete: boolean;
  canonical: boolean;
  prefixVerified: boolean;
  verifiedRounds: number;
  throughBlock: number;
  throughHash: string;
  checkedAt: string;
  difference?: { round: number; field: string; expected: unknown; actual: unknown };
}
export interface ReplayRound {
  round: number;
  reveals: readonly ({ actions: ActionBundle; salt: string; source: HistorySource } | null)[];
}
export interface ReplayFrame {
  index: number;
  kind: 'MatchStarted' | 'RoundResolved' | 'MatchFinished';
  round: number;
  state: BattleState;
  stateHash: string;
  computedHash: string;
  summary?: {
    energySpent: readonly number[];
    moved: readonly boolean[];
    damageTaken: readonly number[];
    energyGained: readonly number[];
    victoryPointsGained: readonly number[];
  };
  source: HistorySource;
}
export interface MatchPage {
  meta: HistoryMeta;
  items: { match: HistoricalMatch; confirmation: Confirmation }[];
  hasMore: boolean;
}
export interface ReplayData {
  meta: HistoryMeta;
  match: HistoricalMatch;
  verification: Verification;
  confirmation: Confirmation;
  items: ReplayFrame[];
  rounds: ReplayRound[];
  map: BattleMap;
  rules: BattleRules;
}
export class HistoryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function historyRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(35_000);
  const response = await fetch(`/api${path}`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    cache: 'no-store',
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => undefined);
    throw new HistoryError(
      failure?.message || 'The history service is unavailable. Try again shortly.',
      response.status,
    );
  }
  return response.json() as Promise<T>;
}
export function deploymentKey(meta: HistoryMeta) {
  return `${meta.chainId}:${meta.arena.toLowerCase()}:${meta.deploymentHash}`;
}
export async function readReplay(id: string, signal: AbortSignal): Promise<ReplayData> {
  type WireMap = Omit<BattleMap, 'obstacles' | 'resources' | 'controlZone'> & {
    obstacles: string;
    resources: string;
    controlZone: string;
  };
  const data = await historyRequest<Omit<ReplayData, 'map'> & { map: WireMap; hasMore: boolean }>(
    `/matches/${id}/replay?limit=100`,
    signal,
  );
  if (data.hasMore) throw new Error('Replay history exceeds the supported match length.');
  return {
    ...data,
    map: {
      ...data.map,
      obstacles: BigInt(data.map.obstacles),
      resources: BigInt(data.map.resources),
      controlZone: BigInt(data.map.controlZone),
    },
  };
}
export function frameLabel(frame: ReplayFrame | undefined) {
  if (!frame) return 'No battle frames';
  if (frame.kind === 'MatchStarted') return 'Initial state';
  return frame.kind === 'MatchFinished'
    ? `Round ${frame.round} · Timeout`
    : `Round ${frame.round} · Settled`;
}
export function publicOrderLabel(action: ActionBundle[number] | undefined) {
  if (!action) return 'Not revealed';
  const name = actionNames[action.kind];
  if (action.kind === 1 || action.kind === 5)
    return `${name} · ${action.path.slice(0, action.pathLength).map(cellLabel).join(' → ')}`;
  if (action.kind === 2 || action.kind === 4) return `${name} · ${cellLabel(action.targetCell)}`;
  return name;
}
export function replayResolution(data: ReplayData, from: number, to: number): RoundResolution {
  const frame = data.items[to]!;
  const orders = data.rounds.find((round) => round.round === frame.round);
  return {
    blockNumber: BigInt(frame.source.block),
    round: frame.round,
    before: data.items[from]!.state,
    after: frame.state,
    paths: frame.state.units.map((_, slot) => {
      const action = orders?.reveals[Math.floor(slot / 3)]?.actions[slot % 3];
      return frame.summary?.moved[slot] && action && (action.kind === 1 || action.kind === 5)
        ? action.path.slice(0, action.pathLength)
        : [];
    }),
  };
}
