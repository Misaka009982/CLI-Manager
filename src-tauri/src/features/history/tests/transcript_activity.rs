use super::*;

#[test]
fn transcript_activity_codex_preserves_calls_outputs_and_public_summaries() {
    let records = [
        json!({"type":"function_call", "name":"shell_command", "call_id":"c1", "arguments":"{\"command\":\"git status\"}"}),
        json!({"type":"function_call_output", "call_id":"c1", "output":"exit code: 0\nclean"}),
        json!({"type":"custom_tool_call", "name":"exec", "call_id":"c2", "input":"await tools.exec_command({cmd:'pwd'})"}),
        json!({"type":"custom_tool_call_output", "call_id":"c2", "output":"C:/repo"}),
        json!({"type":"reasoning", "summary":[{"type":"summary_text", "text":"Check the repository first"}], "encrypted_content":"NEVER_EXPORT_CIPHER"}),
    ];
    let kinds = [
        "tool_call",
        "tool_result",
        "tool_call",
        "tool_result",
        "reasoning",
    ];
    for (index, payload) in records.iter().enumerate() {
        let message = parse_message(
            &json!({"type":"response_item", "timestamp":"2026-10-17T10:00:00Z", "payload":payload}),
        )
        .unwrap();
        assert_eq!(message.parts.len(), 1);
        assert_eq!(message.parts[0].kind, kinds[index]);
        assert_eq!(message.timestamp.as_deref(), Some("2026-10-17T10:00:00Z"));
        assert_eq!(
            message.role,
            if index == 1 || index == 3 {
                "tool"
            } else {
                "assistant"
            }
        );
        assert!(!message.content.contains("NEVER_EXPORT"));
        if index < 4 {
            assert_eq!(
                message.parts[0].call_id,
                Some(format!("c{}", index / 2 + 1))
            );
        }
    }
}

#[test]
fn transcript_activity_claude_tool_and_thinking_only_rows_survive() {
    let command = "echo ".to_owned() + &"x".repeat(1500);
    let call = parse_message(&json!({"type":"assistant", "message":{"role":"assistant", "content":[
        {"type":"tool_use", "name":"Bash", "id":"t1", "input":{"command":command, "timeout":1000}}
    ]}})).unwrap();
    assert_eq!(call.parts[0].kind, "tool_call");
    assert_eq!(call.parts[0].tool_name.as_deref(), Some("Bash"));
    let args: Value = serde_json::from_str(&call.parts[0].content).unwrap();
    assert_eq!(args["command"], command);
    assert_eq!(args["timeout"], 1000);

    let thought = parse_message(
        &json!({"type":"assistant", "message":{"role":"assistant", "content":[
            {"type":"thinking", "thinking":"Inspect state", "signature":"NEVER_EXPORT_SIGNATURE"}
        ]}}),
    )
    .unwrap();
    assert_eq!(thought.parts[0].kind, "reasoning");
    assert_eq!(thought.parts[0].content, "Inspect state");
    assert!(!thought.content.contains("NEVER_EXPORT"));
}

#[test]
fn transcript_activity_never_invents_text_from_encrypted_or_redacted_reasoning() {
    for payload in [
        json!({"type":"reasoning", "summary":[], "encrypted_content":"NEVER_EXPORT_CIPHER"}),
        json!({"type":"reasoning", "encrypted_content":"NEVER_EXPORT_CIPHER"}),
    ] {
        assert!(parse_message(&json!({"type":"response_item", "payload":payload})).is_none());
    }
    let row = json!({"type":"assistant", "message":{"role":"assistant", "content":[
        {"type":"thinking", "signature":"NEVER_EXPORT_SIGNATURE"},
        {"type":"redacted_thinking", "data":"NEVER_EXPORT_CIPHER"}
    ]}});
    assert!(parse_message(&row).is_none());
}

#[test]
fn transcript_activity_source_order_matches_diff_message_indices() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("session.jsonl");
    let records = [
        json!({"type":"response_item", "payload":{"type":"message", "role":"user", "content":[{"type":"input_text", "text":"Fix it"}]}}),
        json!({"type":"response_item", "payload":{"type":"reasoning", "summary":[{"type":"summary_text", "text":"Inspect first"}]}}),
        json!({"type":"response_item", "payload":{"type":"function_call", "name":"shell_command", "call_id":"c1", "arguments":"git status"}}),
        json!({"type":"response_item", "payload":{"type":"function_call_output", "call_id":"c1", "output":"clean"}}),
        json!({"type":"response_item", "payload":{"type":"custom_tool_call", "name":"apply_patch", "call_id":"c2", "input":"*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch"}}),
    ];
    write_text(
        &path,
        &records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let mut messages = Vec::new();
    iter_session_messages(&path, |index, message| {
        messages.push((index, message));
        true
    })
    .unwrap();
    assert_eq!(messages.len(), 5);
    assert_eq!(messages[3].1.role, "tool");
    let changes = scan_file_changes(&path);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].operations[0].message_index, Some(4));
}
