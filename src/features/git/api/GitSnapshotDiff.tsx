import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Diff, Hunk } from "react-diff-view";
import { useGitDiffParser } from "../components/diff/useGitDiffParser";
import { estimateGitDiffHunkHeight } from "../components/diff/gitDiffVirtualization";
import { normalizeGitDiffPayload } from "../../../shared/lib/gitDiffLimits";

interface Props {
  content: string;
  viewMode: "split" | "unified";
  labels: { loading: string; empty: string; unavailable: string; raw: string };
}

/** Platform-neutral snapshot surface: no transport, desktop state or mutation controls. */
export function GitSnapshotDiff({ content, viewMode, labels }: Props) {
  const metadata = useMemo(() => {
    try { return normalizeGitDiffPayload({ content, canRevertHunks: false }); }
    catch { return null; }
  }, [content]);
  const parsed = useGitDiffParser(metadata ? content : "", metadata?.byteLength ?? 0);
  const scroll = useRef<HTMLDivElement>(null);
  const hunks = parsed.file?.hunks ?? [];
  const virtualizer = useVirtualizer({
    count: hunks.length,
    getScrollElement: () => scroll.current,
    estimateSize: (index) => estimateGitDiffHunkHeight(hunks[index], viewMode),
    overscan: 2,
  });
  useEffect(() => { virtualizer.measure(); }, [viewMode, parsed.file, virtualizer]);
  if (!metadata) return <p role="alert">{labels.unavailable}</p>;
  if (parsed.parsing) return <p role="status">{labels.loading}</p>;
  if (!content) return <p>{labels.empty}</p>;
  if (!parsed.file) return <div className="git-snapshot-fallback">
    <p role="status">{labels.raw}</p><pre tabIndex={0}>{content}</pre>
  </div>;
  if (parsed.file.isBinary) return <p>{labels.unavailable}</p>;
  if (!hunks.length) return <p>{labels.empty}</p>;
  return <div className="git-snapshot-scroll" ref={scroll} tabIndex={0}>
    <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
      {virtualizer.getVirtualItems().map((item) => <div key={item.key} data-index={item.index}
        ref={virtualizer.measureElement} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}>
        <div className="git-snapshot-hunk">{hunks[item.index].content}</div>
        <Diff viewType={viewMode} diffType={parsed.file!.type} hunks={[hunks[item.index]]}>
          {(items) => items.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      </div>)}
    </div>
  </div>;
}
