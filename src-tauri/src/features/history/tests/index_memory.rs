use super::super::scan_state::SessionUsageEventScan;
use super::*;
use tempfile::TempDir;

fn fixture(files: usize, events: usize) -> HistorySessionIndex {
    let entries = (0..files)
        .map(|file| {
            let stats = SessionStatsScan {
                input_tokens: events as u64,
                usage_events: (0..events)
                    .map(|event| SessionUsageEventScan {
                        event_key: format!("{file}:{event}:{}", "x".repeat(128)),
                        event_index: event,
                        timestamp_ms: Some(event as i64),
                        model: Some("fixture-model".into()),
                        usage: Default::default(),
                    })
                    .collect(),
                ..Default::default()
            };
            HistoryIndexEntry {
                file_ref: SessionFileRef {
                    source: "codex".into(),
                    project_key: "fixture".into(),
                    path: PathBuf::from(format!("fixture-{file}.jsonl")),
                },
                fingerprint: Default::default(),
                computed: CachedSessionComputation {
                    created_at: 1,
                    updated_at: 2,
                    session_id: format!("session-{file}"),
                    parent_session_id: None,
                    title: "fixture".into(),
                    message_count: events,
                    branch: None,
                    stats: stats.into(),
                },
            }
        })
        .collect();
    HistorySessionIndex {
        entries,
        generation: 1,
        refreshed_at: 1,
        ..Default::default()
    }
}

#[test]
fn snapshots_share_statistics_and_copy_on_write_preserves_old_snapshot() {
    let original = fixture(3, 1000);
    let mut cloned = original.clone();
    for (old, new) in original.entries.iter().zip(&cloned.entries) {
        assert!(Arc::ptr_eq(&old.computed.stats, &new.computed.stats));
    }
    cloned.entries[0].computed.title = "updated title".into();
    assert!(Arc::ptr_eq(
        &original.entries[0].computed.stats,
        &cloned.entries[0].computed.stats
    ));
    Arc::make_mut(&mut cloned.entries[0].computed.stats).current_model = Some("new-model".into());
    assert!(original.entries[0].computed.stats.current_model.is_none());
    assert_eq!(cloned.entries[0].computed.stats.usage_events.len(), 1000);
    assert!(!Arc::ptr_eq(
        &original.entries[0].computed.stats,
        &cloned.entries[0].computed.stats
    ));
}

#[test]
fn streaming_cache_keeps_legacy_json_shape_and_replaces_existing_file() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("index.json");
    let index = fixture(2, 3);
    let mut persisted = PersistedHistoryIndex {
        version: HISTORY_INDEX_CACHE_VERSION,
        roots_key: index.roots.cache_key(),
        generation: 1,
        entries: index.entries,
    };
    // Legacy format is a regular nested JSON object, not an Arc-specific envelope.
    let expected = serde_json::to_value(&persisted).unwrap();
    assert_eq!(
        expected["entries"][0]["computed"]["stats"]["usage_events"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    std::fs::write(&path, serde_json::to_vec(&expected).unwrap()).unwrap();
    let loaded = read_persisted_index(&path).unwrap();
    assert_eq!(serde_json::to_value(loaded).unwrap(), expected);
    persisted.generation = 2;
    write_persisted_index(&path, &persisted).unwrap();
    assert_eq!(
        serde_json::to_value(read_persisted_index(&path).unwrap()).unwrap(),
        serde_json::to_value(persisted).unwrap()
    );
    assert!(!path.with_extension("json.tmp").exists());
}

#[test]
fn failed_streaming_write_keeps_previous_cache_and_bad_reads_are_rejected() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("index.json");
    let persisted = PersistedHistoryIndex {
        version: HISTORY_INDEX_CACHE_VERSION,
        roots_key: "fixture".into(),
        generation: 1,
        entries: fixture(1, 1).entries,
    };
    write_persisted_index(&path, &persisted).unwrap();
    let before = std::fs::read(&path).unwrap();
    std::fs::create_dir(path.with_extension("json.tmp")).unwrap();
    assert!(write_persisted_index(&path, &persisted).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    std::fs::write(&path, b"{\"entries\":[").unwrap();
    assert!(read_persisted_index(&path).is_none());
    assert!(read_persisted_index(&temp.path().join("missing")).is_none());
}

// Run each mode in a separate process and measure its peak working set externally.
// This reproduces old deep-copy/JSON-buffer overhead, not the full installed GUI.
#[test]
#[ignore = "explicit synthetic memory benchmark"]
fn index_memory_probe() {
    let mode = std::env::var("CLI_MANAGER_HISTORY_MEMORY_PROBE_MODE").unwrap();
    assert!(mode == "legacy" || mode == "shared");
    let index = fixture(24, 5000);
    let mut snapshots = Vec::new();
    for _ in 0..4 {
        let mut snapshot = index.clone();
        if mode == "legacy" {
            for entry in &mut snapshot.entries {
                entry.computed.stats = Arc::new((*entry.computed.stats).clone());
            }
        }
        snapshots.push(snapshot);
    }
    let mut bytes = Vec::new();
    if mode == "legacy" {
        bytes = serde_json::to_vec(&snapshots[0].entries).unwrap();
    } else {
        serde_json::to_writer(std::io::sink(), &snapshots[0].entries).unwrap();
    }
    println!(
        "mode={mode} files=24 usage_events=120000 snapshots=4 json_buffer_bytes={}",
        bytes.len()
    );
    std::thread::sleep(std::time::Duration::from_secs(2));
    std::hint::black_box((&index, &snapshots, &bytes));
}
