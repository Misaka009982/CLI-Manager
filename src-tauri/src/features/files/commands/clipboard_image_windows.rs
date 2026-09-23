use super::{first_decodable, MAX_NATIVE_BYTES};
use image::DynamicImage;
use windows_sys::Win32::System::{
    DataExchange::{
        CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
        OpenClipboard, RegisterClipboardFormatW,
    },
    Memory::{GlobalLock, GlobalSize, GlobalUnlock},
};

struct ClipboardGuard;
impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        unsafe {
            CloseClipboard();
        }
    }
}

// 只读锁短时重试，不将暂时占用伪装成空剪贴板。
fn open() -> Result<ClipboardGuard, String> {
    for _ in 0..5 {
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            return Ok(ClipboardGuard);
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    Err("clipboard_busy".into())
}

// 一次只复制一种表示，解码前释放系统锁；回退时检查版本以免混入下一次复制的内容。
pub(super) fn read() -> Result<Option<DynamicImage>, String> {
    let guard = open()?;
    let mut revision = unsafe { GetClipboardSequenceNumber() };
    let png_name: Vec<u16> = "PNG\0".encode_utf16().collect();
    let png = unsafe { RegisterClipboardFormatW(png_name.as_ptr()) };
    // Windows 能从 CF_BITMAP 合成 DIB；PNG 失败仍尝试 DIBV5/DIB。
    let formats: Vec<_> = [(png, false), (17, true), (8, true)]
        .into_iter()
        .filter(|(format, _)| *format != 0 && unsafe { IsClipboardFormatAvailable(*format) } != 0)
        .collect();
    drop(guard);
    first_decodable(formats.into_iter().map(|(format, dib)| {
        let _guard = open()?;
        if unsafe { GetClipboardSequenceNumber() } != revision {
            return Err("clipboard_image_read_failed".into());
        }
        let result = copy_format(format).map(|bytes| (bytes, dib));
        // 延迟渲染会在 GetClipboardData 时更新序号；锁内发生的更新仍属于本次内容。
        revision = unsafe { GetClipboardSequenceNumber() };
        result
    }))
}

// HGLOBAL 在持有剪贴板锁期间复制，复制前检查长度，不读取外部路径或私有结构。
fn copy_format(format: u32) -> Result<Vec<u8>, String> {
    let handle = unsafe { GetClipboardData(format) };
    if handle.is_null() {
        return Err("clipboard_image_read_failed".into());
    }
    let size = unsafe { GlobalSize(handle) };
    if size == 0 || size > MAX_NATIVE_BYTES {
        return Err("clipboard_image_too_large".into());
    }
    let data = unsafe { GlobalLock(handle) };
    if data.is_null() {
        return Err("clipboard_image_read_failed".into());
    }
    let bytes = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), size).to_vec() };
    unsafe {
        GlobalUnlock(handle);
    }
    Ok(bytes)
}
