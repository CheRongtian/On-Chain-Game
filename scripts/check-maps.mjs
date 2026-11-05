import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readJson, saveJson } from "./deployment.mjs";

const root = new URL("../", import.meta.url);
const require = createRequire(new URL("client/package.json", root));
const symbols = {
  obstacles: "#",
  cover: "C",
  resources: "R",
  controlZone: "O",
  spawnA: "A",
  spawnB: "B",
};
const parameters = [
  { name: "mapId", type: "uint8" },
  { name: "width", type: "uint8" },
  { name: "height", type: "uint8" },
  { name: "obstacles", type: "uint64" },
  { name: "cover", type: "uint64" },
  { name: "resources", type: "uint64" },
  { name: "controlZone", type: "uint64" },
  { name: "spawnsA", type: "uint8[3]" },
  { name: "spawnsB", type: "uint8[3]" },
];
const sorted = (cells) => [...cells].sort((a, b) => a - b);
const layers = (map) => ({
  obstacles: map.obstacles,
  cover: map.cover,
  resources: map.resources,
  controlZone: map.controlZone,
  spawnA: map.spawns.A,
  spawnB: map.spawns.B,
});
let encodeAbiParameters, keccak256;

function bitmap(cells) {
  return (
    "0x" +
    cells
      .reduce((mask, cell) => mask | (1n << BigInt(cell)), 0n)
      .toString(16)
      .padStart(16, "0")
  );
}

function bitmapCells(value) {
  assert.match(
    value,
    /^0x[0-9a-f]{16}$/,
    "A bitmap must encode exactly 64 bits.",
  );
  const mask = BigInt(value);
  return Array.from({ length: 64 }, (_, cell) => cell).filter(
    (cell) => (mask & (1n << BigInt(cell))) !== 0n,
  );
}

function ascii(mapLayers) {
  const cells = Array(64).fill(".");
  for (const [name, occupied] of Object.entries(mapLayers))
    for (const cell of occupied) cells[cell] = symbols[name];
  return Array.from({ length: 8 }, (_, row) =>
    cells.slice(row * 8, row * 8 + 8).join(""),
  );
}

