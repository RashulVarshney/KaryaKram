import { describe, expect, it } from 'vitest';
import { formatWorkerId, generateWorkerId } from './workerId';

describe('formatWorkerId', () => {
  it('joins hostname, pid, and random suffix with hyphens', () => {
    expect(formatWorkerId('my-host', 1234, 'ab12cd')).toBe('my-host-1234-ab12cd');
  });
});

describe('generateWorkerId', () => {
  it('produces a non-empty string containing the current pid', () => {
    const id = generateWorkerId();
    expect(id).toContain(String(process.pid));
    expect(id.length).toBeGreaterThan(0);
  });

  it('produces a different id on each call', () => {
    const a = generateWorkerId();
    const b = generateWorkerId();
    expect(a).not.toBe(b);
  });
});
