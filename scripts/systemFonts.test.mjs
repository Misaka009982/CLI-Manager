import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mergeFontFamilyOptions,
  normalizeFontFamilyStack,
  withFontFallback,
} from "../src/shared/platform/systemFonts.ts";

import ts from "typescript";
import { runInNewContext } from "node:vm";
import * as systemFonts from "../src/shared/platform/systemFonts.ts";

// 执行真实 TypeScript 模块，依赖使用同一个字体序列化实现；不复制被测逻辑。
const source = readFileSync(new URL("../src/features/terminal/api/terminalFontFamily.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
runInNewContext(compiled, { module, exports: module.exports, require: () => systemFonts });
const { normalizeTerminalFontFamily, normalizeTerminalFontPreference: terminalNormalizer } = module.exports;

const themeSettingsSource = readFileSync(
  new URL("../src/features/settings/components/pages/ThemeSettingsPage.tsx", import.meta.url),
  "utf8"
);

test("terminal font options use the terminal-specific normalizer", () => {
  assert.match(
    themeSettingsSource,
    /TERMINAL_FONT_FALLBACK,\s*normalizeTerminalFontPreference,?\s*\)/
  );
});

for (const family of ["Maple Mono", "霞鹜文楷等宽", "ACME, Mono", "Mono.Name (Pro)"]) {
  test(`matches installed terminal font option: ${family}`, () => {
    const selectedValue = terminalNormalizer(withFontFallback(family, "monospace"));
    const options = mergeFontFamilyOptions(
      selectedValue,
      [],
      [{ family }],
      "monospace",
      terminalNormalizer
    );

    assert.equal(options[0]?.label, family);
    assert.equal(options.some((option) => option.label === "当前自定义（保留）"), false);
  });
}

test("serializes a comma-containing system font as one CSS family", () => {
  assert.equal(withFontFallback("ACME, Mono", "monospace"), '"ACME, Mono", monospace');
});

test("keeps a genuinely unavailable terminal font as current custom", () => {
  const selectedValue = terminalNormalizer(withFontFallback("Unavailable Mono", "monospace"));
  const options = mergeFontFamilyOptions(
    selectedValue,
    [],
    [{ family: "Maple Mono" }],
    "monospace",
    terminalNormalizer
  );

  assert.equal(options[0]?.label, "当前自定义（保留）");
});

test("user font stacks keep their priority including generic monospace", () => {
  for (const value of ['monospace', 'ui-monospace', 'Consolas, monospace', '"Custom Mono", Consolas, monospace', '"ACME, Mono", monospace']) {
    const preference = terminalNormalizer(value);
    const runtime = normalizeTerminalFontFamily(value);
    assert.ok(runtime.startsWith(preference + ", "));
    assert.equal(runtime.includes("Microsoft YaHei"), false);
    assert.equal(runtime.includes("PingFang"), false);
    assert.equal(normalizeTerminalFontFamily(runtime), runtime);
  }
});

test("empty preference uses a concrete monospace default without CJK injection", () => {
  assert.equal(terminalNormalizer(" "), '"Cascadia Code", Consolas, monospace');
  assert.ok(normalizeTerminalFontFamily("").startsWith('"Cascadia Code", Consolas, monospace,'));
});

test("explicit Chinese fonts and mixed custom stacks are preserved", () => {
  for (const value of ['"Microsoft YaHei", monospace', '"PingFang SC", Consolas, monospace', '"霞鹜文楷等宽", "Microsoft YaHei", monospace']) {
    assert.equal(terminalNormalizer(value), value);
    assert.ok(normalizeTerminalFontFamily(value).startsWith(value));
  }
});

// 固定历史配置夹具，避免从当前实现的常量拼出自证测试。
const legacyTail = '"Symbols Nerd Font Mono", "DejaVu Sans Mono for Powerline", "Droid Sans Mono for Powerline", "Source Code Pro for Powerline", "Roboto Mono for Powerline", "Cascadia Code PL", "CaskaydiaCove Nerd Font", "CaskaydiaCove Nerd Font Mono", "MesloLGS NF", "Meslo LG S for Powerline", "FiraCode Nerd Font", "Fira Code Nerd Font", '
  + '"PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", "Noto Sans SC", monospace';

test("complete legacy generated suffix is removed without losing selected fonts", () => {
  assert.equal(terminalNormalizer('Consolas, ' + legacyTail), 'Consolas, monospace');
  assert.equal(terminalNormalizer('"ACME, Mono", ' + legacyTail), '"ACME, Mono", monospace');
  assert.equal(terminalNormalizer(legacyTail), 'monospace');
  assert.equal(normalizeTerminalFontFamily('Consolas, ' + legacyTail).includes('Microsoft YaHei'), false);
});

test("ambiguous edited legacy suffix is not automatically deleted", () => {
  const edited = 'Consolas, ' + legacyTail.replace('"Hiragino Sans GB", ', '');
  assert.equal(terminalNormalizer(edited), edited);
});

test("font selector and persistence use preferences, previews use runtime fallbacks", () => {
  const preference = terminalNormalizer('"ACME, Mono", ' + legacyTail);
  const options = mergeFontFamilyOptions(preference, [], [{family: "ACME, Mono"}], "monospace", terminalNormalizer);
  assert.equal(options[0].value, '"ACME, Mono", monospace');
  assert.match(themeSettingsSource, /update\("fontFamily", normalizeTerminalFontPreference\(value\)\)/);
  assert.match(themeSettingsSource, /value=\{normalizeTerminalFontPreference\(fontFamily\)\}/);
  assert.match(themeSettingsSource, /const normalizedFontFamily = normalizeTerminalFontFamily\(fontFamily\)/);
});
