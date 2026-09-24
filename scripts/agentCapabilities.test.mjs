import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-agent-capabilities-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const emitModule = (name, path) => {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022}}).outputText
    .replaceAll('"../../../shared/lib/wslPaths"', '"./wslPaths.mjs"');
  writeFileSync(join(tempDir, name + ".mjs"), output);
};
emitModule("wslPaths", "../src/shared/lib/wslPaths.ts");

const source = readFileSync(new URL("../src/features/agents/api/agentCapabilities.ts", import.meta.url), "utf8");
const cardSource = readFileSync(new URL("../src/features/terminal/components/AgentCapabilitiesCard.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText.replaceAll('"../../../shared/lib/wslPaths"', '"./wslPaths.mjs"');
const modulePath = join(tempDir, "agentCapabilities.mjs");
writeFileSync(modulePath, output, "utf8");
const {
  buildSessionMcpEvidence,
  inferWslDistroName,
  normalizeAgentCapabilityError,
  resolveAgentRuntimeKind,
  resolveWslCapabilityLocation,
  toWslGuestPath,
} = await import(pathToFileURL(modulePath).href);

test("五类 Agent 启动命令映射稳定", () => {
  assert.equal(resolveAgentRuntimeKind("claude --model opus"), "claude");
  assert.equal(resolveAgentRuntimeKind("codex resume"), "codex");
  assert.equal(resolveAgentRuntimeKind("pi --provider test"), "pi");
  assert.equal(resolveAgentRuntimeKind("grok build"), "grok");
  assert.equal(resolveAgentRuntimeKind("opencode --continue"), "opencode");
});

test("仅 MCP 分类的当前会话工具事件成为健康证据", () => {
  const evidence = buildSessionMcpEvidence({
    tool_events: [
      { name: "Read", category: "builtin", status: "success" },
      { name: "docs", category: "mcp:docs", status: "success", timestamp: "2026-08-11T08:00:00Z" },
      { name: "search", category: "mcp:search", status: "failed", timestamp: "2026-08-11T08:01:00Z" },
    ],
  });
  assert.deepEqual(evidence, [
    { server: "docs", success: true, timestamp: "2026-08-11T08:00:00Z" },
    { server: "search", success: false, timestamp: "2026-08-11T08:01:00Z" },
  ]);
});

test("WSL 与错误信息只暴露稳定标识", () => {
  assert.equal(inferWslDistroName("\\\\wsl.localhost\\Ubuntu\\home\\dev"), "Ubuntu");
  assert.equal(
    normalizeAgentCapabilityError("agent_capability_wsl_timeout: token=secret"),
    "agent_capability_wsl_timeout",
  );
});

test("WSL 目标路径归一为 guest 内绝对路径", () => {
  assert.equal(toWslGuestPath("F:\\github\\cli-manager"), "/mnt/f/github/cli-manager");
  assert.equal(toWslGuestPath("\\\\wsl.localhost\\Ubuntu\\home\\dev\\app"), "/home/dev/app");
  assert.equal(toWslGuestPath("\\\\wsl$\\Ubuntu\\home\\dev"), "/home/dev");
  // OSC 7 在 Windows 上会带上主机名前缀
  assert.equal(toWslGuestPath("//DESKTOP-ABC/home/dev/app"), "/home/dev/app");
  assert.equal(toWslGuestPath("//DESKTOP-ABC/mnt/f/github/app"), "/mnt/f/github/app");
  assert.equal(toWslGuestPath("//DESKTOP-ABC"), "/");
  // 已是 guest 路径则原样保留
  assert.equal(toWslGuestPath("/home/dev/app"), "/home/dev/app");
  assert.equal(toWslGuestPath("  /mnt/f/github/app  "), "/mnt/f/github/app");
  // 解析不出的形态不臆造
  assert.equal(toWslGuestPath(""), null);
  assert.equal(toWslGuestPath(null), null);
  assert.equal(toWslGuestPath("relative/path"), null);
  assert.equal(toWslGuestPath("\\\\fileserver\\share"), null);
});

test("WSL 诊断目标优先采用 hook 上报的发行版并转换为 guest cwd", () => {
  // 场景 1/2：Windows 路径项目 + shell=wsl 是常见形态，项目路径与会话 cwd 都没有 UNC
  assert.deepEqual(
    resolveWslCapabilityLocation({
      hookDistroName: "Ubuntu-22.04",
      sessionCwd: "F:\\github\\cli-manager",
      projectPath: "F:\\github\\cli-manager",
    }),
    { distroName: "Ubuntu-22.04", cwd: "/mnt/f/github/cli-manager" },
  );
  assert.deepEqual(
    resolveWslCapabilityLocation({
      hookDistroName: "Ubuntu",
      sessionCwd: "/mnt/f/github/cli-manager",
      projectPath: "F:\\github\\cli-manager",
    }),
    { distroName: "Ubuntu", cwd: "/mnt/f/github/cli-manager" },
  );
  // 场景 3：WSL UNC 项目路径不回归
  assert.deepEqual(
    resolveWslCapabilityLocation({
      hookDistroName: null,
      sessionCwd: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\app",
      projectPath: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\app",
    }),
    { distroName: "Ubuntu", cwd: "/home/dev/app" },
  );
  // 场景 4：OSC 主机前缀路径不再被当成合法 guest 路径
  assert.deepEqual(
    resolveWslCapabilityLocation({
      hookDistroName: "Ubuntu",
      sessionCwd: "//DESKTOP-ABC/home/dev/app",
      projectPath: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\app",
    }),
    { distroName: "Ubuntu", cwd: "/home/dev/app" },
  );
  // hook 发行版缺失时回退到路径推断；两者都没有则保持 null，交由后端给出稳定错误
  assert.equal(
    resolveWslCapabilityLocation({ hookDistroName: "  ", sessionCwd: null, configRoot: "\\\\wsl.localhost\\Debian\\home\\dev" }).distroName,
    "Debian",
  );
  assert.deepEqual(
    resolveWslCapabilityLocation({ sessionCwd: null, projectPath: null }),
    { distroName: null, cwd: null },
  );
});

test("Agent 能力摘要打开对应受控页签且长内容不挤出状态徽章", () => {
  assert.match(cardSource, /value=\{activeTab\}/);
  assert.doesNotMatch(cardSource, /defaultValue="mcp"/);
  assert.match(cardSource, /onClick=\{\(\) => openDetails\("mcp"\)\}/);
  assert.match(cardSource, /onClick=\{\(\) => openDetails\("skills"\)\}/);
  assert.match(cardSource, /className="min-w-0 flex-1"/);
  assert.match(cardSource, /className="shrink-0"/);
  assert.match(cardSource, /<CliToolIcon icon=\{AGENT_ICON_KEYS\[agent\]\}/);
  assert.match(cardSource, /<HeaderPill color=\{TERM\.cyan\}>/);
});
