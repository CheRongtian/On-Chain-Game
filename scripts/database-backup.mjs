import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, rename, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readJson, saveJson } from "./deployment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compose = [
  "compose",
  "--project-name",
  process.env.ARENA_COMPOSE_PROJECT || "onchain-arena",
  "--project-directory",
  root,
  "-f",
  resolve(root, "compose.yaml"),
];

function diagnostic(message) {
  for (const name of [
    "PGPASSWORD",
    "ARENA_DATABASE_PASSWORD",
    "KEEPER_PRIVATE_KEY",
  ])
    if (process.env[name])
      message = message.replaceAll(process.env[name], "[redacted]");
  return message;
}

export async function databaseCommand(args, { input, output } = {}) {
  const source = input ? await open(input, "r") : undefined;
  const target = output ? await open(output, "wx", 0o600) : undefined;
  try {
    return await new Promise((done, fail) => {
      const child = spawn("docker", [...compose, ...args], {
        stdio: [source?.fd ?? "ignore", target?.fd ?? "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout?.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr = (stderr + data).slice(-64 * 1024);
      });
      child.on("error", fail);
      child.on("close", (code) =>
        code === 0
          ? done(stdout.trim())
          : fail(
              new Error(
                `Project database operation failed: ${diagnostic(stderr)}`,
              ),
            ),
      );
    });
  } finally {
    if (target) {
      await target.sync();
      await target.close();
    }
    await source?.close();
  }
}

export function databaseSQL(query) {
  return databaseCommand([
    "exec",
    "-T",
    "db",
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "arena",
    "-d",
    "onchain_arena",
    "-Atc",
    query,
  ]);
}

async function publishedSources() {
  const sources = [];
  for (const name of ["deployment.json", "legacy-deployment.json"]) {
    const data = await readJson(resolve(root, "client/public", name)).catch(
      (error) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    if (data)
      sources.push({
        chainId: data.chainId,
        arena: data.arenaAddress.toLowerCase(),
        deploymentBlock: String(data.deploymentBlock),
        deploymentHash: data.deploymentHash,
        deployedAt: data.deployedAt,
      });
  }
  if (!sources.length)
    throw new Error(
      "No saved deployment is available. Start the backend normally before taking a database backup.",
    );
  return sources.sort((a, b) =>
    a.deploymentHash.localeCompare(b.deploymentHash),
  );
}

async function indexedSources() {
  if (
    (await databaseSQL(
      "SELECT to_regclass('public.deployments') IS NOT NULL",
    )) !== "t"
  )
    return [];
  return JSON.parse(
    await databaseSQL(
      `SELECT COALESCE(json_agg(json_build_object('chainId',chain_id::text,'arena',arena,'deploymentBlock',deployment_block::text,'deploymentHash',deployment_hash) ORDER BY deployment_hash),'[]'::json) FROM deployments`,
    ),
  );
}

function requireSources(published, indexed) {
  for (const source of published)
    if (
      !indexed.some(
        (entry) =>
          String(entry.chainId) === String(source.chainId) &&
          entry.arena === source.arena &&
          entry.deploymentBlock === source.deploymentBlock &&
          entry.deploymentHash === source.deploymentHash,
      )
    )
      throw new Error(
        "The database does not contain the saved deployment. Preserve the current data and inspect the deployment before continuing.",
      );
}

export async function backupDatabase(prefix = "database-") {
  const published = await publishedSources();
  const indexed = await indexedSources();
  requireSources(published, indexed);
  return dumpDatabase(prefix, published, indexed);
}

async function dumpDatabase(prefix, published, indexed) {
  const parent = resolve(root, ".local/backups");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(
    resolve(
      parent,
      `${prefix}${new Date().toISOString().replaceAll(":", "-")}-`,
    ),
  );
  const temporary = resolve(directory, "database.partial");
  await databaseCommand(
    [
      "exec",
      "-T",
      "db",
      "pg_dump",
      "-U",
      "arena",
      "-d",
      "onchain_arena",
      "--format=custom",
      "--no-owner",
      "--no-privileges",
    ],
    { output: temporary },
  );
  await rename(temporary, resolve(directory, "database.dump"));
  await saveJson(resolve(directory, "backup.json"), {
    completedAt: new Date().toISOString(),
    published,
    indexed,
  });
  console.log(`Database backup saved: ${directory}`);
  return directory;
}

export async function restoreDatabase(directory) {
  directory = resolve(directory);
  if (await databaseCommand(["ps", "--status", "running", "--services", "api"]))
    throw new Error(
      "Stop the backend with Ctrl+C and wait for its shutdown before restoring. The API and Keeper must stay stopped.",
    );
  const record = await readJson(resolve(directory, "backup.json"));
  const published = await publishedSources();
  if (!record.completedAt || !isDeepStrictEqual(record.published, published))
    throw new Error(
      "This backup belongs to a different chain or deployment. Restore its matching node data and deployment files before restoring its database.",
    );
  if (!Array.isArray(record.indexed))
    throw new Error(
      "The backup lacks its original database deployment record.",
    );
  const dump = resolve(directory, "database.dump");
  if (!(await stat(dump)).size)
    throw new Error("The database dump is empty. Existing data was retained.");
  await databaseCommand(["exec", "-T", "db", "pg_restore", "--list"], {
    input: dump,
  });
  const previous = await dumpDatabase(
    "before-restore-",
    published,
    await indexedSources(),
  );
  console.log(
    "Restoring project database objects in one transaction. The API and Keeper remain stopped.",
  );
  try {
    await databaseCommand(
      [
        "exec",
        "-T",
        "db",
        "pg_restore",
        "--clean",
        "--if-exists",
        "--single-transaction",
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "-U",
        "arena",
        "-d",
        "onchain_arena",
      ],
      { input: dump },
    );
    if (!isDeepStrictEqual(await indexedSources(), record.indexed))
      throw new Error(
        "Restored deployment records differ from the backup metadata.",
      );
  } catch (error) {
    throw new Error(
      `${error.message} Recovery backup: ${previous}. Keep the backend stopped until the database is recovered.`,
    );
  }
  console.log(`Database restored. Recovery backup retained: ${previous}`);
  return previous;
}

async function main() {
  const operation = process.argv[2];
  if (
    !["backup", "restore"].includes(operation) ||
    (operation === "restore"
      ? process.argv.length !== 4
      : process.argv.length !== 3)
  )
    throw new Error(
      "Use the backend entry with backup, or restore followed by a backup directory.",
    );
  if (
    operation === "restore" &&
    (await databaseCommand(["ps", "--status", "running", "--services", "api"]))
  )
    throw new Error(
      "Stop the backend with Ctrl+C before restoring its database.",
    );
  const running = !!(await databaseCommand([
    "ps",
    "--status",
    "running",
    "--services",
    "db",
  ]));
  try {
    if (!running)
      await databaseCommand([
        "up",
        "-d",
        "--wait",
        "--no-build",
        "--pull",
        "never",
        "db",
      ]);
    if (operation === "backup") await backupDatabase();
    else await restoreDatabase(process.argv[3]);
  } finally {
    if (!running) await databaseCommand(["stop", "db"]);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main().catch((error) => {
    console.error(diagnostic(error.message));
    process.exitCode = 1;
  });
