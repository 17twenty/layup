# Layup protocol boundary

This directory is the single source of truth for the wire contract shared by the
Electron desktop and the Go control service.

```text
protocol/
├── VERSION      single protocol version string, read by both language bindings
├── go/          Go binding  (module github.com/layup-app/layup/protocol)
└── ts/          TypeScript binding (npm package @layup/protocol)
```

Rules:

- both bindings must express the same envelope and the same version;
- a change to the envelope or to a message name is a protocol change and must be
  declared by the task that makes it;
- the desktop and the control service must refuse to talk to an unsupported
  protocol version rather than guessing.
