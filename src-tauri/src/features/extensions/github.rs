use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use percent_encoding::percent_decode_str;
use reqwest::redirect::Policy;
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::ZipArchive;

use super::skill_deployment::{
    publish_skill_candidate, scan_skill_package, validate_portable_path_component,
    validate_skill_display_name, SkillPackageView, SkillSourceMetadata,
};
use super::skill_repository;

const MAX_TREE_BYTES: usize = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 512 * 1024;
const MAX_ARCHIVE_BYTES: usize = 256 * 1024 * 1024;
const MAX_CANDIDATES: usize = 128;
const MAX_ARCHIVE_ENTRIES: usize = 4096;
const MAX_ARCHIVE_FILES: usize = 2048;
const MAX_ARCHIVE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ARCHIVE_EXTRACTED_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ARCHIVE_DEPTH: usize = 24;

static CANCELLED_OPERATIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubSkillRequest {
    pub repository_url: String,
    pub reference: Option<String>,
    pub subdirectory: Option<String>,
    pub resolved_commit: Option<String>,
    #[serde(default)]
    pub candidate_ids: Vec<String>,
    pub candidate_id: Option<String>,
    pub operation_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubSkillCandidateView {
    pub candidate_id: String,
    pub name: String,
    pub description: String,
    pub skill_path: String,
    pub package_path: String,
    pub manifest_hash: String,
    pub resolved_commit: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubSkillPreview {
    pub repository_url: String,
    pub owner: String,
    pub repository: String,
    pub reference: String,
    pub resolved_commit: String,
    pub subdirectory: String,
    pub candidates: Vec<GithubSkillCandidateView>,
    pub source_fingerprint: String,
    pub operation_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubSkillInstallResult {
    pub resolved_commit: String,
    pub packages: Vec<SkillPackageView>,
    pub skipped: usize,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
struct GithubLocator {
    owner: String,
    repository: String,
    embedded_tail: Vec<String>,
}

#[derive(Clone, Debug)]
struct ResolvedTarget {
    locator: GithubLocator,
    reference: String,
    resolved_commit: String,
    subdirectory: String,
}

#[derive(Clone, Debug)]
struct GithubCandidate {
    view: GithubSkillCandidateView,
    package_path: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GithubCommitResponse {
    sha: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GithubTreeResponse {
    #[serde(default)]
    tree: Vec<GithubTreeEntry>,
    #[serde(default)]
    truncated: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct GithubTreeEntry {
    path: String,
    mode: Option<String>,
    #[serde(rename = "type")]
    entry_type: Option<String>,
    sha: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct SkillFrontMatter {
    name: Option<String>,
    description: Option<String>,
}

// 解析 GitHub 仓库、tree/blob 路径；仅接受 github.com HTTPS 地址，不把查询参数带入来源身份。
fn parse_github_repository_url(raw: &str) -> Result<GithubLocator, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "extensions_github_url_invalid".to_string())?;
    if url.scheme() != "https"
        || url
            .host_str()
            .is_none_or(|host| !host.eq_ignore_ascii_case("github.com"))
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("extensions_github_url_invalid".to_string());
    }
    let segments = url
        .path_segments()
        .ok_or_else(|| "extensions_github_url_invalid".to_string())?
        .filter(|segment| !segment.is_empty())
        .map(decode_url_segment)
        .collect::<Result<Vec<_>, _>>()?;
    if segments.len() < 2 {
        return Err("extensions_github_url_invalid".to_string());
    }
    validate_github_component(&segments[0])?;
    let mut repository = segments[1].clone();
    if let Some(repository_name) = repository.strip_suffix(".git") {
        repository = repository_name.to_string();
    }
    validate_github_component(&repository)?;
    let embedded_tail = match segments.get(2).map(String::as_str) {
        None => Vec::new(),
        Some("tree") | Some("blob") => segments[3..].to_vec(),
        Some(_) => return Err("extensions_github_url_invalid".to_string()),
    };
    for segment in &embedded_tail {
        validate_relative_component(segment)?;
    }
    Ok(GithubLocator {
        owner: segments[0].clone(),
        repository,
        embedded_tail,
    })
}

// 预览只读取 GitHub API 的 tree 和短 SKILL.md，不下载或执行仓库中的脚本。
pub(crate) async fn preview(request: GithubSkillRequest) -> Result<GithubSkillPreview, String> {
    let operation_id = request.operation_id.clone();
    let result = preview_inner(request).await;
    clear_cancelled(operation_id.as_deref());
    result
}

async fn preview_inner(request: GithubSkillRequest) -> Result<GithubSkillPreview, String> {
    let client = github_client()?;
    let target = resolve_target(&client, &request).await?;
    check_cancelled(request.operation_id.as_deref())?;
    let candidates = discover_candidates(&client, &target, request.operation_id.as_deref()).await?;
    if candidates.is_empty() {
        return Err("extensions_github_skill_not_found".to_string());
    }
    let source_fingerprint = fingerprint_candidates(&target, &candidates);
    Ok(GithubSkillPreview {
        repository_url: repository_url(&target.locator),
        owner: target.locator.owner,
        repository: target.locator.repository,
        reference: target.reference,
        resolved_commit: target.resolved_commit,
        subdirectory: target.subdirectory,
        candidates: candidates
            .into_iter()
            .map(|candidate| candidate.view)
            .collect(),
        source_fingerprint,
        operation_id: request.operation_id,
    })
}

// 按预览锁定的 commit 下载完整包，安装阶段只做解压、校验和受管发布，不执行仓库代码。
pub(crate) async fn install(
    request: GithubSkillRequest,
) -> Result<GithubSkillInstallResult, String> {
    let operation_id = request.operation_id.clone();
    let result = install_inner(request).await;
    clear_cancelled(operation_id.as_deref());
    result
}

async fn install_inner(request: GithubSkillRequest) -> Result<GithubSkillInstallResult, String> {
    if request
        .resolved_commit
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err("extensions_github_preview_required".to_string());
    }
    let client = github_client()?;
    let target = resolve_target(&client, &request).await?;
    check_cancelled(request.operation_id.as_deref())?;
    let candidates = discover_candidates(&client, &target, request.operation_id.as_deref()).await?;
    let selected = select_candidates(&candidates, &request)?;
    if selected.is_empty() {
        return Err("extensions_github_skill_selection_empty".to_string());
    }
    let archive = download_archive(&client, &target, request.operation_id.as_deref()).await?;
    let temporary = create_temporary_directory()?;
    let mut packages = Vec::with_capacity(selected.len());
    let mut skipped = 0;
    let mut warnings = Vec::new();
    for (index, candidate) in selected.iter().enumerate() {
        check_cancelled(request.operation_id.as_deref())?;
        let stage = temporary.path().join(format!("package-{index}"));
        extract_archive_package(
            &archive,
            &candidate.package_path,
            &stage,
            request.operation_id.as_deref(),
        )?;
        let source = SkillSourceMetadata {
            source_kind: "github".to_string(),
            source_identity: repository_url(&target.locator),
            source_ref: target.reference.clone(),
            resolved_commit: Some(target.resolved_commit.clone()),
            subdirectory: candidate.package_path.clone(),
            version: None,
        };
        let scanned = scan_skill_package(&stage, source)?;
        if let Some(existing) = skill_repository::find_package_by_identity_hash(
            &scanned.source.source_kind,
            &scanned.source.source_identity,
            &scanned.source.subdirectory,
            &scanned.content_hash,
        )
        .await?
        {
            skipped += 1;
            packages.push(package_view(&existing));
            continue;
        }
        let package = publish_skill_candidate(&scanned).await?;
        if packages
            .iter()
            .any(|item: &SkillPackageView| item.package_id == package.package_id)
        {
            skipped += 1;
            warnings.push(format!(
                "duplicate_candidate:{}",
                candidate.view.candidate_id
            ));
            continue;
        }
        packages.push(package_view(&package));
    }
    clear_cancelled(request.operation_id.as_deref());
    Ok(GithubSkillInstallResult {
        resolved_commit: target.resolved_commit,
        packages,
        skipped,
        warnings,
    })
}

// 取消只影响本次网络/解压操作；已发布的受管包不会删除，确保重试不会误伤其它安装。
pub(crate) fn cancel(operation_id: &str) -> Result<(), String> {
    validate_operation_id(operation_id)?;
    cancelled_operations()
        .lock()
        .map_err(|_| "extensions_github_cancel_failed".to_string())?
        .insert(operation_id.to_string());
    Ok(())
}

// 取消或完成后清除标记，避免短 ID 的后续操作被旧请求污染。
fn clear_cancelled(operation_id: Option<&str>) {
    let Some(operation_id) = operation_id.filter(|value| !value.is_empty()) else {
        return;
    };
    if let Ok(mut values) = cancelled_operations().lock() {
        values.remove(operation_id);
    }
}

// 在网络、归档和候选循环之间检查取消状态，保持取消有界且不引入后台任务泄漏。
fn check_cancelled(operation_id: Option<&str>) -> Result<(), String> {
    let Some(operation_id) = operation_id.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let cancelled = cancelled_operations()
        .lock()
        .map_err(|_| "extensions_github_cancel_failed".to_string())?
        .contains(operation_id);
    if cancelled {
        Err("extensions_github_cancelled".to_string())
    } else {
        Ok(())
    }
}

fn cancelled_operations() -> &'static Mutex<HashSet<String>> {
    CANCELLED_OPERATIONS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn validate_operation_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        Err("extensions_github_operation_invalid".to_string())
    } else {
        Ok(())
    }
}

fn github_client() -> Result<Client, String> {
    crate::provider::network_client::configure_builder(Client::builder())?
        .user_agent("CLI-Manager/1.4")
        .timeout(std::time::Duration::from_secs(30))
        .redirect(Policy::none())
        .build()
        .map_err(|_| "extensions_github_client_unavailable".to_string())
}

async fn resolve_target(
    client: &Client,
    request: &GithubSkillRequest,
) -> Result<ResolvedTarget, String> {
    let locator = parse_github_repository_url(&request.repository_url)?;
    if let Some(operation_id) = request.operation_id.as_deref() {
        validate_operation_id(operation_id)?;
    }
    let requested_subdirectory = request
        .subdirectory
        .as_deref()
        .map(normalize_relative_path)
        .transpose()?
        .unwrap_or_default();
    let (reference, subdirectory) = if let Some(reference) = request
        .reference
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        validate_reference(reference)?;
        let embedded_subdirectory = embedded_subdirectory_for_reference(&locator, reference)?;
        let subdirectory = if requested_subdirectory.is_empty() {
            embedded_subdirectory
        } else {
            requested_subdirectory
        };
        (reference.to_string(), subdirectory)
    } else if locator.embedded_tail.is_empty() {
        ("HEAD".to_string(), requested_subdirectory)
    } else {
        resolve_embedded_reference(
            client,
            &locator,
            &requested_subdirectory,
            request.operation_id.as_deref(),
        )
        .await?
    };
    let resolved_commit = if let Some(commit) = request
        .resolved_commit
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        validate_commit(commit)?;
        commit.to_string()
    } else {
        resolve_commit(
            client,
            &locator,
            &reference,
            request.operation_id.as_deref(),
        )
        .await?
    };
    Ok(ResolvedTarget {
        locator,
        reference,
        resolved_commit,
        subdirectory,
    })
}

