import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createPublicClient, createWalletClient, http, parseEventLogs } from 'viem';
import { anvil } from 'viem/chains';
import { installedBrowser } from './browser.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = resolve(root, '.local/browser');
const binary = resolve(root, '.local/bin/arena-server');
const run = promisify(execFile);
const backend = `http://${process.env.HTTP_ADDRESS || '127.0.0.1:8080'}`;
const base = 'http://127.0.0.1:5174';
const acceptance = JSON.parse(
  await readFile(resolve(root, '.local/indexer/acceptance.json'), 'utf8'),
);
assert.equal(acceptance.status, 'passed', 'Backend acceptance must pass before browser recovery.');
const deployment = JSON.parse(
  await readFile(resolve(root, 'client/public/deployment.json'), 'utf8'),
);
const { abi } = JSON.parse(
  await readFile(resolve(root, 'contracts/out/Arena.sol/Arena.json'), 'utf8'),
);
const chain = createPublicClient({
  chain: anvil,
  transport: http(deployment.rpcUrl),
  cacheTime: 0,
});
const wallet = createWalletClient({ chain: anvil, transport: http(deployment.rpcUrl) });
const report = {
  status: 'running',
  checks: [],
  events: [],
  errors: [],
  connections: [],
  startedAt: new Date().toISOString(),
};
await mkdir(output, { recursive: true });
let server, browser, page, context, keeper, keeperExited, accounts, original, baseline;
let databaseStopped = false,
  interrupted = false,
  cleaning = false,
  dropEvents = false;
let releaseReads,
  readGate,
  delayedMatch,
  blockedReads = 0,
  replayReads = 0,
  documentLoads = 0,
  rejectedStreams = 0;
