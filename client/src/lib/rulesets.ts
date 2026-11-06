export interface RulesetProfile {
  rulesetId: string;
  schemas: readonly number[];
  abi: string;
  engine: 'fixed' | 'squad';
  replay: boolean;
}
export interface DeploymentBinding {
  chainId: string;
  arena: string;
  deploymentHash: string;
  rulesetId: string;
  schemas: readonly number[];
  abi: string;
}
export class RulesetError extends Error {}

function normalized(binding: DeploymentBinding): DeploymentBinding {
  if (
    !/^[1-9]\d*$/.test(binding.chainId) ||
    BigInt(binding.chainId) >= 1n << 256n ||
    !/^0x[\da-fA-F]{40}$/.test(binding.arena) ||
    !/^0x[\da-fA-F]{64}$/.test(binding.deploymentHash) ||
    !/^0x[\da-fA-F]{64}$/.test(binding.rulesetId) ||
    binding.schemas.length !== 3 ||
    binding.schemas.some((value) => !Number.isInteger(value) || value < 1 || value > 65535)
  )
    throw new RulesetError('invalid_identity');
  return {
    ...binding,
    arena: binding.arena.toLowerCase(),
    deploymentHash: binding.deploymentHash.toLowerCase(),
    rulesetId: binding.rulesetId.toLowerCase(),
  };
}

// Bind immutable observed metadata to the registered deployment before choosing a codec.
export function selectRuleset(
  profiles: readonly RulesetProfile[],
  registered: DeploymentBinding,
  observed: DeploymentBinding,
  capability: 'codec' | 'replay',
  matchId: string,
) {
  const expected = normalized(registered),
    actual = normalized(observed);
  if (!/^[1-9]\d*$/.test(matchId) || BigInt(matchId) >= 1n << 256n)
    throw new RulesetError('invalid_identity');
  for (const key of ['chainId', 'arena', 'deploymentHash', 'rulesetId', 'abi'] as const)
    if (expected[key] !== actual[key]) throw new RulesetError('metadata_mismatch');
  if (expected.schemas.some((value, index) => value !== actual.schemas[index]))
    throw new RulesetError('metadata_mismatch');
  const matches = profiles.filter(
    (profile) =>
      profile.rulesetId.toLowerCase() === actual.rulesetId &&
      profile.abi === actual.abi &&
      profile.schemas.length === 3 &&
      profile.schemas.every((value, index) => value === actual.schemas[index]),
  );
  if (matches.length !== 1 || !['fixed', 'squad'].includes(matches[0].engine))
    throw new RulesetError('unsupported_ruleset');
  const profile = matches[0];
  if (capability === 'replay' && !profile.replay) throw new RulesetError('replay_unavailable');
  const globalKey = `${actual.chainId}:${actual.arena}:${matchId}`;
  return {
    engine: profile.engine,
    globalKey,
    localKey: `${actual.chainId}:${actual.arena}:${actual.deploymentHash}:${matchId}`,
    url: `/chains/${actual.chainId}/arenas/${actual.arena}/matches/${matchId}?deployment=${actual.deploymentHash}`,
  };
}
