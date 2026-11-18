import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/** 仅读取真实源码；此夹具由用户运行，不把 AST/VM 隔离当作 DOM 验证。 */
export const readSource = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
export function sourceAst(path) {
  return ts.createSourceFile(path, readSource(path), ts.ScriptTarget.Latest, true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** 节点缺失立即报错，不能退回测试中重新实现的近似逻辑。 */
export function findNode(root, predicate, label) {
  let found;
  const visit = node => {
    if (found) return;
    if (predicate(node)) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(root);
  assert.ok(found, `找不到真实源码节点：${label}`);
  return found;
}

/** 执行真实表达式，只在平台边界注入依赖。 */
export function evaluateExpression(text, context = {}) {
  const compiled = ts.transpileModule(`module.exports = (${text});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { ...context, module });
  return module.exports;
}

export function functionSource(path, name) {
  const ast = sourceAst(path);
  const node = findNode(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === name, name);
  return node.getText(ast).replace(/^export\s+/, "");
}

export function sourceFunction(path, name, context = {}) {
  return evaluateExpression(functionSource(path, name), context);
}

/** 可选组件限定避免同名局部变量误匹配。 */
export function variableExpression(path, name, component) {
  const ast = sourceAst(path);
  const root = component
    ? findNode(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === component, component)
    : ast;
  const node = findNode(root, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name, name);
  return node.initializer.getText(ast);
}

export function settingsUpdateExpression() {
  const ast = sourceAst("src/shared/preferences/settingsStore.ts");
  return findNode(ast, node => ts.isPropertyAssignment(node) && node.name.getText(ast) === "update"
    && node.initializer.getText(ast).includes("prepareDesktopPetSettingUpdate"), "Settings.update").initializer.getText(ast);
}

/** 使用 load 的两条实际赋值，覆盖旧配置缺失字段的默认行为。 */
export function settingsMigrationSource() {
  const ast = sourceAst("src/shared/preferences/settingsStore.ts");
  return ["fileTreeSort", "fileTreeSortOverrides"].map(key => findNode(ast,
    node => ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)
      && node.expression.left.getText(ast) === `entries.${key}`,
    `Settings.load.${key}`).getText(ast)).join("\n");
}

/** 真实默认项，避免测试自行填充缺失的覆盖字段而掩盖 store 接线错误。 */
export function settingsDefaultsSource() {
  const ast = sourceAst("src/shared/preferences/settingsStore.ts");
  const defaults = findNode(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === "DEFAULTS", "DEFAULTS");
  return ["fileTreeSort", "fileTreeSortOverrides"].map(key => findNode(defaults,
    node => ts.isPropertyAssignment(node) && node.name.getText(ast) === key,
    `DEFAULTS.${key}`).getText(ast)).join(",\n");
}

/** 完整偏好模块只替换 Tauri 和 store；共享队列/继承计算保持真实实现。 */
export function evaluatePreferenceModule(context) {
  const compiled = ts.transpileModule(readSource("src/shared/preferences/fileTreeSortPreference.ts"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: name => {
    if (name === "@tauri-apps/api/core") return { isTauri: () => context.tauri };
    if (name === "./settingsStore") return { useSettingsStore: { getState: context.read } };
    if (name === "../lib/fileTreeSortOverrides") return context.overridesModule;
    throw new Error(`偏好夹具不允许未知依赖：${name}`);
  } });
  return module.exports;
}
