import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

export function chainDirectory(root, engine) {
  return resolve(root, engine === "geth" ? ".local/archive" : ".local/chain");
}

export async function chainEngine(url) {
  const version = await rpc(url, "web3_clientVersion");
  if (/geth\//i.test(version)) return "geth";
  if (/anvil/i.test(version)) return "anvil";
  throw new Error(
    "The managed RPC must serve this project's Geth or Anvil chain.",
  );
}

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
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flush: true,
  });
  await rename(temporary, file);
  const directory = await open(dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
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
  if ((await chainEngine(url)) === "geth") {
    const point = await rpc(url, "arena_checkpoint");
    if (
      !Number.isSafeInteger(point?.number) ||
      !/^0x[\da-f]{64}$/i.test(point.hash)
    )
      throw new Error("Geth did not acknowledge its durable chain checkpoint.");
    return;
  }
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

async function archiveCompilerInput(root, manifest) {
  if (!manifest.compilerInput) {
    const metadata = manifest.artifact.metadata;
    const settings = structuredClone(metadata.settings);
    delete settings.compilationTarget;
    settings.outputSelection = {
      "*": {
        "*": [
          "abi",
          "evm.bytecode.object",
          "evm.deployedBytecode.object",
          "evm.deployedBytecode.immutableReferences",
          "evm.methodIdentifiers",
        ],
      },
    };
    const sources = {};
    for (const source of Object.keys(metadata.sources)) {
      const file = resolve(root, "contracts", source);
      if (!file.startsWith(resolve(root, "contracts/src") + "/"))
        throw new Error(`Unsupported compiler source path: ${source}`);
      sources[source] = { content: await readFile(file, "utf8") };
    }
    manifest.compilerInput = { language: "Solidity", sources, settings };
  }
}

export async function compileArchivedSources(root, manifest) {
  await archiveCompilerInput(root, manifest);
  const output = await new Promise((done, fail) => {
    const child = spawn(
      resolve(root, ".local/bin/solc-0.8.30"),
      ["--standard-json"],
      { cwd: resolve(root, "contracts"), stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (part) => {
      stdout += part;
    });
    child.stderr.on("data", (part) => {
      stderr += part;
    });
    child.once("error", fail);
    child.stdin.on("error", fail);
    child.once("close", (code) => {
      if (code !== 0)
        fail(new Error(`Archived Solidity compilation failed: ${stderr}`));
      else {
        try {
          done(JSON.parse(stdout));
        } catch (error) {
          fail(error);
        }
      }
    });
    child.stdin.end(JSON.stringify(manifest.compilerInput));
  });
  const errors =
    output.errors?.filter((entry) => entry.severity === "error") ?? [];
  if (errors.length)
    throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  const [source, name] = Object.entries(
    manifest.artifact.metadata.settings.compilationTarget,
  )[0];
  const compiled = output.contracts?.[source]?.[name];
  if (!compiled)
    throw new Error(`Archived compilation did not produce ${source}:${name}.`);
  if (
    `0x${compiled.evm.bytecode.object}`.toLowerCase() !==
    manifest.artifact.bytecode.object.toLowerCase()
  )
    throw new Error(
      "Archived sources and compiler settings do not reproduce the deployed creation bytecode.",
    );
  // Foundry omits empty fields in parsed metadata; rawMetadata preserves Solc's ABI.
  const originalAbi = JSON.parse(manifest.artifact.rawMetadata).output.abi;
  if (!isDeepStrictEqual(compiled.abi, originalAbi))
    throw new Error(
      "Archived sources and compiler settings do not reproduce the original Solidity ABI.",
    );
  const references = compiled.evm.deployedBytecode.immutableReferences;
  const reconstructed = {
    deployedBytecode: {
      object: `0x${compiled.evm.deployedBytecode.object}`,
      immutableReferences: references,
    },
  };
  if (
    runtimeCode(reconstructed, manifest.deployment.rulesHash) !==
    runtimeCode(manifest.artifact, manifest.deployment.rulesHash)
  )
    throw new Error(
      "Archived sources do not reproduce the deployed runtime bytecode.",
    );
  return {
    status: "Matched",
    checkedAt: new Date().toISOString(),
    sourceCount: Object.keys(manifest.compilerInput.sources).length,
  };
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
  await archiveCompilerInput(root, manifest);
  return {
    ...d,
    rpcUrl: url,
    engine: await chainEngine(url),
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
    engine: await chainEngine(url),
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
  await saveJson(
    resolve(chainDirectory(root, deployment.engine), "deployment.json"),
    manifest,
  );
  return checked;
}

export async function archiveLegacyHistory(root, url, manifest) {
  const directory = resolve(
    root,
    ".local/deployments",
    manifest.deployment.deploymentHash,
  );
  const head = await rpc(url, "eth_getBlockByNumber", ["latest", false]);
  let from = BigInt(manifest.deployment.deploymentBlock);
  const previous = await readJson(resolve(directory, "history.json")).catch(
    (error) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  if (previous) {
    const block = await rpc(url, "eth_getBlockByNumber", [
      `0x${BigInt(previous.throughBlock).toString(16)}`,
      false,
    ]);
    if (block?.hash !== previous.throughHash)
      throw new Error(
        "The saved legacy history differs from its chain. Existing archives were retained.",
      );
    from = BigInt(previous.throughBlock) + 1n;
  }
  for (let number = from; number <= BigInt(head.number); number++) {
    const block = await rpc(url, "eth_getBlockByNumber", [
      `0x${number.toString(16)}`,
      true,
    ]);
    const receipts = await Promise.all(
      block.transactions.map((transaction) =>
        rpc(url, "eth_getTransactionReceipt", [transaction.hash]),
      ),
    );
    if (
      receipts.some((receipt) => !receipt || receipt.blockHash !== block.hash)
    )
      throw new Error(
        "Legacy receipt history is incomplete or changed during export.",
      );
    await saveJson(resolve(directory, "blocks", `${number}.json`), {
      block,
      receipts,
    });
  }
  await saveJson(resolve(directory, "history.json"), {
    chainId: manifest.deployment.chainId,
    arena: manifest.deployment.arenaAddress,
    deploymentHash: manifest.deployment.deploymentHash,
    throughBlock: BigInt(head.number).toString(),
    throughHash: head.hash,
  });
}
