const headerNames = ["Authorization", "Content-Type", "Accept", "X-API-Key", "User-Agent", "Accept-Language",
  "Cache-Control", "X-Request-ID", "X-Client-ID", "X-Auth-Token", "Cookie", "Origin", "Referer",
  "Accept-Encoding", "Api-Key", "Api-Version", "X-Goog-Api-Key", "OpenAI-Organization", "OpenAI-Project"];
const suggestions = {
  // 名称建议不限制用途；用户可以把请求头风格名称传给 stdio 服务，但不会自动转换成 HTTP 请求头。
  env: ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "API_KEY", "API_TOKEN", "ACCESS_TOKEN",
    "BASE_URL", "API_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
    "GITHUB_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN", "GITLAB_TOKEN", "GOOGLE_API_KEY", "GEMINI_API_KEY",
    "BRAVE_API_KEY", "TAVILY_API_KEY", "EXA_API_KEY", "FIRECRAWL_API_KEY", ...headerNames],
  headers: headerNames,
};

/** 模板优先、前缀优先；候选不限制自由输入，也不记忆密钥。 */
export function mcpFieldSuggestions(group: "env" | "headers", query: string, used: string[], preferred: string[] = []): string[] {
  const normalize = (value: string) => group === "headers" ? value.toLowerCase() : value;
  const occupied = new Set(used.map(normalize));
  const search = query.toLowerCase();
  return [...new Set([...preferred, ...suggestions[group]])]
    .filter(name => !occupied.has(normalize(name)) && name.toLowerCase().includes(search))
    .sort((a, b) => Number(b.toLowerCase().startsWith(search)) - Number(a.toLowerCase().startsWith(search)));
}
