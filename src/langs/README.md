# Bundled Ctags parsers

Each `*.ctags` file here is loaded after `--options=NONE`, so it applies in every
repository without reading untrusted project Ctags configuration. Two kinds:

- `maps.ctags` remaps extensions to parsers Universal Ctags already ships
  (`.tsx`/`.mts`/`.cts` to TypeScript, `.cjs` to JavaScript, `.hcl` to Terraform).
- The rest are regex optlib parsers for popular languages Ctags lacks. Being
  regex-based they find definitions without scope, so some function-local
  declarations also appear, and nested or multi-line signatures can be missed.

To add a language, drop a `.ctags` file here; the indexer loads every file in
this directory and rebuilds affected caches automatically.
