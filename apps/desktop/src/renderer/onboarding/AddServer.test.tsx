import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddServer } from './AddServer';

function bridge(add: ReturnType<typeof vi.fn>, onPrefill: ReturnType<typeof vi.fn> = vi.fn(() => () => {})) {
  Object.defineProperty(window, 'layup', {
    value: { server: { add, state: vi.fn(), forget: vi.fn(), onChanged: vi.fn(() => () => {}), onPrefill } },
    configurable: true,
    writable: true,
  });
}

describe('adding a server', () => {
  it('asks for a server, a code and a name, and nothing else', () => {
    bridge(vi.fn());
    render(<AddServer />);

    expect(screen.getByLabelText('Server')).toBeTruthy();
    expect(screen.getByLabelText('Join code')).toBeTruthy();
    expect(screen.getByLabelText('Your name')).toBeTruthy();
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    // No account to make, and nothing to remember: the join code is the gate.
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByLabelText(/email/i)).toBeNull();
  });

  it("reports the server's own words when the code is wrong", async () => {
    const user = userEvent.setup();
    bridge(
      vi.fn(async () => ({
        ok: false,
        message: 'that join code is not valid for this server',
      })),
    );
    render(<AddServer />);

    await user.type(screen.getByLabelText('Server'), 'layup.blah.au');
    await user.type(screen.getByLabelText('Join code'), 'NOPE');
    await user.type(screen.getByLabelText('Your name'), 'Nick');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    // The sentence that sends somebody back to the join code, not to us.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'that join code is not valid for this server',
    );
  });

  it('normalises a bare hostname into an https url', async () => {
    const user = userEvent.setup();
    const add = vi.fn(async () => ({ ok: true }));
    bridge(add);
    render(<AddServer />);

    await user.type(screen.getByLabelText('Server'), 'layup.blah.au');
    await user.type(screen.getByLabelText('Join code'), 'LAYUP-C9C76D');
    await user.type(screen.getByLabelText('Your name'), 'Nick');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        serverUrl: 'https://layup.blah.au',
        code: 'LAYUP-C9C76D',
        displayName: 'Nick',
      }),
    );
  });

  it('cannot be submitted twice while it is in flight', async () => {
    const user = userEvent.setup();
    let release = () => {};
    const add = vi.fn(
      () => new Promise((resolve) => (release = () => resolve({ ok: true }))),
    );
    bridge(add);
    render(<AddServer />);

    await user.type(screen.getByLabelText('Server'), 'layup.blah.au');
    await user.click(screen.getByRole('button'));

    expect(screen.getByRole('button')).toBeDisabled();
    release();
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
  });

  it('says so when the bridge itself fails, rather than looking idle', async () => {
    const user = userEvent.setup();
    bridge(
      vi.fn(async () => {
        throw new Error('server:add rejected');
      }),
    );
    render(<AddServer />);

    await user.type(screen.getByLabelText('Server'), 'layup.blah.au');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('server:add rejected');
  });

  it('fills in the server and code from a join link, leaving the name for the person', () => {
    let deliver: ((link: { serverUrl: string; code: string }) => void) | undefined;
    const onPrefill = vi.fn((handler: (link: { serverUrl: string; code: string }) => void) => {
      deliver = handler;
      return () => {};
    });
    bridge(vi.fn(), onPrefill);
    render(<AddServer />);

    act(() => deliver?.({ serverUrl: 'https://layup.blah.au', code: 'LAYUP-C9C76D' }));

    expect(screen.getByLabelText('Server')).toHaveValue('https://layup.blah.au');
    expect(screen.getByLabelText('Join code')).toHaveValue('LAYUP-C9C76D');
    expect(screen.getByLabelText('Your name')).toHaveValue('');
    expect(screen.getByLabelText('Your name')).toHaveFocus();
  });
});