async fn resolve_embedded_reference(
    client: &Client,
    locator: &GithubLocator,
    requested_subdirectory: &str,
    operation_id: Option<&str>,
) -> Result<(String, String), String> {
    for split in (1..=locator.embedded_tail.len()).rev() {
        let reference = locator.embedded_tail[..split].join("/");
        match resolve_commit(client, locator, &reference, operation_id).await {
            Ok(_) => {
                let embedded_subdirectory = join_segments(&locator.embedded_tail[split..]);
                return Ok((
                    reference,
                    if requested_subdirectory.is_empty() {
                        embedded_subdirectory
                    } else {
                        requested_subdirectory.to_string()
                    },
                ));
            }
            Err(error) if error == "extensions_github_not_found" => {}
            Err(error) => return Err(error),
        }
    }
    Err("extensions_github_reference_not_found".to_string())
}

async fn resolve_commit(
    client: &Client,
    locator: &GithubLocator,
    reference: &str,
    operation_id: Option<&str>,
) -> Result<String, String> {
    validate_reference(reference)?;
    check_cancelled(operation_id)?;
    let url = repository_api_url(locator, &["commits", reference])?;
    let response: GithubCommitResponse =
        get_json(client, url, MAX_TREE_BYTES, operation_id).await?;
    validate_commit(&response.sha)?;
    check_cancelled(operation_id)?;
    Ok(response.sha)
}

