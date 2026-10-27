import { Scene } from 'phaser';
import type { GameObjects, Input } from 'phaser';
import { ActionKind, contains, isAttack, isMovement, unitCodes } from '../lib/battle';
import type { BattlefieldBridge, BattlefieldFrame } from './bridge';

export const TILE_SIZE = 64;
export const BOARD_MARGIN = 32;
export const CANVAS_SIZE = BOARD_MARGIN * 2 + TILE_SIZE * 8;
export interface BoardPalette {
  background: string;
  tile: string;
  alternate: string;
  wall: string;
  line: string;
  text: string;
  muted: string;
  playerA: string;
  playerB: string;
  preview: string;
  legal: string;
}
const hex = (value: string) => Number.parseInt(value.slice(1), 16);
const position = (cell: number) => ({
  x: BOARD_MARGIN + ((cell % 8) + 0.5) * TILE_SIZE,
  y: BOARD_MARGIN + (Math.floor(cell / 8) + 0.5) * TILE_SIZE,
});

export class BattlefieldScene extends Scene {
  private ink!: GameObjects.Graphics;
  private labels: GameObjects.Text[] = [];
  constructor(
    private bridge: BattlefieldBridge,
    private colors: BoardPalette,
    private onReady: () => void,
  ) {
    super('Battlefield');
  }
  create() {
    this.ink = this.add.graphics();
    const release = this.bridge.onFrame((frame) => this.paint(frame));
    const choose = (pointer: Input.Pointer) => {
      if (pointer.getDistance() > 10) return;
      const x = Math.floor((pointer.x - BOARD_MARGIN) / TILE_SIZE);
      const y = Math.floor((pointer.y - BOARD_MARGIN) / TILE_SIZE);
      if (x >= 0 && x < 8 && y >= 0 && y < 8) this.bridge.selectCell(y * 8 + x);
    };
    this.input.on('pointerup', choose);
    this.events.once('shutdown', () => {
      release();
      this.input.off('pointerup', choose);
    });
    this.events.once('destroy', release);
    this.onReady();
  }
  private label(x: number, y: number, value: string, size = 14, tint = this.colors.text) {
    this.labels.push(
      this.add
        .text(x, y, value, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: `${size}px`,
          fontStyle: 'bold',
          color: tint,
        })
        .setOrigin(0.5),
    );
  }
  private paint(frame: BattlefieldFrame) {
    this.ink.clear();
    for (const label of this.labels) label.destroy();
    this.labels = [];
    this.terrain(frame);
    this.orders(frame);
    this.units(frame);
  }
  private terrain(frame: BattlefieldFrame) {
    const g = this.ink;
    const c = this.colors;
    for (let index = 0; index < 8; index++) {
      this.label(
        BOARD_MARGIN + (index + 0.5) * TILE_SIZE,
        16,
        String.fromCharCode(65 + index),
        13,
        c.muted,
      );
      this.label(16, BOARD_MARGIN + (index + 0.5) * TILE_SIZE, String(index + 1), 13, c.muted);
    }
    for (let cell = 0; cell < 64; cell++) {
      const { x, y } = position(cell);
      g.fillStyle(hex(((cell % 8) + Math.floor(cell / 8)) % 2 ? c.alternate : c.tile));
      g.fillRect(x - 31, y - 31, 62, 62);
      if (contains(frame.map.obstacles, cell)) {
        g.fillStyle(hex(c.wall));
        g.fillRoundedRect(x - 25, y - 25, 50, 50, 5);
        g.lineStyle(2, hex(c.muted), 0.6);
        for (const offset of [-12, 0, 12]) g.lineBetween(x - 16, y + offset, x + 16, y + offset);
      }
      if (contains(frame.map.resources, cell)) {
        g.lineStyle(2, hex(c.playerA));
        g.strokeTriangle(x - 24, y - 14, x - 18, y - 24, x - 12, y - 14);
        this.label(x + 18, y + 22, '+E', 10, c.playerA);
      }
      if (contains(frame.map.controlZone, cell)) {
        g.lineStyle(1, hex(c.playerB), 0.8);
        g.strokeRect(x - 26, y - 26, 52, 52);
        this.label(x + 19, y - 20, 'C', 10, c.playerB);
      }
      if (frame.legalCells.includes(cell)) {
        g.lineStyle(2, hex(c.legal));
        g.strokeRect(x - 29, y - 29, 58, 58);
        g.fillStyle(hex(c.legal));
        g.fillCircle(x, y, 4);
      }
    }
  }
  private dash(from: number, to: number) {
    const a = position(from),
      b = position(to);
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    this.ink.lineStyle(3, hex(this.colors.preview));
    for (let offset = 0; offset < length; offset += 16) {
      const end = Math.min(offset + 9, length);
      this.ink.lineBetween(
        a.x + ((b.x - a.x) * offset) / length,
        a.y + ((b.y - a.y) * offset) / length,
        a.x + ((b.x - a.x) * end) / length,
        a.y + ((b.y - a.y) * end) / length,
      );
    }
  }
  private orders(frame: BattlefieldFrame) {
    if (frame.playerIndex === undefined) return;
    const player = frame.playerIndex;
    frame.drafts.forEach((draft, slot) => {
      const unitId = player * 3 + slot;
      const unit = frame.state.units[unitId];
      if (!unit.hp) return;
      const g = this.ink;
      const tint = hex(this.colors.preview);
      if (isMovement(draft.kind) && draft.path.length) {
        let previous = unit.cell;
        draft.path.forEach((cell, step) => {
          this.dash(previous, cell);
          const { x, y } = position(cell);
          if (!frame.unitCells.includes(cell)) {
            g.lineStyle(1, tint);
            g.strokeCircle(x, y, 11);
            this.label(x, y, String(step + 1), 12, this.colors.preview);
          }
          previous = cell;
        });
        if (frame.unitCells[unitId] !== previous) {
          const end = position(previous);
          g.lineStyle(2, tint);
          g.strokeRoundedRect(end.x - 24, end.y - 25, 48, 50, 6);
          this.label(
            end.x,
            end.y + 21,
            `${unitCodes[unit.unitType]} PLAN`,
            10,
            this.colors.preview,
          );
        }
      } else if (isAttack(draft.kind) && draft.target !== undefined) {
        this.dash(unit.cell, draft.target);
        const { x, y } = position(draft.target);
        g.lineStyle(2, tint);
        g.strokeCircle(x, y, 25);
        g.lineBetween(x - 29, y, x - 17, y);
        g.lineBetween(x + 17, y, x + 29, y);
        g.lineBetween(x, y - 29, x, y - 17);
        g.lineBetween(x, y + 17, x, y + 29);
      } else if (draft.kind === ActionKind.Shield) {
        const { x, y } = position(unit.cell);
        g.lineStyle(2, tint);
        g.strokeCircle(x, y, 29);
      }
    });
  }
  private units(frame: BattlefieldFrame) {
    frame.state.units.forEach((unit, unitId) => {
      if (!unit.hp) return;
      const c = this.colors;
      const team = unitId < 3 ? c.playerA : c.playerB;
      const g = this.ink;
      const cell = frame.unitCells[unitId];
      const moved = cell !== unit.cell;
      const point = position(cell);
      const tint = moved ? c.preview : team;
      if (moved) {
        const start = position(unit.cell);
        g.lineStyle(1, hex(team), 0.35);
        g.strokeRoundedRect(start.x - 20, start.y - 20, 40, 40, 5);
        this.label(start.x, start.y, `${unitCodes[unit.unitType]} START`, 10, c.muted);
      }
      const stack = frame.state.units
        .map((entry, id) => ({ entry, id }))
        .filter(({ entry, id }) => entry.hp > 0 && frame.unitCells[id] === cell);
      const crowded = stack.length > 1;
      const x =
        point.x +
        (crowded ? (stack.findIndex(({ id }) => id === unitId) - (stack.length - 1) / 2) * 19 : 0);
      const y = point.y;
      const width = crowded ? 18 : 44;
      const height = crowded ? 34 : 44;
      g.fillStyle(hex(c.background), moved ? 0.8 : 1);
      g.fillRoundedRect(x - width / 2, y - height / 2, width, height, 4);
      g.lineStyle(2, hex(tint));
      g.strokeRoundedRect(x - width / 2, y - height / 2, width, height, 4);
      this.label(
        x,
        y - 7,
        crowded
          ? unitCodes[unit.unitType]
          : `${unitId < 3 ? 'A' : 'B'}·${unitCodes[unit.unitType]}`,
        crowded ? 12 : 16,
        tint,
      );
      this.label(
        x,
        y + 9,
        crowded ? String(unit.hp) : `${unit.hp}/${frame.rules.maxHp[unit.unitType - 1]}`,
        crowded ? 10 : 12,
      );
      if (!crowded) {
        g.fillStyle(hex(c.line));
        g.fillRect(x - 15, y + 16, 30, 3);
        g.fillStyle(hex(tint));
        g.fillRect(x - 15, y + 16, (30 * unit.hp) / frame.rules.maxHp[unit.unitType - 1], 3);
      }
      if (moved && stack[0].id === unitId) {
        this.label(point.x, y + 27, crowded ? `DRAFT ×${stack.length}` : 'DRAFT', 9, c.preview);
      }
      if (unitId === frame.selectedUnit) {
        g.lineStyle(3, hex(c.text));
        g.strokeRoundedRect(x - width / 2 - 3, y - height / 2 - 3, width + 6, height + 6, 6);
      }
    });
  }
}
