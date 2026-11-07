import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import ts from "typescript";

const template = readFileSync(new URL("../src-tauri/src/pi_extension_template.ts", import.meta.url), "utf8")
  .replaceAll("__PI_SESSION_START__", "true")
  .replaceAll("__PI_RUNNING__", "true")
  .replaceAll("__PI_STOP__", "true");
const code = ts.transpileModule(`${template}\nexports.showSurface = showQuestionSurface;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// 只隔离 TUI 绘制与宿主窗口；执行真正的问答组件和取消处理，不复制生产分支。
function fixture({ failCustom = false } = {}) {
  let component;
  let editor;
  const calls = [];
  const keys = { escape: "escape", enter: "enter", up: "up", down: "down", tab: "tab", left: "left", right: "right", shift: (key) => `shift+${key}` };
  class EditorStub {
    constructor() { editor = this; }
    setText() {}
    handleInput() {}
    render() { return []; }
  }
  const schema = () => ({});
  const context = vm.createContext({
    exports: {}, queueMicrotask,
    require: (name) => {
      if (name === "node:crypto") return { randomUUID };
      if (name === "typebox") return { Type: { Object: schema, Array: schema, String: schema, Boolean: schema, Optional: schema } };
      if (name === "@earendil-works/pi-tui") return {
        Editor: EditorStub, Key: keys, matchesKey: (data, key) => data === key,
        Text: class {}, visibleWidth: (text) => text.length, wrapTextWithAnsi: (text) => [text],
      };
      throw new Error(`未提供的边界: ${name}`);
    },
  });
  vm.runInContext(code, context);
  const ctx = { mode: "tui", ui: {
    custom: (factory, options) => {
      calls.push(options);
      if (failCustom) return Promise.reject(new Error("custom failed"));
      return new Promise((resolve) => {
        let closed = false;
        const done = (value) => {
          if (closed) return;
          closed = true;
          component?.dispose?.();
          resolve(value);
        };
        component = factory({ requestRender() {} }, {
          fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text,
        }, {}, done);
      });
    },
  } };
  return {
    calls,
    show: (questions, signal, mode = "tui") => context.exports.showSurface(questions, { ...ctx, mode }, signal),
    key: (key) => component.handleInput(key),
    text: (text) => editor.onSubmit(text),
    ownDialogs: () => vm.runInContext("ownDialogs", context),
  };
}

const question = (id = "q1") => ({
  id, label: id, prompt: `问题 ${id}`, allowOther: true,
  options: [{ value: "yes", label: "同意", description: "继续操作" }],
});

test("自有问答声明 Pi 1.5.0 阻塞状态，确认后保持原答案结构", async () => {
  const f = fixture();
  const answer = f.show([question()]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].blocked.kind, "question");
  assert.equal(f.calls[0].blocked.message, "问题 q1");
  assert.equal(f.calls[0].overlay, undefined);
  assert.equal(f.ownDialogs(), 1);
  f.key("enter");
  const result = await answer;
  assert.equal(result.cancelled, false);
  assert.equal(result.answers[0].value, "yes");
  assert.equal(result.answers[0].index, 1);
  assert.equal(f.ownDialogs(), 0);
});

test("问卷仍按题目收集并显式提交，自定义答案不丢失", async () => {
  const f = fixture();
  const answer = f.show([question("q1"), question("q2")]);
  f.key("enter");
  f.key("down");
  f.key("enter");
  f.text("  自定义答案  ");
  f.key("enter");
  const result = await answer;
  assert.equal(result.cancelled, false);
  assert.equal(result.answers.length, 2);
  assert.equal(result.answers[0].id, "q1");
  assert.equal(result.answers[1].id, "q2");
  assert.equal(result.answers[1].value, "自定义答案");
  assert.equal(result.answers[1].wasCustom, true);
  assert.equal(f.ownDialogs(), 0);
});

test("用户取消与宠物先答的 abort 均关闭当前自绘界面并配平计数", async () => {
  for (const reason of ["escape", "pet-answer"]) {
    const f = fixture();
    const controller = new AbortController();
    const answer = f.show([question()], controller.signal);
    if (reason === "escape") f.key("escape");
    else controller.abort();
    const result = await answer;
    assert.equal(result.cancelled, true, reason);
    assert.equal(result.answers.length, 0);
    assert.equal(f.ownDialogs(), 0);
  }
});

test("非 TUI、空题目和预先取消不创建阻塞界面，宿主失败也不遗留计数", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await f.show([question()], undefined, "rpc")).cancelled, true);
  assert.equal((await f.show([])).cancelled, true);
  assert.equal((await f.show([question()], controller.signal)).cancelled, true);
  assert.equal(f.calls.length, 0);
  const failed = fixture({ failCustom: true });
  await assert.rejects(failed.show([question()]), /custom failed/);
  assert.equal(failed.ownDialogs(), 0);
});
