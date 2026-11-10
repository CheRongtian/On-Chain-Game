export const browserEngines = ["chromium", "firefox", "webkit"];

// Required evidence for the existing backend test entry and its release report.
export const acceptanceReports = [
  ["Squad rule design consistency", ".local/design/rules.json"],
  ["Three-map geometry and content identity", ".local/design/maps.json"],
  ["Squad protocol bytes, hashes and events", ".local/design/protocol.json"],
  [
    "Shared design baseline and ruleset compatibility",
    ".local/design/baseline.json",
  ],
  [
    "Solidity squad rules, initialization and data isolation",
    ".local/design/types.json",
  ],
  [
    "Solidity map geometry and complete squad validation",
    ".local/design/actions.json",
  ],
  [
    "Solidity seven-stage squad battle resolution",
    ".local/design/battles.json",
  ],
  [
    "Squad skill lifecycle, runtime state hashes and Gas baseline",
    ".local/design/edges.json",
  ],
  [
    "Anvil operational controls and database restore",
    ".local/operations/anvil.json",
  ],
  [
    "Geth operational controls and database restore",
    ".local/operations/geth.json",
  ],
  ["Safety, rule comparisons and gas budgets", ".local/safety/acceptance.json"],
  [
    "Squad rule fuzz, invariants, generated games and Gas pressure",
    ".local/safety/squad.json",
  ],
  [
    "Squad rooms, manual host start and immutable signed commits on both engines",
    ".local/safety/squad-rooms.json",
  ],
  [
    "Anvil indexing, Keeper and controlled branch faults",
    ".local/indexer/anvil-acceptance.json",
  ],
  ["Anvil two-player browser gameplay", ".local/browser/gameplay-anvil.json"],
  [
    "Anvil database, Go and SSE browser recovery",
    ".local/browser/recovery-anvil.json",
  ],
  [
    "Anvil deployment and secret recovery",
    ".local/browser/persistence-anvil.json",
  ],
  [
    "Geth full matches and independent replay",
    ".local/indexer/acceptance.json",
  ],
  ...browserEngines.flatMap((browser) => {
    const suffix = browser === "chromium" ? "geth" : `geth-${browser}`;
    return [
      [
        `Geth ${browser} two-player gameplay and replay`,
        `.local/browser/gameplay-${suffix}.json`,
      ],
      [
        `Geth ${browser} database, Go and SSE recovery`,
        `.local/browser/recovery-${suffix}.json`,
      ],
    ];
  }),
  ["Geth persistence and archives", ".local/browser/persistence-geth.json"],
];
