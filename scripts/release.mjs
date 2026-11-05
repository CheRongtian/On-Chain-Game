import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { readJson, saveJson } from "./deployment.mjs";
import { acceptanceReports, browserEngines } from "./acceptance.mjs";

export function distribution(values, unit = "Milliseconds") {
  if (!values.length) return null;
  assert.ok(
    values.every((value) => Number.isFinite(value) && value >= 0),
    "A measurement is missing or invalid.",
  );
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    samples: sorted.length,
    [`minimum${unit}`]: sorted[0],
    [`median${unit}`]:
      sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2,
    [`maximum${unit}`]: sorted.at(-1),
  };
}

const interfaces = [
  {
    boundary:
      "Authoritative battle rules, action encoding, commitments, state hashes and events",
    sources: [
      "contracts/src/IArena.sol",
      "contracts/src/GameTypes.sol",
      "contracts/src/GameHash.sol",
      "config/protocol-vectors.json",
    ],
    evidence:
      "Unchanged frozen compiler input, ABI, rule vectors and independent Solidity/Go comparisons.",
    requirement:
      "New rules require a separate deployment; old games retain their original rules and interpretation.",
  },
  {
    boundary: "Deployment identity, receipt queries and historical accounts",
    sources: [
      "scripts/deployment.mjs",
      "server/internal/indexer/chain_details.go",
      "client/src/lib/arena.ts",
    ],
    evidence:
      "Both node sources, retained receipts, crash recovery and Geth historical account acceptance.",
    requirement:
      "Keep chain, contract and deployment identity attached to every query and stored secret.",
  },
  {
    boundary: "Public history, replay, independent verification and updates",
    sources: [
      "server/internal/indexer/http.go",
      "server/internal/indexer/replay_http.go",
      "server/internal/indexer/stream.go",
      "client/src/lib/history.ts",
    ],
    evidence:
      "Verified games, controlled mismatch/reorganization, event resumption and database rebuild acceptance.",
    requirement:
      "Retain pagination, source blocks, confirmation status and honest Verified/Mismatch/Incomplete results.",
  },
  {
    boundary: "Player signing and browser-only order recovery",
    sources: [
      "client/src/lib/secrets.ts",
      "client/src/stores/transaction.ts",
      "client/src/stores/battle.ts",
    ],
    evidence:
      "Signed receipts, save-before-send, encrypted import/export, account isolation and refresh acceptance.",
    requirement:
      "Preserve the original secret context and pending transaction hash; public services never take custody of unrevealed orders.",
  },
  {
    boundary:
      "Database recovery, public progression and the two startup entries",
    sources: [
      "scripts/run-backend.sh",
      "scripts/run-frontend.sh",
      "scripts/database-backup.mjs",
      "server/internal/indexer/schema.sql",
    ],
    evidence:
      "Real backup/restore, original Keeper transaction identities and full projection rebuild comparisons.",
    requirement:
      "Keep ordinary data separate from fault acceptance and preserve existing games during any future schema change.",
  },
];

