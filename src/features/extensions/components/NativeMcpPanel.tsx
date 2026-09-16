import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Group, Modal, SegmentedControl, Stack, Text } from "@mantine/core";
import { useI18n, type TranslationKey } from "../../../shared/i18n";
import type { ExtensionCli } from "../../../shared/types/extensions";
import { previewNativeMcp, type NativeMcpPreview } from "../api/native";

const CLI_ORDER: ExtensionCli[] = ["claude", "codex", "grok"];

const CLI_LABEL_KEYS: Record<ExtensionCli, TranslationKey> = {
  claude: "extensions.mcp.cliClaude",
  codex: "extensions.mcp.cliCodex",
  grok: "extensions.mcp.cliGrok",
};

const ERROR_KEYS: Partial<Record<string, TranslationKey>> = {
  extensions_native_preview_changed: "extensions.native.previewChanged",
  extensions_invalid_claude_json: "extensions.native.invalidConfig",
  extensions_invalid_toml: "extensions.native.invalidConfig",
  extensions_native_encoding_invalid: "extensions.native.invalidConfig",
  extensions_native_config_too_large: "extensions.native.configTooLarge",
  extensions_secret_reference_unresolved: "extensions.native.secretUnavailable",
  extensions_projection_unsupported: "extensions.mcp.projectionUnsupported",
  "extensions_projection_unsupported:transport_unsupported": "extensions.native.unsupportedTransport",
  "extensions_projection_unsupported:timeout_unsupported": "extensions.native.unsupportedTimeout",
  "extensions_projection_unsupported:timeout_unit_not_representable": "extensions.native.unsupportedTimeout",
  "extensions_projection_unsupported:env_unsupported_for_network_transport": "extensions.native.unsupportedEnv",
  "extensions_projection_unsupported:reserved_cli_extension_field": "extensions.native.unsupportedExtension",
  "extensions_projection_unsupported:toml_extension_not_representable": "extensions.native.unsupportedExtension",
  "extensions_projection_unsupported:duplicate_server_key": "extensions.native.duplicateServerKey",
};

// 仅返回白名单中的字段级错误，未知错误剥离正文以免泄漏配置或凭据。
function nativeErrorCode(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const normalized = raw.replace(/^Error:\s*/i, "").trim();
  if (Object.prototype.hasOwnProperty.call(ERROR_KEYS, normalized)) return normalized;
  return normalized.match(/^((?:extensions|provider)_[a-z0-9_]+)(?=:|$)/)?.[1] ?? "unknown";
}

interface NativeMcpPanelProps {
  availableClis?: ExtensionCli[];
  onClose: () => void;
}