const streamRequests = [];
const streams = new Set();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true;
    void browser?.close();
  });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(check, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interrupted && !cleaning) throw new Error('Browser recovery acceptance interrupted.');
    if (await check()) return;
    await pause(100);
  }
  throw new Error(message);
}
function passed(name, started) {
  const durationMilliseconds = Date.now() - started;
  report.checks.push({ name, durationMilliseconds });
  console.log(`PASS: browser ${name} in ${durationMilliseconds}ms.`);
}
async function api(path) {
  const response = await fetch(`${backend}${path}`, { signal: AbortSignal.timeout(35_000) });
  assert.equal(response.status, 200, `API ${path}`);
  return response.json();
}
async function ready(previousPID) {
  const block = await chain.getBlock();
  let meta;
  await waitFor(async () => {
    try {
      const response = await fetch(`${backend}/ready`, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return false;
      meta = await response.json();
      return (
        meta.deploymentHash === acceptance.deploymentHash &&
        meta.indexedHash === block.hash &&
        meta.indexedBlock === Number(block.number) &&
        (previousPID === undefined || meta.processId !== previousPID)
      );
    } catch {
      return false;
    }
  }, 'Backend did not recover at the current canonical block.');
  return meta;
}
async function databaseState() {
  const { stdout } = await run(binary, ['browser-fault', 'database-state'], {
    cwd: resolve(root, 'server'),
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}
async function launchctl(...args) {
  return run('/usr/bin/sudo', ['-n', '/bin/launchctl', ...args, 'system/postgresql-16'], {
    timeout: 20_000,
  });
}
async function startDatabase() {
  if (!databaseStopped) return;
  await waitFor(async () => {
    const { stdout } = await launchctl('print');
    return !/^\s*pid = [1-9]\d*\s*$/m.test(stdout);
  }, 'PostgreSQL did not finish its requested shutdown.');
  console.log('Starting the existing PostgreSQL 16 service again...');
  await launchctl('kickstart');
  databaseStopped = false;
  await ready();
}
async function holdKeeper() {
  let available = false,
    failure;
  keeper = spawn(binary, ['browser-fault', 'hold-keeper'], {
    cwd: resolve(root, 'server'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  keeperExited = new Promise((done) => keeper.once('close', done));
  keeper.on('error', (error) => {
    failure = error;
  });
  keeper.stdout.on('data', () => {
    available = true;
  });
  keeper.stderr.on('data', (data) => process.stderr.write(data));
  await waitFor(() => {
    if (failure) throw failure;
    if (keeper.exitCode !== null)
      throw new Error('Could not pause Keeper for browser branch acceptance.');
    return available;
  }, 'Keeper acceptance lock was not acquired.');
}
async function send(player, functionName, args) {
  const hash = await wallet.writeContract({
    abi,
    address: deployment.arenaAddress,
    functionName,
    args,
    account: accounts[player],
    gas: 8_000_000n,
  });
  const receipt = await chain.waitForTransactionReceipt({
    hash,
    pollingInterval: 100,
    timeout: 15_000,
  });
  assert.equal(receipt.status, 'success', functionName);
  return receipt;
}
async function createRoom(player) {
  const receipt = await send(player, 'createMatch', [1]);
  const [created] = parseEventLogs({ abi, logs: receipt.logs, eventName: 'MatchCreated' });
  assert.ok(created, 'Room creation must emit its actual ID.');
  return created.args.matchId;
}
async function secret(id, round, player, actions) {
  const rulesHash = await chain.readContract({
    abi,
    address: deployment.arenaAddress,
    functionName: 'getRulesHash',
  });
  return page.evaluate(
    async ({ deployment, id, round, player, rulesHash, actions }) => {
      const { createSecret, secretContext } = await import('/src/lib/secrets.ts');
      const { encodeActions, emptyDrafts } = await import('/src/lib/battle.ts');
      return createSecret(
        secretContext(deployment, BigInt(id), round, player, rulesHash),
        actions ?? encodeActions(emptyDrafts()),
      );
    },
    { deployment, id: id.toString(), round, player: accounts[player], rulesHash, actions },
  );
}
const badge = (value) =>
  page.locator(`[data-verification="${value}"]`).waitFor({ state: 'visible' });
const connected = () =>
  page.locator('.sync-status').getByText('Live updates connected', { exact: true }).waitFor();
async function restoreChain() {
  if (!original) return;
  assert.equal(
    await chain.request({ method: 'evm_revert', params: [original] }),
    true,
    'Restore browser fault chain.',
  );
  original = undefined;
  await ready();
  assert.deepEqual(
    (await databaseState()).records,
    baseline.records,
    'Cleanup must restore the original canonical records.',
  );
  console.log(
    'PASS: browser cleanup restored the original chain, rooms, clock, and indexed records.',
  );
}

try {
  const executablePath = await installedBrowser();
  server = await createServer({
    root: resolve(root, 'client'),
    configFile: resolve(root, 'client/vite.config.js'),
    cacheDir: resolve(output, 'vite'),
    server: { host: '127.0.0.1', port: 5174, strictPort: true, ws: { port: 5174 } },
    plugins: [
      {
        name: 'acceptance-stream-interruption',
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url?.split('?')[0] === '/api/events') {
              if (dropEvents) {
                rejectedStreams++;
                res.writeHead(503);
                res.end();
                return;
              }
              streams.add(res);
              res.on('close', () => streams.delete(res));
            }
            if (readGate && req.url?.startsWith(`/api/matches/${delayedMatch}/replay?`)) {
              blockedReads++;
              void readGate.then(() => {
                if (!res.destroyed) next();
              });
              return;
            }
            next();
          });
        },
      },
    ],
  });
  const headers = server.config.server.headers;
  if (headers?.['Content-Security-Policy'])
    headers['Content-Security-Policy'] = String(headers['Content-Security-Policy']).replace(
      'ws://127.0.0.1:5173',
      'ws://127.0.0.1:5174',
    );
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath });
  context = await browser.newContext({
    viewport: { width: 1100, height: 760 },
    reducedMotion: 'no-preference',
  });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('request', (request) => {
    if (request.isNavigationRequest()) documentLoads++;
    if (/\/api\/matches\/\d+\/replay/.test(request.url())) replayReads++;
    if (new URL(request.url()).pathname === '/api/events') streamRequests.push(request.url());
  });
  const protocol = await context.newCDPSession(page);
  await protocol.send('Network.enable');
  const eventStreams = new Set();
  protocol.on('Network.requestWillBeSent', (event) => {
    if (new URL(event.request.url).pathname === '/api/events') eventStreams.add(event.requestId);
  });
  for (const name of ['Network.loadingFailed', 'Network.loadingFinished'])
    protocol.on(name, (event) => {
      if (eventStreams.delete(event.requestId))
        report.connections.push({ kind: name, at: Date.now() });
    });
  protocol.on('Network.eventSourceMessageReceived', (event) => {
    if (!['change', 'reorg', 'reset'].includes(event.eventName)) return;
    const notice = JSON.parse(event.data);
    report.events.push({
      kind: event.eventName,
      id: event.eventId,
      matches: notice.matches,
      block: notice.block,
    });
  });
  accounts = await wallet.getAddresses();
  const initial = await ready();
  baseline = await databaseState();
  assert.ok(baseline.indexerLockPid > 0, 'Indexer must own its database lock before faults.');
  original = await chain.request({ method: 'evm_snapshot' });
  const first = acceptance.matches[0];
  await page.goto(`${base}/history/${first.id}`);
  await badge('Verified');
  await connected();

  let started = Date.now();
  const loadsBeforeDatabase = documentLoads,
    readsBeforeDatabase = replayReads;
  console.log(
    'Deliberately stopping shared PostgreSQL 16 to check the real outage and browser recovery.',
  );
  databaseStopped = true;
  // SIGINT requests PostgreSQL fast shutdown, including its active sessions.
  await launchctl('kill', 'SIGINT');
  await waitFor(async () => {
    const response = await fetch(`${backend}/health`, { signal: AbortSignal.timeout(4_000) });
    const state = await response.json();
    return (
      response.status === 503 && state.services.database === 'unavailable' && !state.services.ready
    );
  }, 'Health did not report the stopped PostgreSQL service.');
  await badge('Unavailable');
  await page
    .locator('.sync-status')
    .getByText(/History temporarily unavailable|Live updates reconnecting/)
    .waitFor();
  const room = await createRoom(0);
  await startDatabase();
  const recovered = await ready();
  const database = await databaseState();
  assert.notEqual(
    database.startedAt,
    baseline.startedAt,
    'The PostgreSQL server itself must restart.',
  );
  assert.ok(
    database.indexerLockPid > 0 && database.indexerLockPid !== baseline.indexerLockPid,
    'Indexer must reacquire its session lock.',
  );
  assert.equal(recovered.processId, initial.processId, 'Database recovery must keep Go running.');
  assert.ok(
    recovered.indexedBlock > initial.indexedBlock,
    'Indexing must catch up with RPC writes made during the outage.',
  );
  for (const [table, rows] of Object.entries(baseline.records)) {
    if (table !== 'cursor')
      assert.deepEqual(
        database.records[table].slice(0, rows.length),
        rows,
        `Database restart changed existing ${table}.`,
      );
  }
  await badge('Verified');
  await connected();
  assert.ok(
    replayReads > readsBeforeDatabase,
    'Verification must be fetched again after recovery.',
  );
  assert.equal(
    documentLoads,
    loadsBeforeDatabase,
    'Database recovery must not reload the document.',
  );
  report.database = {
    before: baseline.startedAt,
    after: database.startedAt,
    oldLockPid: baseline.indexerLockPid,
    newLockPid: database.indexerLockPid,
    processId: recovered.processId,
  };
  passed(
    'PostgreSQL service restart, lock recovery, catch-up, and automatic verification refresh',
    started,
  );

  // Keep timed branch fixtures from triggering background work in other rooms.
  await holdKeeper();
  started = Date.now();
  const pageNumber = ((room - 1n) / 10n + 1n).toString();
  await page.goto(`${base}/history?page=${pageNumber}`);
  await connected();
  const row = page
    .locator('tbody tr')
    .filter({ has: page.getByRole('link', { name: `View match ${room}`, exact: true }) });
  await row.getByText('Open seat').waitFor();
  const previousCursor = report.events.at(-1)?.id,
    previousRejections = rejectedStreams,
    previousRequests = streamRequests.length;
  assert.ok(previousCursor, 'The browser must have an event cursor before interruption.');
  dropEvents = true;
  for (const response of streams) response.destroy();
  await page
    .locator('.sync-status')
    .getByText('Live updates reconnecting', { exact: true })
    .waitFor();
  const eventCount = report.events.length,
    loadsBeforeFallback = documentLoads;
  await send(1, 'joinMatch', [room]);
  await row.getByText('Open seat').waitFor({ state: 'hidden' });
  await send(0, 'cancelWaitingMatch', [room]);
  await row.getByText('Cancelled', { exact: true }).waitFor();
  assert.equal(
    report.events.length,
    eventCount,
    'No SSE notification should pass the interrupted connection.',
  );
  assert.equal(
    documentLoads,
    loadsBeforeFallback,
    'Polling fallback must update the existing page.',
  );
  await waitFor(
    () => rejectedStreams > previousRejections,
    'The interruption must exercise an actual HTTP 503 response.',
  );
  dropEvents = false;
  await connected();
  assert.ok(
    streamRequests
      .slice(previousRequests)
      .some((url) => new URL(url).searchParams.get('after') === previousCursor),
    'A replacement EventSource must resume after the previous event ID.',
  );
  await waitFor(
    () =>
      report.events
        .slice(eventCount)
        .some((event) => event.kind === 'change' && event.matches.includes(room.toString())),
    'SSE must deliver missed room changes after recovering from HTTP 503.',
  );
  passed(
    'SSE interruption keeps HTTP polling active; HTTP 503 recovery resumes missed events automatically',
    started,
  );

  started = Date.now();
  await page.goto(`${base}/history/${first.id}`);
  await badge('Verified');
  await connected();
  const oldGo = await ready(),
    loadsBeforeGo = documentLoads,
    readsBeforeGo = replayReads,
    endedBeforeGo = report.connections.length;
  console.log('Deliberately terminating Go while its history page stays open.');
  process.kill(oldGo.processId, 'SIGKILL');
  await waitFor(
    () => report.connections.length > endedBeforeGo,
    'The API proxy did not close the browser SSE connection after Go exited.',
  );
  await badge('Unavailable');
  const newGo = await ready(oldGo.processId);
  await badge('Verified');
  await connected();
  assert.equal(newGo.indexedHash, oldGo.indexedHash, 'Go restart must retain the chain.');
  assert.ok(replayReads > readsBeforeGo, 'Go recovery must trigger a new history read.');
  assert.equal(documentLoads, loadsBeforeGo, 'Go recovery must not reload the document.');
  passed(
    'Go crash automatically reconnects the open page and restores current verification',
    started,
  );

  started = Date.now();
  const branch = await chain.request({ method: 'evm_snapshot' });
  const match = await createRoom(0);
  await ready();
  await page.goto(`${base}/history/${match}`);
  await badge('Incomplete');
  await connected();
  const loadsBeforeBranch = documentLoads,
    eventsBeforeBranch = report.events.length;
  await send(1, 'joinMatch', [match]);
  await send(0, 'startMatch', [match]);
  await page.locator('.renderer[data-ready="true"]').waitFor();
  const orders = [];
  for (const player of [0, 1]) {
    orders[player] = await secret(match, 1, player, first.rounds[0].orders[player]);
    await send(player, 'commitActions', [match, 1, orders[player].commitment]);
  }
  for (const player of [0, 1])
    await send(player, 'revealActions', [match, 1, orders[player].actions, orders[player].salt]);
  await send(0, 'settleRound', [match, 1]);
  const held = await secret(match, 2, 0);
  await send(0, 'commitActions', [match, 2, held.commitment]);
  const state = await chain.readContract({
    abi,
    address: deployment.arenaAddress,
    functionName: 'getMatch',
    args: [match],
  });
  await chain.request({
    method: 'evm_setNextBlockTimestamp',
    params: [Number(state.phaseDeadline) + 1],
  });
  await send(0, 'advanceExpiredPhase', [match, 2, 2]);
  await ready();
  await badge('Verified');
  await connected();
  assert.ok(
    report.events
      .slice(eventsBeforeBranch)
      .some((event) => event.kind === 'change' && event.matches.includes(match.toString())),
    'The browser must receive real committed change events.',
  );
  const win = await api(`/matches/${match}/replay?limit=100`);
  assert.equal(win.match.outcome, 1, 'The displaced branch must contain a real player A victory.');
  assert.equal(win.verification.status, 'Verified');
  await page.getByRole('combobox', { name: 'Playback speed' }).selectOption('0.5');
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.replay-screen')?.getAttribute('data-animating') === 'true',
  );
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  assert.equal(await page.locator('.replay-screen').getAttribute('data-animating'), 'true');

  delayedMatch = match.toString();
  readGate = new Promise((done) => {
    releaseReads = done;
  });
  const eventsBeforeReorg = report.events.length;
  assert.equal(await chain.request({ method: 'evm_revert', params: [branch] }), true);
  const replacement = await createRoom(1);
  assert.equal(replacement, match);
  await send(1, 'cancelWaitingMatch', [replacement]);
  await ready();
  await waitFor(
    () =>
      report.events
        .slice(eventsBeforeReorg)
        .some((event) => event.kind === 'reorg' && event.matches.includes(match.toString())),
    'The open browser did not receive the real reorg notification.',
  );
  await badge('Unavailable');
  await waitFor(() => blockedReads > 0, 'Reorg did not automatically request replacement history.');
  assert.equal(
    await page.locator('canvas').count(),
    0,
    'Discard old replay before replacement reads finish.',
  );
  assert.equal(await page.locator('.replay-screen').getAttribute('data-animating'), 'false');
  releaseReads();
  releaseReads = undefined;
  readGate = undefined;
  await badge('Incomplete');
  await page.getByRole('heading', { name: 'No battle to replay yet', exact: true }).waitFor();
  assert.equal(await page.locator('canvas').count(), 0);
  assert.equal(
    documentLoads,
    loadsBeforeBranch,
    'Chain changes must refresh the open replay without navigation.',
  );
  const replaced = await api(`/matches/${match}`);
  assert.equal(replaced.match.phase, 6);
  assert.equal(replaced.match.outcome, 0);
  passed(
    'committed events update the page; reorg cancels old animation and Verified before replacement loads',
    started,
  );
  assert.deepEqual(report.errors, [], 'Uncaught browser errors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack || String(error);
  process.exitCode = 1;
  console.error(`Browser recovery acceptance failed: ${error.message}`);
  if (!databaseStopped && !interrupted && page && !page.isClosed())
    await page
      .screenshot({ path: resolve(output, 'recovery-failure.png'), fullPage: true, timeout: 5_000 })
      .catch(() => {});
} finally {
  cleaning = true;
  releaseReads?.();
  readGate = undefined;
  dropEvents = false;
  try {
    await startDatabase();
    await restoreChain();
  } catch (error) {
    report.status = 'failed';
    report.cleanupError = error.message;
    process.exitCode = 1;
    console.error(`Browser recovery cleanup failed: ${error.message}`);
    if (databaseStopped)
      console.error('Restore PostgreSQL with: sudo launchctl kickstart system/postgresql-16');
  }
  if (keeper) {
    keeper.stdin.end();
    await keeperExited;
  }
  await browser?.close();
  for (const response of streams) response.destroy();
  await server?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'recovery.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'passed')
    console.log(
      'PASS: browser updates and PostgreSQL restart acceptance completed. Local recovery report saved.',
    );
}
