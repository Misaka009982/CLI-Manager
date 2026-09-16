import type { ExtensionCli } from "../../../shared/types/extensions";

export const MCP_CLIS: ExtensionCli[] = ["claude", "codex", "grok"];
export type McpRevisions = Record<ExtensionCli, number>;

/** 已应用与用户取消是不同状态，但都只结束对应 Home/CLI 的已捕获批次。 */
export function pendingMcpClis(
  revisions: McpRevisions, applied?: Partial<McpRevisions>, discarded?: Partial<McpRevisions>,
): ExtensionCli[] {
  return MCP_CLIS.filter(cli => revisions[cli] > Math.max(applied?.[cli] ?? 0, discarded?.[cli] ?? 0));
}

/** Isolate target failures: successful targets stay saved; failures remain retryable. */
export async function applyMcpTargets(
  targets: ExtensionCli[],
  apply: (cli: ExtensionCli) => Promise<void>,
): Promise<{ cli: ExtensionCli; error: unknown }[]> {
  const failures: { cli: ExtensionCli; error: unknown }[] = [];
  for (const cli of targets) {
    try { await apply(cli); } catch (error) { failures.push({ cli, error }); }
  }
  return failures;
}

/** Pin every write to the displayed Home and the fingerprint returned by its preview. */
export function saveMcpRevisionTargets(
  identity: string, revisions: McpRevisions, targets: ExtensionCli[],
  io: {
    homeIdentity: () => Promise<string>;
    preview: (cli: ExtensionCli) => Promise<{ fingerprint: string }>;
    apply: (cli: ExtensionCli, fingerprint: string) => Promise<unknown>;
    acknowledge: (cli: ExtensionCli, revision: number) => void;
  },
) {
  return applyMcpTargets(targets, async cli => {
    if (await io.homeIdentity() !== identity) throw new Error("extensions_native_preview_changed");
    const preview = await io.preview(cli);
    if (await io.homeIdentity() !== identity) throw new Error("extensions_native_preview_changed");
    await io.apply(cli, preview.fingerprint);
    io.acknowledge(cli, revisions[cli]);
  });
}
