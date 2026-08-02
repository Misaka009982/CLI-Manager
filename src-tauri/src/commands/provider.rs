use crate::provider::{
    service, CliType, ProviderCommonConfig, ProviderConfigValidation,
    ProviderConfigValidationInput, ProviderCreateInput, ProviderDetail, ProviderEffectivePreview,
    ProviderKeyCreateInput, ProviderKeyUpdateInput, ProviderStatus, ProviderSummary,
    ProviderUpdateInput,
};

#[tauri::command]
pub async fn provider_list(cli_type: Option<CliType>) -> Result<Vec<ProviderSummary>, String> {
    service::list(cli_type).await
}

#[tauri::command]
pub async fn provider_get(id: String) -> Result<ProviderDetail, String> {
    service::get(id).await
}

#[tauri::command]
pub async fn provider_create(input: ProviderCreateInput) -> Result<ProviderDetail, String> {
    service::create(input).await
}

#[tauri::command]
pub async fn provider_update(
    id: String,
    input: ProviderUpdateInput,
) -> Result<ProviderDetail, String> {
    service::update(id, input).await
}

#[tauri::command]
pub async fn provider_duplicate(id: String) -> Result<ProviderDetail, String> {
    service::duplicate(id).await
}

#[tauri::command]
pub async fn provider_delete(id: String) -> Result<(), String> {
    service::delete(id).await
}

#[tauri::command]
pub async fn provider_set_status(
    id: String,
    status: ProviderStatus,
) -> Result<ProviderDetail, String> {
    service::set_status(id, status).await
}

#[tauri::command]
pub async fn provider_key_create(
    provider_id: String,
    input: ProviderKeyCreateInput,
) -> Result<ProviderDetail, String> {
    service::key_create(provider_id, input).await
}

#[tauri::command]
pub async fn provider_key_update(
    provider_id: String,
    key_id: String,
    input: ProviderKeyUpdateInput,
) -> Result<ProviderDetail, String> {
    service::key_update(provider_id, key_id, input).await
}

#[tauri::command]
pub async fn provider_key_activate(
    provider_id: String,
    key_id: String,
) -> Result<ProviderDetail, String> {
    service::key_activate(provider_id, key_id).await
}

#[tauri::command]
pub async fn provider_key_delete(
    provider_id: String,
    key_id: String,
    replacement_key_id: Option<String>,
) -> Result<ProviderDetail, String> {
    service::key_delete(provider_id, key_id, replacement_key_id).await
}

#[tauri::command]
pub async fn provider_common_get(cli_type: CliType) -> Result<ProviderCommonConfig, String> {
    service::common_get(cli_type).await
}

#[tauri::command]
pub async fn provider_common_update(
    cli_type: CliType,
    config_text: String,
) -> Result<ProviderCommonConfig, String> {
    service::common_update(cli_type, config_text).await
}

#[tauri::command]
pub fn provider_validate_config(input: ProviderConfigValidationInput) -> ProviderConfigValidation {
    service::validate_config(input)
}

#[tauri::command]
pub async fn provider_preview_effective(
    provider_id: String,
) -> Result<ProviderEffectivePreview, String> {
    service::preview_effective(provider_id).await
}
