import { gitGraphColor, type GitGraphRow } from "../components/workspace/gitGraphLayout";

export { layoutGitGraph } from "../components/workspace/gitGraphLayout";

/** Snapshot-only graph glyph; shares the desktop topology without loading its stores. */
export function GitCommitGraph({ row, width = 84 }: { row: GitGraphRow; width?: number }) {
  const x = (lane: number) => 9 + lane * 14;
  return <svg width={width} height={34} viewBox={`0 0 ${width} 34`} preserveAspectRatio="none"
    aria-hidden="true" style={{ display: "block" }}>
    <path d={`M ${x(row.lane)} 0 V 17`} stroke={gitGraphColor(row.lane)} fill="none" strokeWidth={1.5} />
    {row.segments.map((segment, index) => <path key={index}
      d={`M ${x(segment.fromLane)} ${segment.kind === "continuation" ? 0 : 17} C ${x(segment.fromLane)} 25, ${x(segment.toLane)} 25, ${x(segment.toLane)} 34`}
      fill="none" stroke={gitGraphColor(segment.colorLane)} strokeWidth={1.5}
      strokeDasharray={segment.kind === "truncated" ? "2 2" : undefined} />)}
    <circle cx={x(row.lane)} cy={17} r={4} fill={gitGraphColor(row.lane)} />
  </svg>;
}
