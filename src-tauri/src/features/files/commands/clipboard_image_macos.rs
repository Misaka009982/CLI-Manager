use super::{first_decodable, MAX_NATIVE_BYTES};
use image::DynamicImage;
use objc2::rc::{autoreleasepool, Retained};
use objc2::{msg_send, ClassType};
use objc2_app_kit::NSPasteboard;
use objc2_foundation::NSString;

// 与底层 clipboard 库一致，允许无 GUI pasteboard 的进程返回错误而不是解引用空对象。
fn pasteboard() -> Result<Retained<NSPasteboard>, String> {
    let board: Option<Retained<NSPasteboard>> =
        unsafe { msg_send![NSPasteboard::class(), generalPasteboard] };
    board.ok_or_else(|| "clipboard_image_read_failed".into())
}

// PNG-only 和 TIFF-only 都可读取；一种表示损坏不会阻断另一种。
pub(super) fn read() -> Result<Option<DynamicImage>, String> {
    autoreleasepool(|_| {
        let board = pasteboard()?;
        let revision = board.changeCount();
        let candidates = ["public.png", "public.tiff", "public.jpeg"]
            .into_iter()
            .filter_map(|name| {
                if board.changeCount() != revision {
                    return Some(Err("clipboard_image_read_failed".into()));
                }
                let kind = NSString::from_str(name);
                board.dataForType(&kind).map(|data| {
                    if data.len() == 0 || data.len() > MAX_NATIVE_BYTES {
                        Err("clipboard_image_too_large".into())
                    } else {
                        Ok((data.to_vec(), false))
                    }
                })
            });
        first_decodable(candidates)
    })
}

// Finder 提供的 file URL 才转成本机路径，拒绝网络 URL；沿用文件导入的符号链接检查。
pub(crate) fn read_file_paths() -> Result<Vec<String>, String> {
    autoreleasepool(|_| {
        let board = pasteboard()?;
        let Some(items) = board.pasteboardItems() else {
            return Ok(Vec::new());
        };
        if items.len() > 4096 {
            return Err("clipboard_too_many_files".into());
        }
        let kind = NSString::from_str("public.file-url");
        let mut paths = Vec::new();
        for item in items.iter() {
            if let Some(value) = item.stringForType(&kind) {
                let path = url::Url::parse(&value.to_string())
                    .ok()
                    .and_then(|url| url.to_file_path().ok())
                    .ok_or("clipboard_image_unavailable")?;
                paths.push(path.to_string_lossy().into_owned());
            }
        }
        Ok(paths)
    })
}
