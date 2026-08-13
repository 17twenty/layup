# ADR-0006 - Native input helper boundary

Status: Accepted for PLAN-1

OS input injection lives in a separate privileged local helper reached through authenticated narrow IPC. The Electron renderer never receives arbitrary injection capability.
