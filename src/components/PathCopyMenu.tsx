import { Copy } from "./icons";
import { copyText } from "../lib/aiClipboard";
import { formatAiPathBlock } from "../lib/aiPathFormatter";
import { formatProjectAbsolutePath, formatProjectRelativePath, type CopyPathKind, type ProjectPathContext } from "../lib/projectPathFormatter";
import { useI18n } from "../lib/i18n";
import { ContextMenuItem, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "./ui/context-menu";

interface PathCopyMenuProps {
  project: ProjectPathContext;
  relativePath: string;
  kind: CopyPathKind;
}

export function PathCopyMenu({ project, relativePath, kind }: PathCopyMenuProps) {
  const { t } = useI18n();
  const copy = (value: string, successMessage: string) => {
    void copyText(value, successMessage, t("files.toast.copyFailed"));
  };

  return (
    <>
      <ContextMenuItem onSelect={() => copy(formatProjectAbsolutePath(project, relativePath), t("files.toast.pathCopied"))}>
        <Copy size={13} /> {t("files.menu.copyPath")}
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Copy size={13} /> {t("files.menu.copyPathAs")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="file-explorer-menu">
          <ContextMenuItem onSelect={() => copy(formatAiPathBlock(relativePath, kind), t("files.toast.aiPathCopied"))}>
            <Copy size={13} /> {t("files.menu.copyAiPath")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => copy(formatProjectRelativePath(relativePath), t("files.toast.relativePathCopied"))}>
            <Copy size={13} /> {t("files.menu.copyRelativePath")}
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}
