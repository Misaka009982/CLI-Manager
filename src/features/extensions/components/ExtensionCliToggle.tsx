import { ActionIcon, Tooltip } from "@mantine/core";
import { CliToolIcon } from "../../../shared/ui/CliToolIcon";
import type { ExtensionCli } from "../../../shared/types/extensions";

/** Shared visual language: colored means enabled/installed, grayscale means off. */
export function ExtensionCliToggle({ cli, enabled, label, busy, disabled, onClick }: {
  cli: ExtensionCli; enabled: boolean; label: string; busy?: boolean; disabled?: boolean; onClick: () => void;
}) {
  const color = cli === "claude" ? "orange" : cli === "codex" ? "teal" : "cyan";
  return <Tooltip label={label} multiline maw={320} withArrow><span style={{ display: "inline-flex" }}><ActionIcon size={34} radius="xl" variant={enabled ? "light" : "subtle"}
    color={enabled ? (cli === "claude" ? "orange" : cli === "codex" ? "teal" : "cyan") : "gray"}
    aria-pressed={enabled} aria-label={label} title={label} loading={busy} disabled={disabled} onClick={onClick}
    style={enabled ? { backgroundColor: `var(--mantine-color-${color}-light)`, color: `var(--mantine-color-${color}-light-color)` } : undefined}>
    <span style={{ display: "flex", filter: enabled ? undefined : "grayscale(1)", opacity: enabled ? 1 : 0.4 }}>
      <CliToolIcon icon={cli === "claude" ? "claude-code" : cli} size={19} className="" />
    </span>
  </ActionIcon></span></Tooltip>;
}
