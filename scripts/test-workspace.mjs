import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(root, ".local/test");
try {
  const pid = Number(
    await readFile(resolve(workspace, ".local/backend.pid"), "utf8"),
  );
  process.kill(pid, 0);
  throw new Error(
    "The isolated acceptance environment is already running. Let it finish first.",
  );
} catch (error) {
  if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
}
const processes = [];
for (const engine of ["anvil", "geth"]) {
  try {
    const pid = Number(
      await readFile(resolve(workspace, `.local/${engine}.pid`), "utf8"),
    );
    const previous = await readFile(resolve(workspace, ".env"), "utf8");
    const port = previous.match(/^ARENA_RPC_PORT=(\d+)$/m)?.[1];
    if (port) processes.push({ pid, port });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
try {
  const legacy = JSON.parse(
    await readFile(
      resolve(workspace, ".local/chain/legacy-process.json"),
      "utf8",
    ),
  );
  processes.push({ pid: legacy.pid, port: new URL(legacy.rpcUrl).port });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
for (const { pid, port } of processes) {
  try {
    execFileSync(
      "lsof",
      ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN"],
      { stdio: "ignore" },
    );
  } catch (error) {
    if (error.status !== 1) throw error;
    continue;
  }
  process.kill(pid, "SIGCONT");
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      break;
    }
    if (Date.now() >= deadline)
      throw new Error(
        "An old acceptance node is still using its data; the workspace was retained.",
      );
    await new Promise((done) => setTimeout(done, 100));
  }
}
const cache = resolve(root, ".local/test-build");
const reusable = [
  ".local/bin",
  ".local/vite",
  ".local/frontend-build.json",
  ".local/safety/foundry-fuzz",
  ".local/safety/foundry-invariant",
  ".local/safety/squad-failures",
  "contracts/out",
  "contracts/cache",
  "client/dist",
];
for (const name of reusable) {
  const previous = resolve(workspace, name);
  const present = await stat(previous).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!present) continue;
  const target = resolve(cache, name);
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await rename(previous, target);
}
// Clear chain/database evidence while retaining independently checked build inputs and outputs.
await rm(workspace, { recursive: true, force: true });
await mkdir(workspace, { recursive: true });
const excluded = new Set([
  "node_modules",
  ".local",
  "dist",
  "out",
  "cache",
  "broadcast",
  "deployment.json",
  "legacy-deployment.json",
]);
for (const name of [
  "scripts",
  "config",
  "server",
  "contracts",
  "client",
  "compose.yaml",
  "Dockerfile",
  ".dockerignore",
])
  await cp(resolve(root, name), resolve(workspace, name), {
    recursive: true,
    preserveTimestamps: true,
    filter: (file) =>
      !excluded.has(file.split("/").at(-1)) &&
      !file.split("/").at(-1).startsWith(".env"),
  });
for (const name of reusable) {
  const source = resolve(cache, name);
  const present = await stat(source).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!present) continue;
  const target = resolve(workspace, name);
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
}
await rm(cache, { recursive: true, force: true });
await mkdir(resolve(workspace, ".local/bin"), { recursive: true });
await rm(resolve(workspace, ".local/bin/solc-0.8.30"), { force: true });
await symlink(
  resolve(root, ".local/bin/solc-0.8.30"),
  resolve(workspace, ".local/bin/solc-0.8.30"),
);
await symlink(
  resolve(root, "client/node_modules"),
  resolve(workspace, "client/node_modules"),
);

// Hold all four reservations together so each service gets a distinct available port.
const servers = [];
try {
  for (let i = 0; i < 4; i++) {
    const server = createServer();
    await new Promise((done, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", done);
    });
    servers.push(server);
  }
  const [rpc, database, api, browser] = servers.map(
    (server) => server.address().port,
  );
  await writeFile(
    resolve(workspace, ".env"),
    `ARENA_COMPOSE_PROJECT=onchain-arena-test\nARENA_RPC_PORT=${rpc}\nARENA_DATABASE_PORT=${database}\nHTTP_ADDRESS=127.0.0.1:${api}\nARENA_BROWSER_PORT=${browser}\nARENA_DATABASE_PASSWORD=arena_acceptance\nKEEPER_ENABLED=true\nCONFIRMATION_DEPTH=0\nKEEPER_PRIVATE_KEY=${"0".repeat(63)}3\n`,
    { mode: 0o600 },
  );
  console.log(
    `Acceptance workspace prepared with independent chain, database, and ports (${rpc}, ${database}, ${api}, ${browser}).`,
  );
} finally {
  await Promise.all(
    servers.map((server) => new Promise((done) => server.close(done))),
  );
}
