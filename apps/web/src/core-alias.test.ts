import { describe, expect, it } from 'vitest';
import { createSession } from '@core/session';

/**
 * The one thing this task has to prove: `@core` resolves to
 * `apps/desktop/src/core`, and that module compiles under this workspace's
 * own, Node-typeless, browser tsconfig (see tsconfig.json and
 * vite.config.ts). `createSession` is an arbitrary but real export from
 * `core/` - nothing about it is web-specific, which is the whole point.
 */
describe('the @core alias', () => {
  it('resolves apps/desktop/src/core and imports a real export from it', () => {
    expect(typeof createSession).toBe('function');
  });
});
