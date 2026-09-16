import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { toast } from "sonner";
import { useI18n } from "../../../shared/i18n";
import { getActiveNativeProviderHome } from "../../settings/api/nativeProviderHome";
import type { NativeProviderHomeState } from "../../settings/api/nativeProviderTypes";
import { applyNativeMcp, previewNativeMcp } from "./native";
import { pendingMcpClis, saveMcpRevisionTargets } from "../lib/mcpPending";
import { acknowledgeMcpSave, beginMcpOperation, discardMcpChanges, finishMcpOperation, useMcpPendingStore } from "../state/mcpPendingStore";

export interface McpSaveControls {
  pending: boolean;
  busy: boolean;
  save: () => Promise<boolean>;
  error: string | null;
  homePath?: string;
  homeIdentity?: string;
  pendingClis: import("../../../shared/types/extensions").ExtensionCli[];
}

/** Settings owns navigation; extensions owns pending revisions and native application. */
export function useMcpSaveWorkflow(enabled: boolean) {
  const { t } = useI18n();
  const [home, setHome] = useState<NativeProviderHomeState | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const continuation = useRef<(() => void) | null>(null);
  const state = useMcpPendingStore();
  const homeIdentity = home?.identity.identity;
  const targets = pendingMcpClis(state.revisions,
    homeIdentity ? state.applied[homeIdentity] : undefined,
    homeIdentity ? state.discarded[homeIdentity] : undefined);
  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    const epoch = useMcpPendingStore.getState().epoch;
    setHome(null);
    setChecking(true); setFailure(null);
    void (async () => {
      const value = await getActiveNativeProviderHome();
      if (stale) return;
      setHome(value);
      // Reading native differences (or failing to read) is not a user edit.
      // Pending revisions are created only by explicit mutation APIs.
    })().catch(() => { if (!stale && useMcpPendingStore.getState().epoch === epoch) setFailure("inspect"); })
      .finally(() => { if (!stale) setChecking(false); });
    return () => { stale = true; };
  }, [enabled]);

  const save = useCallback(async () => {
    if (useMcpPendingStore.getState().operation) return false;
    beginMcpOperation("save");
    setFailure(null);
    try {
      const currentHome = await getActiveNativeProviderHome();
      const identity = currentHome.identity.identity;
      // Do not silently redirect a save when the displayed target changed elsewhere.
      if (home && home.identity.identity !== identity) {
        setHome(currentHome);
        throw new Error("extensions_native_preview_changed");
      }
      setHome(currentHome);
      const snapshot = useMcpPendingStore.getState();
      const pending = pendingMcpClis(snapshot.revisions, snapshot.applied[identity], snapshot.discarded[identity]);
      const failures = await saveMcpRevisionTargets(identity, snapshot.revisions, pending, {
        homeIdentity: async () => (await getActiveNativeProviderHome()).identity.identity,
        preview: previewNativeMcp,
        apply: applyNativeMcp,
        acknowledge: (cli, revision) => acknowledgeMcpSave(identity, cli, revision),
      });
      if (failures.length) {
        const message = t("extensions.save.partial", { clis: failures.map(item => item.cli).join(", ") });
        setFailure(message); toast.error(message); return false;
      }
      toast.success(t("extensions.save.success"));
      return true;
    } catch {
      const message = t("extensions.save.failed");
      setFailure(message); toast.error(message); return false;
    } finally { finishMcpOperation(); }
  }, [home, t]);

  const requestLeave = useCallback((next: () => void) => {
    // 同一次离开意图只打开一个确认框，后续点击不能替换它的目标。
    if (continuation.current) return;
    if (!enabled) { next(); return; }
    const current = useMcpPendingStore.getState();
    if (current.operation || checking) { toast.info(t("extensions.save.wait")); return; }
    if (!pendingMcpClis(current.revisions,
      homeIdentity ? current.applied[homeIdentity] : undefined,
      homeIdentity ? current.discarded[homeIdentity] : undefined).length) { next(); return; }
    continuation.current = next; setFailure(null); setLeaveOpen(true);
  }, [enabled, homeIdentity, t, checking]);
  const cancelLeave = () => { continuation.current = null; setLeaveOpen(false); };
  const leave = () => { const next = continuation.current; cancelLeave(); next?.(); };
  // 只取消待应用状态，列表随后读回原生启用状态；编辑器已保存的受管定义不回滚。
  const discardAndLeave = () => {
    const next = continuation.current;
    if (!next || !homeIdentity || !discardMcpChanges(homeIdentity)) return;
    leave();
  };
  const busy = state.operation !== null;
  return {
    pending: targets.length > 0, pendingClis: targets, busy: busy || checking, save, requestLeave,
    error: failure === "inspect" ? t("extensions.save.inspectFailed") : failure,
    homePath: home?.homePath,
    homeIdentity: home?.identity.identity,
    dialog: <Modal opened={leaveOpen} onClose={() => { if (!busy) cancelLeave(); }}
      title={t("extensions.save.leaveTitle")} centered zIndex={90}
      closeOnClickOutside={false} closeOnEscape={!busy}
      closeButtonProps={{ disabled: busy, "aria-label": t("extensions.import.close") }}>
      <Stack gap="sm">
        <Text size="sm">{t("extensions.save.leaveMessage")}</Text>
        {home && <Text size="xs" className="break-all">{home.homePath}</Text>}
        <Text size="sm">{targets.join(", ")}</Text>
        {failure && <Alert color="red">{failure === "inspect" ? t("extensions.save.inspectFailed") : failure}</Alert>}
        <Group justify="flex-end">
          <Button variant="subtle" disabled={busy} onClick={cancelLeave}>{t("extensions.save.stay")}</Button>
          <Button variant="light" disabled={busy || !homeIdentity} onClick={discardAndLeave}>{t("extensions.save.later")}</Button>
          <Button loading={state.operation === "save"} disabled={busy} onClick={() => { void save().then(ok => { if (ok) leave(); }); }}>{t("extensions.save.applyLeave")}</Button>
        </Group>
      </Stack>
    </Modal>,
  };
}
