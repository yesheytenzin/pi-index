---
name: verify-pi-index
description: Verify pi-index through real Pi tool dispatch, Git, Ctags, and SQLite, including local package installation.
---

# Verify pi-index

## Prerequisites

Run from the package root. `pi --version` must report a compatible Pi installation. `ctags --list-features` must include `json`.

No account or API key is needed. The verification script creates a temporary Git repository and removes it after the run.

## Flows

| Feature | Command | Pass criterion |
| --- | --- | --- |
| Type contract | `npm run check` | TypeScript exits successfully. |
| Index behavior | `npm test` | Real Git, Ctags, and SQLite tests pass. |
| Pi tools | `npm run verify` | Prints `PASS real Pi explicit extension` after finding a definition, showing an outline, observing an external edit, removing an old symbol, and rejecting an escaping path. |
| Installed package | `pi install "$PWD"`, then `node scripts/verify-pi.mjs --installed` | Prints `PASS real Pi installed package`. |
| Human command | Start `pi` in a Git repository and run `/symbols rebuild`, then `/symbols status`. | Both commands report index metadata without an extension error. |

The live script uses a deterministic local provider to request a tool call. The real Pi runtime validates and dispatches tools. Git, Ctags, SQLite, and file updates are real. This proves integration, not whether a remote model will choose the tool unaided.
