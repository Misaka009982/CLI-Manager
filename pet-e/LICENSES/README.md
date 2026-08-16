# 桌面宠物E许可证材料

桌面宠物E的应用代码随 CLI-Manager 发布，遵循仓库根目录的 AGPL-3.0-or-later 许可。构建脚本会把根目录 `LICENSE` 复制到安装包的 `pet-e/LICENSES/CLI-Manager-AGPL-3.0-or-later.txt`。

Electron runtime 使用官方 `41.10.2` Windows x64 发布 ZIP。该 ZIP 内的 `LICENSE` 和 `LICENSES.chromium.html` 原样保留在安装包的 `pet-e/runtime/` 下，作为 Electron 及其 Chromium 依赖的许可证材料。固定来源和 SHA-256 位于 `pet-e/runtime-manifest.json`。

本单元不复制 Clawd、Calico、Cloudling 或任何 Codex 宠物 artwork。宠物图像只从用户本机已经由 CLI-Manager 校验的 Codex 宠物包读取，不进入源码仓库或安装包。
