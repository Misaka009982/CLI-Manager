import { useState } from "react";
import { flushSync } from "react-dom";
import { Drawer, Modal } from "@mantine/core";
import { McpEditorDialog } from "../../src/features/extensions/components/McpEditorDialog";
import "../../src/styles/components/extensions-editor.css";

// 使用真实 Mantine portal/过渡/捕获监听，远程业务被隔离，两个抽屉保持生产页的 keepMounted 配置。
export function CcConnectSettingsPage() {
  const [active, setActive] = useState<string | null>(null);
  const duration = Number(new URLSearchParams(location.search).get("duration") ?? 200);
  const close = () => {
    // 强制覆盖捕获阶段卸载后，原始 Esc 仍继续冒泡的时序。
    if (duration === 0) flushSync(() => setActive(null));
    else setActive(null);
  };
  return <div>
    <button id="open-web-device" onClick={() => setActive("web-device")}>Web device</button>
    <button id="open-cc-connect" onClick={() => setActive("cc-connect")}>cc-connect</button>
    <button id="open-inner-modal" onClick={() => setActive("modal")}>Modal</button>
    <button id="open-mcp" onClick={() => setActive("mcp")}>MCP</button>
    <input id="consuming-input" onKeyDown={event => {
      if (event.key === "Escape") event.preventDefault();
    }} />
    {(["web-device", "cc-connect"] as const).map(name => <Drawer
      key={name} opened={active === name} onClose={close} title={name}
      position="right" keepMounted transitionProps={{ duration }}
    ><input aria-label={`${name} field`} /></Drawer>)}
    <Modal opened={active === "modal"} onClose={close} title="Inner modal" transitionProps={{ duration }}>
      <input aria-label="Modal field" />
    </Modal>
    <McpEditorDialog resource={null} open={active === "mcp"} onClose={close} onSaved={() => {}}
      onBeforeSave={async () => {}} />
  </div>;
}
