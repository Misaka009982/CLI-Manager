use crate::provider::repository::{
    self, CommonConfigDocument, CommonConfigSetInput, ProviderCard, ProviderCreateInput,
    ProviderDetail, ProviderKeyCreateInput, ProviderKeySummary, ProviderKeyUpdateInput,
    ProviderUpdateInput,
};
use std::future::Future;

fn block_on<T>(future: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    tauri::async_runtime::block_on(future)
}

#[tauri::command]
pub fn provider_catalog_list(app_type: Option<String>) -> Result<Vec<ProviderCard>, String> {
    block_on(repository::list_providers(app_type))
}

#[tauri::command]
pub fn provider_catalog_get(
    app_type: String,
    provider_id: String,
) -> Result<ProviderDetail, String> {
    block_on(repository::get_provider(app_type, provider_id))
}

#[tauri::command]
pub fn provider_catalog_create(input: ProviderCreateInput) -> Result<ProviderDetail, String> {
    block_on(repository::create_provider(input))
}

#[tauri::command]
pub fn provider_catalog_update(input: ProviderUpdateInput) -> Result<ProviderDetail, String> {
    block_on(repository::update_provider(input))
}

#[tauri::command]
pub fn provider_catalog_duplicate(
    app_type: String,
    provider_id: String,
    name: Option<String>,
) -> Result<ProviderDetail, String> {
    block_on(repository::duplicate_provider(app_type, provider_id, name))
}

#[tauri::command]
pub fn provider_catalog_delete(app_type: String, provider_id: String) -> Result<(), String> {
    block_on(repository::delete_provider(app_type, provider_id))
}

#[tauri::command]
pub fn provider_catalog_set_enabled(
    app_type: String,
    provider_id: String,
    enabled: bool,
) -> Result<ProviderDetail, String> {
    block_on(repository::set_provider_enabled(
        app_type,
        provider_id,
        enabled,
    ))
}

#[tauri::command]
pub fn provider_catalog_set_current(
    app_type: String,
    provider_id: String,
) -> Result<ProviderDetail, String> {
    block_on(repository::set_current_provider(app_type, provider_id))
}

#[tauri::command]
pub fn provider_catalog_reorder(
    app_type: String,
    provider_ids: Vec<String>,
) -> Result<Vec<ProviderCard>, String> {
    block_on(repository::reorder_providers(app_type, provider_ids))
}

#[tauri::command]
pub fn provider_key_list(
    app_type: String,
    provider_id: String,
) -> Result<Vec<ProviderKeySummary>, String> {
    block_on(repository::list_keys(app_type, provider_id))
}

#[tauri::command]
pub fn provider_key_create(input: ProviderKeyCreateInput) -> Result<ProviderKeySummary, String> {
    block_on(repository::create_key(input))
}

#[tauri::command]
pub fn provider_key_update(input: ProviderKeyUpdateInput) -> Result<ProviderKeySummary, String> {
    block_on(repository::update_key(input))
}

#[tauri::command]
pub fn provider_key_delete(
    app_type: String,
    provider_id: String,
    key_id: String,
    replacement_key_id: Option<String>,
) -> Result<(), String> {
    block_on(repository::delete_key(
        app_type,
        provider_id,
        key_id,
        replacement_key_id,
    ))
}

#[tauri::command]
pub fn provider_key_set_enabled(
    app_type: String,
    provider_id: String,
    key_id: String,
    enabled: bool,
) -> Result<ProviderKeySummary, String> {
    block_on(repository::set_key_enabled(
        app_type,
        provider_id,
        key_id,
        enabled,
    ))
}

#[tauri::command]
pub fn provider_key_activate(
    app_type: String,
    provider_id: String,
    key_id: String,
) -> Result<ProviderKeySummary, String> {
    block_on(repository::activate_key(app_type, provider_id, key_id))
}

#[tauri::command]
pub fn provider_key_reorder(
    app_type: String,
    provider_id: String,
    key_ids: Vec<String>,
) -> Result<Vec<ProviderKeySummary>, String> {
    block_on(repository::reorder_keys(app_type, provider_id, key_ids))
}

#[tauri::command]
pub fn provider_key_reveal(
    app_type: String,
    provider_id: String,
    key_id: String,
) -> Result<String, String> {
    block_on(repository::reveal_key(app_type, provider_id, key_id))
}

#[tauri::command]
pub fn provider_common_config_get(app_type: String) -> Result<CommonConfigDocument, String> {
    block_on(repository::get_common_config(app_type))
}

#[tauri::command]
pub fn provider_common_config_set(
    input: CommonConfigSetInput,
) -> Result<CommonConfigDocument, String> {
    block_on(repository::set_common_config(input))
}
