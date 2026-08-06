import { describe, it, expect } from 'vitest';
import { relayOutcome, type RelayStaticTerminalStatus } from './relay-finalizer';

describe('relayOutcome', () => {
  it('maps each static terminal status to its canonical (httpStatus, errorCode)', () => {
    const cases: Array<[RelayStaticTerminalStatus, { httpStatus: number; errorCode: string | null }]> = [
      ['insufficient_balance', { httpStatus: 402, errorCode: 'insufficient_balance' }],
      ['success', { httpStatus: 200, errorCode: null }],
      ['no_channel', { httpStatus: 503, errorCode: 'no_channel_available' }],
      ['no_pricing', { httpStatus: 503, errorCode: 'pricing_not_configured' }],
    ];
    for (const [status, expected] of cases) {
      expect(relayOutcome(status)).toEqual(expected);
    }
  });

  it('is a single source of truth (stable reference per status)', () => {
    expect(relayOutcome('success')).toBe(relayOutcome('success'));
  });
});
