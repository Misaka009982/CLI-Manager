// 仅对真实 macOS 适配模块做目标类型检查；不替代系统剪贴板实测。
const MAX_NATIVE_BYTES: usize = 161_048_576;
fn first_decodable(_: impl IntoIterator<Item = Result<(Vec<u8>, bool), String>>) -> Result<Option<image::DynamicImage>, String> { unimplemented!() }
#[path = "../../../../../src-tauri/src/features/files/commands/clipboard_image_macos.rs"]
mod platform;
