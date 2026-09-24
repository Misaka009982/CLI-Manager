//! Publish cut files as a live Shell data object so Explorer can report paste completion.
use std::{
    cell::Cell,
    ffi::c_void,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr,
};

use windows_sys::{
    core::{IUnknown_Vtbl, GUID},
    Win32::{
        Foundation::GlobalFree,
        System::{
            Com::{DVASPECT_CONTENT, FORMATETC, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL},
            DataExchange::RegisterClipboardFormatW,
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
            Ole::{OleInitialize, OleSetClipboard},
        },
        UI::Shell::{
            Common::ITEMIDLIST, ILCreateFromPathW, ILFindLastID, ILFree, SHCreateDataObject,
        },
    },
};

const IID_IDATAOBJECT: GUID = GUID::from_u128(0x0000010e_0000_0000_c000_000000000046);

#[repr(C)]
struct DataObjectVtable {
    unknown: IUnknown_Vtbl,
    get_data: usize,
    get_data_here: usize,
    query_get_data: usize,
    get_canonical_format_etc: usize,
    set_data:
        unsafe extern "system" fn(*mut c_void, *const FORMATETC, *const STGMEDIUM, i32) -> i32,
}

struct ShellDataObject(*mut c_void);

impl Drop for ShellDataObject {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                (vtable(self.0).unknown.Release)(self.0);
            }
        }
    }
}

struct Pidl(*mut ITEMIDLIST);

impl Drop for Pidl {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                ILFree(self.0);
            }
        }
    }
}

unsafe fn vtable(object: *mut c_void) -> &'static DataObjectVtable {
    unsafe { &**(object.cast::<*const DataObjectVtable>()) }
}

fn shell_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

fn pidl_for_path(path: &Path) -> Result<Pidl, String> {
    let wide: Vec<u16> = shell_path(path)
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let pidl = unsafe { ILCreateFromPathW(wide.as_ptr()) };
    if pidl.is_null() {
        Err(format!(
            "clipboard_shell_path_unavailable: {}",
            path.display()
        ))
    } else {
        Ok(Pidl(pidl))
    }
}

fn create_data_object(paths: &[PathBuf]) -> Result<ShellDataObject, String> {
    let first_parent = paths
        .first()
        .and_then(|path| path.parent())
        .ok_or("clipboard_invalid_file_count")?;
    if paths
        .iter()
        .any(|path| path.parent().is_none_or(|parent| parent != first_parent))
    {
        return Err("clipboard_move_mixed_parents_unsupported".into());
    }
    let folder = pidl_for_path(first_parent)?;
    let children = paths
        .iter()
        .map(|path| pidl_for_path(path))
        .collect::<Result<Vec<_>, _>>()?;
    let relative_children = children
        .iter()
        .map(|child| unsafe { ILFindLastID(child.0) as *const ITEMIDLIST })
        .collect::<Vec<_>>();
    if relative_children.iter().any(|pidl| pidl.is_null()) {
        return Err("clipboard_shell_path_unavailable".into());
    }
    let mut object = ptr::null_mut();
    let result = unsafe {
        SHCreateDataObject(
            folder.0,
            relative_children.len() as u32,
            relative_children.as_ptr(),
            ptr::null_mut(),
            &IID_IDATAOBJECT,
            &mut object,
        )
    };
    if result < 0 || object.is_null() {
        return Err(format!("clipboard_shell_data_object_failed: {result:#x}"));
    }
    Ok(ShellDataObject(object))
}

