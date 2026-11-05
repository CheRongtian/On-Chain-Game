import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readJson, saveJson } from "./deployment.mjs";
import { distribution, prepareRelease, retainRelease } from "./release.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = process.env.ARENA_TEST_PROJECT_ROOT === workspace;
const root = isolated ? resolve(workspace, "../..") : workspace;
const frozen = resolve(root, ".local/baseline");
const engines = { anvil: ".local/chain", geth: ".local/archive" };
const inputs = [
  "contracts/foundry.toml",
  "server/internal/indexer/schema.sql",
  "server/go.mod",
  "server/go.sum",
  "client/package.json",
  "client/package-lock.json",
];

async function exists(file) {
  return stat(file).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function accepted(directory, expectedStatus = "passed") {
  const summary = await readJson(resolve(directory, ".local/acceptance.json"));
  if (summary.status !== expectedStatus)
    throw new Error("A baseline requires complete successful acceptance.");
  for (const item of summary.items) {
    const report = await readJson(resolve(directory, item.report));
    if (item.status !== "passed" || report.status !== "passed")
      throw new Error(`Baseline evidence did not pass: ${item.name}.`);
  }
  for (const name of [
    "confirmed-recovery",
    "history-archive",
    "source-reproduction",
    "historical-accounts",
  ]) {
    if (summary.requirements[name] !== "passed")
      throw new Error(`Baseline requirement did not pass: ${name}.`);
  }
  return summary;
}

async function capture(directory, summary) {
  if (await exists(resolve(frozen, "baseline.json"))) return;
  await mkdir(dirname(frozen), { recursive: true });
  const staging = await mkdtemp(frozen + "-");
  try {
    for (const file of inputs) {
      const target = resolve(staging, "inputs", file);
      await mkdir(dirname(target), { recursive: true });
      await cp(resolve(directory, file), target);
    }
    await cp(resolve(directory, "config"), resolve(staging, "inputs/config"), {
      recursive: true,
    });
    const deployments = {};
    for (const [engine, path] of Object.entries(engines)) {
      const manifest = await readJson(
        resolve(directory, path, "deployment.json"),
      );
      await saveJson(
        resolve(staging, "deployments", `${engine}.json`),
        manifest,
      );
      deployments[engine] = manifest.deployment;
    }
    const daily = resolve(root, ".local/archive/deployment.json");
    if (await exists(daily)) {
      await cp(daily, resolve(staging, "deployments/daily.json"));
    }
    const reports = [];
    for (const item of summary.items) {
      const relative = `evidence/${item.report.replace(/^\.local\//, "")}`;
      const target = resolve(staging, relative);
      await mkdir(dirname(target), { recursive: true });
      await cp(resolve(directory, item.report), target);
      reports.push({ ...item, report: relative });
    }
    await cp(
      resolve(directory, ".local/safety/gas.snapshot"),
      resolve(staging, "gas.snapshot"),
    );
    await cp(
      resolve(directory, ".local/safety/toolchain.txt"),
      resolve(staging, "toolchain.txt"),
    );
    const measured = resolve(directory, ".local/regression/acceptance.json");
    if (await exists(measured)) {
      const report = await readJson(measured);
      await cp(
        resolve(directory, ".local/regression/database-schema.sql"),
        resolve(staging, "database-schema.sql"),
      );
      await saveJson(
        resolve(staging, "measurements.json"),
        report.measurements,
      );
    }
    await saveJson(resolve(staging, "acceptance.json"), summary);
    await saveJson(resolve(staging, "baseline.json"), {
      recordedAt: new Date().toISOString(),
      acceptedAt: summary.checkedAt,
      environment:
        "isolated local acceptance; Anvil fault regression and Geth archive gameplay",
      dailyDeployment: (await exists(daily))
        ? "deployments/daily.json; saved identity, not a live-node check"
        : null,
      deployments,
      reports,
      schema: "inputs/server/internal/indexer/schema.sql",
    });
    await rename(staging, frozen);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function protocol(manifest) {
  return {
    chainId: manifest.deployment.chainId,
    compiler: manifest.deployment.compiler,
    rulesHash: manifest.deployment.rulesHash,
    compilerInput: manifest.compilerInput,
    abi: JSON.parse(manifest.artifact.rawMetadata).output.abi,
    creationBytecode: manifest.artifact.bytecode.object,
    vectors: manifest.vectors,
  };
}

async function check() {
  const summary = await accepted(workspace, "pending-cleanup");
  const reference = await exists(resolve(frozen, "baseline.json"));
  if (reference) {
    for (const [engine, directory] of Object.entries(engines)) {
      const before = protocol(
        await readJson(resolve(frozen, "deployments", `${engine}.json`)),
      );
      const current = protocol(
        await readJson(resolve(workspace, directory, "deployment.json")),
      );
      for (const field of Object.keys(before)) {
        if (!isDeepStrictEqual(current[field], before[field]))
          throw new Error(
            `${engine} ${field} differs from the frozen baseline. The baseline was retained.`,
          );
      }
    }
    for (const file of [
      "contracts/foundry.toml",
      "server/internal/indexer/schema.sql",
    ]) {
      if (
        (await readFile(resolve(workspace, file), "utf8")) !==
        (await readFile(resolve(frozen, "inputs", file), "utf8"))
      )
        throw new Error(
          `${file} differs from the frozen baseline. Review the change before updating its baseline.`,
        );
    }
    const manifest = await readJson(resolve(frozen, "deployments/geth.json"));
    for (const [name, value] of Object.entries(manifest.vectors)) {
      if (
        !isDeepStrictEqual(
          await readJson(resolve(workspace, "config", `${name}.json`)),
          value,
        )
      )
        throw new Error(
          `Current ${name} differs from the frozen rule vectors.`,
        );
    }
  }
  const measurements = {
    recordedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    environments: {},
  };
  for (const engine of Object.keys(engines)) {
    const gameplay = await readJson(
      resolve(workspace, `.local/browser/gameplay-${engine}.json`),
    );
    const recovery = await readJson(
      resolve(workspace, `.local/browser/recovery-${engine}.json`),
    );
    const timings = gameplay.timings;
    if (
      !timings ||
      !timings.matches.length ||
      !timings.indexing.length ||
      !timings.verification.length
    )
      throw new Error(`${engine} baseline measurements are incomplete.`);
    const confirmation = gameplay.receipts
      .map((item) => item.confirmationMilliseconds)
      .filter((value) => value !== null && value !== undefined);
    if (!confirmation.length)
      throw new Error(`${engine} has no measured confirmations.`);
    measurements.environments[engine] = {
      browser: gameplay.browser,
      measurementScope: gameplay.measurementScope,
      confirmation: distribution(confirmation),
      unobservedReceiptTimings: gameplay.receipts.length - confirmation.length,
      indexing: distribution(
        timings.indexing.map((item) => item.durationMilliseconds),
      ),
      verification: distribution(
        timings.verification.map((item) => item.durationMilliseconds),
      ),
      automatedMatches: timings.matches,
      recovery: recovery.checks,
    };
  }
  const previous = (await exists(resolve(frozen, "measurements.json")))
    ? await readJson(resolve(frozen, "measurements.json"))
    : null;
  await saveJson(resolve(workspace, ".local/regression/acceptance.json"), {
    status: "passed",
    protocol: reference ? "unchanged" : "initial successful reference",
    regressions: summary.items,
    measurements,
    referenceMeasurements: previous,
  });
  await saveJson(resolve(workspace, ".local/acceptance.json"), {
    ...summary,
    baseline: { status: "passed", report: ".local/regression/acceptance.json" },
  });
  await prepareRelease(workspace, frozen);
  console.log(
    "PASS: baseline ABI, rules, vectors, compiler input, schema and all regression evidence agree.",
  );
  for (const [engine, values] of Object.entries(measurements.environments)) {
    console.log(
      `Baseline ${engine}: confirmation median=${values.confirmation.medianMilliseconds}ms; index catch-up median=${values.indexing.medianMilliseconds}ms; verified replay query median=${values.verification.medianMilliseconds}ms. Local automated measurements include test faults and browser overhead.`,
    );
  }
}

const command = process.argv[2];
if (command === "preserve") {
  const previous = resolve(root, ".local/test");
  if (
    !(await exists(resolve(frozen, "baseline.json"))) &&
    (await exists(resolve(previous, ".local/acceptance.json")))
  ) {
    const summary = await readJson(resolve(previous, ".local/acceptance.json"));
    if (summary.status === "passed")
      await capture(previous, await accepted(previous));
  }
} else {
  if (!isolated)
    throw new Error(
      "Baseline recording belongs to the isolated backend test entry.",
    );
  if (command === "check") await check();
  else if (command === "retain") {
    const summary = await accepted(workspace, "pending-cleanup");
    if (summary.baseline?.status !== "passed")
      throw new Error("Baseline comparison did not finish.");
    summary.status = "passed";
    summary.cleanup = {
      status: "passed",
      finishedAt: new Date().toISOString(),
    };
    await capture(workspace, summary);
    if (!(await exists(resolve(frozen, "measurements.json")))) {
      const report = await readJson(
        resolve(workspace, ".local/regression/acceptance.json"),
      );
      await cp(
        resolve(workspace, ".local/regression/database-schema.sql"),
        resolve(frozen, "database-schema.sql"),
      );
      await saveJson(resolve(frozen, "measurements.json"), report.measurements);
    }
    await saveJson(resolve(workspace, ".local/acceptance.json"), summary);
    await retainRelease(workspace, root);
    console.log(
      "PASS: successful baseline and original evidence retained outside the disposable test workspace.",
    );
  } else
    throw new Error(
      "Expected an internal baseline preserve, check, or retain operation.",
    );
}
