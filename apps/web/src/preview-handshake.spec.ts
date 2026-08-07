import { describe, expect, it } from 'vitest';
import {
  acceptPreviewHandshake,
  previewCapabilityAllowed,
  validatePreviewHandshake,
} from './preview-handshake';

const frame = {};
const security_report = {
  parent_dom_readable: false,
  parent_storage_readable: false,
  parent_token_readable: false,
  own_storage_readable: false,
  own_cookie_readable: false,
};
const event = {
  origin: 'null',
  source: frame,
  data: {
    type: 'lingfang.preview.handshake.v1',
    session_id: 'session-1',
    nonce: 'nonce-1',
    security_report,
  },
};
function session() {
  return {
    sessionId: 'session-1',
    nonce: 'nonce-1',
    expiresAt: Date.now() + 10_000,
    consumed: false,
  };
}

describe('opaque preview handshake', () => {
  it('accepts null origin, exact frame/session/nonce once', () => {
    const value = session();
    expect(acceptPreviewHandshake(value, event, frame)).toBe(true);
    expect(acceptPreviewHandshake(value, event, frame)).toBe(false);
  });
  it('rejects real origin, wrong source, session and nonce', () => {
    expect(
      acceptPreviewHandshake(session(), { ...event, origin: 'https://preview.example' }, frame)
    ).toBe(false);
    expect(acceptPreviewHandshake(session(), { ...event, source: {} }, frame)).toBe(false);
    expect(
      acceptPreviewHandshake(
        session(),
        { ...event, data: { ...event.data, session_id: 'wrong' } },
        frame
      )
    ).toBe(false);
    expect(
      acceptPreviewHandshake(
        session(),
        { ...event, data: { ...event.data, nonce: 'wrong' } },
        frame
      )
    ).toBe(false);
  });
  it('rejects a frame that can observe parent DOM, storage, token, cookies, or opaque-origin storage', () => {
    for (const key of Object.keys(security_report)) {
      expect(
        validatePreviewHandshake(
          session(),
          {
            ...event,
            data: { ...event.data, security_report: { ...security_report, [key]: true } },
          },
          frame
        )
      ).toBe(false);
    }
  });
  it('allows only preview-safe capabilities', () => {
    expect(previewCapabilityAllowed('ui.view')).toBe(true);
    for (const denied of ['fs.read', 'clipboard', 'shared.set', 'plugin.upload', 'system.notify'])
      expect(previewCapabilityAllowed(denied)).toBe(false);
  });
});
