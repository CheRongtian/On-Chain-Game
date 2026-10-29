import { access, constants, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
