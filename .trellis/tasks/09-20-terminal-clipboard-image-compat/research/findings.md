# 兼容发现与验证边界

## 根因与触点
- 用户远端反馈：Snipaste 截图经微信粘贴并重新复制后可用；无法取到现场剪贴板，不能断言其具体格式。
- arboard 3.6.1 Windows PNG 优先分支失败直接返回，macOS 仅请求 TIFF；本次新增原生多格式适配。
- image 0.25.10 的 BMP new_without_file_header 对 V4/V5 BI_BITFIELDS 在头后额外加掩码偏移。用该库自己编码的 3×2 RGBA BMP 去掉文件头，可重现 UnexpectedEof；补显式 BMP 像素偏移后正常解码。新增透明度/V5/非法头测试。
- 前端空 MIME/files-only 图片此前漏识别，原生图片读取失败被吞；统一后端解码和显式错误。
- 文件预览、文件树导入、SSH legacy 协议预算不变；共享 macOS 文件路径读取新增 Finder 支持。

## 验证
- 13 项前端测试通过：识别/优先级/错误/像素/WSL/Web 既有链路。
- 8 项后端图片测试通过：PNG/TIFF/DIB、V5/alpha、损坏格式回退、20MiB/+1、8K/40M。
- TypeScript、Windows cargo check 通过；严格架构零违规。
- macOS API 已对照 objc2-app-kit/Foundation 0.3.2 源码检查，新增依赖均为原依赖树已有版本。
- 本机没有 Apple target；尝试安装 aarch64-apple-darwin 标准库下载无进展后停止。隔离适配器 cargo check 因缺少目标 core/std 失败，没有取得 macOS 编译/实机通过证据。macos-check 保留用于目标环境重试，编译产物忽略。
- 未改写用户系统剪贴板，未在真实 Snipaste、macOS、SSH 主机执行端到端测试；需目标环境验收。
