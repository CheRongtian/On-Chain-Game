import type { ContractFunctionArgs } from 'viem';
import type { arenaAbi } from '../generated/arena';
import type { BattleMap, BattleRules, BattleState } from './arena';

export enum ActionKind {
  Hold,
  Move,
  Attack,
  Shield,
  PowerShot,
  Dash,
}

export interface ActionDraft {
  readonly kind: ActionKind;
  readonly path: readonly number[];
  readonly target?: number;
}
export type DraftBundle = readonly [ActionDraft, ActionDraft, ActionDraft];
export type ActionBundle = ContractFunctionArgs<typeof arenaAbi, 'nonpayable', 'revealActions'>[2];
export type UnitState = BattleState['units'][number];

export const unitNames = ['None', 'Guardian', 'Ranger', 'Scout'] as const;
export const unitCodes = ['—', 'G', 'R', 'S'] as const;
export const actionNames = ['Hold', 'Move', 'Attack', 'Shield', 'Power shot', 'Dash'] as const;
export const cells = Array.from({ length: 64 }, (_, cell) => cell);

export function hold(): ActionDraft {
  return { kind: ActionKind.Hold, path: [] };
}
export function emptyDrafts(): DraftBundle {
  return [hold(), hold(), hold()];
}
export function cellLabel(cell: number): string {
  return cell >= 0 && cell < 64
    ? `${String.fromCharCode(65 + (cell % 8))}${Math.floor(cell / 8) + 1}`
    : '—';
}
export function contains(bitmap: bigint, cell: number): boolean {
  return cell >= 0 && cell < 64 && (bitmap & (1n << BigInt(cell))) !== 0n;
}
export function isMovement(kind: ActionKind): boolean {
  return kind === ActionKind.Move || kind === ActionKind.Dash;
}
export function isAttack(kind: ActionKind): boolean {
  return kind === ActionKind.Attack || kind === ActionKind.PowerShot;
}
export function availableActions(unit: UnitState): readonly ActionKind[] {
  if (unit.hp === 0) return [ActionKind.Hold];
  const skills = [ActionKind.Shield, ActionKind.PowerShot, ActionKind.Dash] as const;
  return [ActionKind.Hold, ActionKind.Move, ActionKind.Attack, skills[unit.unitType - 1]];
}
export function actionCost(draft: ActionDraft, unit: UnitState, rules: BattleRules): number {
  return draft.kind >= ActionKind.Shield ? rules.skillCost[unit.unitType - 1] : 0;
}

function adjacent(from: number, to: number): boolean {
  return (
    Math.abs((from % 8) - (to % 8)) + Math.abs(Math.floor(from / 8) - Math.floor(to / 8)) === 1
  );
}

export function actionIssue(
  draft: ActionDraft,
  unitId: number,
  state: BattleState,
  map: BattleMap,
  rules: BattleRules,
): string {
  const unit = state.units[unitId];
  if (!availableActions(unit).includes(draft.kind))
    return unit.hp === 0 ? 'Defeated units must Hold.' : 'This skill belongs to a different unit.';
  if (isMovement(draft.kind)) {
    const limit =
      draft.kind === ActionKind.Dash ? rules.dashRange : rules.moveRange[unit.unitType - 1];
    if (!draft.path.length) return 'Choose at least one path tile.';
    if (draft.path.length > limit || draft.path.length > 4)
      return `This action allows at most ${limit} steps.`;
    let previous = unit.cell;
    const visited = new Set([unit.cell]);
    for (const cell of draft.path) {
      if (cell < 0 || cell >= 64) return 'The path must stay on the board.';
      if (visited.has(cell)) return 'A path cannot revisit a tile, including its starting tile.';
      if (!adjacent(previous, cell)) return 'Choose an orthogonally adjacent tile for each step.';
      if (contains(map.obstacles, cell)) return `${cellLabel(cell)} is blocked by a wall.`;
      if (state.units.some((other) => other.hp > 0 && other.cell === cell))
        return `${cellLabel(cell)} is occupied at round start, even if that unit plans to move.`;
      visited.add(cell);
      previous = cell;
    }
  }
  if (isAttack(draft.kind)) {
    const target = draft.target;
    if (target === undefined) return 'Choose a target tile.';
    if (target < 0 || target >= 64) return 'The target must stay on the board.';
    if (unit.unitType !== 2)
      return adjacent(unit.cell, target) ? '' : 'Choose an orthogonally adjacent target tile.';
    if (target === unit.cell) return 'A Ranger cannot target its own starting tile.';
    const sameRow = Math.floor(unit.cell / 8) === Math.floor(target / 8);
    if (!sameRow && unit.cell % 8 !== target % 8)
      return 'A Ranger fires along a straight row or column.';
    const distance = Math.abs(target - unit.cell) / (sameRow ? 1 : 8);
    if (distance > rules.attackRange[unit.unitType - 1])
      return `The target must be within ${rules.attackRange[unit.unitType - 1]} tiles of the starting tile.`;
    const stride = (sameRow ? 1 : 8) * Math.sign(target - unit.cell);
    for (let cell = unit.cell + stride; ; cell += stride) {
      if (contains(map.obstacles, cell))
        return 'A wall blocks this shot, including a wall at the target.';
      if (cell === target) break;
    }
  }
  return '';
}

