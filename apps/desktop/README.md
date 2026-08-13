# Layup desktop

Electron main + hardened preload + React renderer.

```text
src/main/      privileged: windows, capture, media, control-plane client
src/preload/   the entire surface the renderer can reach (bundled, sandboxed)
src/renderer/  unprivileged React UI
src/core/      framework-free logic shared by main and tests
src/shared/    the IPC contract
```

## Running two clients on one machine

PLAN-1 identity is a development handle - no passwords, no tokens, no identity
provider. Pick who a client is with `LAYUP_DEV_USER` (`nick`, `karl`, `emelia`,
`priya`; default `nick`).

```bash
# terminal 1
make dev-control

# terminal 2
LAYUP_DEV_USER=nick npm run dev

# terminal 3
LAYUP_DEV_USER=karl npm run dev
```

Both clients talk to the same control service (`LAYUP_CONTROL_URL`, default
`http://127.0.0.1:8787`). The server resolves the handle against its directory
and decides the organisation itself - a client cannot assert one.

## Commands

```bash
npm run dev            # Vite renderer + compiled main/preload + Electron
npm run build          # main (tsc) + preload (bundled) + renderer (Vite)
npm test               # unit tests
npm run test:smoke     # against a real Go control service (needs Go)
npm run test:boundary  # renderer privilege proof in a real window
```
