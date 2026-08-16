# 桌面宠物E说明

桌面宠物E的程序代码随 CLI-Manager 一并发布，并遵循仓库根目录的 AGPL-3.0-or-later 许可与版权声明。

本目录不复制或再分发任何 Clawd、Calico、Cloudling 或 Codex 宠物 artwork。运行时只读取 CLI-Manager 已校验的本机 Codex 宠物包，并通过受限的 `pet-e-asset:` 协议向 Electron renderer 提供当前精灵图。

Windows 安装包内的 Electron runtime 由官方 `41.10.2` Windows x64 发布 ZIP 提供。构建阶段会校验 `pet-e/runtime-manifest.json` 中的来源和 SHA-256，然后把 runtime、应用产物、此 NOTICE 和许可证材料写入 `$RESOURCE/pet-e/`。应用启动阶段不下载 runtime。
