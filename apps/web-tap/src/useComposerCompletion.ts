import { useEffect, useId, useRef, useState } from "react";
import { completionToken, fileItems, fileReference, fileRequest, replaceCompletion,
  type CompletionItem } from "./completion.ts";
import type { JsonObject, JsonValue } from "./protocol";
import type { TextKey } from "./i18n";
import type { InputKey } from "./input";

export type CompletionContext = {
  enabled: boolean; source: string; projectId: string; worktreeId?: string; capabilities: readonly string[];
  run: (kind: string, payload: JsonObject) => Promise<JsonValue>;
};
type FileState = { key: string; items: CompletionItem[]; limited: boolean; error?: TextKey };

export function useComposerCompletion({ context, scope, text, caret, enabled, onReplace }: {
  context?: CompletionContext; scope: string; text: string; caret: [number, number]; enabled: boolean;
  onReplace: (text: string, caret: number) => void;
}) {
  const id = useId();
  const token = enabled && context?.enabled && ["claude", "codex"].includes(context.source)
    ? completionToken(text, ...caret) : null;
  const draftIdentity = JSON.stringify([scope, context?.source, context?.projectId, context?.worktreeId, token, text]);
  // A repeated draft starts a new interaction. Old dismissals, selections and callbacks cannot revive.
  const interaction = useRef({ draftIdentity, version: 0 });
  if (interaction.current.draftIdentity !== draftIdentity)
    interaction.current = { draftIdentity, version: interaction.current.version + 1 };
  const identity = JSON.stringify([draftIdentity, interaction.current.version]);
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const [dismissed, setDismissed] = useState("");
  const [choice, setChoice] = useState({ key: "", index: 0 });
  const [files, setFiles] = useState<FileState>();
  const [revision, setRevision] = useState(0);
  const [problem, setProblem] = useState<{ key: string; error: TextKey }>();
  const open = Boolean(token?.kind === "file" && identity !== dismissed);
  const request = open && token?.kind === "file" ? fileRequest(token.query) : null;
  const supported = Boolean(context?.projectId && request && context.capabilities.includes("file.management"));
  const requestKey = JSON.stringify([identity, request, supported, open, revision]);
  const current = useRef({ key: requestKey, run: context?.run });
  current.current = { key: requestKey, run: context?.run };
  const flight = useRef<Promise<JsonValue> | undefined>(undefined);
  const run = context?.run;
  const projectId = context?.projectId;
  const worktreeId = context?.worktreeId;

  useEffect(() => {
    if (!request || !supported || !run || !projectId) return;
    let alive = true;
    const valid = () => alive && current.current.key === requestKey && current.current.run === run;
    const timer = setTimeout(async () => {
      // Host management is serial; do not queue every keystroke behind a slow directory search.
      try { await flight.current; } catch { /* The originating query owns its error. */ }
      if (!valid()) return;
      let pending: Promise<JsonValue> | undefined;
      try {
        pending = run(request.kind, { projectId, ...(worktreeId ? { worktreeId } : {}),
          [request.kind === "file.list" ? "path" : "query"]: request.value });
        flight.current = pending;
        const value = await pending;
        if (valid()) setFiles({ key: requestKey, ...fileItems(value) });
      } catch {
        if (valid()) setFiles({ key: requestKey, items: [], limited: false, error: "completionReadFailed" });
      } finally {
        if (flight.current === pending) flight.current = undefined;
      }
    }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [requestKey, run, projectId, worktreeId]);

  const fileState = files?.key === requestKey ? files : undefined;
  const items = open && supported ? fileState?.items ?? [] : [];
  const index = choice.key === identity ? Math.min(choice.index, Math.max(0, items.length - 1)) : 0;
  const error: TextKey | undefined = problem?.key === identity ? problem.error
    : token?.kind !== "file" ? undefined : !request ? "completionRelativeOnly"
    : !supported ? "completionUnavailable" : fileState?.error;
  const loading = open && token?.kind === "file" && supported && !fileState;
  const dismiss = () => setDismissed(identity);
  const apply = (value: string, directory: boolean) => {
    if (!open || !token || latestIdentity.current !== identity) return;
    const replacement = replaceCompletion(text, token, value, directory);
    if (!replacement) { setProblem({ key: identity, error: "completionTooLong" }); return; }
    if (!directory) dismiss();
    onReplace(replacement.text, replacement.caret);
  };
  const select = (item: CompletionItem) => {
    // A pointer callback from an old list must not insert a different query's result.
    if (!items.some((candidate) => candidate.id === item.id)) return;
    apply(fileReference(item.value, item.kind === "directory"), item.kind === "directory");
  };
  const key = (event: InputKey): boolean => {
    if (!open || event.isComposing || event.keyCode === 229 || event.key === "Process"
      || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
    if (event.key === "Escape") { dismiss(); return true; }
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      if (items.length) setChoice({ key: identity, index: (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length });
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (items[index]) select(items[index]!);
      return true; // Empty/loading results must not turn candidate confirmation into submission.
    }
    return false;
  };
  const parent = token?.kind === "file" ? token.query.replace(/\/$/, "").split("/").slice(0, -1).join("/") : "";
  return { id, open, token, items, index, error, loading, limited: Boolean(fileState?.limited), key, select, dismiss,
    retry: () => setRevision((value) => value + 1),
    up: token?.kind === "file" && token.query.includes("/") ? () => apply(parent ? fileReference(parent, true) : "@", true) : undefined,
  };
}
