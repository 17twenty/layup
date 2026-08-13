import { PROTOCOL_VERSION } from '@layup/protocol';
import { ControlStatus } from './ControlStatus';
import { Identity } from './Identity';
import { RealtimeStatus } from './RealtimeStatus';

export function App() {
  return (
    <main className="shell">
      <h1>Layup</h1>
      <p className="tagline">People → Layup → Share → Collaborate</p>
      <Identity />
      <ControlStatus />
      <RealtimeStatus />
      <p className="meta">protocol v{PROTOCOL_VERSION}</p>
    </main>
  );
}