async fn discover_candidates(
    client: &Client,
    target: &ResolvedTarget,
    operation_id: Option<&str>,
) -> Result<Vec<GithubCandidate>, String> {
    let mut url = repository_api_url(&target.locator, &["git", "trees", &target.resolved_commit])?;
    url.query_pairs_mut().append_pair("recursive", "1");
    let tree: GithubTreeResponse = get_json(client, url, MAX_TREE_BYTES, operation_id).await?;
    if tree.truncated {
        return Err("extensions_github_tree_too_large".to_string());
    }
    let mut candidates = Vec::new();
    let prefix = target.subdirectory.trim_matches('/');
    for entry in tree.tree {
        check_cancelled(operation_id)?;
        if entry.entry_type.as_deref() != Some("blob")
            || entry.path.rsplit('/').next() != Some("SKILL.md")
            || entry.mode.as_deref() == Some("120000")
        {
            continue;
        }
        let skill_path = normalize_relative_path(&entry.path)?;
        let package_path = skill_path
            .strip_suffix("/SKILL.md")
            .unwrap_or_default()
            .to_string();
        if !prefix.is_empty()
            && package_path != prefix
            && !package_path.starts_with(&format!("{prefix}/"))
        {
            continue;
        }
        if candidates.len() >= MAX_CANDIDATES {
            return Err("extensions_github_too_many_candidates".to_string());
        }
        let manifest = fetch_manifest(client, target, &skill_path, operation_id).await?;
        let name = manifest
            .name
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                package_path
                    .rsplit('/')
                    .next()
                    .filter(|value| !value.is_empty())
                    .unwrap_or("skill")
                    .to_string()
            });
        validate_skill_name(&name)?;
        let description = manifest.description.unwrap_or_default();
        let candidate_id = candidate_key(&target.locator, &target.resolved_commit, &package_path);
        candidates.push(GithubCandidate {
            view: GithubSkillCandidateView {
                candidate_id,
                name,
                description,
                skill_path,
                package_path: package_path.clone(),
                manifest_hash: entry.sha.unwrap_or_default(),
                resolved_commit: target.resolved_commit.clone(),
            },
            package_path,
        });
    }
    candidates.sort_by(|left, right| left.package_path.cmp(&right.package_path));
    Ok(candidates)
}

