import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
try {
  const pid = Number(
    await readFile(resolve(workspace, ".local/anvil.pid"), "utf8"),
  );
  const previous = await readFile(resolve(workspace, ".env"), "utf8");
  const port = previous.match(/^ARENA_RPC_PORT=(\d+)$/m)?.[1];
  if (port) {
    let listening = false;
    try {
      execFileSync(
        "lsof",
        ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN"],
        { stdio: "ignore" },
      );
      listening = true;
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    if (listening) {
      process.kill(pid, "SIGCONT");
      process.kill(pid, "SIGTERM");
      await new Promise((done) => setTimeout(done, 250));
    }
  }
} catch (error) {
  if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
}
// Recreate only this launcher's disposable source copy; daily data stays outside it.
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
    filter: (file) =>
      !excluded.has(file.split("/").at(-1)) &&
      !file.split("/").at(-1).startsWith(".env"),
  });
await mkdir(resolve(workspace, ".local/bin"), { recursive: true });
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
