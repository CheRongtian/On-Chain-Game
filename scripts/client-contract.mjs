import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const abiFile = resolve(projectRoot, 'client/src/generated/arena.ts');
const deploymentFile = resolve(projectRoot, 'client/public/deployment.json');

async function writeChanged(file, content) {
  const previous = await readFile(file, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  if (previous === content) return;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function exportAbi() {
  const artifact = JSON.parse(
    await readFile(resolve(projectRoot, 'contracts/out/Arena.sol/Arena.json'), 'utf8'),
  );
  await writeChanged(
    abiFile,
    '// Generated from the compiled Arena artifact by the startup scripts.\n' +
      "import type { Abi } from 'viem';\n\n" +
      `export const arenaAbi = ${JSON.stringify(artifact.abi, null, 2)} as const satisfies Abi;\n`,
  );
  console.log('Frontend Arena ABI synchronized from the compiler artifact.');
}

async function publishDeployment() {
  const [rpcUrl, arenaAddress, deploymentBlock] = process.argv.slice(3);
  if (
    !rpcUrl ||
    !/^0x[\da-fA-F]{40}$/.test(arenaAddress ?? '') ||
    !/^\d+$/.test(deploymentBlock ?? '')
  ) {
    throw new Error('Deployment publication requires an RPC URL, Arena address, and block number.');
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
    ) + '\n',
  );
  console.log('Frontend local account connection published.');
}

const command = process.argv[2];
if (command === 'abi') await exportAbi();
else if (command === 'publish') await publishDeployment();
else if (command === 'clear') await rm(deploymentFile, { force: true });
else throw new Error('Expected an internal abi, publish, or clear operation.');
