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
    "Anvil operational controls and database restore",
    ".local/operations/anvil.json",
  ],
  [
    "Geth operational controls and database restore",
    ".local/operations/geth.json",
  ],
  ["Safety, rule comparisons and gas budgets", ".local/safety/acceptance.json"],
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
