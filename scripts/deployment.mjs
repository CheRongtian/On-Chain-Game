import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function saveJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flush: true,
  });
  await rename(`${file}.tmp`, file);
}

export function runtimeCode(artifact, rulesHash) {
  let code = artifact.deployedBytecode.object.replace(/^0x/, "");
  const references = Object.values(
    artifact.deployedBytecode.immutableReferences,
  );
  if (references.length !== 1 || !/^0x[\da-f]{64}$/i.test(rulesHash))
    throw new Error(
      "Arena must have exactly its supported RULES_HASH immutable.",
    );
  for (const { start, length } of references[0]) {
    if (length !== 32 || start < 0 || (start + length) * 2 > code.length)
      throw new Error(
        "Invalid Arena immutable reference in the compiler artifact.",
      );
    code =
      code.slice(0, start * 2) +
      rulesHash.slice(2) +
      code.slice((start + length) * 2);
  }
  return `0x${code}`.toLowerCase();
}

export async function checkpoint(root, url) {
  const encoded = await rpc(url, "anvil_dumpState", [true]);
  if (typeof encoded !== "string" || !/^0x[\da-f]+$/i.test(encoded))
    throw new Error("Anvil did not return a serializable chain state.");
  let bytes = Buffer.from(encoded.slice(2), "hex");
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const state = JSON.parse(bytes.toString("utf8"));
  if (
    !state.block ||
    !Array.isArray(state.blocks) ||
    !Array.isArray(state.transactions) ||
    !Array.isArray(state.historical_states)
  )
    throw new Error(
      "The chain checkpoint is missing block, transaction, or retained state history.",
    );
  await saveJson(resolve(root, ".local/chain/state.json"), state);
}

export async function verifyDeployment(root, url, manifest) {
  const artifact = await readJson(
    resolve(root, "contracts/out/Arena.sol/Arena.json"),
  );
  const vectors = await readJson(resolve(root, "config/state-vectors.json"));
  const d = manifest.deployment;
  if (
    !d ||
    d.chainId !== 31337 ||
    !/^0x[\da-f]{40}$/i.test(d.arenaAddress) ||
    !/^0x[\da-f]{64}$/i.test(d.transactionHash) ||
    !/^\d+$/.test(d.deploymentBlock) ||
    !d.deployedAt ||
    d.rulesHash !== vectors.rulesHash
  )
    throw new Error(
      "The saved deployment is invalid or has different rules. Restore its saved files or explicitly reset.",
    );
  if (
    manifest.artifact?.bytecode?.object !== artifact.bytecode.object ||
    JSON.stringify(manifest.artifact.abi) !== JSON.stringify(artifact.abi)
  )
    throw new Error(
      "The current compiler artifact differs from the saved deployment baseline. Restore the matching sources or explicitly reset.",
    );
  const [chain, receipt, transaction, code, rules] = await Promise.all([
    rpc(url, "eth_chainId"),
    rpc(url, "eth_getTransactionReceipt", [d.transactionHash]),
    rpc(url, "eth_getTransactionByHash", [d.transactionHash]),
    rpc(url, "eth_getCode", [d.arenaAddress, "latest"]),
    rpc(url, "eth_call", [
      {
        to: d.arenaAddress,
        data: "0x" + artifact.methodIdentifiers["getRulesHash()"],
      },
      "latest",
    ]),
  ]);
  if (
    BigInt(chain) !== 31337n ||
    !receipt ||
    receipt.status !== "0x1" ||
    receipt.contractAddress?.toLowerCase() !== d.arenaAddress.toLowerCase() ||
    BigInt(receipt.blockNumber).toString() !== d.deploymentBlock ||
    receipt.blockHash !== d.deploymentHash ||
    !transaction ||
    transaction.to != null ||
    transaction.input.toLowerCase() !==
      artifact.bytecode.object.toLowerCase() ||
    code.toLowerCase() !== runtimeCode(artifact, d.rulesHash) ||
    rules !== d.rulesHash
  )
    throw new Error(
      "Saved deployment, canonical receipt, rules, or compiler bytecode do not match. Existing data was retained; restore matching sources or explicitly reset.",
    );
  const block = await rpc(url, "eth_getBlockByNumber", [
    receipt.blockNumber,
    false,
  ]);
  if (block?.hash !== receipt.blockHash)
    throw new Error(
      "The saved deployment is no longer on the canonical chain.",
    );
  return {
    ...d,
    rpcUrl: url,
    verification: { status: "Matched", checkedAt: new Date().toISOString() },
  };
}

export async function recordDeployment(root, url, result) {
  const receipt = await rpc(url, "eth_getTransactionReceipt", [
    result.transactionHash,
  ]);
  if (!receipt || !receipt.contractAddress)
    throw new Error("The deployment receipt is unavailable.");
  const artifact = await readJson(
    resolve(root, "contracts/out/Arena.sol/Arena.json"),
  );
  const vectors = await readJson(resolve(root, "config/state-vectors.json"));
  const deployment = {
    chainId: 31337,
    rpcUrl: url,
    arenaAddress: receipt.contractAddress,
    deploymentBlock: BigInt(receipt.blockNumber).toString(),
    deploymentHash: receipt.blockHash,
    transactionHash: receipt.transactionHash,
    deployedAt: result.deployedAt ?? new Date().toISOString(),
    rulesHash: vectors.rulesHash,
    compiler: artifact.metadata.compiler.version,
    optimizer: artifact.metadata.settings.optimizer,
    evmVersion: artifact.metadata.settings.evmVersion,
    gasUsed: BigInt(receipt.gasUsed).toString(),
    feeWei: (
      BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)
    ).toString(),
  };
  const manifest = { deployment, artifact, vectors: {} };
  for (const name of [
    "map",
    "state-vectors",
    "battle-vectors",
    "protocol-vectors",
  ])
    manifest.vectors[name] = await readJson(
      resolve(root, `config/${name}.json`),
    );
  const checked = await verifyDeployment(root, url, manifest);
  manifest.deployment = checked;
  await checkpoint(root, url);
  await saveJson(
    resolve(root, `.local/deployments/${receipt.blockHash}.json`),
    manifest,
  );
  await saveJson(resolve(root, ".local/chain/deployment.json"), manifest);
  return checked;
}
