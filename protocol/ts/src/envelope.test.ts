import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  ProtocolVersionError,
  TYPE_ERROR,
  decodeEnvelope,
  envelope,
  errorEnvelope,
  supportsVersion,
} from './envelope';
import { ValidationError } from './validate';

describe('protocol envelope', () => {
  it('matches protocol/VERSION', () => {
    const raw = readFileSync(fileURLToPath(new URL('../../VERSION', import.meta.url)), 'utf8');
    expect(PROTOCOL_VERSION).toBe(Number(raw.trim()));
  });

  it('stamps outgoing messages with this version', () => {
    expect(envelope('presence.update', { userId: 'u1' }, 'm1')).toEqual({
      v: PROTOCOL_VERSION,
      type: 'presence.update',
      payload: { userId: 'u1' },
      id: 'm1',
    });
    expect(envelope('ping')).toEqual({ v: PROTOCOL_VERSION, type: 'ping' });
  });

  it('decodes a supported envelope from an object or a JSON string', () => {
    const wire = '{"v":1,"type":"layup.join","payload":{"layupId":"l1"}}';
    expect(decodeEnvelope(wire)).toEqual({ v: 1, type: 'layup.join', payload: { layupId: 'l1' } });
    expect(decodeEnvelope(JSON.parse(wire))).toEqual(decodeEnvelope(wire));
  });

  it('rejects an unsupported version deterministically', () => {
    expect(() => decodeEnvelope({ v: 99, type: 'layup.join' })).toThrow(ProtocolVersionError);
    try {
      decodeEnvelope({ v: 99, type: 'layup.join' });
    } catch (error) {
      expect((error as ProtocolVersionError).receivedVersion).toBe(99);
      expect((error as Error).message).toMatch(/v99.*v1/);
    }
    expect(supportsVersion(99)).toBe(false);
    expect(supportsVersion(PROTOCOL_VERSION)).toBe(true);
  });

  it('rejects malformed envelopes rather than coercing them', () => {
    expect(() => decodeEnvelope('not json')).toThrow(ValidationError);
    expect(() => decodeEnvelope({ type: 'layup.join' })).toThrow(ValidationError);
    expect(() => decodeEnvelope({ v: 1 })).toThrow(ValidationError);
    expect(() => decodeEnvelope({ v: 1, type: '' })).toThrow(ValidationError);
    expect(() => decodeEnvelope([1, 2, 3])).toThrow(ValidationError);
  });

  it('describes the version header and error envelope', () => {
    expect(PROTOCOL_HEADER).toBe('X-Layup-Protocol-Version');
    const err = errorEnvelope('unsupported_protocol_version', 'peer speaks v99', 99);
    expect(err.type).toBe(TYPE_ERROR);
    expect(err.payload).toEqual({
      code: 'unsupported_protocol_version',
      message: 'peer speaks v99',
      serverVersion: PROTOCOL_VERSION,
      receivedVersion: 99,
    });
  });
});
