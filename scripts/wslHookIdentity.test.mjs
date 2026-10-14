import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// 执行实际受管插件源码，隔离 process/fetch，避免触碰用户环境或发送网络请求。
function loadPlugin(source, distro) {
  const payloads = [];
  const exports = {};
  // 生命周期用例不创建问答界面；仅桩掉 Pi 提供的 schema/TUI 边界，不要求安装 Pi。
  const schema = () => ({});
  const require = (name) => {
    if (name === "typebox") {
      return { Type: { Object: schema, Array: schema, String: schema, Boolean: schema, Optional: schema } };
    }
    if (name === "@earendil-works/pi-tui") return {};
    throw new Error(`未声明的插件测试依赖：${name}`);
  };
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, {
    exports,
    require,
    crypto: { randomUUID },
    // 不创建真实心跳定时器；这里只检查显式触发的生命周期通知。
    setInterval: () => 1,
    clearInterval: () => {},
    process: {
      env: {
        CLI_MANAGER_TAB_ID: "wsl-tab",
        CLI_MANAGER_NOTIFY_PORT: "12345",
        CLI_MANAGER_NOTIFY_TOKEN: "fixture-only",
        ...(distro === undefined ? {} : { WSL_DISTRO_NAME: distro }),
      },
      cwd: () => "/mnt/f/project/worktree",
    },
    fetch: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return { ok: true, status: 204 };
    },
    AbortController, AbortSignal, setTimeout, clearTimeout,
  });
  return { exports, payloads };
}

// 按 Rust include_str! 的实际目标读取 fork 模板，启用全部生命周期模块。
function piSource() {
  const rustUrl = new URL("../src-tauri/src/features/hooks/settings/pi.rs", import.meta.url);
  const rust = readFileSync(rustUrl, "utf8");
  const templatePath = rust.match(/include_str!\("([^"]*pi_extension_template\.ts)"\)/);
  assert.ok(templatePath, "Pi 外部受管模板必须可定位");
  return readFileSync(new URL(templatePath[1], rustUrl), "utf8")
    .replaceAll("__PI_MARKER__", "__CLI_MANAGER_PI_TEST__")
    .replace(/__PI_(?:SESSION_START|RUNNING|STOP)__/g, "true");
}

const opencodeSource = readFileSync(new URL("../src-tauri/resources/opencode/cli-manager-hook.js", import.meta.url), "utf8");

for (const [label, distro, expected] of [
  ["Ubuntu", "Ubuntu", "Ubuntu"],
  ["other distro", "  Debian  ", "Debian"],
  ["native local", undefined, null],
  ["empty identity", "  ", null],
]) {
  test(`Pi lifecycle reports the guest identity: ${label}`, async () => {
    const { exports, payloads } = loadPlugin(piSource(), distro);
    const handlers = new Map();
    exports.default({
      on: (event, callback) => handlers.set(event, callback),
      getAllTools: () => [],
    });
    for (const event of ["session_start", "agent_start", "agent_settled"]) {
      await handlers.get(event)({}, { sessionManager: { getSessionId: () => "pi-session" } });
    }
    await Promise.resolve();
    assert.deepEqual(payloads.map((p) => p.event), ["SessionStart", "UserPromptSubmit", "Stop"]);
    for (const payload of payloads) {
      assert.equal(payload.wslDistroName, expected);
      assert.equal(payload.tabId, "wsl-tab");
      assert.equal(payload.sessionId, "pi-session");
      assert.equal(payload.cwd, "/mnt/f/project/worktree");
    }
  });

  test(`OpenCode lifecycle reports the guest identity: ${label}`, async () => {
    const { exports, payloads } = loadPlugin(opencodeSource, distro);
    const bridge = await exports.CliManagerSessionBridge();
    await bridge.event({ type: "session.created", properties: { sessionID: "ses_wsl" } });
    await bridge.event({ type: "session.status", properties: { sessionID: "ses_wsl", status: { type: "busy" } } });
    await bridge.event({ type: "session.idle", properties: { sessionID: "ses_wsl" } });
    assert.deepEqual(payloads.map((p) => p.event), ["SessionStart", "UserPromptSubmit", "Stop"]);
    for (const payload of payloads) {
      assert.equal(payload.wslDistroName, expected);
      assert.equal(payload.tabId, "wsl-tab");
      assert.equal(payload.sessionId, "ses_wsl");
      assert.equal(payload.cwd, "/mnt/f/project/worktree");
    }
  });
}
