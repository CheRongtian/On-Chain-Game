import type { BattleMap, BattleRules, BattleState } from '../lib/arena';
import type { DraftBundle } from '../lib/battle';

export interface BattlefieldFrame {
  readonly state: BattleState;
  readonly map: BattleMap;
  readonly rules: BattleRules;
  readonly drafts: DraftBundle;
  readonly unitCells: readonly number[];
  readonly playerIndex?: number;
  readonly selectedUnit: number;
  readonly legalCells: readonly number[];
}

// Each mounted board owns its bridge; no events cross tabs or room instances.
export class BattlefieldBridge {
  private frame?: BattlefieldFrame;
  private frameListeners = new Set<(frame: BattlefieldFrame) => void>();
  private cellListeners = new Set<(cell: number) => void>();

  publish(frame: BattlefieldFrame) {
    this.frame = frame;
    for (const listener of this.frameListeners) listener(frame);
  }
  onFrame(listener: (frame: BattlefieldFrame) => void) {
    this.frameListeners.add(listener);
    if (this.frame) listener(this.frame);
    return () => {
      this.frameListeners.delete(listener);
    };
  }
  selectCell(cell: number) {
    for (const listener of this.cellListeners) listener(cell);
  }
  onCell(listener: (cell: number) => void) {
    this.cellListeners.add(listener);
    return () => {
      this.cellListeners.delete(listener);
    };
  }
}
