import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), "pi-index-live-"));
const installed = process.argv.includes("--installed");
try {
  execFileSync("git", ["init", "-q", fixture]);
  await writeFile(join(fixture, "sample.ts"), "export function liveIndexProof() { return 1; }\n");
  const driver = join(fixture, "driver.ts");
  await writeFile(join(fixture, ".gitignore"), "cache/\ndriver.ts\n");
  await writeFile(driver, `
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
  let turns = 0;
  pi.registerProvider("pi-index-verifier", {
    api: "pi-index-verifier-api", apiKey: "local-verification", baseUrl: "http://unused.invalid",
    models: [{ id: "verify", name: "Local verification", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const call = turns++ === 0;
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: call ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (call) {
          const toolCall = { type: "toolCall", id: "verify-call", name: "verify_index", arguments: {} };
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
        }
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    }
  });
  pi.registerTool({
    name: "verify_index", label: "Verify index", description: "Drive real pi-index tools", parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      try {
        const query = async (name, args) => {
          const result = await ctx.executeTool(name, args);
          assert.notEqual(result.isError, true, JSON.stringify(result));
          return JSON.parse(result.result.content.find(block => block.type === "text").text);
        };
        const found = await query("symbol_find", { name: "liveIndexProof" });
        assert(found.results.some(hit => hit.path === "sample.ts" && hit.line === 1), JSON.stringify(found));
        const outline = await query("symbol_outline", { path: "sample.ts" });
        assert(outline.results.some(hit => hit.name === "liveIndexProof"), JSON.stringify(outline));
        await writeFile(join(ctx.cwd, "sample.ts"), "export function changedIndexProof() { return 2; }\\n");
        const changed = await query("symbol_find", { name: "changedIndexProof" });
        assert(changed.results.some(hit => hit.name === "changedIndexProof"));
        const old = await query("symbol_find", { name: "liveIndexProof" });
        assert.equal(old.results.length, 0);
        const invalid = await ctx.executeTool("symbol_outline", { path: "../outside.ts" });
        assert.equal(invalid.isError, true, JSON.stringify(invalid));
        process.stderr.write("PI_INDEX_LIVE_PASS\\n");
        return { content: [{ type: "text", text: "Verified" }], details: undefined };
      } catch (error) {
        process.stderr.write("PI_INDEX_LIVE_FAIL " + String(error.stack || error) + "\\n");
        throw error;
      }
    }
  });
}
`);
  const args = ["--print", "--mode", "json", "--no-session", "--no-mcp", "--no-skills", "--no-context-files", "--offline", "--no-approve", "--provider", "pi-index-verifier", "--model", "verify"];
  if (!installed) args.push("--no-extensions", "--extension", resolve(packageRoot, "src/extension.ts"));
  args.push("--extension", driver, "Run the verification tool.");
  const child = spawn("pi", args, {
    cwd: fixture,
    env: { ...process.env, PI_INDEX_CACHE_DIR: join(fixture, "cache") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    const events = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const failures = events.filter(event => event.type === "tool_execution_end" && event.isError);
    const diagnostics = stderr + JSON.stringify(failures);
    assert.equal(code, 0, diagnostics);
    assert(stderr.includes("PI_INDEX_LIVE_PASS"), diagnostics);
    console.log(`PASS real Pi ${installed ? "installed package" : "explicit extension"}: definition, outline, external edit, removed symbol, invalid path`);
  } finally { clearTimeout(timeout); }
} finally {
  await rm(fixture, { recursive: true, force: true });
}
