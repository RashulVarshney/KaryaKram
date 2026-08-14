import os from 'node:os';
import crypto from 'node:crypto';

/** Pure formatting, split out from generateWorkerId() so it's testable without mocking hostname/pid/random. */
export function formatWorkerId(hostname: string, pid: number, random: string): string {
  return `${hostname}-${pid}-${random}`;
}

export function generateWorkerId(): string {
  return formatWorkerId(os.hostname(), process.pid, crypto.randomBytes(3).toString('hex'));
}
