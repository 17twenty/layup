/**
 * The whole of what a guest does before the call: say who they are.
 *
 * No account, no password, no download. The one thing asked for is a name,
 * because it is the only thing the people already in the room will know this
 * visitor by (`guest_join.go`'s `guestDisplayName`).
 */
import { useState, type FormEvent } from 'react';
import { GuestJoinError, joinAsGuest, type GuestJoinResult } from './guest-client';

export interface JoinProps {
  /** The control plane's origin. */
  serverUrl: string;
  /**
   * The link token, read from the URL fragment by the caller. Absent means
   * somebody arrived at `/j/` with nothing after the `#`.
   */
  token?: string;
  /** The layup's name, when something already knows it. Usually nothing does. */
  layupTitle?: string;
  onJoined: (result: GuestJoinResult) => void;
  /** Injected for tests; the real one is the module's own. */
  join?: typeof joinAsGuest;
}

export function Join({ serverUrl, token, layupTitle, onJoined, join = joinAsGuest }: JoinProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [joining, setJoining] = useState(false);

  // No token, no form. A form here would be an invitation to type a name and
  // then be refused for a reason that had nothing to do with the name.
  if (!token) {
    return (
      <main className="join">
        <h1>Layup</h1>
        <p className="join__error" role="alert">
          This link is not valid. Ask whoever invited you for a new one.
        </p>
      </main>
    );
  }

  const trimmed = name.trim();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (trimmed === '' || joining) return;
    setJoining(true);
    setError(undefined);
    try {
      // `token` is narrowed above, but the closure outlives that narrowing.
      onJoined(await join({ serverUrl, token: token as string, displayName: trimmed }));
    } catch (cause) {
      // The server's own words, whatever they were. It answers every way a
      // link can fail with one message on purpose; replacing it here would
      // either say more than it meant to or contradict it.
      setError(
        cause instanceof GuestJoinError || cause instanceof Error
          ? cause.message
          : 'could not join this call',
      );
      setJoining(false);
    }
  }

  return (
    <main className="join">
      <h1>{layupTitle ? `Join ${layupTitle}` : 'Join this call'}</h1>
      <form className="join__form" onSubmit={submit}>
        <label className="join__label" htmlFor="join-name">
          Your name
        </label>
        <input
          id="join-name"
          className="join__name"
          name="displayName"
          autoComplete="name"
          autoFocus
          maxLength={60}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className="join__submit" disabled={trimmed === '' || joining}>
          {joining ? 'Joining…' : 'Join'}
        </button>
      </form>
      {error ? (
        <p className="join__error" role="alert">
          {error}
        </p>
      ) : null}
    </main>
  );
}
