import { describe, expect, it } from 'vitest';
import { BUILD_INFO, resolveBuildInfo } from './build-info';

/**
 * The build stamp exists so a tester can read one string back to us and we
 * know exactly which bits they are running. A stamp that says `undefined` is
 * worse than no stamp at all: it looks like an answer.
 */
describe('build identity', () => {
  it('carries a version somebody can read out loud', () => {
    expect(BUILD_INFO.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('carries either a real commit or the honest word dev', () => {
    expect(BUILD_INFO.commit).toMatch(/^([0-9a-f]{7,40}|dev)$/);
  });

  it('carries a built-at stamp that is never empty', () => {
    expect(BUILD_INFO.builtAt.length).toBeGreaterThan(0);
  });

  it('falls back to dev rather than undefined when nothing was injected', () => {
    const info = resolveBuildInfo({});
    expect(info.commit).toBe('dev');
    expect(info.version).not.toMatch(/undefined/);
    expect(info.builtAt).not.toMatch(/undefined/);
  });

  it('refuses a stamp that is only the word undefined wearing a string', () => {
    expect(resolveBuildInfo({ commit: 'undefined' }).commit).toBe('dev');
    expect(resolveBuildInfo({ commit: 'null' }).commit).toBe('dev');
    expect(resolveBuildInfo({ commit: '' }).commit).toBe('dev');
    expect(resolveBuildInfo({ commit: '   ' }).commit).toBe('dev');
    expect(resolveBuildInfo({ commit: 42 }).commit).toBe('dev');
  });

  it('keeps a real stamp exactly as it was given', () => {
    expect(
      resolveBuildInfo({ version: '0.2.0', commit: 'abc1234', builtAt: '2026-08-17T00:00:00Z' }),
    ).toEqual({ version: '0.2.0', commit: 'abc1234', builtAt: '2026-08-17T00:00:00Z' });
  });
});
