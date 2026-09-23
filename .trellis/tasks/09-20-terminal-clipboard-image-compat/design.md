# 设计与根因分析

已确认缺口：Windows arboard 先尝试 PNG，失败即退出而不尝试 DIB；macOS arboard 只请求 TIFF；前端只按 image/* 识别事件图片且原生失败被吞。不能把上述缺口等同于已证明的 Snipaste 现场根因。

在文件领域新增 clipboard_image 编解码模块与 windows/macos 原生适配：原始数据在后端限长、先验像素、解码、转 PNG 和保存，避免 40M RGBA 通过 IPC。复用 clipboard_attach_image_files 命令兼容扩展为文件或原生位图附件；添加 file_attach_image_data 专门校验浏览器图片，不改变通用附件语义。原有 file_attach_data 只提高附件字节上限，预览常量保持。

macOS 使用项目依赖树已有 objc2 系列的目标专用直接依赖，不引入 shell/AppleScript。Windows 复用 Win32 API 读取多表示，CF_BITMAP 由系统合成 DIB。macOS 文件 URL 只解析 file scheme。SSH 新协议 20 MiB 不动，旧协议保持明确升级提示。

触点：files commands/clipboard_files、新图片模块、lib IPC 注册、macOS 依赖、terminalClipboardImage/useTerminalInput、终端中英文字典；WSL path formatter/SSH transport/文件预览确认保持。

场景：Windows/macOS/Linux，本机/WSL/SSH，截图/复制图片文件/普通文件/文字，PNG 损坏+DIB 有效、空 MIME、超限、占用、取消、跨 Shell、重复粘贴。窗口/焦点/分屏沿用当前会话快照。
