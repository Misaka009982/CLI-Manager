import type { TerminalChunk, TerminalOutputFrame } from "../types/webBrowser";
export type RenderFrame = { frame: TerminalOutputFrame; reset: boolean };
export function createWebTerminalFrames() {
  let lastChunk = 0;
  let accepted = 0;
  let partial: TerminalOutputFrame[] = [];
  let replay: TerminalOutputFrame[] | null = null;
  let buffered = 0;
  return {
    pending: () => Boolean(partial.length || replay),
    accept: (chunk: TerminalChunk): RenderFrame[] => {
      if (chunk.sequence <= lastChunk) return [];
      lastChunk = chunk.sequence;
      const output: RenderFrame[] = [];
      for (const frame of chunk.frames) {
        if (frame.kind === "reset") {
          partial = []; accepted = 0; replay = []; buffered = 0;
          if (frame.replayBatchEnd) { output.push({ frame, reset: true }); replay = null; }
          continue;
        }
        if (frame.sequenceStart || (partial.length && (partial[0]!.sequence !== frame.sequence || partial[0]!.kind !== frame.kind))) {
          buffered -= partial.reduce((sum, item) => sum + item.data.length, 0); partial = [];
        }
        if (frame.sequence > 0 && frame.sequence <= accepted) continue;
        partial.push(frame);
        buffered += frame.data.length;
        if (buffered > 24 * 1024 * 1024) throw new Error("terminal_buffer_full");
        if (frame.sequenceEnd === false) continue;
        const complete = partial;
        partial = []; accepted = Math.max(accepted, frame.sequence);
        if (replay) {
          replay.push(...complete);
          if (!frame.replayBatchEnd) continue;
          replay.forEach((item, index) => output.push({ frame: item, reset: index === 0 }));
          replay = null; buffered = 0;
        } else {
          complete.forEach((item) => output.push({ frame: item, reset: false }));
          buffered = 0;
        }
      }
      return output;
    },
  };
}
