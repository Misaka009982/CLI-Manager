import { Select } from "@mantine/core";
import { useSettingsStore } from "../../../../shared/preferences/settingsStore";
import { normalizeExternalTerminalProgram } from "../../../../shared/lib/externalTerminalProgram";
import { useI18n } from "../../../../shared/i18n/index";

// 程序选择独立于“外部终端”开关；直接菜单操作同样使用这一偏好。
export function ExternalTerminalProgramSetting() {
  const { t } = useI18n();
  const program = useSettingsStore((state) => state.externalTerminalProgram);
  const update = useSettingsStore((state) => state.update);
  return (
    <Select
      label={t("settings.terminal.externalProgram")}
      description={t("settings.terminal.externalProgramDescription")}
      value={program}
      onChange={(value) => { if (value) void update("externalTerminalProgram", normalizeExternalTerminalProgram(value)); }}
      data={[
        { value: "windows-terminal", label: "Windows Terminal" },
        { value: "cmd", label: "CMD" },
        { value: "powershell", label: "Windows PowerShell" },
        { value: "pwsh", label: "PowerShell 7" },
      ]}
      allowDeselect={false}
      size="xs"
    />
  );
}
