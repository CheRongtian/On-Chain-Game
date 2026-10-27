import { formatEther } from 'viem';

export function parseRoomId(value: string): bigint | undefined {
  const input = value.trim();
  if (!/^[1-9]\d*$/.test(input)) return undefined;
  const id = BigInt(input);
  return id < 2n ** 256n ? id : undefined;
}

export function parseRoomInvitation(value: string, origin: string): bigint | undefined {
  const id = parseRoomId(value);
  if (id !== undefined) return id;
  try {
    const invitation = new URL(value.trim());
    if (invitation.origin !== origin) return undefined;
    const room = /^\/rooms\/([1-9]\d*)\/?$/.exec(invitation.pathname);
    return room ? parseRoomId(room[1]) : undefined;
  } catch {
    return undefined;
  }
}

export function shortAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
export function balanceLabel(value: bigint): string {
  return `${Number(formatEther(value)).toLocaleString('en', { maximumFractionDigits: 3 })} ETH`;
}
export function chainDate(value: bigint): string {
  return (
    new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(new Date(Number(value) * 1000)) + ' UTC'
  );
}

export const phases = [
  'Not started',
  'Waiting for opponent',
  'Commit',
  'Reveal',
  'Ready to settle',
  'Finished',
  'Cancelled',
  'Expired',
] as const;
export const outcomes = ['In progress', 'Player A wins', 'Player B wins', 'Draw'] as const;
export const reasons = [
  '',
  'Elimination',
  'Mutual elimination',
  'Victory points',
  'Round limit',
  'Commit timeout',
  'Reveal timeout',
] as const;