fn set_drop_effect(object: &ShellDataObject, format_name: &str, effect: u32) -> Result<(), String> {
    let name: Vec<u16> = format_name.encode_utf16().chain(Some(0)).collect();
    let clipboard_format = unsafe { RegisterClipboardFormatW(name.as_ptr()) };
    if clipboard_format == 0 {
        return Err("clipboard_write_failed".into());
    }
    let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, 4) };
    if handle.is_null() {
        return Err("clipboard_write_failed".into());
    }
    let data = unsafe { GlobalLock(handle) };
    if data.is_null() {
        unsafe {
            GlobalFree(handle);
        }
        return Err("clipboard_write_failed".into());
    }
    unsafe {
        ptr::copy_nonoverlapping(effect.to_le_bytes().as_ptr(), data.cast::<u8>(), 4);
        GlobalUnlock(handle);
    }
    let format = FORMATETC {
        cfFormat: clipboard_format as u16,
        ptd: ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT,
        lindex: -1,
        tymed: TYMED_HGLOBAL as u32,
    };
    let medium = STGMEDIUM {
        tymed: TYMED_HGLOBAL as u32,
        u: STGMEDIUM_0 { hGlobal: handle },
        pUnkForRelease: ptr::null_mut(),
    };
    let result = unsafe { (vtable(object.0).set_data)(object.0, &format, &medium, 1) };
    if result < 0 {
        unsafe {
            GlobalFree(handle);
        }
        return Err(format!("clipboard_shell_move_effect_failed: {result:#x}"));
    }
    Ok(())
}

// Must run on Tauri's GUI thread: the OLE clipboard calls back into this STA after Explorer pastes.
pub(super) fn write_shell_cut_file_paths(paths: &[PathBuf]) -> Result<(), String> {
    thread_local! { static OLE_READY: Cell<bool> = const { Cell::new(false) }; }
    OLE_READY.with(|ready| {
        if !ready.get() {
            let result = unsafe { OleInitialize(ptr::null()) };
            if result < 0 {
                return Err(format!("clipboard_shell_ole_unavailable: {result:#x}"));
            }
            ready.set(true);
        }
        Ok(())
    })?;
    let object = create_data_object(paths)?;
    set_drop_effect(&object, "Preferred DropEffect", 2)?;
    let result = unsafe { OleSetClipboard(object.0) };
    if result < 0 {
        return Err(format!("clipboard_write_failed: {result:#x}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{create_data_object, set_drop_effect, shell_path};
    use std::path::Path;

    #[test]
    fn shell_paths_drop_verbatim_prefixes() {
        assert_eq!(
            shell_path(Path::new(r"\\?\C:\work\a.txt")),
            Path::new(r"C:\work\a.txt")
        );
        assert_eq!(
            shell_path(Path::new(r"\\?\UNC\server\share\a.txt")),
            Path::new(r"\\server\share\a.txt")
        );
    }

    #[test]
    fn shell_data_object_accepts_move_completion_feedback() {
        let initialized =
            unsafe { windows_sys::Win32::System::Ole::OleInitialize(std::ptr::null()) };
        assert!(initialized >= 0);
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.txt");
        std::fs::write(&source, b"clipboard move probe").unwrap();
        let object = create_data_object(&[source]).unwrap();
        set_drop_effect(&object, "Preferred DropEffect", 2).unwrap();
        set_drop_effect(&object, "Performed DropEffect", 2).unwrap();
        set_drop_effect(&object, "Paste Succeeded", 2).unwrap();
        drop(object);
        assert!(!temp.path().join("source.txt").exists());
        unsafe {
            windows_sys::Win32::System::Ole::OleUninitialize();
        }
    }

    #[test]
    fn shell_data_object_does_not_delete_without_paste_success() {
        let initialized =
            unsafe { windows_sys::Win32::System::Ole::OleInitialize(std::ptr::null()) };
        assert!(initialized >= 0);
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.txt");
        std::fs::write(&source, b"keep until paste succeeds").unwrap();
        let object = create_data_object(&[source.clone()]).unwrap();
        set_drop_effect(&object, "Preferred DropEffect", 2).unwrap();
        set_drop_effect(&object, "Performed DropEffect", 2).unwrap();
        drop(object);
        assert!(source.exists());
        unsafe {
            windows_sys::Win32::System::Ole::OleUninitialize();
        }
    }

    #[test]
    fn shell_data_object_rejects_mixed_source_folders() {
        let temp = tempfile::tempdir().unwrap();
        let left = temp.path().join("left");
        let right = temp.path().join("right");
        std::fs::create_dir_all(&left).unwrap();
        std::fs::create_dir_all(&right).unwrap();
        assert_eq!(
            create_data_object(&[left.join("a.txt"), right.join("b.txt")])
                .err()
                .as_deref(),
            Some("clipboard_move_mixed_parents_unsupported"),
        );
    }
}
