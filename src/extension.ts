import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SymbolIndex, type Coverage } from "./indexer.ts";

// Group a reason's skipped paths: unsupported files roll up by extension (one ".zig ×41"
// line beats 41 paths), everything else lists a few example paths.
function describeSkips(reason: string, paths: string[]): string {
  if (reason === "unsupported-language") {
    const byExtension = new Map<string, number>();
    for (const path of paths) {
      const base = path.slice(path.lastIndexOf("/") + 1);
      const dot = base.lastIndexOf(".");
      const key = dot > 0 ? base.slice(dot) : "(no extension)";
      byExtension.set(key, (byExtension.get(key) ?? 0) + 1);
    }
    return [...byExtension].sort((a, b) => b[1] - a[1]).map(([ext, n]) => `${ext} ×${n}`).join(", ");
  }
  const shown = paths.slice(0, 5).join(", ");
  return paths.length > 5 ? `${shown}, +${paths.length - 5} more` : shown;
}

function formatReport(verb: string, value: { root: string; coverage: Coverage; initialized?: boolean }): string {
  if (value.initialized === false) return `${value.root}\nNo index built yet — run /index rebuild to create it.`;
  const c = value.coverage;
  const lines = [
    `${verb} · ${value.root}`,
    `${c.indexed} of ${c.discovered} files indexed` + (c.unsupported ? ` · ${c.unsupported} unsupported language` : ""),
  ];
  if (c.skipped_total) {
    const groups = new Map<string, string[]>();
    for (const { path, reason } of c.skipped) groups.set(reason, [...(groups.get(reason) ?? []), path]);
    lines.push(`Skipped ${c.skipped_total}${c.skipped_truncated ? ` (showing first ${c.skipped.length})` : ""}:`);
    for (const [reason, paths] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  ${reason} (${paths.length}): ${describeSkips(reason, paths)}`);
    }
  }
  return lines.join("\n");
}

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
        const report = formatReport(action === "rebuild" ? "Index rebuilt" : "Index status", value);
        if (ctx.hasUI) ctx.ui.notify(report, "info");
        else pi.sendMessage({ customType: "pi-index-status", content: report, display: true });
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
