import assert from 'node:assert/strict';
import { getAddress } from 'viem';

export function linkSquadArena(artifact, settlementAddress) {
  const address = getAddress(settlementAddress).slice(2).toLowerCase();
  function linked(part) {
    const refs = part.linkReferences;
    assert.deepEqual(Object.keys(refs), ['src/SquadSettlement.sol']);
    assert.deepEqual(Object.keys(refs['src/SquadSettlement.sol']), ['SquadSettlement']);
    const locations = refs['src/SquadSettlement.sol'].SquadSettlement;
    assert.ok(locations.length > 0, 'Missing settlement library link');
    let code = part.object.replace(/^0x/, '');
    for (const { start, length } of locations) {
      assert.equal(length, 20);
      assert.ok(start >= 0 && (start + length) * 2 <= code.length);
      code = code.slice(0, start * 2) + address + code.slice((start + length) * 2);
    }
    assert.match(code, /^[\da-f]+$/i, 'All compiler library placeholders are linked');
    return { ...part, object: `0x${code}` };
  }
  return {
    ...artifact,
    bytecode: linked(artifact.bytecode),
    deployedBytecode: linked(artifact.deployedBytecode),
  };
}

export function settlementRuntime(artifact, settlementAddress) {
  const code = artifact.deployedBytecode.object;
  // Solidity 0.8.30 library creation patches the leading PUSH20 with its own deployed address.
  assert.equal(code.slice(0, 44), `0x73${'0'.repeat(40)}`);
  return `0x73${getAddress(settlementAddress).slice(2)}${code.slice(44)}`.toLowerCase();
}
