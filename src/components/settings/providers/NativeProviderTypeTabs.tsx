import { Box, Button, Group } from "@mantine/core";
import { Code2, Terminal, Wrench } from "lucide-react";
import type { NativeProviderAppType } from "./nativeProviderTypes";

interface NativeProviderTypeTabsProps {
  value: NativeProviderAppType;
  labels: Record<NativeProviderAppType, string>;
  onChange: (value: NativeProviderAppType) => void;
}
const ICONS = {
  claude: Terminal,
  codex: Code2,
  grokbuild: Wrench,
} satisfies Record<NativeProviderAppType, typeof Terminal>;

export function NativeProviderTypeTabs({ value, labels, onChange }: NativeProviderTypeTabsProps) {
  const values: NativeProviderAppType[] = ["claude", "codex", "grokbuild"];

  return (
    <Box
      component="div"
      role="tablist"
      aria-label={labels[value]}
      className="rounded-xl border border-border/70 bg-surface-container-low p-1"
    >
      <Group gap={4} wrap="wrap">
        {values.map((item) => {
          const Icon = ICONS[item];
          const active = item === value;
          return (
            <Button
              key={item}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              variant={active ? "light" : "subtle"}
              color={active ? "cliPrimary" : "gray"}
              size="compact-sm"
              leftSection={<Icon size={15} />}
              onClick={() => onChange(item)}
            >
              {labels[item]}
            </Button>
          );
        })}
      </Group>
    </Box>
  );
}
