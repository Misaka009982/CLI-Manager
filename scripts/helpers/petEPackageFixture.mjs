import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const runtimeManifest = JSON.parse(readFileSync(new URL("../../pet-e/runtime-manifest.json", import.meta.url), "utf8"));

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

// 仅生成可被真实校验器识别的 PE 头，不下载或执行 Electron。
export function fakeWindowsX64Executable() {
  const executable = Buffer.alloc(512);
  executable.writeUInt16LE(0x5a4d, 0);
  executable.writeUInt32LE(0x80, 0x3c);
  executable.write("PE\u0000\u0000", 0x80, "ascii");
  executable.writeUInt16LE(0x8664, 0x84);
  return executable;
}

// 临时目录和清理归调用者所有，两个打包回归共用完整资源输入。
export function createPetEPackageFixture(root) {
  writeFile(root, "runtime-manifest.json", `${JSON.stringify(runtimeManifest)}\n`);
  writeFile(root, "runtime/electron.exe", fakeWindowsX64Executable());
  writeFile(root, "runtime/version", "41.10.2\n");
  writeFile(root, "runtime/LICENSE", "Electron license\n");
  writeFile(root, "runtime/LICENSES.chromium.html", "Chromium notices\n");
  writeFile(root, "runtime/resources/default_app.asar", "asar\n");
  writeFile(root, "app/package.json", `${JSON.stringify({
    name: "cli-manager-desktop-pet-e-runtime",
    version: "1.0.0",
    private: true,
    type: "module",
    main: "main.js",
  })}\n`);
  for (const relativePath of [
    "app/main.js",
    "app/preload.cjs",
    "app/bridge/protocol.js",
    "app/bridge/agent-action.js",
    "app/renderer/index.html",
    "app/renderer/app.js",
    "app/renderer/task-state.js",
    "app/renderer/agent-action.js",
    "app/renderer/styles.css",
  ]) {
    writeFile(root, relativePath, "static\n");
  }
  writeFile(root, "NOTICE.md", "notice\n");
  writeFile(root, "LICENSES/CLI-Manager-AGPL-3.0-or-later.txt", "license\n");
  writeFile(root, "LICENSES/README.md", "license readme\n");
  return root;
}
