import { Children, createContext, isValidElement, useContext, useEffect, useId, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { translator, type Translate } from "./i18n";

export const ConversationCodeI18n = createContext<Translate>(translator("zh-CN"));

/** Keep source formatting and clipboard actions inside each Markdown code block. */
export function ConversationCodeBlock({ children }: { children?: ReactNode }) {
  const t = useContext(ConversationCodeI18n);
  const id = useId();
  const [expanded, setExpanded] = useState(true);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const code = Children.toArray(children).find((child) => isValidElement(child));
  const props = isValidElement<{ className?: string; children?: ReactNode }>(code) ? code.props : undefined;
  const text = typeof props?.children === "string" ? props.children : "";
  const language = /(?:^|\s)language-([^\s]+)/.exec(props?.className ?? "")?.[1];
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopyState("copied"); }
    catch { setCopyState("failed"); }
  };
  return <section className="tap-code-block">
    <header className="tap-code-head">
      <button type="button" className="tap-code-fold" aria-expanded={expanded} aria-controls={id}
        aria-label={t(expanded ? "collapseCode" : "expandCode")} title={t(expanded ? "collapseCode" : "expandCode")}
        onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{language || t("codeBlock")}</span>
      </button>
      <span className="tap-code-feedback" role="status">{copyState === "failed" ? t("copyFailed") : copyState === "copied" ? t("copied") : ""}</span>
      <button type="button" className="tap-code-copy" aria-label={t(copyState === "copied" ? "copied" : "copyCode")}
        title={t(copyState === "copied" ? "copied" : "copyCode")} onClick={() => void copy()}>
        {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </header>
    <pre id={id} hidden={!expanded}>{children}</pre>
  </section>;
}
