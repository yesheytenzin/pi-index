# pi-index

Local symbol navigation for Pi. Find definitions and inspect file outlines using Universal Ctags and a persistent SQLite index.

## Install

Requirements:

- Pi 1.4.0 or a compatible version with `defineTool` and tool annotations.
- Node.js 24 or newer for development. Pi's standalone Bun executable is also supported.
- Git.
- Universal Ctags with JSON support, available as `ctags` on `PATH`.

Install Ctags with your package manager. On Arch Linux:

```sh
sudo pacman -S ctags
```

On Ubuntu:

```sh
sudo apt-get install universal-ctags
```

Install the extension from a checkout:

```sh
pi install /absolute/path/to/pi-index
```

Restart Pi or run `/reload` in an existing session. Open Pi inside a Git working tree. Ask it to find a definition or outline a file.

## Tools

`symbol_find` searches definitions by exact name or prefix. Optional parameters restrict the repository-relative path and result count.

```json
{"name":"SessionManager","match":"exact","limit":10}
```

`symbol_outline` lists definitions in a repository-relative file, in source order.

```json
{"path":"src/session.ts","limit":50}
```

Both tools reconcile saved files before answering. Results include paths, line numbers, symbol information, coverage, and a truncation flag. They locate definitions, not resolved references. Read current source before editing. Use text search for strings and potential callers.

## Commands

- `/index status` inspects the index.
- `/index rebuild` regenerates it from current files.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run verify
```

`npm run verify` starts the real Pi executable with a deterministic local test provider. No remote model is called. It drives the actual tools against Git and Ctags, checks external-edit freshness, and rejects an escaping path. The provider controls tool selection only; indexing is not mocked.

See [the verification checklist](.agents/skills/verify-pi-index/SKILL.md) for installed-package checks.

## Limits

Ctags support varies by language. Zig is not a built-in Ctags language, so pi-index bundles a regex optlib parser for it (`src/zig.ctags`, covering `fn`, `const`/`var`, `struct`/`enum`/`union`, and `test` blocks); being regex-based it finds definitions without scope, so some function-local declarations also appear. An empty result does not prove a definition is absent. The index does not include unsaved editor buffers, inferred types, a call graph, or semantic search.

Content reconciliation costs disk reads. This project does not claim a speedup over text search. A changing checkout is not an atomic filesystem snapshot.

Symbol names and paths are stored locally. No source code is sent to an indexing service. Normal Pi tool output still becomes part of the selected model's context.
