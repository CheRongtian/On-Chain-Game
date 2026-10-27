import { bytesToHex, encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from 'viem';
import type { Address, Hex } from 'viem';
import type { Deployment } from './arena';
import { encodeActions, isAttack, isMovement } from './battle';
import type { ActionBundle, ActionDraft, DraftBundle } from './battle';

export interface SecretContext {
  deployment: string;
  chainId: number;
  arena: Address;
  matchId: string;
  round: number;
  player: Address;
  rulesHash: Hex;
}
export interface OrderSecret {
  context: SecretContext;
  actions: ActionBundle;
  salt: Hex;
  commitment: Hex;
}

const actionsDomain = keccak256(stringToHex('OnChainTacticalArena.Actions'));
const commitmentType = keccak256(
  stringToHex('ActionCommitment((uint256,address,uint256),uint8,address,bytes32,bytes32,bytes32)'),
);
const actionParameters = parseAbiParameters(
  'bytes32, (uint8 kind, uint8 targetCell, uint8 pathLength, uint8[4] path)[3]',
);
const commitmentParameters = parseAbiParameters(
  'bytes32, (uint256 chainId, address arena, uint256 matchId), uint8, address, bytes32, bytes32, bytes32',
);
const iterations = 250_000;

export function secretContext(
  deployment: Deployment,
  id: bigint,
  round: number,
  player: Address,
  rulesHash: Hex,
): SecretContext {
  return {
    deployment: deployment.deployedAt,
    chainId: deployment.chainId,
    arena: deployment.arenaAddress,
    matchId: id.toString(),
    round,
    player,
    rulesHash,
  };
}
function key(context: SecretContext): string {
  return JSON.stringify([
    context.deployment,
    context.chainId,
    context.arena.toLowerCase(),
    context.matchId,
    context.round,
    context.player.toLowerCase(),
  ]);
}
export function commitmentFor(context: SecretContext, actions: ActionBundle, salt: Hex): Hex {
  const actionHash = keccak256(encodeAbiParameters(actionParameters, [actionsDomain, actions]));
  return keccak256(
    encodeAbiParameters(commitmentParameters, [
      commitmentType,
      { chainId: BigInt(context.chainId), arena: context.arena, matchId: BigInt(context.matchId) },
      context.round,
      context.player,
      context.rulesHash,
      actionHash,
      salt,
    ]),
  );
}
export function createSecret(context: SecretContext, actions: ActionBundle): OrderSecret {
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  return { context, actions, salt, commitment: commitmentFor(context, actions, salt) };
}
export function secretDrafts(secret: OrderSecret): DraftBundle {
  const draft = (action: ActionBundle[number]): ActionDraft => ({
    kind: action.kind,
    path: isMovement(action.kind) ? action.path.slice(0, action.pathLength) : [],
    target: isAttack(action.kind) ? action.targetCell : undefined,
  });
  return [draft(secret.actions[0]), draft(secret.actions[1]), draft(secret.actions[2])];
}
function validate(value: unknown, context: SecretContext): OrderSecret {
  const secret = value as OrderSecret | undefined;
  try {
    if (
      !secret ||
      key(secret.context) !== key(context) ||
      secret.context.rulesHash.toLowerCase() !== context.rulesHash.toLowerCase() ||
      !/^0x[0-9a-f]{64}$/i.test(secret.salt) ||
      !Array.isArray(secret.actions) ||
      secret.actions.length !== 3 ||
      secret.actions.some(
        (action) =>
          !Number.isInteger(action.kind) ||
          action.kind < 0 ||
          action.kind > 5 ||
          !Number.isInteger(action.targetCell) ||
          action.targetCell < 0 ||
          action.targetCell > 255 ||
          (isAttack(action.kind) && action.targetCell >= 64) ||
          !Number.isInteger(action.pathLength) ||
          action.pathLength < 0 ||
          action.pathLength > 4 ||
          (isMovement(action.kind) && !action.pathLength) ||
          !Array.isArray(action.path) ||
          action.path.length !== 4 ||
          action.path.some((cell: number) => !Number.isInteger(cell) || cell < 0 || cell >= 64),
      )
    )
      throw new Error();
    const canonical = encodeActions(secretDrafts(secret));
    if (
      secret.actions.some(
        (action, slot) =>
          action.kind !== canonical[slot].kind ||
          action.targetCell !== canonical[slot].targetCell ||
          action.pathLength !== canonical[slot].pathLength ||
          action.path.some((cell: number, step: number) => cell !== canonical[slot].path[step]),
      ) ||
      commitmentFor(context, secret.actions, secret.salt).toLowerCase() !==
        secret.commitment.toLowerCase()
    )
      throw new Error();
    return secret;
  } catch {
    throw new Error(
      'These orders do not match this deployment, room, round, account, or commitment.',
    );
  }
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('arena-orders', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('secrets');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error('Cannot open order storage. Enable IndexedDB before committing.'));
    request.onblocked = () =>
      reject(new Error('Close older Arena tabs, then retry opening order storage.'));
  });
}
export async function readSecret(context: SecretContext): Promise<OrderSecret | undefined> {
  const db = await database();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction('secrets').objectStore('secrets').get(key(context));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error('Cannot read saved orders. Retry or import the original backup.'));
    });
    return value === undefined ? undefined : validate(value, context);
  } finally {
    db.close();
  }
}
// Commit waits for durable transaction completion, including the complete orders and Salt.
export async function saveSecret(secret: OrderSecret, replaceExisting = false): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('secrets', 'readwrite', { durability: 'strict' });
      const store = transaction.objectStore('secrets');
      const request = store.get(key(secret.context));
      let conflict = false;
      request.onsuccess = () => {
        const existing = request.result as OrderSecret | undefined;
        if (!replaceExisting && existing && existing.commitment !== secret.commitment) {
          conflict = true;
          transaction.abort();
        } else store.put(secret, key(secret.context));
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(
          new Error(
            conflict
              ? 'This round already has saved orders. Refresh to recover them before continuing.'
              : 'Orders could not be saved. No Commit was sent. Free local storage and retry.',
          ),
        );
    });
  } finally {
    db.close();
  }
}
function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}
function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
async function encryptionKey(password: string, salt: Uint8Array<ArrayBuffer>) {
  if (!password) throw new Error('Enter a backup password and keep it for recovery.');
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
export async function encryptSecret(secret: OrderSecret, password: string): Promise<Blob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(password, salt),
    new TextEncoder().encode(JSON.stringify(secret)),
  );
  return new Blob(
    [
      JSON.stringify({
        cipher: 'AES-GCM',
        kdf: 'PBKDF2-SHA256',
        iterations,
        salt: base64(salt),
        iv: base64(iv),
        payload: base64(new Uint8Array(cipher)),
      }),
    ],
    { type: 'application/json' },
  );
}
export async function decryptSecret(
  file: File,
  password: string,
  context: SecretContext,
): Promise<OrderSecret> {
  let value: unknown;
  try {
    const backup = JSON.parse(await file.text());
    if (
      backup.cipher !== 'AES-GCM' ||
      backup.kdf !== 'PBKDF2-SHA256' ||
      backup.iterations !== iterations
    )
      throw new Error();
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unbase64(backup.iv) },
      await encryptionKey(password, unbase64(backup.salt)),
      unbase64(backup.payload),
    );
    value = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('Cannot unlock this backup. Check its file and password.');
  }
  return validate(value, context);
}
