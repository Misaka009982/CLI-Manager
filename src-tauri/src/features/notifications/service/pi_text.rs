use serde_json::Value;
use std::sync::OnceLock;

// 与前端共用 Pi 文案源；不改变第三方通知已有的正文布局和其他 CLI 文案。
fn run_ended_label(language: &str) -> &'static str {
    static MESSAGES: OnceLock<Value> = OnceLock::new();
    let messages = MESSAGES.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../../src/shared/i18n/messages/pi-hook.json"
        ))
        .expect("bundled Pi notification translations must be valid JSON")
    });
    let language = match language {
        "en-US" => "en-US",
        "zh-TW" => "zh-TW",
        _ => "zh-CN",
    };
    messages[language]["notifications.hookToast.piRunEnded"]
        .as_str()
        .expect("bundled Pi run-ended translation must exist")
}

// 后台 daemon 从持久化偏好取得显式语言；auto 保持既有第三方通知的中文默认。
pub(super) fn current_run_ended_label() -> &'static str {
    let settings = crate::app_paths::data_paths()
        .ok()
        .and_then(|paths| std::fs::read_to_string(paths.settings_store_path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    run_ended_label(
        settings
            .as_ref()
            .and_then(|value| value.get("language"))
            .and_then(Value::as_str)
            .unwrap_or("auto"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_end_labels_are_localized_without_claiming_task_success() {
        assert_eq!(run_ended_label("en-US"), "Run ended");
        assert_eq!(run_ended_label("zh-CN"), "本轮运行已结束");
        assert_eq!(run_ended_label("zh-TW"), "本輪執行已結束");
    }
}
