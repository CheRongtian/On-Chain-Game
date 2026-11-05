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
import { createServer } from "node:net";
import { acceptanceReports } from "./acceptance.mjs";
import {
  checkpoint,
  archiveLegacyHistory,
  chainDirectory,
  chainEngine,
  compileArchivedSources,
  rpc,
  readJson,
  recordDeployment,
  saveJson,
  verifyDeployment,
} from "./deployment.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const abiFile = resolve(projectRoot, "client/src/generated/arena.ts");
const deploymentFile = resolve(projectRoot, "client/public/deployment.json");
const previewDeploymentFile = resolve(
  projectRoot,
  "client/dist/deployment.json",
);

async function publishConnection(deployment) {
  await saveJson(deploymentFile, deployment);
  const preview = await stat(dirname(previewDeploymentFile)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (preview?.isDirectory()) await saveJson(previewDeploymentFile, deployment);
}

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
      "scripts/archive-chain.sh",
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
  const directory = chainDirectory(projectRoot, await chainEngine(rpcUrl));
  let deployment;
  if (resultFile)
    deployment = await recordDeployment(
      projectRoot,
      rpcUrl,
      await readJson(resultFile),
    );
  else {
    const manifest = await readJson(resolve(directory, "deployment.json"));
    deployment = await verifyDeployment(projectRoot, rpcUrl, manifest);
    manifest.deployment = deployment;
    await saveJson(resolve(directory, "deployment.json"), manifest);
    await saveJson(
      resolve(
        projectRoot,
        `.local/deployments/${deployment.deploymentHash}.json`,
      ),
      manifest,
    );
  }
  // Refresh readiness without changing the identity used by browser order secrets.
  await publishConnection(deployment);
  console.log(
    `Arena ${resultFile ? "deployed" : "restored and verified"}: ${deployment.arenaAddress}, deployment block ${deployment.deploymentBlock}.`,
  );
}

