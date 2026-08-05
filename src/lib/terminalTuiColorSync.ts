import type { Terminal } from "@xterm/xterm";
import {
  hasCodexTuiViewport,
  hasKnownAiTuiViewport,
  hasTuiComposerPromptViewport,
  normalizeTerminalTuiComposerBackground,
} from "./terminalTuiDisplay";
import {
  isClaudeTerminalContext,
  isCodexTerminalContext,
  type TerminalCliContext,
} from "../terminal/browser/TerminalCliContext";

export interface TerminalTuiColorSyncOptions {
  isTransparent: boolean;
  isLightTheme: boolean;
  terminalTextColor?: string;
  tuiUserColor?: string;
  tuiAssistantColor?: string;
  getContext: () => TerminalCliContext;
}

export interface TerminalTuiColorSyncController {
  normalize: (terminal: Terminal) => void;
  schedule: (terminal: Terminal | null) => void;
  reset: () => void;
  dispose: () => void;
}

export function createTerminalTuiColorSyncController(
  getOptions: () => TerminalTuiColorSyncOptions,
): TerminalTuiColorSyncController {
  let frameId: number | null = null;
  let tuiSessionDetected = false;

  const normalize = (terminal: Terminal) => {
    const options = getOptions();
    const context = options.getContext();
    const hasContextualTuiPrompt = (
      (isCodexTerminalContext(context) || isClaudeTerminalContext(context))
      && hasTuiComposerPromptViewport(terminal)
    );
    if (hasKnownAiTuiViewport(terminal) || hasContextualTuiPrompt) tuiSessionDetected = true;

    const isTuiCodexSession = tuiSessionDetected && (
      hasCodexTuiViewport(terminal) || isCodexTerminalContext(context)
    );
    const isTuiClaudeSession = tuiSessionDetected && isClaudeTerminalContext(context);
    normalizeTerminalTuiComposerBackground(terminal, {
      shouldNormalize: options.isTransparent || ((isTuiCodexSession || isTuiClaudeSession) && options.isLightTheme),
      isTransparent: options.isTransparent,
      isLightTheme: options.isLightTheme,
      isTuiSession: tuiSessionDetected,
      isCodexSession: isTuiCodexSession,
      isClaudeSession: isTuiClaudeSession,
      terminalTextColor: options.terminalTextColor,
      tuiUserColor: options.tuiUserColor,
      tuiAssistantColor: options.tuiAssistantColor,
    });
  };

  const schedule = (terminal: Terminal | null) => {
    if (!terminal || frameId !== null) return;
    frameId = window.requestAnimationFrame(() => {
      frameId = null;
      normalize(terminal);
    });
  };

  const reset = () => {
    tuiSessionDetected = false;
  };

  const dispose = () => {
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
    reset();
  };

  return { normalize, schedule, reset, dispose };
}
