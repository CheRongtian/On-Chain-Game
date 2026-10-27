<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Game, Scale, WEBGL } from 'phaser';
import {
  BattlefieldScene,
  BOARD_MARGIN,
  CANVAS_SIZE,
  TILE_SIZE,
} from '../battlefield/BattlefieldScene';
import type { BoardPalette } from '../battlefield/BattlefieldScene';
import { BattlefieldBridge } from '../battlefield/bridge';
import type { BattlefieldFrame } from '../battlefield/bridge';
import { cellLabel, cells, contains, unitNames } from '../lib/battle';

const props = defineProps<{ frame: BattlefieldFrame }>();
const emit = defineEmits<{ choose: [cell: number] }>();
const host = ref<HTMLDivElement>();
const grid = ref<HTMLDivElement>();
const ready = ref(false);
const error = ref('');
const active = ref(0);
const bounds = ref({ left: 0, top: 0, size: 0 });
const bridge = new BattlefieldBridge();
const stopInput = bridge.onCell((cell) => {
  active.value = cell;
  emit('choose', cell);
});
let game: Game | undefined;
let observer: ResizeObserver | undefined;

watch(
  () => props.frame,
  (frame) => bridge.publish(frame),
  { immediate: true },
);
function alignKeyboard() {
  if (!host.value || !game?.canvas) return;
  const canvas = game.canvas.getBoundingClientRect();
  const parent = host.value.getBoundingClientRect();
  bounds.value = {
    left: canvas.left - parent.left + (canvas.width * BOARD_MARGIN) / CANVAS_SIZE,
    top: canvas.top - parent.top + (canvas.height * BOARD_MARGIN) / CANVAS_SIZE,
    size: (canvas.width * TILE_SIZE * 8) / CANVAS_SIZE,
  };
}
function fit() {
  if (!game || !ready.value) return;
  game.scale.getParentBounds();
  game.scale.refresh();
}
onMounted(() => {
  if (!host.value) return;
  const css = getComputedStyle(host.value);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const palette: BoardPalette = {
    background: token('--surface-input'),
    tile: token('--board-tile'),
    alternate: token('--board-alternate'),
    wall: token('--line'),
    line: token('--control-border'),
    text: token('--text'),
    muted: token('--text-muted'),
    playerA: token('--success'),
    playerB: token('--amber'),
    preview: token('--draft'),
    legal: token('--board-legal'),
  };
  try {
    game = new Game({
      type: WEBGL,
      parent: host.value,
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      backgroundColor: palette.background,
      banner: false,
      audio: { noAudio: true },
      scale: { mode: Scale.FIT, autoCenter: Scale.CENTER_BOTH },
      input: { touch: { capture: false } },
      callbacks: { postBoot: (instance) => instance.canvas.setAttribute('aria-hidden', 'true') },
      scene: new BattlefieldScene(bridge, palette, () => {
        ready.value = true;
        void nextTick(fit);
      }),
    });
    game.scale.on('resize', alignKeyboard);
    observer = new ResizeObserver(fit);
    observer.observe(host.value);
  } catch {
    error.value = 'The board requires WebGL. Enable hardware acceleration and reload.';
  }
});
onBeforeUnmount(() => {
  observer?.disconnect();
  stopInput();
  game?.scale.off('resize', alignKeyboard);
  game?.destroy(true);
});
function focusCell(cell: number) {
  active.value = cell;
  grid.value
    ?.querySelector<HTMLButtonElement>(`[data-cell="${cell}"]`)
    ?.focus({ preventScroll: true });
}
function focusUnit(unitId?: number) {
  const unit = unitId === undefined ? undefined : props.frame.state.units[unitId];
  focusCell(
    unit && unit.hp > 0 && unitId !== undefined ? props.frame.unitCells[unitId] : active.value,
  );
}
defineExpose({ focusUnit });
function describe(cell: number) {
  const frame = props.frame;
  const terrain = contains(frame.map.obstacles, cell)
    ? 'Wall'
    : contains(frame.map.resources, cell)
      ? 'Energy resource'
      : contains(frame.map.controlZone, cell)
        ? 'Control zone'
        : 'Open tile';
  const descriptions = frame.state.units.flatMap((unit, unitId) => {
    if (!unit.hp) return [];
    const label = `Player ${unitId < 3 ? 'A' : 'B'} ${unitNames[unit.unitType]}`;
    if (frame.unitCells[unitId] === cell)
      return [
        `${label}, ${unit.hp} HP${cell !== unit.cell ? `, draft position; start ${cellLabel(unit.cell)}` : ''}.`,
      ];
    return unit.cell === cell
      ? [`${label} starting tile; drafted to ${cellLabel(frame.unitCells[unitId])}.`]
      : [];
  });
  return `${cellLabel(cell)}. ${terrain}. ${descriptions.join(' ')}${descriptions.length > 1 ? ' Select again to inspect the next unit.' : ''}${frame.legalCells.includes(cell) ? ' Available target.' : ''}`;
}
function navigate(event: KeyboardEvent, cell: number) {
  let destination = cell;
  switch (event.key) {
    case 'ArrowLeft':
      if (cell % 8 > 0) destination--;
      break;
    case 'ArrowRight':
      if (cell % 8 < 7) destination++;
      break;
    case 'ArrowUp':
      if (cell >= 8) destination -= 8;
      break;
    case 'ArrowDown':
      if (cell < 56) destination += 8;
      break;
    case 'Home':
      destination = event.ctrlKey ? 0 : cell - (cell % 8);
      break;
    case 'End':
      destination = event.ctrlKey ? 63 : cell - (cell % 8) + 7;
      break;
    default:
      return;
  }
  event.preventDefault();
  focusCell(destination);
}
</script>

<template>
  <div class="renderer">
    <div ref="host" class="canvas-host"></div>
    <p id="board-instructions" class="sr-only">
      Arrow keys navigate tiles. Enter or Space chooses a tile.
    </p>
    <div
      v-if="ready && bounds.size > 0"
      ref="grid"
      class="keyboard-grid"
      role="group"
      aria-label="Battlefield tiles"
      aria-describedby="board-instructions"
      :style="{
        left: `${bounds.left}px`,
        top: `${bounds.top}px`,
        width: `${bounds.size}px`,
        height: `${bounds.size}px`,
      }"
    >
      <button
        v-for="cell in cells"
        :key="cell"
        :data-cell="cell"
        :tabindex="active === cell ? 0 : -1"
        :aria-label="describe(cell)"
        @focus="active = cell"
        @keydown="navigate($event, cell)"
        @click="bridge.selectCell(cell)"
      ></button>
    </div>
    <p v-if="error || !ready" class="renderer-status" :role="error ? 'alert' : 'status'">
      {{ error || 'Preparing board…' }}
    </p>
  </div>
</template>

<style scoped>
.renderer {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.canvas-host {
  position: absolute;
  inset: 0;
}
.canvas-host :deep(canvas) {
  display: block;
}
.keyboard-grid {
  position: absolute;
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  grid-template-rows: repeat(8, 1fr);
  pointer-events: none;
}
.keyboard-grid button {
  padding: 0;
  min-width: 0;
  border: 0;
  background: transparent;
  pointer-events: none;
}
.keyboard-grid button:focus-visible {
  outline: 3px solid var(--focus);
  outline-offset: -3px;
}
.renderer-status {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  padding: 16px;
  margin: 0;
  text-align: center;
  background: var(--surface-input);
  color: var(--text-muted);
}
</style>
