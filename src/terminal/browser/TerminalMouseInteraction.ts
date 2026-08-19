import type { ITerminalOptions } from "@xterm/xterm";

export type TerminalMouseInteractionOptions = Pick<
  ITerminalOptions,
  "mouseEventsRequireAlt"
>;

/**
 * Host text selection is the default. Hold Alt to send click/drag to a
 * mouse-aware TUI so Grok/Claude/Codex cannot eat the selection on mouseup.
 */
export const createTerminalMouseInteractionOptions =
  (): TerminalMouseInteractionOptions => ({
    mouseEventsRequireAlt: true,
  });
