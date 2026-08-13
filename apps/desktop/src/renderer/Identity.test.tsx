import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Identity } from './Identity';
import type { IdentityResponse } from '../shared/ipc';

function stub(identity: IdentityResponse) {
  Object.defineProperty(window, 'layup', {
    value: {
      protocolVersion: 1,
      app: { info: vi.fn() },
      control: { status: vi.fn() },
      identity: { current: vi.fn(async () => identity) },
    },
    configurable: true,
    writable: true,
  });
}

describe('identity view', () => {
  it('names the development user and organisation', async () => {
    stub({
      devUser: 'karl',
      resolved: true,
      userId: 'usr_devkarlx',
      displayName: 'Karl',
      organisationId: 'org_devlayup',
      organisationName: 'Layup Development',
    });

    render(<Identity />);
    await waitFor(() => {
      expect(screen.getByRole('note').textContent).toMatch(
        /You are Karl · Layup Development · LAYUP_DEV_USER=karl/,
      );
    });
  });

  it('says why an identity is unresolved instead of pretending', async () => {
    stub({ devUser: 'karl', resolved: false, detail: 'control service unreachable' });

    render(<Identity />);
    await waitFor(() => {
      expect(screen.getByRole('note').textContent).toMatch(/unresolved — control service unreachable/);
    });
  });
});
