import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import ts from "typescript";

// 可选集成测试：在隔离目录安装官方固定版本，不改变项目依赖或用户的全局 Pi。
const sdkRoot = process.env.PI_SDK_DIR ?? join(tmpdir(), "cli-manager-pi-1.2.0-probe");
const packageRoot = join(sdkRoot, "node_modules/@earendil-works");
const manifest = join(packageRoot, "pi-coding-agent/package.json");
const available = existsSync(manifest);
const require = createRequire(import.meta.url);
// fork 模板还从 Pi 虚拟模块与 node:crypto 引入；仅桩这两个边界，不要求安装 Pi。
const schema = () => ({});
function requireStub(name) {
  if (name === "typebox") {
    return { Type: { Object: schema, Array: schema, String: schema, Boolean: schema, Optional: schema } };
  }
  if (name === "@earendil-works/pi-tui") return {};
  return require(name);
}
// 与 Rust include_str! 的实际目标一致，启用全部生命周期模块。
function piTemplate() {
  const rustUrl = new URL("../src-tauri/src/features/hooks/settings/pi.rs", import.meta.url);
  const rust = readFileSync(rustUrl, "utf8");
  const templatePath = rust.match(/include_str!\("([^"]*pi_extension_template\.ts)"\)/);
  assert.ok(templatePath, "Pi 外部受管模板必须可定位");
  return readFileSync(new URL(templatePath[1], rustUrl), "utf8")
    .replaceAll("__PI_SESSION_START__", "true")
    .replaceAll("__PI_RUNNING__", "true")
    .replaceAll("__PI_STOP__", "true");
}
const template = piTemplate();
const code = ts.transpileModule(template, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

test("official Pi 1.2.0: standard continuation, deferred run, abort and final error", { skip: !available }, async () => {
  assert.equal(JSON.parse(readFileSync(manifest, "utf8")).version, "1.2.0");
  const sdk = await import(pathToFileURL(join(packageRoot, "pi-coding-agent/dist/index.js")).href);
  const ai = await import(pathToFileURL(join(packageRoot, "pi-ai/dist/index.js")).href);
  const scenarios = ["normal", "tool-cycle", "before-settle", "follow-up", "deferred", "abort", "error", "retry-success", "compaction"];
  const directory = mkdtempSync(join(tmpdir(), "cli-manager-pi-sdk-state-"));
  try {
    for (const scenario of scenarios) {
      const sent = [];
      const events = [];
      const sandbox = vm.createContext({
        exports: {}, require: requireStub, crypto: { randomUUID },
        process: {
          pid: 100, cwd: () => directory,
          env: { CLI_MANAGER_TAB_ID: "sdk-tab", CLI_MANAGER_NOTIFY_PORT: "1234", CLI_MANAGER_NOTIFY_TOKEN: "test" },
        },
        AbortController, setTimeout, clearTimeout,
        setInterval: () => 1, clearInterval: () => {},
        fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; },
      });
      vm.runInContext(code, sandbox);
      let calls = 0;
      const modelRuntime = await sdk.ModelRuntime.create({
        credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(),
        modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
      });
      modelRuntime.registerProvider("cli-manager-test", {
        api: "openai-completions", apiKey: "test", baseUrl: "http://unused.invalid",
        models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 }],
        streamSimple: (model) => {
          calls += 1;
          const stream = new ai.AssistantMessageEventStream();
          const failed = scenario === "error" || (["retry-success", "compaction"].includes(scenario) && calls === 1);
          const toolCall = scenario === "tool-cycle" && calls === 1;
          const message = {
            role: "assistant", content: toolCall
              ? [{ type: "toolCall", id: "test-call", name: "test_tool", arguments: {} }]
              : [{ type: "text", text: "test reply" }],
            api: model.api, provider: model.provider, model: model.id,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: failed ? "error" : toolCall ? "toolUse" : "stop", timestamp: Date.now(),
            ...(failed ? { errorMessage: scenario === "compaction" ? "maximum context length exceeded" : "503 overloaded" } : {}),
          };
          queueMicrotask(() => {
            stream.push(failed ? { type: "error", reason: "error", error: message }
              : { type: "done", reason: toolCall ? "toolUse" : "stop", message });
            stream.end(message);
          });
          return stream;
        },
      });
      let continued = false;
      const settingsManager = sdk.SettingsManager.inMemory({
        compaction: { enabled: scenario === "compaction", keepRecentTokens: 1, reserveTokens: 1024 },
        retry: { enabled: scenario === "retry-success", maxRetries: 1, baseDelayMs: 1 },
      });
      const loader = new sdk.DefaultResourceLoader({
        cwd: directory, agentDir: directory, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [sandbox.exports.default, (pi) => {
          pi.on("agent_before_settle", () => {
            if (scenario !== "before-settle" || continued) return;
            continued = true;
            return { entries: [{ type: "custom_message", customType: "test", content: "continue", display: false }], continue: true };
          });
          pi.on("agent_end", () => {
            if (scenario !== "follow-up" || continued) return;
            continued = true;
            pi.sendUserMessage("follow up", { deliverAs: "followUp" });
          });
          pi.on("agent_settled", () => {
            if (scenario !== "deferred" || continued) return;
            continued = true;
            pi.sendUserMessage("new run");
          });
          pi.on("agent_start", (_event, ctx) => {
            if (scenario === "abort") ctx.abort();
          });
        }],
      });
      await loader.reload();
      const sessionManager = sdk.SessionManager.inMemory(directory);
      if (scenario === "compaction") {
        sessionManager.appendMessage({ role: "user", content: "earlier request", timestamp: Date.now() });
        sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "earlier response" }],
          api: "openai-completions", provider: "cli-manager-test", model: "mock", stopReason: "stop", timestamp: Date.now(),
          usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      }
      const { session } = await sdk.createAgentSession({
        cwd: directory, agentDir: directory, resourceLoader: loader, modelRuntime,
        model: modelRuntime.getModel("cli-manager-test", "mock"), thinkingLevel: "off",
        sessionManager, settingsManager, tools: scenario === "tool-cycle" ? ["test_tool"] : [],
        customTools: [{ name: "test_tool", label: "Test", description: "In-memory test tool", parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: "tool result" }], details: {} }) }],
      });
      try {
        await session.bindExtensions({});
        session.subscribe((event) => {
          if (["agent_start", "agent_end", "agent_settled", "tool_execution_end", "compaction_start", "compaction_end"].includes(event.type)) events.push(event.type);
        });
        await session.prompt("test");
        await new Promise((resolve) => setTimeout(resolve, 30));
        const ends = sent.filter((event) => ["Stop", "StopFailure", "Interrupt"].includes(event.event));
        assert.equal(ends.length, 1, `${scenario}: ${JSON.stringify({ events, sent })}`);
        assert.equal(ends[0].event, scenario === "abort" ? "Interrupt" : scenario === "error" ? "StopFailure" : "Stop");
        if (["before-settle", "follow-up", "retry-success"].includes(scenario)) {
          assert(calls >= 2, scenario);
          assert.equal(events.filter((event) => event === "agent_settled").length, 1, scenario);
        }
        if (scenario === "deferred") assert.equal(events.filter((event) => event === "agent_settled").length, 2);
        if (scenario === "tool-cycle") assert(events.includes("tool_execution_end"));
        if (scenario === "compaction") {
          assert(events.includes("compaction_start"));
          assert(events.includes("compaction_end"));
          assert.equal(events.filter((event) => event === "agent_settled").length, 1);
        }
        console.log(`${scenario}: ${events.join(" -> ")} => ${ends[0].event}`);
      } finally {
        session.dispose();
      }
    }
  } finally {
    assert.equal(dirname(directory), tmpdir());
    rmSync(directory, { recursive: true, force: true });
  }
});
