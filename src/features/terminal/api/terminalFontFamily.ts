import { normalizeFontFamilyStack, splitFontFamilyStack, toCssFontFamilyName } from "../../../shared/platform/systemFonts";

const POWERLINE_FALLBACK_STACK = [
  "\"Symbols Nerd Font Mono\"",
  "\"DejaVu Sans Mono for Powerline\"",
  "\"Droid Sans Mono for Powerline\"",
  "\"Source Code Pro for Powerline\"",
  "\"Roboto Mono for Powerline\"",
  "\"Cascadia Code PL\"",
  "\"CaskaydiaCove Nerd Font\"",
  "\"CaskaydiaCove Nerd Font Mono\"",
  "\"MesloLGS NF\"",
  "\"Meslo LG S for Powerline\"",
  "\"FiraCode Nerd Font\"",
  "\"Fira Code Nerd Font\"",
] as const;
// 仅用于识别旧版自动追加的完整尾部，不再注入运行时或保存到用户偏好。
const LEGACY_CJK_STACK = [
  "\"PingFang SC\"",
  "\"Microsoft YaHei UI\"",
  "\"Microsoft YaHei\"",
  "\"Hiragino Sans GB\"",
  "\"Noto Sans CJK SC\"",
  "\"Source Han Sans SC\"",
  "\"Noto Sans SC\"",
] as const;
const DEFAULT_MONOSPACE_STACK = [
  "\"Cascadia Code\"",
  "Consolas",
  "monospace",
] as const;
const GENERIC_MONOSPACE_TOKENS = new Set(["monospace", "ui-monospace"]);

const normalizeFamilyToken = (token: string) => token.trim().replace(/^['"]|['"]$/g, "");

const isGenericMonospaceToken = (token: string) =>
  GENERIC_MONOSPACE_TOKENS.has(normalizeFamilyToken(token).toLowerCase());

const dedupeTokens = (tokens: string[]) => {
  const seen = new Set<string>();
  return tokens.filter((token) => {
    const normalized = normalizeFamilyToken(token).toLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
};

// 只清理完整的旧版生成尾部；不按名称删除用户主动指定的 CJK/Powerline 字体。
export function normalizeTerminalFontPreference(fontFamily: string) {
  const tokens = splitFontFamilyStack(fontFamily)
    .map(toCssFontFamilyName)
    .filter(Boolean);

  if (tokens.length === 0) {
    return DEFAULT_MONOSPACE_STACK.join(", ");
  }

  const dedupedTokens = dedupeTokens(tokens);
  const genericMonospaceTokens = dedupedTokens.filter(isGenericMonospaceToken);
  const legacyTail = [...POWERLINE_FALLBACK_STACK, ...LEGACY_CJK_STACK];
  const tailStart = dedupedTokens.length - genericMonospaceTokens.length - legacyTail.length;
  const hasLegacyTail = tailStart >= 0
    && legacyTail.every((token, index) =>
      normalizeFamilyToken(token).toLowerCase() === normalizeFamilyToken(dedupedTokens[tailStart + index]).toLowerCase())
    && dedupedTokens.slice(tailStart + legacyTail.length).every(isGenericMonospaceToken);
  const preference = hasLegacyTail
    ? [...dedupedTokens.slice(0, tailStart), ...dedupedTokens.slice(tailStart + legacyTail.length)]
    : dedupedTokens;
  return normalizeFontFamilyStack(preference.join(", "), "monospace");
}

// 用户完整字体栈优先，浏览器仅在缺字或字体不可用时尝试后续符号字体与系统回退。
export function normalizeTerminalFontFamily(fontFamily: string) {
  return normalizeFontFamilyStack(
    normalizeTerminalFontPreference(fontFamily),
    [...POWERLINE_FALLBACK_STACK, "monospace"].join(", "),
  );
}