async function optionalJson(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

export async function prepareRelease(workspace, frozen) {
  const acceptance = await readJson(
    resolve(workspace, ".local/acceptance.json"),
  );
  assert.equal(acceptance.status, "pending-cleanup");
  assert.equal(acceptance.baseline.status, "passed");
  assert.deepEqual(
    acceptance.items.map(({ name, report }) => [name, report]),
    acceptanceReports,
    "The release must contain every required acceptance group.",
  );
  const regression = await readJson(
    resolve(workspace, ".local/regression/acceptance.json"),
  );
  const reference = regression.referenceMeasurements;
  const safety = await readJson(
    resolve(workspace, ".local/safety/acceptance.json"),
  );
  const previousSafety = await optionalJson(
    resolve(frozen, "evidence/safety/acceptance.json"),
  );
  const measurements = {};
  const deployments = {};
  for (const engine of ["anvil", "geth"]) {
    const manifest = await readJson(
      resolve(
        workspace,
        engine === "geth"
          ? ".local/archive/deployment.json"
          : ".local/chain/deployment.json",
      ),
    );
    const {
      chainId,
      arenaAddress,
      deploymentHash,
      deploymentBlock,
      transactionHash,
      rulesHash,
      deployedAt,
      compiler,
    } = manifest.deployment;
    deployments[engine] = {
      chainId,
      arenaAddress,
      deploymentHash,
      deploymentBlock,
      transactionHash,
      rulesHash,
      deployedAt,
      compiler,
    };
    const gameplay = await readJson(
      resolve(workspace, `.local/browser/gameplay-${engine}.json`),
    );
    assert.equal(gameplay.status, "passed");
    assert.equal(
      gameplay.replayChecks.attempted,
      gameplay.replayChecks.verified,
    );
    assert.ok(gameplay.replayChecks.attempted > 0);
    const gas = {};
    for (const operation of new Set(
      gameplay.receipts.map((receipt) => receipt.operation),
    )) {
      assert.ok(
        operation,
        "Every measured receipt must identify its operation.",
      );
      gas[operation] = distribution(
        gameplay.receipts
          .filter((receipt) => receipt.operation === operation)
          .map((receipt) => receipt.gasUsed),
        "Gas",
      );
    }
    const current = regression.measurements.environments[engine];
    const previous = reference?.environments[engine];
    const previousGameplay = await optionalJson(
      resolve(frozen, `evidence/browser/gameplay-${engine}.json`),
    );
    const comparison = {};
    for (const name of ["confirmation", "indexing", "verification"]) {
      const comparable =
        typeof previous?.measurementScope?.[name] === "string" &&
        previous.measurementScope[name] === current.measurementScope[name];
      comparison[name] = {
        current: current[name],
        reference: previous?.[name] ?? null,
        comparable,
        reason: comparable
          ? "Same recorded measurement boundaries; local machine load can still differ."
          : "The retained older sample does not establish the same scenario and timing boundaries. Values are historical observations only.",
        medianDeltaMilliseconds:
          comparable && previous?.[name]
            ? current[name].medianMilliseconds -
              previous[name].medianMilliseconds
            : null,
      };
    }
    measurements[engine] = {
      comparison,
      automatedMatches: gameplay.timings.matches,
      referenceAutomatedMatches: previous?.automatedMatches ?? null,
      measurementScope: gameplay.measurementScope,
      confirmationByCondition: Object.fromEntries(
        ["normal", "controlled-faults"].map((condition) => [
          condition,
          distribution(
            gameplay.receipts
              .filter(
                (receipt) =>
                  receipt.conditions === condition &&
                  receipt.confirmationMilliseconds != null,
              )
              .map((receipt) => receipt.confirmationMilliseconds),
          ),
        ]),
      ),
      normalMatchPlay: distribution(
        gameplay.timings.matches
          .filter((match) => match.conditions === "normal")
          .map((match) => match.playMilliseconds),
      ),
      faultInjectedMatchPlay: distribution(
        gameplay.timings.matches
          .filter((match) => match.conditions === "controlled-faults")
          .map((match) => match.playMilliseconds),
      ),
      normalRound: distribution(
        gameplay.timings.rounds
          .filter((round) => round.conditions === "normal")
          .map((round) => round.durationMilliseconds),
      ),
      faultInjectedRound: distribution(
        gameplay.timings.rounds
          .filter((round) => round.conditions === "controlled-faults")
          .map((round) => round.durationMilliseconds),
      ),
      drawerResponse: distribution(
        gameplay.timings.interactions.map(
          (sample) => sample.durationMilliseconds,
        ),
      ),
      replayChecks: {
        ...gameplay.replayChecks,
        successRate:
          gameplay.replayChecks.verified / gameplay.replayChecks.attempted,
      },
      referenceReplayChecks: previousGameplay?.replayChecks ?? null,
      referenceDrawerInteractions:
        previousGameplay?.timings?.interactions ?? null,
      gasUsedByOperation: gas,
      recovery: {
        current: current.recovery,
        reference: previous?.recovery ?? null,
      },
    };
    assert.ok(
      measurements[engine].normalMatchPlay &&
        measurements[engine].faultInjectedMatchPlay &&
        measurements[engine].drawerResponse,
    );
  }
  const browsers = [];
  for (const name of browserEngines) {
    const file =
      name === "chromium" ? "gameplay-geth.json" : `gameplay-geth-${name}.json`;
    const result = await readJson(resolve(workspace, ".local/browser", file));
    assert.equal(result.status, "passed");
    assert.equal(result.browserName, name);
    assert.deepEqual(result.errors, []);
    assert.equal(result.replayChecks.attempted, result.replayChecks.verified);
    const recoveryFile =
      name === "chromium" ? "recovery-geth.json" : `recovery-geth-${name}.json`;
    const recovery = await readJson(
      resolve(workspace, ".local/browser", recoveryFile),
    );
    assert.equal(recovery.status, "passed");
    assert.equal(recovery.browserName, name);
    assert.deepEqual(recovery.errors, []);
    browsers.push({
      name,
      version: result.browser,
      checks: result.checks,
      viewports: result.viewports,
      replayChecks: result.replayChecks,
      recovery: {
        version: recovery.browser,
        checks: recovery.checks,
        events: recovery.events.length,
      },
    });
  }
  assert.deepEqual(safety.initialBudgetMisses, []);
  for (const item of interfaces)
    for (const path of item.sources) await readFile(resolve(workspace, path));
  await saveJson(resolve(workspace, ".local/release/report.json"), {
    release: "1.1.0",
    status: "pending-cleanup",
    acceptanceAt: acceptance.checkedAt,
    environment:
      "Local development accounts and fictitious ETH; Anvil fault regression and Geth archive gameplay.",
    changes: [
      "Preserved authoritative battle rules, ABI, commitments and state hashes against the original frozen reference.",
      "Improved first-round guidance, locked-plan feedback, original-receipt recovery and browser-only encrypted order recovery.",
      "Added operational metrics, bounded public reads, redacted diagnostics and real PostgreSQL backup/restore with verified rebuild comparison.",
      "Extended complete two-player acceptance to Chromium, Firefox and WebKit, including keyboard interaction and narrow replay drawers.",
      "Applied the same database, Go-process and SSE recovery acceptance to all three browser engines using real native EventSource observations.",
      "Retained actual performance, receipt Gas and replay observations with explicit measurement limits and a separate manual walkthrough.",
    ],
    deployments,
    protocol: regression.protocol,
    automatedChecks: acceptance.items,
    archiveRequirements: acceptance.requirements,
    browsers,
    measurements,
    referenceRecordedAt: reference?.recordedAt ?? null,
    referenceScope:
      "The retained successful local acceptance, not a reconstructed original product release or a human-play study. Timing conditions may differ; deltas are observations, not speed guarantees.",
    gasBudgets: {
      current: safety.gasSamples,
      reference: previousSafety?.gasSamples ?? null,
      misses: safety.initialBudgetMisses,
    },
    userErrorRate: {
      status: "not-measured",
      reason:
        "Scripted negative cases are not human mistakes. The release walkthrough records operator-reported attempted and mistaken actions; no background telemetry is added.",
    },
    interfaces,
    blockers: ["The manual walkthrough has not been recorded."],
    manualReview: {
      status: "pending",
      checks: [
        "Follow the root README in two fresh tabs: choose different accounts, create and join, start manually as host and complete one round without editing database or contract data.",
        "Inspect board and drawer readability, close controls, keyboard focus and confirmation guidance at the window size normally used.",
        "Open an existing finished game's history and replay; inspect a unit, play/pause, change speed and reach the final frame.",
      ],
    },
    limitations: [
      "Automated browser engines do not establish testing of the Safari application, physical phones or assistive technology.",
      "Match timings use scripted planning. Manual error observations describe one walkthrough and do not establish a population-wide player error rate.",
      "Local evidence does not establish public consensus, Base fees, a public explorer attestation or an independent security audit.",
    ],
  });
  console.log(
    "Release 1.1.0 automated evidence assembled; cleanup and the manual walkthrough remain required.",
  );
}

export async function retainRelease(workspace, root) {
  const acceptance = await readJson(
    resolve(workspace, ".local/acceptance.json"),
  );
  const report = await readJson(
    resolve(workspace, ".local/release/report.json"),
  );
  assert.equal(acceptance.status, "passed");
  assert.equal(acceptance.cleanup.status, "passed");
  assert.equal(acceptance.checkedAt, report.acceptanceAt);
  assert.equal(report.status, "pending-cleanup");
  report.status = "awaiting-manual-review";
  report.cleanup = acceptance.cleanup;
  const releaseRoot = resolve(root, ".local/release");
  const runName = report.acceptanceAt.replaceAll(":", "-");
  report.evidenceDirectory = `runs/${runName}`;
  await mkdir(resolve(releaseRoot, "runs"), { recursive: true });
  const staging = await mkdtemp(resolve(releaseRoot, "pending-"));
  try {
    report.evidence = [];
    for (const [name, relative] of acceptanceReports) {
      const target = `evidence/${relative.replace(/^\.local\//, "")}`;
      await mkdir(dirname(resolve(staging, target)), { recursive: true });
      await cp(resolve(workspace, relative), resolve(staging, target));
      report.evidence.push({ name, report: target });
      const result = await readJson(resolve(workspace, relative));
      for (const screenshot of result.screenshots ?? []) {
        const image = resolve(staging, "evidence/browser", screenshot);
        await mkdir(dirname(image), { recursive: true });
        await cp(resolve(workspace, ".local/browser", screenshot), image);
      }
    }
    for (const relative of [
      ".local/acceptance.json",
      ".local/regression/acceptance.json",
      ".local/regression/database-schema.sql",
      ".local/safety/gas.snapshot",
      ".local/safety/toolchain.txt",
      ".local/chain/deployment.json",
      ".local/archive/deployment.json",
    ]) {
      const target = resolve(
        staging,
        "evidence",
        relative.replace(/^\.local\//, ""),
      );
      await mkdir(dirname(target), { recursive: true });
      await cp(resolve(workspace, relative), target);
    }
    await saveJson(resolve(staging, "report.json"), report);
    await rename(staging, resolve(releaseRoot, report.evidenceDirectory));
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  await saveJson(resolve(workspace, ".local/release/report.json"), report);
  await saveJson(resolve(releaseRoot, "report.json"), report);
  await recordAcceptanceOutcome(workspace, root);
  console.log(
    `Release evidence bundle retained: ${resolve(releaseRoot, report.evidenceDirectory)}`,
  );
  console.log(
    "PASS: local release evidence retained after cleanup. Complete the README walkthrough, then run ./scripts/run-backend.sh release to record it.",
  );
}

export async function recordAcceptanceOutcome(workspace, root) {
  const acceptance = await readJson(
    resolve(workspace, ".local/acceptance.json"),
  );
  await saveJson(resolve(root, ".local/release/latest-acceptance.json"), {
    status: acceptance.status,
    checkedAt: acceptance.checkedAt ?? null,
    cleanup: acceptance.cleanup ?? null,
    finishedAt: new Date().toISOString(),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const root =
    process.env.ARENA_TEST_PROJECT_ROOT === workspace
      ? resolve(workspace, "../..")
      : workspace;
  const command = process.argv[2];
  if (command === "begin") {
    await saveJson(resolve(root, ".local/release/latest-acceptance.json"), {
      status: "running",
      startedAt: new Date().toISOString(),
    });
  } else if (command === "record-outcome") {
    await recordAcceptanceOutcome(workspace, root);
  } else if (command) throw new Error("Unknown internal release operation.");
  else {
    const path = resolve(root, ".local/release/report.json");
    const report = await optionalJson(path);
    assert.ok(
      report,
      "Run ./scripts/run-backend.sh test successfully before recording a release walkthrough.",
    );
    const latest = await readJson(
      resolve(root, ".local/release/latest-acceptance.json"),
    );
    assert.equal(
      latest.status,
      "passed",
      "The latest automated attempt did not pass. Earlier release evidence was retained as history.",
    );
    assert.equal(
      latest.checkedAt,
      report.acceptanceAt,
      "The retained release must match the latest successful acceptance.",
    );
    for (const item of report.evidence) {
      const result = await readJson(
        resolve(root, ".local/release", report.evidenceDirectory, item.report),
      );
      assert.equal(
        result.status,
        "passed",
        `Retained evidence failed: ${item.name}`,
      );
    }
    if (report.status === "passed")
      console.log(
        `Local release ${report.release} already has automated evidence and a recorded manual walkthrough.`,
      );
    else {
      assert.equal(report.status, "awaiting-manual-review");
      console.log(
        `Local release ${report.release}: automated acceptance and cleanup passed. Confirm only checks you actually completed:`,
      );
      for (const [index, check] of report.manualReview.checks.entries())
        console.log(`${index + 1}. ${check}`);
      const input = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const browser = (
          await input.question(
            "Browser name and version used for this walkthrough: ",
          )
        ).trim();
        assert.ok(
          browser,
          "Record the browser before approving the walkthrough.",
        );
        const attemptedText = (
          await input.question(
            "Intended player interactions attempted during the walkthrough: ",
          )
        ).trim();
        const mistakesText = (
          await input.question(
            "Of those, interactions mistaken, unexpectedly failed, or needing help: ",
          )
        ).trim();
        const attempted = Number(attemptedText),
          mistakes = Number(mistakesText);
        assert.ok(
          attemptedText && Number.isSafeInteger(attempted) && attempted > 0,
          "Enter the actual positive number of attempted interactions.",
        );
        assert.ok(
          mistakesText &&
            Number.isSafeInteger(mistakes) &&
            mistakes >= 0 &&
            mistakes <= attempted,
          "Enter an actual mistake count from zero through the attempted count.",
        );
        const notes = mistakes
          ? (
              await input.question(
                "Describe those interactions and their recovery: ",
              )
            ).trim()
          : "No mistaken or unexpectedly failed interactions reported.";
        assert.ok(
          notes,
          "Describe the observed mistakes before recording the walkthrough.",
        );
        if (
          (
            await input.question(
              "Type release if all three checks passed, or press Enter to leave them pending: ",
            )
          ).trim() === "release"
        ) {
          report.manualReview = {
            ...report.manualReview,
            status: "passed",
            browser,
            recordedAt: new Date().toISOString(),
            method:
              "Operator-reported manual walkthrough; automated engine coverage is recorded separately.",
          };
          report.status = "passed";
          report.blockers = [];
          report.userErrorRate = {
            status: "measured-walkthrough",
            attempted,
            mistakes,
            rate: mistakes / attempted,
            notes,
            source: "Operator-reported short walkthrough",
            reference: null,
            limitation:
              "No comparable original human sample exists; this is not a population estimate.",
          };
          await saveJson(
            resolve(
              root,
              ".local/release",
              report.evidenceDirectory,
              "report.json",
            ),
            report,
          );
          await saveJson(path, report);
          console.log(
            `PASS: local release ${report.release}; automated evidence and manual walkthrough recorded.`,
          );
        } else console.log("Manual review remains pending.");
      } finally {
        input.close();
      }
    }
  }
}
