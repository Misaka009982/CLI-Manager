/** Binary terminal output shared by the transport and Web frame encoder. */
export interface TerminalBinaryFrame {
  kind: "output" | "replay" | "reset";
  sessionId: string;
  sequence: number;
  cols: number;
  rows: number;
  data: Uint8Array;
  replayBatchEnd?: boolean;
}
