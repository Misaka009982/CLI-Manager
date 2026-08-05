import { Text } from "@mantine/core";

export function PathItem({ label, path }: { label: string; path: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/50 bg-surface-container-lowest px-3 py-2">
      <Text size="xs" c="dimmed">{label}</Text>
      <Text size="xs" truncate title={path}>{path}</Text>
    </div>
  );
}