async fn fetch_manifest(
    client: &Client,
    target: &ResolvedTarget,
    path: &str,
    operation_id: Option<&str>,
) -> Result<SkillFrontMatter, String> {
    let mut url = Url::parse("https://raw.githubusercontent.com/")
        .map_err(|_| "extensions_github_url_invalid".to_string())?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "extensions_github_url_invalid".to_string())?;
        segments.push(&target.locator.owner);
        segments.push(&target.locator.repository);
        segments.push(&target.resolved_commit);
        for segment in path.split('/') {
            segments.push(segment);
        }
    }
    let bytes = get_bytes(client, url, MAX_MANIFEST_BYTES, operation_id).await?;
    let text =
        String::from_utf8(bytes).map_err(|_| "extensions_github_manifest_invalid".to_string())?;
    parse_front_matter(&text)
}

fn parse_front_matter(text: &str) -> Result<SkillFrontMatter, String> {
    let mut result = SkillFrontMatter::default();
    let mut in_front_matter = false;
    for (index, line) in text.lines().enumerate() {
        if index == 0 && line.trim() == "---" {
            in_front_matter = true;
            continue;
        }
        if in_front_matter && line.trim() == "---" {
            break;
        }
        if !in_front_matter {
            if index > 30 {
                break;
            }
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches(['"', '\'']);
        if value.is_empty() || value.chars().any(char::is_control) {
            continue;
        }
        match key.trim().to_ascii_lowercase().as_str() {
            "name" => result.name = Some(limit_manifest_text(value, 128)?),
            "description" => result.description = Some(limit_manifest_text(value, 4096)?),
            _ => {}
        }
    }
    Ok(result)
}

fn limit_manifest_text(value: &str, limit: usize) -> Result<String, String> {
    if value.len() > limit || value.chars().any(char::is_control) {
        return Err("extensions_github_manifest_invalid".to_string());
    }
    Ok(value.to_string())
}

fn select_candidates<'a>(
    candidates: &'a [GithubCandidate],
    request: &GithubSkillRequest,
) -> Result<Vec<&'a GithubCandidate>, String> {
    let mut selected_ids = request
        .candidate_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    if let Some(candidate_id) = request.candidate_id.as_ref() {
        selected_ids.insert(candidate_id.clone());
    }
    if selected_ids.is_empty() {
        return Ok(candidates.iter().collect());
    }
    let selected = candidates
        .iter()
        .filter(|candidate| selected_ids.contains(&candidate.view.candidate_id))
        .collect::<Vec<_>>();
    if selected.len() != selected_ids.len() {
        return Err("extensions_github_candidate_not_found".to_string());
    }
    Ok(selected)
}

