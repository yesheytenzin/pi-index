import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SymbolIndex } from "./indexer.ts";

const outputSchema = Type.Object({
  root: Type.String(),
  results: Type.Array(Type.Object({
    name: Type.String(), path: Type.String(), line: Type.Integer({ minimum: 1 }),
    kind: Type.String(), language: Type.Optional(Type.String()),
    scope: Type.Optional(Type.String()), signature: Type.Optional(Type.String()),
  })),
  coverage: Type.Unknown(),
  truncated: Type.Boolean(),
});

export default function (pi: ExtensionAPI) {
  const indexes = new Map<string, SymbolIndex>();
  function index(cwd: string) {
    let value = indexes.get(cwd);
    if (!value) {
      value = new SymbolIndex(cwd);
      indexes.set(cwd, value);
    }
    return value;
  }
  function result(value: Awaited<ReturnType<SymbolIndex["find"]>>) {
    return {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) } satisfies { type: "text"; text: string }],
      details: value,
      structuredContent: value,
    };
  }

  pi.registerTool(defineTool({
    name: "symbol_find",
    label: "Find symbol",
    outputSchema,
    description: "Find function, class, and method definitions in this Git worktree using a persistent local Ctags index. Exact names or prefixes only, not natural-language search or resolved references. Refreshes saved files before searching. Read current source before editing. Use text search for usages and strings. Requires Universal Ctags with JSON support.",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, description: "Symbol name or prefix" }),
      match: Type.Optional(Type.Union([Type.Literal("exact"), Type.Literal("prefix")])),
      path_prefix: Type.Optional(Type.String({ description: "Repository-relative path restriction" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      return result(await index(ctx.cwd).find(params, signal));
    },
  }));

  pi.registerTool(defineTool({
    name: "symbol_outline",
    label: "Outline file",
    outputSchema,
    description: "List Ctags definitions in a repository-relative source file, in source order. Refreshes saved files before querying. Reports indexing coverage. Does not read unsaved buffers or resolve references. Read current source before editing.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "Repository-relative file path" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      return result(await index(ctx.cwd).outline(params, signal));
    },
  }));

  pi.registerCommand("index", {
    description: "Inspect the symbol index (/index status) or rebuild it (/index rebuild)",
    async handler(args, ctx) {
      const action = args.trim() || "status";
      if (action !== "status" && action !== "rebuild") {
        if (ctx.hasUI) ctx.ui.notify("Usage: /index [status|rebuild]", "warning");
        return;
      }
      try {
        const value = action === "rebuild"
          ? await index(ctx.cwd).rebuild()
          : await index(ctx.cwd).status();
        if (ctx.hasUI) ctx.ui.notify(JSON.stringify(value, null, 2), "info");
        else pi.sendMessage({ customType: "pi-index-status", content: JSON.stringify(value, null, 2), display: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else pi.sendMessage({ customType: "pi-index-error", content: message, display: true });
      }
    },
  });

  pi.on("session_shutdown", () => {
    for (const value of indexes.values()) value.close();
    indexes.clear();
  });
}
