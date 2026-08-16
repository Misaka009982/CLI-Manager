桌面宠物E的构建资源占位目录。

Windows 打包前，scripts/prepare-pet-e-runtime.mjs 会在此目录生成 pet-e/runtime、pet-e/app、许可证和校验清单。运行时通过 Tauri 的 $RESOURCE/pet-e 路径读取；本文件不代表已包含 Electron runtime。
