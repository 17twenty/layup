import { PROTOCOL_VERSION } from '@layup/protocol';
import { ControlStatus } from './ControlStatus';

export function App() {
  return (
    <main className="shell">
      <h1>Layup</h1>
      <p className="tagline">People → Layup → Share → Collaborate</p>
      <ControlStatus />
      <p className="meta">protocol v{PROTOCOL_VERSION}</p>
    </main>
  );
}
