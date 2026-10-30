import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  checkpoint,
  rpc,
  readJson,
  recordDeployment,
  saveJson,
  verifyDeployment,
} from "./deployment.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const abiFile = resolve(projectRoot, "client/src/generated/arena.ts");
const deploymentFile = resolve(projectRoot, "client/public/deployment.json");

async function latestSourceChange(directory, suffixes) {
  let latest = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory())
      latest = Math.max(latest, await latestSourceChange(file, suffixes));
    else if (suffixes.some((suffix) => entry.name.endsWith(suffix)))
      latest = Math.max(latest, (await stat(file)).mtimeMs);
  }
  return latest;
}

async function requireCurrentDeployment() {
  const deployment = await stat(deploymentFile).catch((error) => {
    if (error.code === "ENOENT")
      throw new Error(
        "Start ./scripts/run-backend.sh and wait for its ready message before starting the frontend.",
      );
    throw error;
  });
  const artifact = await stat(
    resolve(projectRoot, "contracts/out/Arena.sol/Arena.json"),
  );
  const changed = await latestSourceChange(
    resolve(projectRoot, "contracts/src"),
    [".sol"],
  );
  const backend = await latestSourceChange(resolve(projectRoot, "server"), [
    ".go",
    ".sql",
    "go.mod",
    "go.sum",
  ]);
  const runtime = await Promise.all(
    [
      "contracts/foundry.toml",
      "Dockerfile",
      "compose.yaml",
      ".dockerignore",
      "scripts/run-backend.sh",
      "scripts/local-chain.sh",
      "scripts/client-contract.mjs",
      "scripts/deployment.mjs",
      "scripts/local-indexer.sh",
      "scripts/local-compose.sh",
      "scripts/container-backend.sh",
    ].map((file) => stat(resolve(projectRoot, file))),
  );
  if (
    Math.max(
      changed,
      backend,
      artifact.mtimeMs,
      ...runtime.map((file) => file.mtimeMs),
    ) > deployment.mtimeMs
  ) {
    throw new Error(
      "The contracts or backend runtime changed after this local deployment. Restart ./scripts/run-backend.sh, wait for its ready message, then run ./scripts/run-frontend.sh.",
    );
  }
}

async function writeChanged(file, content) {
  const previous = await readFile(file, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  if (previous === content) return;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function exportAbi() {
  const artifact = JSON.parse(
    await readFile(
      resolve(projectRoot, "contracts/out/Arena.sol/Arena.json"),
      "utf8",
    ),
  );
  await writeChanged(
    abiFile,
    "// Generated from the compiled Arena artifact by the startup scripts.\n" +
      "import type { Abi } from 'viem';\n\n" +
      `export const arenaAbi = ${JSON.stringify(artifact.abi, null, 2)} as const satisfies Abi;\n`,
  );
  console.log("Frontend Arena ABI synchronized from the compiler artifact.");
}

async function publishDeployment() {
  const rpcUrl = process.argv[3];
  const resultFile = process.argv[4];
  if (!rpcUrl)
    throw new Error("Deployment publication requires the managed RPC URL.");
  const deployment = resultFile
    ? await recordDeployment(projectRoot, rpcUrl, await readJson(resultFile))
    : await verifyDeployment(
        projectRoot,
        rpcUrl,
        await readJson(resolve(projectRoot, ".local/chain/deployment.json")),
      );
  // Refresh readiness without changing the identity used by browser order secrets.
  await saveJson(deploymentFile, deployment);
  console.log(
    `Arena ${resultFile ? "deployed" : "restored and verified"}: ${deployment.arenaAddress}, deployment block ${deployment.deploymentBlock}.`,
  );
}

const command = process.argv[2];
if (command === "abi") await exportAbi();
else if (command === "ready") await requireCurrentDeployment();
else if (command === "publish") await publishDeployment();
else if (command === "preserve") {
  const previous = await readJson(deploymentFile);
  const block = await rpc(previous.rpcUrl, "eth_getBlockByNumber", [
    `0x${BigInt(previous.deploymentBlock).toString(16)}`,
    true,
  ]);
  let creation;
  for (const transaction of block?.transactions ?? []) {
    if (transaction.to != null) continue;
    const receipt = await rpc(previous.rpcUrl, "eth_getTransactionReceipt", [
      transaction.hash,
    ]);
    if (
      receipt?.contractAddress?.toLowerCase() ===
      previous.arenaAddress.toLowerCase()
    ) {
      creation = transaction.hash;
      break;
    }
  }
  if (!creation)
    throw new Error(
      "The existing deployment creation receipt could not be identified. Its running backend was left untouched.",
    );
  await recordDeployment(projectRoot, previous.rpcUrl, {
    transactionHash: creation,
    deployedAt: previous.deployedAt,
  });
  console.log(
    "The running chain and original browser deployment identity have been checkpointed.",
  );
} else if (command === "start-chain") {
  // Keep terminal Ctrl+C on the launcher so it can checkpoint before stopping Anvil.
  const child = spawn("anvil", process.argv.slice(3), {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  await new Promise((done, fail) => {
    child.once("spawn", done);
    child.once("error", fail);
  });
  await writeFile(resolve(projectRoot, ".local/anvil.pid"), `${child.pid}\n`);
  child.unref();
} else if (command === "checkpoint")
  await checkpoint(projectRoot, process.argv[3]);
else if (command === "watch") {
  let failed = false;
  for (;;) {
    await new Promise((done) => setTimeout(done, 15_000));
    try {
      await checkpoint(projectRoot, process.argv[3]);
      if (failed) console.log("Chain checkpoint saving recovered.");
      failed = false;
    } catch (error) {
      if (!failed)
        console.error(
          `Chain checkpoint failed: ${error.message}. The last successful save is retained.`,
        );
      failed = true;
    }
  }
} else if (command === "clear") await rm(deploymentFile, { force: true });
else
  throw new Error(
    "Expected an internal ABI, deployment, or checkpoint operation.",
  );
