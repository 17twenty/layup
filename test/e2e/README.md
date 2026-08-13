# End-to-end and cross-component tests

These prove behaviour across a real boundary rather than against a mock.

| Harness | Command | What it proves |
|---|---|---|
| Desktop ↔ control smoke | `make test-smoke` | The desktop's control client reaches a freshly built Go control service, negotiates the protocol version, and reports a useful disconnected state once the service stops. |
| Electron security boundary | `make test-boundary` | A real window with the production preload gives the renderer no Node/OS privilege. |

Both harnesses build what they test, so they fail if the components drift apart.

Requirements: Go toolchain (smoke), a display or `xvfb-run` (boundary).