export function legalCells(
  draft: ActionDraft,
  unitId: number,
  state: BattleState,
  map: BattleMap,
  rules: BattleRules,
): readonly number[] {
  if (isMovement(draft.kind))
    return [...movementPaths(draft.kind, unitId, state, map, rules).keys()];
  if (!isAttack(draft.kind)) return [];
  return cells.filter(
    (cell) => !actionIssue({ ...draft, target: cell }, unitId, state, map, rules),
  );
}

// Breadth-first search supplies one shortest legal path per destination for planning only.
export function movementPaths(
  kind: ActionKind,
  unitId: number,
  state: BattleState,
  map: BattleMap,
  rules: BattleRules,
): ReadonlyMap<number, readonly number[]> {
  const paths = new Map<number, readonly number[]>();
  const queue = [{ cell: state.units[unitId].cell, path: [] as readonly number[] }];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    for (const cell of [current.cell - 8, current.cell + 1, current.cell + 8, current.cell - 1]) {
      if (paths.has(cell)) continue;
      const path = [...current.path, cell];
      if (actionIssue({ kind, path }, unitId, state, map, rules)) continue;
      paths.set(cell, path);
      queue.push({ cell, path });
    }
  }
  return paths;
}

export function encodeActions(drafts: DraftBundle): ActionBundle {
  const encode = (draft: ActionDraft): ActionBundle[number] => ({
    kind: draft.kind,
    targetCell: isAttack(draft.kind) ? (draft.target ?? 255) : 255,
    pathLength: isMovement(draft.kind) ? draft.path.length : 0,
    path: isMovement(draft.kind)
      ? [draft.path[0] ?? 0, draft.path[1] ?? 0, draft.path[2] ?? 0, draft.path[3] ?? 0]
      : [0, 0, 0, 0],
  });
  return [encode(drafts[0]), encode(drafts[1]), encode(drafts[2])];
}

export function draftLabel(draft: ActionDraft): string {
  if (isMovement(draft.kind))
    return `${actionNames[draft.kind]} · ${draft.path.length ? draft.path.map(cellLabel).join(' → ') : 'Choose path'}`;
  if (isAttack(draft.kind))
    return `${actionNames[draft.kind]} · ${draft.target === undefined ? 'Choose target' : cellLabel(draft.target)}`;
  return actionNames[draft.kind];
}

export function actionHelp(kind: ActionKind, unit: UnitState, rules: BattleRules): string {
  const index = unit.unitType - 1;
  switch (kind) {
    case ActionKind.Hold:
      return unit.hp === 0
        ? 'This slot remains in the squad and must Hold.'
        : 'Stay in place without attacking or spending Energy.';
    case ActionKind.Move:
    case ActionKind.Dash:
      return `Choose a highlighted destination, inspect its path of up to ${kind === ActionKind.Dash ? rules.dashRange : rules.moveRange[index]} steps, then confirm.`;
    case ActionKind.Attack:
    case ActionKind.PowerShot:
      return `Target a tile from the confirmed starting position. ${unit.unitType === 2 ? `Straight range 1–${rules.attackRange[index]}; walls block shots, units do not.` : 'Orthogonally adjacent range.'} Empty and friendly tiles are valid targets. Damage: ${kind === ActionKind.PowerShot ? rules.powerShotDamage : rules.attackDamage[index]}.`;
    case ActionKind.Shield:
      return `Reduce this Guardian's total incoming damage by up to ${rules.shieldReduction} this round.`;
  }
}
