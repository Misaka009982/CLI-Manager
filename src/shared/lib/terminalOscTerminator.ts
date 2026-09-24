// BEL or ST (ESC \) ends OSC. null indicates an incomplete sequence.
export type OscTerminator = { index: number; length: number } | { abortAt: number } | null;

export const findOscTerminator = (text: string, from: number): OscTerminator => {
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x07) return { index: i, length: 1 };
    if (code === 0x1b) {
      if (i + 1 >= text.length) return null;
      if (text[i + 1] === "\\") return { index: i, length: 2 };
      // A bare ESC should not appear inside an OSC body; treat it as an invalid
      // sequence and pass it through rather than swallowing normal output.
      return { abortAt: i };
    }
  }
  return null;
};