function asciiCells(rows) {
  assert.equal(rows.length, 8, "ASCII row count");
  const result = Object.fromEntries(
    Object.keys(symbols).map((name) => [name, []]),
  );
  for (const [y, row] of rows.entries()) {
    assert.match(row, /^[.#CROAB]{8}$/, `ASCII row ${y}`);
    for (const [x, symbol] of [...row].entries()) {
      const name = Object.keys(symbols).find((key) => symbols[key] === symbol);
      if (name) result[name].push(y * 8 + x);
    }
  }
  return result;
}

function contentHash(map) {
  const masks = Object.fromEntries(
    Object.entries(layers(map)).map(([name, cells]) => [
      name,
      BigInt(bitmap(cells)),
    ]),
  );
  return keccak256(
    encodeAbiParameters(parameters, [
      map.mapId,
      map.width,
      map.height,
      masks.obstacles,
      masks.cover,
      masks.resources,
      masks.controlZone,
      map.spawns.A,
      map.spawns.B,
    ]),
  );
}

function distancesFrom(spawn, obstacles) {
  const blocked = new Set(obstacles),
    queue = [spawn],
    distances = new Map([[spawn, 0]]);
  for (let index = 0; index < queue.length; index++) {
    const cell = queue[index];
    for (const next of [cell - 8, cell + 8, cell - 1, cell + 1]) {
      const adjacent =
        Math.abs((next % 8) - (cell % 8)) +
          Math.abs(Math.floor(next / 8) - Math.floor(cell / 8)) ===
        1;
      if (
        next < 0 ||
        next >= 64 ||
        !adjacent ||
        blocked.has(next) ||
        distances.has(next)
      )
        continue;
      distances.set(next, distances.get(cell) + 1);
      queue.push(next);
    }
  }
  return distances;
}

function reachability(map) {
  const objectives = [...map.resources, ...map.controlZone],
    paths = [];
  for (const player of ["A", "B"])
    for (const [slot, spawn] of map.spawns[player].entries()) {
      const distances = distancesFrom(spawn, map.obstacles);
      for (const target of objectives)
        assert.ok(
          distances.has(target),
          `${player} slot ${slot}, spawn ${spawn}: objective ${target} is unreachable.`,
        );
      paths.push({
        player,
        slot,
        spawn,
        distances: Object.fromEntries(
          objectives.map((target) => [target, distances.get(target)]),
        ),
      });
    }
  return { reachablePairs: paths.length * objectives.length, paths };
}

function checkMap(map) {
  try {
    assert.equal(map.width, 8, "Map width");
    assert.equal(map.height, 8, "Map height");
    assert.deepEqual(map.spawns.A, [8, 24, 40], "Ordered A birth slots");
    assert.deepEqual(
      map.spawns.B,
      map.spawns.A.map((cell) => 63 - cell),
      "Ordered mirrored B birth slots",
    );
    assert.deepEqual(sorted(map.resources), [18, 45], "Resource cells");
    assert.deepEqual(
      sorted(map.controlZone),
      [27, 28, 35, 36],
      "Central control cells",
    );
    const mapLayers = layers(map),
      occupied = new Map();
    assert.deepEqual(
      Object.keys(map.bitmaps).sort(),
      Object.keys(symbols).sort(),
      "Bitmap layers",
    );
    for (const [name, cells] of Object.entries(mapLayers)) {
      assert.equal(
        new Set(cells).size,
        cells.length,
        `${name}: duplicate cells`,
      );
      for (const cell of cells) {
        assert.ok(
          Number.isInteger(cell) && cell >= 0 && cell < 64,
          `${name}: cell ${cell} is outside the board.`,
        );
        assert.ok(
          !occupied.has(cell),
          `${name}: cell ${cell} overlaps ${occupied.get(cell)}.`,
        );
        occupied.set(cell, name);
      }
      if (!name.startsWith("spawn"))
        assert.deepEqual(
          sorted(cells.map((cell) => 63 - cell)),
          sorted(cells),
          `${name}: 180-degree symmetry`,
        );
      assert.equal(
        map.bitmaps[name],
        bitmap(cells),
        `${name}: cell-to-bitmap conversion`,
      );
      assert.deepEqual(
        bitmapCells(map.bitmaps[name]),
        sorted(cells),
        `${name}: bitmap-to-cell conversion`,
      );
    }
    assert.deepEqual(ascii(mapLayers), map.ascii, "Cell-to-ASCII conversion");
    const parsed = asciiCells(map.ascii);
    for (const name of Object.keys(symbols))
      assert.deepEqual(
        sorted(parsed[name]),
        sorted(mapLayers[name]),
        `${name}: ASCII-to-cell conversion`,
      );
    assert.deepEqual(ascii(parsed), map.ascii, "ASCII round trip");
    const mapHash = contentHash(map);
    assert.equal(mapHash, map.mapHash, "Frozen mapHash");
    const reachable = reachability(map);
    return {
      name: map.name,
      mapId: map.mapId,
      mapHash,
      bitmaps: map.bitmaps,
      obstacles: map.obstacles.length,
      cover: map.cover.length,
      ...reachable,
    };
  } catch (error) {
    error.message = `${map.name}: ${error.message}`;
    throw error;
  }
}

const report = {
  status: "running",
  scope: "map geometry and content identity; gameplay balance is unmeasured",
  maps: [],
  startedAt: new Date().toISOString(),
};
try {
  ({ encodeAbiParameters, keccak256 } = require("viem"));
  const catalogue = await readJson(
    fileURLToPath(new URL("config/maps.json", root)),
  );
  assert.deepEqual(
    catalogue.hashEncoding,
    { algorithm: "keccak256", encoding: "abi.encode", fields: parameters },
    "Frozen map hash encoding",
  );
  assert.deepEqual(
    catalogue.selection,
    {
      selectedBy: "host",
      visibility: "public-before-join",
      fixedFrom: "room-creation",
      practice: "same-three-maps",
    },
    "Frozen map selection policy",
  );
  assert.deepEqual(
    catalogue.maps.map((map) => [map.mapId, map.name]),
    [
      [1, "Arena"],
      [2, "Ruins"],
      [3, "Crossroads"],
    ],
    "Released map identities",
  );
  for (const map of catalogue.maps) {
    const result = checkMap(map);
    report.maps.push(result);
    console.log(
      `PASS: map geometry ${map.name}: ASCII/bitmaps, symmetry, birth slots, ${result.reachablePairs} reachable pairs and mapHash.`,
    );
  }
  const alteredAscii = structuredClone(catalogue.maps[0]);
  alteredAscii.ascii[0] = "#.......";
  assert.throws(
    () => checkMap(alteredAscii),
    assert.AssertionError,
    "Altered source ASCII must fail.",
  );
  const reversedSlots = structuredClone(catalogue.maps[0]);
  reversedSlots.spawns.B.reverse();
  assert.throws(
    () => checkMap(reversedSlots),
    assert.AssertionError,
    "Reversed birth slots must fail.",
  );
  const isolated = {
    ...catalogue.maps[0],
    obstacles: [1, 9, 17, 25, 33, 41, 49, 57],
  };
  assert.throws(
    () => reachability(isolated),
    assert.AssertionError,
    "An unreachable objective must fail.",
  );
  const alteredHash = { ...catalogue.maps[0], mapHash: "0x" + "00".repeat(32) };
  assert.throws(
    () => checkMap(alteredHash),
    assert.AssertionError,
    "An altered map identity must fail.",
  );
  report.selfChecks = [
    "altered-ASCII",
    "reversed-slots",
    "unreachable-objective",
    "altered-mapHash",
  ];
  report.status = "passed";
  report.reachablePairs = report.maps.reduce(
    (total, map) => total + map.reachablePairs,
    0,
  );
  console.log(
    `PASS: three-map geometry and content identity: ${report.reachablePairs} reachable pairs; four negative self-checks passed.`,
  );
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  console.error(`FAIL: map geometry: ${error.message}`);
  if (error.code === "ERR_ASSERTION") {
    console.error(`Expected: ${JSON.stringify(error.expected)}`);
    console.error(`Actual: ${JSON.stringify(error.actual)}`);
  }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await saveJson(
    fileURLToPath(new URL(".local/design/maps.json", root)),
    report,
  );
}