async function startLegacy() {
  const directory = chainDirectory(projectRoot, "anvil");
  const publicFile = resolve(
    projectRoot,
    "client/public/legacy-deployment.json",
  );
  const manifest = await readJson(resolve(directory, "deployment.json")).catch(
    (error) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  if (!manifest) {
    await rm(publicFile, { force: true });
    return;
  }
  await stat(resolve(directory, "state.json"));
  let processRecord = await readJson(
    resolve(directory, "legacy-process.json"),
  ).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (processRecord) {
    try {
      process.kill(processRecord.pid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      processRecord = undefined;
    }
  }
  if (!processRecord) {
    const previousPid = await readFile(
      resolve(projectRoot, ".local/anvil.pid"),
      "utf8",
    ).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (previousPid) {
      let running = true;
      try {
        process.kill(Number(previousPid), 0);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        running = false;
      }
      if (running) {
        await verifyDeployment(
          projectRoot,
          manifest.deployment.rpcUrl,
          manifest,
        );
        await checkpoint(projectRoot, manifest.deployment.rpcUrl);
        process.kill(Number(previousPid), "SIGTERM");
        const deadline = Date.now() + 30_000;
        for (;;) {
          try {
            process.kill(Number(previousPid), 0);
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
            break;
          }
          if (Date.now() >= deadline)
            throw new Error(
              "The old Anvil node did not stop; its checkpoint was retained.",
            );
          await new Promise((done) => setTimeout(done, 100));
        }
      }
      await rm(resolve(projectRoot, ".local/anvil.pid"), { force: true });
    }
    const reservation = createServer();
    await new Promise((done, fail) => {
      reservation.once("error", fail);
      reservation.listen(0, "127.0.0.1", done);
    });
    const port = reservation.address().port;
    await new Promise((done, fail) =>
      reservation.close((error) => (error ? fail(error) : done())),
    );
    const child = spawn(
      "anvil",
      [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--chain-id",
        "31337",
        "--hardfork",
        "cancun",
        "--gas-limit",
        "30000000",
        "--accounts",
        "2",
        "--no-mining",
        "--load-state",
        resolve(directory, "state.json"),
        "--mnemonic",
        "test test test test test test test test test test test junk",
      ],
      { detached: true, stdio: ["ignore", "inherit", "inherit"] },
    );
    await new Promise((done, fail) => {
      child.once("spawn", done);
      child.once("error", fail);
    });
    child.unref();
    processRecord = { pid: child.pid, rpcUrl: `http://127.0.0.1:${port}` };
    await saveJson(resolve(directory, "legacy-process.json"), processRecord);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null)
        throw new Error(
          "The old Anvil history could not be restored; its files were retained.",
        );
      try {
        await rpc(processRecord.rpcUrl, "anvil_setLoggingEnabled", [false]);
        ready = true;
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    if (!ready) throw new Error("The old Anvil history did not become ready.");
  }
  const deployment = await verifyDeployment(
    projectRoot,
    processRecord.rpcUrl,
    manifest,
  );
  manifest.deployment = { ...deployment, readOnly: true };
  await archiveLegacyHistory(projectRoot, processRecord.rpcUrl, manifest);
  await saveJson(resolve(directory, "deployment.json"), manifest);
  await saveJson(
    resolve(
      projectRoot,
      `.local/deployments/${deployment.deploymentHash}.json`,
    ),
    manifest,
  );
  await saveJson(publicFile, manifest.deployment);
  console.log(
    "Old Anvil matches retained as a separate read-only history source.",
  );
}

const command = process.argv[2];
if (command === "abi") await exportAbi();
else if (command === "ready") await requireCurrentDeployment();
else if (command === "publish") await publishDeployment();
else if (command === "check-sources") {
  const deployment = await readJson(deploymentFile);
  const file = resolve(
    chainDirectory(projectRoot, deployment.engine),
    "deployment.json",
  );
  const manifest = await readJson(file);
  manifest.deployment.sourceVerification = await compileArchivedSources(
    projectRoot,
    manifest,
  );
  await saveJson(
    resolve(
      projectRoot,
      `.local/deployments/${deployment.deploymentHash}.json`,
    ),
    manifest,
  );
  await saveJson(file, manifest);
  await publishConnection(manifest.deployment);
  console.log(
    "PASS: archived Solidity sources reproduce the deployment bytecode and ABI.",
  );
} else if (command === "start-legacy") await startLegacy();
else if (command === "acceptance-summary") {
  const items = [];
  for (const [name, file] of acceptanceReports) {
    const result = await readJson(resolve(projectRoot, file));
    if (result.status !== "passed")
      throw new Error(`Acceptance incomplete: ${name}.`);
    items.push({ name, status: "passed", report: file });
  }
  const archive = await readJson(
    resolve(projectRoot, ".local/browser/persistence-geth.json"),
  );
  if (archive.engine !== "geth")
    throw new Error("Archive acceptance must run against Geth.");
  for (const name of [
    "confirmed-recovery",
    "history-archive",
    "source-reproduction",
    "historical-accounts",
  ]) {
    if (archive.requirements[name] !== "passed")
      throw new Error(`Missing Geth requirement: ${name}.`);
    console.log(`PASS: Geth requirement ${name}.`);
  }
  await saveJson(resolve(projectRoot, ".local/acceptance.json"), {
    status: "pending-cleanup",
    checkedAt: new Date().toISOString(),
    items,
    requirements: archive.requirements,
  });
} else if (command === "stop-legacy") {
  const file = resolve(projectRoot, ".local/chain/legacy-process.json");
  const record = await readJson(file).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (record) {
    try {
      process.kill(record.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        process.kill(record.pid, 0);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        break;
      }
      if (Date.now() >= deadline)
        throw new Error(
          "The legacy history process did not finish stopping. Its process record was retained.",
        );
      await new Promise((done) => setTimeout(done, 100));
    }
    await rm(file, { force: true });
  }
} else if (command === "follow-logs") {
  const child = spawn(
    "docker",
    [
      "compose",
      "--project-name",
      process.env.ARENA_COMPOSE_PROJECT || "onchain-arena",
      "--project-directory",
      projectRoot,
      "-f",
      resolve(projectRoot, "compose.yaml"),
      "logs",
      "--follow",
      "--since",
      process.argv[3],
      "db",
      "api",
    ],
    { detached: true, stdio: ["ignore", "inherit", "inherit"] },
  );
  let stopping = false;
  const stop = () => {
    stopping = true;
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const code = await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("close", done);
    });
    process.exitCode = stopping ? 0 : (code ?? 1);
  } finally {
    stop();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
} else if (command === "start-geth") {
  const child = spawn(
    resolve(projectRoot, ".local/bin/arena-chain"),
    [projectRoot, process.argv[3]],
    { detached: true, stdio: ["ignore", "inherit", "inherit"] },
  );
  await new Promise((done, fail) => {
    child.once("spawn", done);
    child.once("error", fail);
  });
  await writeFile(resolve(projectRoot, ".local/geth.pid"), `${child.pid}\n`);
  child.unref();
} else if (command === "preserve") {
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
else if (command === "clear") {
  await rm(deploymentFile, { force: true });
  await rm(previewDeploymentFile, { force: true });
} else
  throw new Error(
    "Expected an internal ABI, deployment, or checkpoint operation.",
  );
