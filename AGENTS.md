# AGENTS.md

## Purpose
This repo is the Electron signage player. Future agents must treat main-process lifecycle, persistence, IPC, and renderer state as one runtime system.

## Required workflow
1. Trace the feature end-to-end before editing.
2. Inspect the real flow in this order when relevant:
   - main-process lifecycle/state machine
   - service/client implementation
   - persistence/local identity handling
   - renderer IPC/UI consumer
   - existing tests
   - docs/runbooks
3. Edit the smallest correct set of files.
4. If lifecycle or recovery behavior changes, update tests and docs in the same change.
5. Do not declare a feature complete until required local validation passes.

## Player-specific tracing rules
- Trace main-process state machine -> service -> persistence -> IPC -> renderer UI.
- Lifecycle changes require state-machine test updates.
- Runtime/recovery changes require integration or fault coverage, not only isolated unit coverage.
- Keep device identity logic in main process; renderer must consume snapshots only.

## Testing policy
Every feature change must include one or more of:
- unit tests for touched services/state transitions
- integration tests for lifecycle flows
- fault-injection tests when networking/recovery semantics change
- docs update if operator/device workflow changes

Renderer-only UI checks are not enough when lifecycle behavior changes.

## Minimum validation before completion
- `npm run build`
- `npm run test:unit`
- `npm run test:integration` when lifecycle or pairing flow changes
- `npm run test:fault` when networking/recovery behavior changes

## File change guidance
- Keep public lifecycle states explicit and deterministic.
- Preserve cached playback and offline replay behavior unless the task explicitly changes it.
- Prefer one centralized outbound auth/header path and one error-classification path.
- Do not add renderer-derived identity state.
