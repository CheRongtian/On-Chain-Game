import assert from 'node:assert/strict';
import { access, constants, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const { status, operation, hash, message, diagnostic } = state;
    return { status, operation, hash, message, diagnostic };
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

export async function installedBrowser() {
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
  await import('playwright');
  await import('vite');
  console.log(`Using installed headless shell: ${await installedBrowser()}`);
}
