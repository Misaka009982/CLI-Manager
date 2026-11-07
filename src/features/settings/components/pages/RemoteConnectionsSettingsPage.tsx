import { Stack } from "@mantine/core";
import { WebDeviceSettingsSection } from "../WebDeviceSettingsSection";
import { WebServerSettingsSection } from "../WebServerSettingsSection";

// 远程连接只组合现有 Web 服务和配对入口；不加载已退役的消息平台或托管状态。
export function RemoteConnectionsSettingsPage() {
  return (
    <Stack gap="md" w="100%">
      <WebServerSettingsSection />
      <WebDeviceSettingsSection />
    </Stack>
  );
}