struct TemporaryDirectory {
    path: PathBuf,
}

impl TemporaryDirectory {
    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn create_temporary_directory() -> Result<TemporaryDirectory, String> {
    let path = std::env::temp_dir().join(format!("cli-manager-github-{}", Uuid::new_v4()));
    std::fs::create_dir(&path).map_err(|_| "extensions_github_staging_unavailable".to_string())?;
    Ok(TemporaryDirectory { path })
}

async fn download_archive(
    client: &Client,
    target: &ResolvedTarget,
    operation_id: Option<&str>,
) -> Result<Vec<u8>, String> {
    let mut url = Url::parse("https://codeload.github.com/")
        .map_err(|_| "extensions_github_url_invalid".to_string())?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "extensions_github_url_invalid".to_string())?;
        segments.push(&target.locator.owner);
        segments.push(&target.locator.repository);
        segments.push("zip");
        segments.push(&target.resolved_commit);
    }
    get_bytes(client, url, MAX_ARCHIVE_BYTES, operation_id).await
}

fn extract_archive_package(
    archive: &[u8],
    package_path: &str,
    destination: &Path,
    operation_id: Option<&str>,
) -> Result<(), String> {
    if archive.len() > MAX_ARCHIVE_BYTES {
        return Err("extensions_github_archive_too_large".to_string());
    }
    let mut zip = ZipArchive::new(Cursor::new(archive))
        .map_err(|_| "extensions_github_archive_invalid".to_string())?;
    if zip.len() > MAX_ARCHIVE_ENTRIES {
        return Err("extensions_github_archive_too_many_entries".to_string());
    }
    let package_path = normalize_relative_path(package_path)?;
    std::fs::create_dir(destination)
        .map_err(|_| "extensions_github_staging_unavailable".to_string())?;
    let mut archive_root = None;
    let mut seen = HashSet::new();
    let mut file_count = 0_usize;
    let mut total_bytes = 0_u64;
    for index in 0..zip.len() {
        check_cancelled(operation_id)?;
        let mut entry = zip
            .by_index(index)
            .map_err(|_| "extensions_github_archive_invalid".to_string())?;
        let raw_name = entry.name().to_string();
        let components = safe_archive_components(&raw_name)?;
        let Some((root, relative_components)) = components.split_first() else {
            continue;
        };
        if archive_root.is_none() {
            archive_root = Some(root.clone());
        }
        if archive_root.as_deref() != Some(root.as_str()) {
            return Err("extensions_github_archive_invalid".to_string());
        }
        let relative = relative_components.join("/");
        if !path_is_in_package(&relative, &package_path) {
            continue;
        }
        let package_relative = if package_path.is_empty() {
            relative.clone()
        } else if relative == package_path {
            String::new()
        } else {
            relative
                .strip_prefix(&format!("{package_path}/"))
                .unwrap_or_default()
                .to_string()
        };
        if package_relative.is_empty() {
            continue;
        }
        let package_components = safe_archive_components(&package_relative)?;
        if package_components.len() > MAX_ARCHIVE_DEPTH {
            return Err("extensions_github_archive_path_invalid".to_string());
        }
        if entry.unix_mode().is_some_and(|mode| {
            let file_type = mode & 0o170000;
            file_type != 0 && file_type != 0o040000 && file_type != 0o100000
        }) {
            return Err("extensions_github_archive_special_file_rejected".to_string());
        }
        if !seen.insert(package_relative.clone()) {
            return Err("extensions_github_archive_duplicate_path".to_string());
        }
        let output = package_components
            .iter()
            .fold(destination.to_path_buf(), |path, component| {
                path.join(component)
            });
        if entry.is_dir() {
            create_archive_directory(destination, &package_components)?;
            continue;
        }
        file_count += 1;
        if file_count > MAX_ARCHIVE_FILES || entry.size() > MAX_ARCHIVE_FILE_BYTES {
            return Err("extensions_github_archive_too_large".to_string());
        }
        total_bytes = total_bytes
            .checked_add(entry.size())
            .ok_or_else(|| "extensions_github_archive_too_large".to_string())?;
        if total_bytes > MAX_ARCHIVE_EXTRACTED_BYTES {
            return Err("extensions_github_archive_too_large".to_string());
        }
        let parent_components = &package_components[..package_components.len() - 1];
        create_archive_directory(destination, parent_components)?;
        let entry_size = entry.size();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|_| "extensions_github_archive_extract_failed".to_string())?;
        let mut limited = entry.by_ref().take(MAX_ARCHIVE_FILE_BYTES + 1);
        let mut bytes = Vec::with_capacity(entry_size.min(MAX_ARCHIVE_FILE_BYTES) as usize);
        limited
            .read_to_end(&mut bytes)
            .map_err(|_| "extensions_github_archive_extract_failed".to_string())?;
        if bytes.len() as u64 != entry_size || bytes.len() as u64 > MAX_ARCHIVE_FILE_BYTES {
            return Err("extensions_github_archive_too_large".to_string());
        }
        std::io::Write::write_all(&mut file, &bytes)
            .map_err(|_| "extensions_github_archive_extract_failed".to_string())?;
    }
    if !seen.contains("SKILL.md") {
        return Err("extensions_github_manifest_missing".to_string());
    }
    Ok(())
}

