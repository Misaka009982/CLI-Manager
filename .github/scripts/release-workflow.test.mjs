import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../workflows/release.yml", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");
const build = workflow.split(/(?=^  [\w-]+:\n)/m)
  .find((job) => job.startsWith("  build:\n"));
assert.ok(build, "release must contain the desktop build job");
const steps = build.split(/(?=^      - )/m).slice(1);

// 从真实工作流定位资源生产者与 Cargo 消费者，缺少步骤时直接报告前置条件缺失。
function stepIndex(pattern, description) {
  const index = steps.findIndex((step) => pattern.test(step));
  assert.notEqual(index, -1, description);
  return index;
}

const web = stepIndex(/run: npm run web:build\b/, "web assets must be built before direct Cargo checks");
const agent = stepIndex(/name: Download bundled SSH Agent\b/, "signed Agent assets must be downloaded");
const verifyAgent = stepIndex(/name: Verify bundled SSH Agent files\b/, "downloaded Agent assets must be verified");
const proxy = stepIndex(/run: npm run test:codex-proxy:e2e\b/, "the real Windows proxy test must remain enabled");
const devProxy = stepIndex(/run: npm run test:tauri-dev-proxy\b/, "the Windows dev proxy test must remain enabled");
const bundle = stepIndex(/uses: tauri-apps\/tauri-action@/, "the signed Tauri build must remain enabled");

assert.ok(agent < verifyAgent, "verify Agent assets after download");
for (const consumer of [proxy, devProxy]) {
  assert.ok(web < consumer, "direct Cargo checks require generated web assets");
  assert.ok(verifyAgent < consumer, "direct Cargo checks require verified bundle resources");
  assert.ok(consumer < bundle, "Windows checks must gate signed packaging");
  assert.match(steps[consumer], /if: matrix\.platform == 'windows-latest'/);
}
assert.match(steps[web], /if: matrix\.platform == 'windows-latest'/);
assert.doesNotMatch(
  [web, agent, verifyAgent, proxy, devProxy].map((index) => steps[index]).join("\n"),
  /continue-on-error:\s*true/,
  "resource preparation and Windows checks must fail the release on error",
);
assert.match(workflow, /node \.github\/scripts\/release-workflow\.test\.mjs/);
console.log("release workflow resource prerequisites: checks passed");
