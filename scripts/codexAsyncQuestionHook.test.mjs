import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let questionPredicate;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "isQuestionRequestNotification") questionPredicate = node;
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(questionPredicate);
const compiled = ts.transpileModule(`module.exports = ${questionPredicate.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const module = { exports: null };
vm.runInNewContext(compiled, {
  module,
  CLAUDE_QUESTION_TOOL_NAME: "AskUserQuestion",
  CODEX_QUESTION_TOOL_NAME: "request_user_input",
  CODEX_ASYNC_QUESTION_TOOL_NAME: "request_user_input_async",
});
const isQuestion = module.exports;

test("Codex sync and async questions require attention, other tools do not", () => {
  for (const toolName of ["request_user_input", "request_user_input_async"]) {
    assert.equal(isQuestion({ source: "codex", event: "Notification", toolName }), true);
  }
  assert.equal(isQuestion({ source: "codex", event: "Notification", toolName: "request_user_input_async_extra" }), false);
  assert.equal(isQuestion({ source: "codex", event: "ToolStart", toolName: "request_user_input_async" }), false);
  assert.equal(isQuestion({ source: "claude", event: "Notification", toolName: "request_user_input_async" }), false);
});
