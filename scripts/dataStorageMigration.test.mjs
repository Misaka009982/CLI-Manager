import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const section = readFileSync(new URL("../src/features/settings/components/pages/DataStorageSection.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("DataStorageSection.tsx", section, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const fn = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "dataStorageErrorMessage");
assert.ok(fn, "the actual settings error mapper must exist");
const compiled = ts.transpileModule(fn.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const errorMessage = new Function(`${compiled}; return dataStorageErrorMessage;`)();

// 直接读取真实领域字典的静态字符串，避免为测试引入 UI/store 依赖或模拟翻译内容。
function messages(language) {
  const code = readFileSync(new URL(`../src/shared/i18n/messages/settings.${language}.ts`, import.meta.url), "utf8");
  const ast = ts.createSourceFile("messages.ts", code, ts.ScriptTarget.Latest, true);
  const result = {};
  function visit(node) {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && ts.isStringLiteral(node.initializer)) {
      result[node.name.text] = node.initializer.text;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}

for (const language of ["zh-CN", "en-US"]) {
  const dictionary = messages(language);
  const t = (key, params = {}) => {
    assert.equal(typeof dictionary[key], "string", `missing ${language} message: ${key}`);
    return dictionary[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
  };
  test(`${language}: migration link failures explain retained data and keep the exact path`, () => {
    const path = "C:\\Users\\tester\\data\\linked folder\\api.sock";
    for (const value of [`data_storage_migration_symlink_rejected: ${path}`,
      new Error(`data_storage_migration_symlink_rejected: ${path}`)]) {
      const result = errorMessage(value, t);
      assert.equal(result, t("settings.dataStorage.error.migrationLink", { path }));
      assert.ok(result.includes(path));
      assert.ok(!result.includes("data_storage_migration_symlink_rejected"));
    }
  });
  test(`${language}: active services and unconfirmed sockets have distinct localized feedback`, () => {
    assert.equal(errorMessage("data_storage_tasks_active", t), t("settings.dataStorage.error.tasksActive"));
    assert.equal(errorMessage("data_storage_runtime_socket_probe_failed: 10013", t), t("settings.dataStorage.error.runtimeSocket"));
    assert.equal(errorMessage("data_storage_path_is_symlink", t), t("settings.dataStorage.error.symlink"));
    assert.equal(errorMessage("data_storage_bootstrap_is_symlink", t), t("settings.dataStorage.error.symlink"));
    assert.equal(errorMessage("unexpected error", t), "unexpected error");
  });
}

test("restart failure feedback uses the actual mapper, not the raw persisted error", () => {
  assert.match(section, /dataStorageErrorMessage\(status\.lastError, t\)/);
});

test("switch IPC retains daemon safety without the retired manager", () => {
  const code = readFileSync(new URL("../src-tauri/src/features/app-data/commands.rs", import.meta.url), "utf8");
  const command = code.slice(code.indexOf("pub async fn app_prepare_data_dir_switch"));
  assert.doesNotMatch(command, /CcConnectManager|data_storage_idle_guard/);
  assert.ok(command.indexOf("validate_data_storage_switch(") < command.indexOf("daemon_bridge.get()"));
  assert.ok(command.indexOf("session.alive") < command.indexOf("prepare_data_storage_switch("));
  assert.match(command, /data_storage_tasks_active/);
  assert.match(command, /shutdown_if_idle\(\)\?/);
  assert.match(section, /targetMode: switchRequest\.mode/);
  assert.match(section, /migrate,\s*\}\)/);
});
