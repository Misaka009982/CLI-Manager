import Editor from "@monaco-editor/react";
import { configureMonaco } from "@/lib/monacoSetup";
import type { NativeProviderConfigFormat } from "./nativeProviderConfigView";

configureMonaco();

interface NativeProviderCodeEditorProps {
  format: NativeProviderConfigFormat;
  value: string;
  path: string;
  ariaLabel: string;
  height?: string;
  readOnly?: boolean;
  invalid?: boolean;
  onChange?: (value: string) => void;
}

export function NativeProviderCodeEditor({
  format,
  value,
  path,
  ariaLabel,
  height = "260px",
  readOnly = false,
  invalid = false,
  onChange,
}: NativeProviderCodeEditorProps) {
  return (
    <div
      className={`min-w-0 overflow-hidden rounded-lg border ${invalid ? "border-red-400" : "border-border/60"}`}
      aria-invalid={invalid}
    >
      <Editor
        path={path}
        height={height}
        language={format === "json" ? "json" : "ini"}
        theme="vs"
        value={value}
        onChange={onChange ? (next) => onChange(next ?? "") : undefined}
        options={{
          automaticLayout: true,
          ariaLabel,
          fontSize: 13,
          folding: true,
          minimap: { enabled: false },
          padding: { top: 10, bottom: 10 },
          readOnly,
          scrollBeyondLastLine: false,
          tabSize: 2,
          wordWrap: "on",
        }}
      />
    </div>
  );
}
