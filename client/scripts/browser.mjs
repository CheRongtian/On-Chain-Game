import assert from 'node:assert/strict';
import { access, constants, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { browserEngines } from '../../scripts/acceptance.mjs';

export const browserTypes = { chromium, firefox, webkit };

export async function observeEventSource(context, report) {
  await context.exposeBinding('arenaObserveEvent', (_, event) => {
    report.events.push(event);
  });
  await context.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url, options) {
        super(url, options);
        for (const kind of ['change', 'reorg', 'reset'])
          this.addEventListener(kind, (event) => {
            const notice = JSON.parse(event.data);
            void window
              .arenaObserveEvent({
                kind,
                id: event.lastEventId,
                matches: notice.matches,
                block: notice.block,
              })
              .catch(() => {});
          });
      }
    };
  });
}

export function replayState(page) {
  return page.evaluate(() => {
    const screen = document.querySelector('.replay-screen');
    const timeline = document.querySelector('.timeline');
    const range = timeline?.querySelector('input[type="range"]');
    const sync = document.querySelector('.sync-status')?.textContent ?? '';
    return {
      url: location.href,
      frame: screen?.getAttribute('data-frame-index') ?? null,
      hash: screen?.getAttribute('data-state-hash') ?? null,
      verification:
        document.querySelector('[data-verification]')?.getAttribute('data-verification') ?? null,
      value: range?.value ?? null,
      max: range?.max ?? null,
      disabled: range?.disabled ?? true,
      progress: timeline?.style.getPropertyValue('--timeline-progress') ?? null,
      boardReady: !!document.querySelector('.renderer[data-ready="true"]'),
      animating: screen?.getAttribute('data-animating') ?? null,
      playing: screen?.getAttribute('data-playing') ?? null,
      refreshing:
        document.querySelector('.replay-actions .refresh')?.getAttribute('aria-busy') ?? null,
      historyReady: sync.includes('History up to date'),
      live: sync.includes('Live updates connected'),
    };
  });
}

export async function waitForVerifiedReplay(page, expected, diagnostic) {
  diagnostic.expected = expected;
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const actual = await replayState(page);
    diagnostic.actual = actual;
    const progress = expected.last ? `${(expected.frame / expected.last) * 100}%` : '0%';
    if (
      actual.frame === String(expected.frame) &&
      actual.hash === expected.hash &&
      actual.verification === 'Verified' &&
      actual.value === String(expected.frame) &&
      actual.max === String(expected.last) &&
      !actual.disabled &&
      actual.progress === progress &&
      actual.boardReady &&
      actual.animating === 'false' &&
      actual.refreshing === 'false' &&
      actual.historyReady &&
      actual.live
    )
      return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(
    `Verified replay did not reach its expected ready state: ${JSON.stringify(diagnostic)}`,
  );
}

export async function requirePreviewDeployment(root, deployment) {
  const built = JSON.parse(await readFile(join(root, 'client/dist/deployment.json'), 'utf8'));
  for (const field of [
    'engine',
    'chainId',
    'rpcUrl',
    'arenaAddress',
    'deploymentBlock',
    'deploymentHash',
    'deployedAt',
  ]) {
    assert.equal(
      built[field],
      deployment[field],
      `Preview deployment ${field} is stale. The backend must publish the current deployment to client/dist before browser acceptance.`,
    );
  }
}

export function transactionState(page) {
  return page.evaluate(() => {
    const state =
      document.getElementById('app').__vue_app__.config.globalProperties.$pinia.state.value
        .transaction;
    const { status, operation, roomId, hash, message, diagnostic } = state;
    return { status, operation, roomId, hash, message, diagnostic };
  });
}

export async function waitForReceiptRecovery(page) {
  try {
    await page.waitForFunction(() => {
      const state =
        document.getElementById('app').__vue_app__.config.globalProperties.$pinia.state.value
          .transaction;
      return ['unconfirmed', 'failed', 'confirmed'].includes(state.status);
    });
    const state = await transactionState(page);
    assert.equal(
      state.status,
      'unconfirmed',
      `${state.operation} did not enter receipt recovery: ${state.diagnostic || state.message}`,
    );
    const button = page.getByRole('button', { name: 'Check confirmation', exact: true });
    await button.waitFor();
    return button;
  } catch (cause) {
    const state = await transactionState(page).catch(() => ({ status: 'unavailable' }));
    throw new Error(
      `Receipt recovery failed: ${cause.message}\nTransaction: ${JSON.stringify(state)}`,
      { cause },
    );
  }
}

export async function installedBrowser(name = 'chromium') {
  if (name !== 'chromium') {
    const type = { firefox, webkit }[name];
    assert.ok(type, `Unsupported browser: ${name}`);
    const path = type.executablePath();
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      throw new Error(
        `The installed Playwright ${name} is missing. Run ./client/node_modules/.bin/playwright install ${name} from the project root, then retry. Nothing was downloaded.`,
      );
    }
  }
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const shells = (await readdir(cache).catch(() => []))
    .filter((name) => /^chromium_headless_shell-\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const shell of shells) {
    for (const relative of [
      'chrome-headless-shell-mac-arm64/chrome-headless-shell',
      'chrome-mac/headless_shell',
    ]) {
      const executablePath = join(cache, shell, relative);
      try {
        await access(executablePath, constants.X_OK);
        return executablePath;
      } catch {
        // The two existing cache layouts use different executable names.
      }
    }
  }
  throw new Error(
    'An installed Playwright headless shell is required. No browser was downloaded or Chrome app launched.',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await import('vite');
  const missing = [];
  for (const name of browserEngines) {
    try {
      console.log(`Using installed ${name}: ${await installedBrowser(name)}`);
    } catch (error) {
      missing.push(error.message);
    }
  }
  if (missing.length) throw new Error(missing.join('\n'));
}
