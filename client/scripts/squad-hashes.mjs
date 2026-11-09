import assert from 'node:assert/strict';

export function resolvedFrames(outputs) {
  return outputs.flatMap((output) => output?.steps ?? [output]).filter((output) => output?.state);
}

export function runtimeStateCases(frames, rulesetId) {
  return frames.flatMap((frame) =>
    [
      {
        name: `runtime-before:${frame.name}`,
        state: frame.initial,
        encoding: frame.beforeEncoding,
        hash: frame.beforeHash,
      },
      {
        name: `runtime-after:${frame.name}`,
        state: frame.state,
        encoding: frame.afterEncoding,
        hash: frame.stateHash,
      },
    ].map((row) => ({
      name: row.name,
      kind: 4,
      valid: true,
      input: { context: frame.context, rulesetId, state: row.state },
      expectedEncoding: row.encoding,
      expectedHash: row.hash,
    })),
  );
}

export function stateHashChanges(frame, config, viem) {
  const base = { context: frame.context, rulesetId: config.rulesetId, state: frame.state };
  const changes = [
    [
      'chain',
      (input) => {
        input.context.chainId = (BigInt(input.context.chainId) + 1n).toString();
      },
    ],
    [
      'arena',
      (input) => {
        input.context.arena = '0x000000000000000000000000000000000000cafe';
      },
    ],
    [
      'match',
      (input) => {
        input.context.matchId = (BigInt(input.context.matchId) + 1n).toString();
      },
    ],
    [
      'ruleset',
      (input) => {
        input.rulesetId = '0x' + '01'.repeat(32);
      },
    ],
    [
      'map',
      (input) => {
        input.state.mapId = 2;
      },
    ],
    [
      'completed-round',
      (input) => {
        input.state.completedRound++;
      },
    ],
    [
      'unit-type',
      (input) => {
        input.state.units[2].unitType = 2;
      },
    ],
    [
      'position',
      (input) => {
        input.state.units[0].position = 2;
      },
    ],
    [
      'HP',
      (input) => {
        input.state.units[0].hp--;
      },
    ],
    [
      'effective-lock',
      (input) => {
        input.state.units[2].lockedRound = input.state.completedRound + 1;
      },
    ],
    [
      'canonical-death',
      (input) => {
        Object.assign(input.state.units[2], { position: 255, hp: 0, alive: false, lockedRound: 0 });
      },
    ],
    [
      'fixed-unit-order',
      (input) => {
        [input.state.units[0], input.state.units[2]] = [input.state.units[2], input.state.units[0]];
      },
    ],
    [
      'Energy',
      (input) => {
        input.state.energy[0]--;
      },
    ],
    [
      'VP',
      (input) => {
        input.state.victoryPoints[0] = 2;
      },
    ],
    [
      'outcome-A',
      (input) => {
        input.state.outcome = 1;
        input.state.reason = 5;
      },
    ],
    [
      'outcome-B',
      (input) => {
        input.state.outcome = 2;
        input.state.reason = 5;
      },
    ],
    [
      'end-reason',
      (input) => {
        input.state.outcome = 1;
        input.state.reason = 6;
      },
    ],
    [
      'pregame',
      (input) => {
        Object.assign(input.state, {
          battleStarted: false,
          completedRound: 0,
          energy: [0, 0],
          victoryPoints: [0, 0],
          outcome: 0,
          reason: 0,
        });
        input.state.units = input.state.units.map(() => ({
          unitType: 0,
          position: 255,
          hp: 0,
          alive: false,
          lockedRound: 0,
        }));
      },
    ],
  ];
  const inputType = viem.parseAbiParameters(config.types.stateInput);
  return changes.map(([name, change]) => {
    const input = structuredClone(base);
    change(input);
    const native = {
      ...input,
      context: {
        ...input.context,
        chainId: BigInt(input.context.chainId),
        matchId: BigInt(input.context.matchId),
      },
    };
    return {
      name: `resolved-state-change:${name}`,
      kind: 4,
      valid: true,
      input,
      payload: viem.encodeAbiParameters(inputType, [native]),
    };
  });
}

export function gasBaseline(frames, artifact) {
  const metadata = JSON.parse(artifact.rawMetadata);
  const samples = frames
    .filter((frame) => frame.measurement)
    .map((frame) => ({
      name: frame.name,
      mapId: frame.state.mapId,
      completedRound: frame.state.completedRound,
      resolve: frame.gas.resolve,
      hash: frame.gas.hash,
    }));
  assert.ok(samples.length > 0, 'Gas measurements must exist');
  assert.ok(
    samples.every((sample) => sample.resolve > 0 && sample.hash > 0),
    'Gas intervals must be positive',
  );
  const summary = Object.fromEntries(
    ['resolve', 'hash'].map((operation) => {
      const sorted = [...samples].sort((a, b) => a[operation] - b[operation]);
      const middle = Math.floor(sorted.length / 2);
      return [
        operation,
        {
          minimum: sorted[0][operation],
          median:
            sorted.length % 2
              ? sorted[middle][operation]
              : (sorted[middle - 1][operation] + sorted[middle][operation]) / 2,
          maximum: sorted.at(-1)[operation],
          maximumCase: sorted.at(-1).name,
        },
      ];
    }),
  );
  return {
    scope:
      'gasleft deltas around internal resolve and production hashState calls; each evaluate call has fresh EVM memory, with the hash interval following resolution in that same frame. Includes resolver diagnostics and hash ruleset computation; excludes fixture decode/encode/I/O, intrinsic transaction gas, storage and events. Sampled maxima are not a worst-case or complete settlement-transaction claim. Both-at-threshold comparator-only fixtures are excluded.',
    compiler: metadata.compiler.version,
    optimizer: metadata.settings.optimizer,
    evmVersion: metadata.settings.evmVersion,
    summary,
    samples,
  };
}
