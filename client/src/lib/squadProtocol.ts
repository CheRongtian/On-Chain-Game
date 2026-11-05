import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  stringToHex,
  toEventSelector,
} from 'viem';
import type { AbiEvent, AbiParameter, Address, Hex } from 'viem';
import { squadArenaAbi } from '../generated/squadArena';

export class ProtocolError extends Error {}
export interface ProtocolContext {
  chainId: bigint;
  arena: Address;
  matchId: bigint;
}
export interface SquadAction {
  actionType: number;
  targetCell: number;
  targetUnit: number;
  pathLength: number;
  pathBits: number;
}
export interface SquadUnit {
  unitType: number;
  position: number;
  hp: number;
  alive: boolean;
  lockedRound: number;
}
export interface SquadState {
  mapId: number;
  battleStarted: boolean;
  completedRound: number;
  units: SquadUnit[];
  energy: number[];
  victoryPoints: number[];
  outcome: number;
  reason: number;
}
export interface SquadInput {
  context: ProtocolContext;
  player: Address;
  rulesetId: Hex;
  unitTypes: number[];
  salt: Hex;
}
export interface ActionInput extends SquadInput {
  round: number;
  side: number;
  alive: boolean[];
  lockedRound: number[];
  actions: SquadAction[];
}
export interface StateInput {
  context: ProtocolContext;
  rulesetId: Hex;
  state: SquadState;
}
export interface RulesDefinition {
  semanticsId: Hex;
  matchRules: number[];
  unitRules: number[][];
  skillRules: number[];
  windows: number[];
  schemas: number[];
  mapHashes: Hex[];
}

export const domainNames = [
  'OTA_RULESET_V2',
  'OTA_SQUAD_V2',
  'OTA_ACTION_V2',
  'OTA_STATE_V2',
] as const;
export const contextType = '(uint256 chainId,address arena,uint256 matchId)';
export const actionType =
  '(uint8 actionType,uint8 targetCell,uint8 targetUnit,uint8 pathLength,uint32 pathBits)';
export const unitType = '(uint8 unitType,uint8 position,uint8 hp,bool alive,uint16 lockedRound)';
export const stateType = `(uint8 mapId,bool battleStarted,uint16 completedRound,${unitType}[6] units,uint8[2] energy,uint8[2] victoryPoints,uint8 outcome,uint8 reason)`;
export const rulesType =
  '(bytes32 semanticsId,uint8[8] matchRules,uint8[5][5] unitRules,uint8[10] skillRules,uint32[5] windows,uint16[3] schemas,bytes32[3] mapHashes)';
