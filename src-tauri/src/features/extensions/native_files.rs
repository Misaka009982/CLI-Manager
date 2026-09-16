use crate::provider::global;
use std::{fs::OpenOptions, path::Path, time::Duration};
use uuid::Uuid;

// Create private files before writing any configuration bytes; Unix/WSL secrets never pass through a world-readable stage.
fn write_private(path: &str, bytes: &[u8]) -> Result<(), String> {
    let parent = Path::new(path)
        .parent()
        .ok_or("extensions_native_path_invalid")?;
    global::create_live_dir_all(&parent.to_string_lossy())?;
    if let Some((distro, linux)) = crate::wsl::parse_wsl_unc_path(path) {
        let exe = crate::wsl::find_wsl_exe().ok_or("extensions_wsl_unavailable")?;
        let mut command = crate::shell_resolver::silent_command(exe.to_string_lossy().as_ref());
        command.args([
            "-d",
            &distro,
            "--exec",
            "sh",
            "-c",
            "umask 077; set -C; : > \"$1\"",
            "cli-manager",
            &linux,
        ]);
        let output = crate::shell_resolver::output_with_timeout(command, Duration::from_secs(15))
            .map_err(|_| "extensions_native_stage_failed")?;
        if !output.status.success() {
            return Err("extensions_native_stage_failed".into());
        }
    } else {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(path)
            .map_err(|_| "extensions_native_stage_failed")?;
    }
    global::write_live(path, bytes)
}

// Publish one file with a recoverable private backup, a final stale-read check and readback verification.
pub(super) fn publish(
    path: &str,
    before: Option<&[u8]>,
    desired: &[u8],
) -> Result<Option<String>, String> {
    let id = Uuid::new_v4();
    let stage = format!("{path}.cli-manager-{id}.stage");
    let backup = before.map(|_| format!("{path}.cli-manager-{id}.backup"));
    if let (Some(bytes), Some(backup)) = (before, &backup) {
        write_private(backup, bytes)?;
    }
    let result = (|| {
        write_private(&stage, desired)?;
        if global::read_live(path)?.as_deref() != before {
            return Err("extensions_native_preview_changed".into());
        }
        global::replace_live_from_stage(path, &stage)?;
        if global::read_live(path)?.as_deref() != Some(desired) {
            return Err("extensions_native_verification_failed".into());
        }
        Ok(backup)
    })();
    if result.is_err() {
        let _ = global::remove_live(&stage);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_file_write_backup_readback_and_conflict() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("config.toml");
        std::fs::write(&path, b"old").unwrap();
        let backup = publish(&path.to_string_lossy(), Some(b"old"), b"new")
            .unwrap()
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert_eq!(std::fs::read(&backup).unwrap(), b"old");
        assert_eq!(
            publish(&path.to_string_lossy(), Some(b"old"), b"overwrite").unwrap_err(),
            "extensions_native_preview_changed"
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