fn create_archive_directory(root: &Path, components: &[String]) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for component in components {
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("extensions_github_archive_path_invalid".to_string())
            }
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Err("extensions_github_archive_extract_failed".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current)
                    .map_err(|_| "extensions_github_archive_extract_failed".to_string())?;
            }
            Err(_) => return Err("extensions_github_archive_extract_failed".to_string()),
        }
    }
    Ok(current)
}

fn path_is_in_package(path: &str, package: &str) -> bool {
    package.is_empty() || path == package || path.starts_with(&format!("{package}/"))
}

fn safe_archive_components(value: &str) -> Result<Vec<String>, String> {
    if value.is_empty() || value.contains('\\') || value.contains('\0') {
        return Err("extensions_github_archive_path_invalid".to_string());
    }
    let path = Path::new(value);
    let mut components = Vec::new();
    for component in path.components() {
        let Component::Normal(component) = component else {
            return Err("extensions_github_archive_path_invalid".to_string());
        };
        let value = component
            .to_str()
            .ok_or_else(|| "extensions_github_archive_path_invalid".to_string())?;
        validate_portable_path_component(value)
            .map_err(|_| "extensions_github_archive_path_invalid".to_string())?;
        components.push(value.to_string());
    }
    Ok(components)
}

fn package_view(record: &skill_repository::SkillPackageRecord) -> SkillPackageView {
    SkillPackageView {
        package_id: record.package_id.clone(),
        name: record.name.clone(),
        description: record.description.clone(),
        source_kind: record.source_kind.clone(),
        source_identity: record.source_identity.clone(),
        source_ref: record.source_ref.clone(),
        resolved_commit: record.resolved_commit.clone(),
        subdirectory: record.subdirectory.clone(),
        content_hash: record.content_hash.clone(),
        version: record.version.clone(),
        package_path: record.package_path.to_string_lossy().into_owned(),
        updated_at_ms: record.updated_at_ms,
    }
}

fn repository_url(locator: &GithubLocator) -> String {
    format!(
        "https://github.com/{}/{}",
        locator.owner, locator.repository
    )
}

fn repository_api_url(locator: &GithubLocator, tail: &[&str]) -> Result<Url, String> {
    let mut url = Url::parse("https://api.github.com/")
        .map_err(|_| "extensions_github_url_invalid".to_string())?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "extensions_github_url_invalid".to_string())?;
        segments.push("repos");
        segments.push(&locator.owner);
        segments.push(&locator.repository);
        for segment in tail {
            segments.push(segment);
        }
    }
    Ok(url)
}

