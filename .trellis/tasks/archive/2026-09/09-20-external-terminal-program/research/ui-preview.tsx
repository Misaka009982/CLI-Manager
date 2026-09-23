import React from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider, Stack, Button } from "@mantine/core";
import "@mantine/core/styles.css";
import { ExternalTerminalProgramSetting } from "/src/features/settings/components/pages/ExternalTerminalProgramSetting";
import { useSettingsStore } from "/src/shared/preferences/settingsStore";
import { normalizeTerminalFontFamily } from "/src/features/terminal/api/terminalFontFamily";
useSettingsStore.setState({ language: "zh-CN", update: async (key, value) => { useSettingsStore.setState({ [key]: value }); } });
window.__preview = {
 state: () => ({language: useSettingsStore.getState().language, program: useSettingsStore.getState().externalTerminalProgram}),
 measure: () => { const c = document.createElement("canvas").getContext("2d"); c.font = `16px ${normalizeTerminalFontFamily("Unavailable_Mono_7e22, monospace")}`; return {font: c.font, i: c.measureText("iiiiiiii").width, w: c.measureText("WWWWWWWW").width}; },
};
createRoot(document.getElementById("root")).render(<MantineProvider><Stack p="xl" maw={640}>
<Button onClick={() => useSettingsStore.setState({language: "zh-CN"})}>中文</Button>
<Button onClick={() => useSettingsStore.setState({language: "en-US"})}>English</Button>
<ExternalTerminalProgramSetting />
<div style={{fontFamily: normalizeTerminalFontFamily("Maple Mono, monospace"), fontSize: 16, padding:16, background:"#252a32", color:"#eee"}}>用户字体优先：Embedding 和 rerank 调用云端 API.<br/>iiiiiiii WWWWWWWW 12345678</div>
</Stack></MantineProvider>);
