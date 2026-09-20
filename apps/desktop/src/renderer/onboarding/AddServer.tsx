import { useEffect, useRef, useState, type FormEvent } from 'react';
import { normaliseServerUrl } from '../../core/server-url';

/**
 * The first thing somebody without this repository ever sees.
 *
 * Three things: where the server is, the code that lets them in, and what to
 * call them. No account, no password, no email - the join code is the whole
 * gate, and everything else about identity is decided by the server.
 *
 * A refusal is shown in the server's own words. "That join code is not valid
 * for this server" sends somebody back to whoever gave them the code; a
 * generic failure sends them to us.
 */
export interface AddServerProps {
  /** Called after the server has accepted us, for anyone who wants to know. */
  onAdded?: () => void;
}

export function AddServer({ onAdded }: AddServerProps = {}) {
  const [serverUrl, setServerUrl] = useState('');
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const nameInput = useRef<HTMLInputElement>(null);

  // A join link fills in where and how, but never who: the name stays for
  // the person to type, and the field they land on is that one.
  useEffect(
    () =>
      window.layup.server.onPrefill((link) => {
        setServerUrl(link.serverUrl);
        setCode(link.code);
        nameInput.current?.focus();
      }),
    [],
  );

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (connecting) return;
    setConnecting(true);
    setMessage(undefined);
    try {
      const result = await window.layup.server.add({
        // "layup.example" is what people type; https is what they mean.
        serverUrl: normaliseServerUrl(serverUrl),
        code: code.trim(),
        displayName: displayName.trim(),
      });
      if (result.ok) {
        onAdded?.();
        return;
      }
      setMessage(result.message ?? 'the server refused, without saying why');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <main className="onboarding">
      <div className="onboarding__card">
        <h1>Add a server</h1>
        <p className="tagline">Somebody gave you an address and a join code. Use them here.</p>

        <form className="onboarding__form" onSubmit={(event) => void connect(event)}>
          <label htmlFor="add-server-url">Server</label>
          <input
            id="add-server-url"
            name="serverUrl"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="layup.example"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
          />

          <label htmlFor="add-server-code">Join code</label>
          <input
            id="add-server-code"
            name="code"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="LAYUP-XXXXXX"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />

          <label htmlFor="add-server-name">Your name</label>
          <input
            id="add-server-name"
            name="displayName"
            type="text"
            autoComplete="off"
            placeholder="Nick"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            ref={nameInput}
          />

          <button type="submit" className="onboarding__connect" disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </form>

        {message ? (
          <p className="onboarding__error" role="alert">
            {message}
          </p>
        ) : null}
      </div>
    </main>
  );
}