async fn get_json<T: for<'de> Deserialize<'de>>(
    client: &Client,
    url: Url,
    limit: usize,
    operation_id: Option<&str>,
) -> Result<T, String> {
    let bytes = get_bytes(client, url, limit, operation_id).await?;
    serde_json::from_slice(&bytes).map_err(|_| "extensions_github_response_invalid".to_string())
}

async fn get_bytes(
    client: &Client,
    url: Url,
    limit: usize,
    operation_id: Option<&str>,
) -> Result<Vec<u8>, String> {
    check_cancelled(operation_id)?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "extensions_github_network_failed".to_string())?;
    if response.status() != StatusCode::OK {
        return Err(map_github_status(response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(if limit >= MAX_ARCHIVE_BYTES {
            "extensions_github_archive_too_large".to_string()
        } else {
            "extensions_github_response_too_large".to_string()
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "extensions_github_network_failed".to_string())?
    {
        check_cancelled(operation_id)?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(if limit >= MAX_ARCHIVE_BYTES {
                "extensions_github_archive_too_large".to_string()
            } else {
                "extensions_github_response_too_large".to_string()
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn map_github_status(status: StatusCode) -> String {
    match status {
        StatusCode::NOT_FOUND => "extensions_github_not_found".to_string(),
        StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS => {
            "extensions_github_rate_limited".to_string()
        }
        _ => format!("extensions_github_http_{}", status.as_u16()),
    }
}

fn fingerprint_candidates(target: &ResolvedTarget, candidates: &[GithubCandidate]) -> String {
    let mut values = candidates
        .iter()
        .map(|candidate| {
            (
                candidate.view.candidate_id.clone(),
                candidate.view.manifest_hash.clone(),
            )
        })
        .collect::<Vec<_>>();
    values.sort();
    let mut hasher = Sha256::new();
    hasher.update(target.resolved_commit.as_bytes());
    hasher.update(target.subdirectory.as_bytes());
    for (candidate_id, manifest_hash) in values {
        hasher.update((candidate_id.len() as u64).to_le_bytes());
        hasher.update(candidate_id.as_bytes());
        hasher.update(manifest_hash.as_bytes());
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn candidate_key(locator: &GithubLocator, commit: &str, package_path: &str) -> String {
    let mut hasher = Sha256::new();
    for value in [
        &locator.owner,
        &locator.repository,
        &commit.to_string(),
        &package_path.to_string(),
    ] {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    format!(
        "github-{}",
        hasher
            .finalize()
            .iter()
            .take(16)
            .map(|value| format!("{value:02x}"))
            .collect::<String>()
    )
}

fn validate_github_component(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 100
        || value.chars().any(|character| {
            character.is_control() || character == '/' || character == '\\' || character == ':'
        })
    {
        return Err("extensions_github_url_invalid".to_string());
    }
    Ok(())
}

fn decode_url_segment(value: &str) -> Result<String, String> {
    percent_decode_str(value)
        .decode_utf8()
        .map(|value| value.into_owned())
        .map_err(|_| "extensions_github_url_invalid".to_string())
}

fn validate_reference(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("extensions_github_reference_invalid".to_string());
    }
    Ok(())
}

fn validate_commit(value: &str) -> Result<(), String> {
    if value.len() != 40 || !value.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("extensions_github_commit_invalid".to_string());
    }
    Ok(())
}

fn normalize_relative_path(value: &str) -> Result<String, String> {
    let value = value.trim().trim_matches('/');
    if value.is_empty() {
        return Ok(String::new());
    }
    let mut result = Vec::new();
    for component in value.split('/') {
        validate_relative_component(component)?;
        result.push(component.to_string());
    }
    Ok(result.join("/"))
}

fn validate_relative_component(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('\\')
        || value.contains('\0')
        || value.chars().any(char::is_control)
    {
        return Err("extensions_github_path_invalid".to_string());
    }
    Ok(())
}

fn join_segments(segments: &[String]) -> String {
    segments.join("/")
}

fn embedded_subdirectory_for_reference(
    locator: &GithubLocator,
    reference: &str,
) -> Result<String, String> {
    let embedded = join_segments(&locator.embedded_tail);
    if embedded.is_empty() {
        return Ok(String::new());
    }
    if embedded == reference {
        return Ok(String::new());
    }
    embedded
        .strip_prefix(&format!("{reference}/"))
        .map(str::to_string)
        .ok_or_else(|| "extensions_github_reference_path_conflict".to_string())
}

fn validate_skill_name(value: &str) -> Result<(), String> {
    validate_skill_display_name(value)
        .map_err(|_| "extensions_github_skill_name_invalid".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn test_archive(entries: &[(&str, &[u8], Option<u32>)]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        for (name, contents, mode) in entries {
            let mut options = zip::write::FileOptions::default();
            if let Some(mode) = mode {
                options = options.unix_permissions(*mode);
            }
            writer.start_file(*name, options).unwrap();
            writer.write_all(contents).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    // 解析仓库、tree 子路径和 .git 后缀，同时拒绝凭据、查询参数与非 GitHub 主机。
    fn parses_safe_github_repository_urls() {
        let locator = parse_github_repository_url(
            "https://github.com/acme/demo/tree/feature%2Fslash/skills/one",
        )
        .unwrap();
        assert_eq!(locator.owner, "acme");
        assert_eq!(locator.repository, "demo");
        assert_eq!(locator.embedded_tail, ["feature/slash", "skills", "one"]);
        assert!(parse_github_repository_url("https://user:secret@github.com/acme/demo").is_err());
        assert!(parse_github_repository_url("https://gitlab.com/acme/demo").is_err());
        assert!(parse_github_repository_url("https://github.com/acme/demo?token=secret").is_err());
    }

    #[test]
    // ref 支持斜杠但拒绝空组件和路径穿越，子目录也不能逃出仓库根。
    fn validates_references_and_relative_paths() {
        assert!(validate_reference("feature/with-slash").is_ok());
        assert!(validate_reference("feature//broken").is_err());
        assert!(validate_reference("../main").is_err());
        assert_eq!(
            normalize_relative_path("/skills/demo/").unwrap(),
            "skills/demo"
        );
        assert!(normalize_relative_path("skills/../demo").is_err());
    }

    #[test]
    // 显式 ref 与 tree URL 共用同一解析结果，不能把 ref 本身误当成技能子目录。
    fn explicit_reference_removes_embedded_branch_prefix() {
        let locator = parse_github_repository_url(
            "https://github.com/acme/demo/tree/feature%2Fslash/skills/one",
        )
        .unwrap();
        assert_eq!(
            embedded_subdirectory_for_reference(&locator, "feature/slash").unwrap(),
            "skills/one"
        );
        assert!(embedded_subdirectory_for_reference(&locator, "main").is_err());
    }

    #[test]
    // 归档路径必须由普通组件组成，Windows 设备名和链接路径不进入受管包。
    fn rejects_unsafe_archive_components() {
        assert!(safe_archive_components("repo/skills/SKILL.md").is_ok());
        assert!(safe_archive_components("../SKILL.md").is_err());
        assert!(safe_archive_components("repo\\SKILL.md").is_err());
        if cfg!(target_os = "windows") {
            assert!(validate_portable_path_component("CON").is_err());
        }
    }

    #[test]
    // 归档只提取所选技能目录，并拒绝穿越条目和 Unix 链接条目。
    fn extracts_bounded_package_without_links_or_traversal() {
        let directory = tempfile::tempdir().unwrap();
        let archive = test_archive(&[
            ("repo/skills/demo/SKILL.md", b"# demo", None),
            ("repo/skills/demo/helper.txt", b"helper", None),
        ]);
        let destination = directory.path().join("package");
        extract_archive_package(&archive, "skills/demo", &destination, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(destination.join("SKILL.md")).unwrap(),
            "# demo"
        );
        assert!(!destination.join("other.txt").exists());

        let traversal = test_archive(&[("repo/skills/demo/../escape.txt", b"escape", None)]);
        let traversal_destination = directory.path().join("traversal");
        assert!(
            extract_archive_package(&traversal, "skills/demo", &traversal_destination, None)
                .is_err()
        );

        let symlink = test_archive(&[("repo/skills/demo/link", b"/outside", Some(0o120777))]);
        let symlink_destination = directory.path().join("symlink");
        assert!(
            extract_archive_package(&symlink, "skills/demo", &symlink_destination, None).is_err()
        );
    }
}
