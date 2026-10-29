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
      "Dockerfile",
      "compose.yaml",
      ".dockerignore",
      "scripts/run-backend.sh",
      "scripts/local-chain.sh",
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
  const [rpcUrl, arenaAddress, deploymentBlock] = process.argv.slice(3);
  if (
    !rpcUrl ||
    !/^0x[\da-fA-F]{40}$/.test(arenaAddress ?? "") ||
    !/^\d+$/.test(deploymentBlock ?? "")
  ) {
    throw new Error(
      "Deployment publication requires an RPC URL, Arena address, and block number.",
    );
  }
  await writeChanged(
    deploymentFile,
    JSON.stringify(
      {
        chainId: 31337,
        rpcUrl,
        arenaAddress,
        deploymentBlock,
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Frontend local account connection published.");
}

const command = process.argv[2];
if (command === "abi") await exportAbi();
else if (command === "ready") await requireCurrentDeployment();
else if (command === "publish") await publishDeployment();
else if (command === "clear") await rm(deploymentFile, { force: true });
else
  throw new Error(
    "Expected an internal abi, ready, publish, or clear operation.",
  );
