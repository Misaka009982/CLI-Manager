import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const text = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("App.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["getClaudeHookToastStyle", "getClaudeHookToastTitle", "getSystemNotificationBody"];
const functions = source.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(functions.length, names.length);
const code = ts.transpileModule(functions.map((node) => node.getText(source)).join("\n"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const messages = JSON.parse(readFileSync(new URL("../src/shared/i18n/messages/pi-hook.json", import.meta.url), "utf8"));

// 执行应用真实格式化函数；翻译使用共享 JSON，避免仅检查键名却漏掉硬编码回退。
for (const language of ["zh-CN", "en-US"]) {
  test(`Pi run-ended wording reaches toast title, eyebrow and system body (${language})`, () => {
    const context = vm.createContext({
      resolveCliHookStatus: () => ({ goalStatus: null }),
      isQuestionRequestNotification: () => false,
      getCliHookSourceName: () => "Pi Agent", localizeHookMessage: () => null,
      CircleCheck: "check", CircleAlert: "error", Info: "info", ShieldAlert: "shield",
      translateCurrent: (key, params = {}) => Object.entries(params).reduce(
        (value, [name, replacement]) => value.replaceAll(`{${name}}`, replacement), messages[language][key] ?? key,
      ),
    });
    vm.runInContext(code, context);
    const pi = { source: "pi", event: "Stop" };
    const label = messages[language]["notifications.hookToast.piRunEnded"];
    assert.equal(context.getClaudeHookToastStyle(pi).eyebrow, label);
    assert.match(context.getClaudeHookToastTitle(pi, "demo"), /demo/);
    assert(context.getSystemNotificationBody(pi, "demo").includes(language === "en-US" ? "run ended" : label));
    for (const source of ["claude", "codex", "kimi", "grok", "opencode"]) {
      const payload = { source, event: "Stop" };
      assert.equal(context.getClaudeHookToastTitle(payload, "demo"), "notifications.hookToast.title.finished");
    }
    assert.equal(context.getClaudeHookToastTitle({ source: "pi", event: "StopFailure" }, "demo"), "notifications.hookToast.title.failed");
  });
}