/** Read-only native preview; the MCP toolbar owns the explicit save workflow. */
export function NativeMcpPanel({ availableClis = CLI_ORDER, onClose }: NativeMcpPanelProps) {
  const { t } = useI18n();
  const defaultCli = availableClis[0] ?? "claude";
  const [cli, setCli] = useState<ExtensionCli>(defaultCli);
  const [preview, setPreview] = useState<NativeMcpPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const inspect = useCallback(async (targetCli: ExtensionCli) => {
    const requestId = ++requestIdRef.current;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const next = await previewNativeMcp(targetCli);
      if (requestId === requestIdRef.current) setPreview(next);
    } catch (cause) {
      if (requestId === requestIdRef.current) setError(nativeErrorCode(cause));
    } finally {
      if (requestId === requestIdRef.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void inspect(cli);
    return () => {
      // A closed dialog or a replaced CLI tab cannot publish an older response.
      requestIdRef.current += 1;
    };
  }, [cli, inspect]);

  const selectCli = (value: string) => {
    if (value === cli || !CLI_ORDER.includes(value as ExtensionCli)) return;
    // 点击即失效，覆盖 React 提交新页签与 effect 启动之间的旧请求完成窗口。
    requestIdRef.current += 1;
    setPreview(null);
    setError(null);
    setCli(value as ExtensionCli);
  };

  return (
    <Modal
      opened
      onClose={() => { if (!busy) onClose(); }}
      title={t("extensions.native.configPreview")}
      size="xl"
      centered
      zIndex={70}
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
      closeButtonProps={{ disabled: busy, "aria-label": t("extensions.import.close") }}
      styles={{
        content: { maxHeight: "92dvh", display: "flex", flexDirection: "column" },
        header: { flexShrink: 0 },
        body: { minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" },
      }}
    >
      <Stack gap="sm" className="min-h-0 overflow-y-auto">
        <Text size="sm" c="dimmed">{t("extensions.save.previewHelp")}</Text>
        <SegmentedControl
          fullWidth
          value={cli}
          data={CLI_ORDER.map((item) => ({ value: item, label: t(CLI_LABEL_KEYS[item]) }))}
          onChange={selectCli}
          aria-label={t("extensions.skills.cli")}
        />

        {busy && <Text size="xs" c="dimmed">{t("extensions.loading")}</Text>}
        {error && (
          <Alert color="red" variant="light">
            <Text size="sm">{t(ERROR_KEYS[error] ?? "extensions.errors.generic")}</Text>
            <Text size="xs" c="dimmed" className="mt-1 break-all">
              {t("extensions.errors.code")}: {error}
            </Text>
          </Alert>
        )}

        {preview && (
          <div className="flex min-h-0 flex-col gap-3">
            <Group gap="xs" wrap="wrap">
              <Badge variant="light">{t("extensions.native.format", { format: preview.format.toUpperCase() })}</Badge>
              <Badge variant="light">{t("extensions.mcp.selectedCount", { count: preview.enabledKeys.length })}</Badge>
              <Badge color={preview.changed ? "yellow" : "green"}>
                {preview.changed ? t("extensions.native.pending") : t("extensions.native.current")}
              </Badge>
            </Group>

            <div className="grid min-w-0 gap-2 rounded-lg border border-border/60 bg-surface-container-low/50 px-3 py-2 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
              <span className="text-text-muted">{t("extensions.native.path")}</span>
              <span className="min-w-0 break-all text-text-primary">{preview.path}</span>
              <span className="text-text-muted">{t("extensions.native.fingerprint")}</span>
              <span className="min-w-0 break-all font-mono text-text-primary">{preview.fingerprint.slice(0, 16)}</span>
            </div>

            <Text size="xs" c="dimmed">{t("extensions.native.redactedNote")}</Text>
            <div className="min-h-0 overflow-hidden rounded-lg border border-border/60 bg-surface-container-lowest">
              <Text size="xs" fw={600} px="sm" pt="sm">{t("extensions.native.previewContent")}</Text>
              <pre
                aria-label={t("extensions.native.previewContent")}
                className="max-h-[min(48dvh,34rem)] min-h-[12rem] overflow-auto whitespace-pre p-3 pt-2 font-mono text-xs leading-relaxed text-text-primary"
              >
                {preview.content || t("extensions.mcp.projectionEmpty")}
              </pre>
            </div>

            <div className="grid min-w-0 gap-2 text-xs sm:grid-cols-2">
              <div className="min-w-0 rounded-lg border border-border/60 px-3 py-2">
                <Text size="xs" c="dimmed">{t("extensions.native.existing")}</Text>
                <Text size="xs" className="mt-1 break-words">{preview.existingKeys.join(", ") || "—"}</Text>
              </div>
              <div className="min-w-0 rounded-lg border border-border/60 px-3 py-2">
                <Text size="xs" c="dimmed">{t("extensions.native.enabled")}</Text>
                <Text size="xs" className="mt-1 break-words">{preview.enabledKeys.join(", ") || "—"}</Text>
              </div>
            </div>
            {preview.removedKeys.length > 0 && (
              <Alert color="yellow" variant="light">
                {t("extensions.native.removed")}: {preview.removedKeys.join(", ")}
              </Alert>
            )}
          </div>
        )}
      </Stack>
    </Modal>
  );
}
