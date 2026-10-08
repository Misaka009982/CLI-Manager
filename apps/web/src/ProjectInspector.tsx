import { useState } from "react";
import { Files, GitBranch } from "lucide-react";
import type { Device, ProjectContext } from "./domain";
import type { TranslationKey } from "./i18n";
import { ProjectFilesPanel } from "./ProjectFilesPanel";
import { ProjectGitPanel } from "./ProjectGitPanel";
import { directoryScope } from "./projectDirectoryCache";
import "./projectGit.css";

type Props = { device?: Device; context?: ProjectContext; t: (key: TranslationKey) => string; onClose: () => void };

// 只挂载可见页面，切换到 Git 时停止文件预取；沿用原 dock/drawer 的尺寸和关闭语义。
export function ProjectInspector(props: Props) {
  const [tab, setTab] = useState<"files" | "git">("files");
  return <section className="project-files project-inspector">
    <nav className="project-inspector-tabs" aria-label={props.t("projectTools")}>
      <button type="button" aria-pressed={tab === "files"} onClick={() => setTab("files")}><Files size={15} />{props.t("projectFiles")}</button>
      <button type="button" aria-pressed={tab === "git"} onClick={() => setTab("git")}><GitBranch size={15} />Git</button>
    </nav>
    {tab === "files" ? <ProjectFilesPanel {...props} /> : <ProjectGitPanel {...props}
      key={props.device && props.context ? directoryScope(props.device.id, props.context) : "none"} />}
  </section>;
}