const maxHp = [10, 6, 5, 7, 6];
const moveRange = [1, 2, 3, 2, 2];
const obstacles = [0x0000420000420000n, 0x0030002244000c00n, 0x0010004422000800n];
const integer = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;
function check(value: unknown, field: string): asserts value {
  if (!value) throw new ProtocolError(`Invalid ${field}`);
}
function encode(parameters: readonly AbiParameter[], values: readonly unknown[]): Hex {
  return encodeAbiParameters(parameters, values);
}
function checkContext(context: ProtocolContext) {
  check(
    typeof context.chainId === 'bigint' && context.chainId >= 0n && context.chainId < 1n << 256n,
    'chainId',
  );
  check(
    typeof context.matchId === 'bigint' && context.matchId >= 0n && context.matchId < 1n << 256n,
    'matchId',
  );
  check(/^0x[\da-fA-F]{40}$/.test(context.arena), 'Arena address');
}
export function protocolDomain(index: number): Hex {
  check(integer(index, 0, 3), 'domain');
  return keccak256(stringToHex(domainNames[index]));
}
export function validateSquad(types: number[]) {
  check(
    types.length === 3 && types.every((value) => integer(value, 1, 5)) && new Set(types).size === 3,
    'ordered squad',
  );
}
function checkCommitment(input: SquadInput) {
  checkContext(input.context);
  check(/^0x[\da-fA-F]{40}$/.test(input.player), 'player');
  check(/^0x[\da-fA-F]{64}$/.test(input.rulesetId), 'rulesetId');
  check(/^0x[\da-fA-F]{64}$/.test(input.salt), 'salt');
  validateSquad(input.unitTypes);
}
export function encodeRules(rules: RulesDefinition): Hex {
  return encode(parseAbiParameters(`bytes32,${rulesType}`), [protocolDomain(0), rules]);
}
export function encodeSquad(input: SquadInput): Hex {
  checkCommitment(input);
  return encode(parseAbiParameters(`bytes32,${contextType},address,bytes32,uint8[3],bytes32`), [
    protocolDomain(1),
    input.context,
    input.player,
    input.rulesetId,
    input.unitTypes,
    input.salt,
  ]);
}
export function encodeTurn(input: ActionInput): Hex {
  checkCommitment(input);
  check(integer(input.round, 1, 20) && integer(input.side, 0, 1), 'round or side');
  check(
    input.alive.length === 3 &&
      input.alive.every((value) => typeof value === 'boolean') &&
      input.lockedRound.length === 3 &&
      input.lockedRound.every((value) => integer(value, 0, 65535)) &&
      input.actions.length === 3,
    'action context',
  );
  for (const [slot, action] of input.actions.entries()) {
    const type = input.unitTypes[slot];
    check(
      integer(action.actionType, 0, 3) &&
        integer(action.targetCell, 0, 255) &&
        integer(action.targetUnit, 0, 255) &&
        integer(action.pathLength, 0, 4) &&
        integer(action.pathBits, 0, 0xffffffff),
      `action ${slot} fields`,
    );
    check(input.alive[slot] || action.actionType === 0, `dead slot ${slot}`);
    check(
      input.lockedRound[slot] !== input.round || action.actionType !== 3,
      `locked slot ${slot}`,
    );
    const skill = action.actionType === 3;
    const moves = action.actionType === 1 || (skill && type === 3);
    if (moves) {
      check(
        action.targetCell === 255 &&
          action.targetUnit === 255 &&
          action.pathLength >= 1 &&
          action.pathLength <= (skill ? 4 : moveRange[type - 1]),
        `movement ${slot}`,
      );
    } else {
      const cell = action.actionType === 2 || (skill && (type === 2 || type === 5));
      const target = skill && type === 4;
      check(
        action.pathLength === 0 &&
          (cell ? action.targetCell < 64 : action.targetCell === 255) &&
          (target ? action.targetUnit < 6 : action.targetUnit === 255),
        `targets ${slot}`,
      );
      if (target)
        check(
          Math.floor(action.targetUnit / 3) === input.side && input.alive[action.targetUnit % 3],
          `healing target ${slot}`,
        );
    }
    const bits = BigInt(action.pathBits);
    check(bits >> BigInt(action.pathLength * 6) === 0n, `unused path bits ${slot}`);
    const cells = Array.from({ length: action.pathLength }, (_, index) =>
      Number((bits >> BigInt(index * 6)) & 63n),
    );
    check(new Set(cells).size === cells.length, `repeated path ${slot}`);
    for (let i = 1; i < cells.length; i++)
      check(
        Math.abs((cells[i] % 8) - (cells[i - 1] % 8)) +
          Math.abs(Math.floor(cells[i] / 8) - Math.floor(cells[i - 1] / 8)) ===
          1,
        `path adjacency ${slot}`,
      );
  }
  return encode(
    parseAbiParameters(`bytes32,${contextType},uint16,address,bytes32,${actionType}[3],bytes32`),
    [
      protocolDomain(2),
      input.context,
      input.round,
      input.player,
      input.rulesetId,
      input.actions,
      input.salt,
    ],
  );
}
export function encodeState(input: StateInput): Hex {
  checkContext(input.context);
  const state = input.state;
  check(
    integer(state.mapId, 1, 3) &&
      typeof state.battleStarted === 'boolean' &&
      integer(state.completedRound, 0, 20),
    'state identity',
  );
  check(
    state.units.length === 6 &&
      state.energy.length === 2 &&
      state.victoryPoints.length === 2 &&
      state.energy.every((value) => integer(value, 0, 5)) &&
      state.victoryPoints.every((value) => integer(value, 0, 255)),
    'state arrays',
  );
  check(
    integer(state.outcome, 0, 3) &&
      integer(state.reason, 0, 8) &&
      (state.outcome === 0) === (state.reason === 0),
    'result',
  );
  if (!state.battleStarted) {
    check(
      state.completedRound === 0 &&
        (state.reason === 0 || state.reason >= 7) &&
        [...state.energy, ...state.victoryPoints].every((value) => value === 0),
      'pregame state',
    );
    check(
      state.units.every(
        (value) =>
          value.unitType === 0 &&
          value.position === 255 &&
          value.hp === 0 &&
          value.alive === false &&
          value.lockedRound === 0,
      ),
      'uninitialized units',
    );
  } else {
    check(
      state.reason <= 6 &&
        (state.completedRound < 20 || (state.outcome !== 0 && state.reason <= 4)) &&
        (state.reason < 1 || state.reason > 4 || state.completedRound > 0),
      'battle result round',
    );
    validateSquad(state.units.slice(0, 3).map((value) => value.unitType));
    validateSquad(state.units.slice(3).map((value) => value.unitType));
    const occupied = new Set<number>();
    for (const value of state.units) {
      check(
        integer(value.hp, 0, maxHp[value.unitType - 1]) &&
          typeof value.alive === 'boolean' &&
          value.alive === value.hp > 0 &&
          integer(value.lockedRound, 0, 65535),
        'unit fields',
      );
      if (value.alive) {
        check(
          integer(value.position, 0, 63) &&
            !occupied.has(value.position) &&
            (obstacles[state.mapId - 1] & (1n << BigInt(value.position))) === 0n,
          'live occupancy',
        );
        occupied.add(value.position);
        check(
          value.lockedRound === 0 ||
            (state.completedRound > 0 && value.lockedRound === state.completedRound + 1),
          'lock lifetime',
        );
      } else check(value.position === 255 && value.lockedRound === 0, 'canonical death');
    }
  }
  return encode(parseAbiParameters(`bytes32,${contextType},bytes32,${stateType}`), [
    protocolDomain(3),
    input.context,
    input.rulesetId,
    state,
  ]);
}
export function encodeProtocolEvent(
  name: string,
  args: Record<string, unknown>,
): { encoding: Hex; topics: Hex[] } {
  const found = squadArenaAbi.find((value) => value.type === 'event' && value.name === name);
  check(found?.type === 'event', 'event name');
  const event: AbiEvent = found;
  const indexed = event.inputs.filter((value) => value.indexed);
  const data = event.inputs.filter((value) => !value.indexed);
  return {
    topics: [
      toEventSelector(event),
      ...indexed.map((value) => encode([value], [args[value.name!]])),
    ],
    encoding: encode(
      data,
      data.map((value) => args[value.name!]),
    ),
  };
}
export function protocolSecretKey(
  deployment: Hex,
  context: ProtocolContext,
  player: Address,
  rulesetId: Hex,
  purpose: 'squad' | 'actions',
  round: number,
): string {
  checkContext(context);
  check(
    /^0x[\da-fA-F]{64}$/.test(deployment) &&
      /^0x[\da-fA-F]{64}$/.test(rulesetId) &&
      /^0x[\da-fA-F]{40}$/.test(player),
    'secret identity',
  );
  check(
    (purpose === 'squad' && round === 0) || (purpose === 'actions' && integer(round, 1, 20)),
    'secret purpose and round',
  );
  return [
    'arena-squad-secret',
    deployment.toLowerCase(),
    context.chainId.toString(),
    context.arena.toLowerCase(),
    context.matchId.toString(),
    player.toLowerCase(),
    rulesetId.toLowerCase(),
    purpose,
    round,
  ].join(':');
}
