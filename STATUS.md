# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0302
- completed: 29
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0301 enumerate and preview capture sources
- result: done
- tests: `npm test` (119 passed incl. 9 capture cases), typecheck/lint green, boundary OK
- evidence:
  - `apps/desktop/src/main/capture.ts` - `desktopCapturer` runs in the privileged process and
    the renderer receives only a description (id, name, kind, display id, preview), never a
    capture handle; it then asks Chromium for the stream by id
  - untitled windows (OS artefacts) are dropped, empty thumbnails are omitted, screens sort
    first, and the log line carries counts only - never window names, never pixels
    (`never logs window names or pixels`)
  - `useLocalCapture` + `CapturePicker`: pick a source, live preview, stop cleanly. Stop
    releases every track, and unmounting releases capture too, so the OS recording indicator
    never stays lit
  - a refused capture shows the reason instead of a blank frame
  - 4 main-process tests + 5 renderer tests

## Recent runs

- P1-0207 done - link-join layups
- P1-0208 done - incoming invitation experience
- P1-0209 done - invite while already in a layup
- P1-0210 done - menu/tray pending attention
- P1-0301 done - enumerate and preview capture sources

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
