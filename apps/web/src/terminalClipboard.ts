/** Let the browser dispatch its clipboard event instead of sending Ctrl+V to the PTY. */
export function isClipboardPasteShortcut(event: Pick<KeyboardEvent, "type" | "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">): boolean {
  return event.type === "keydown" && event.ctrlKey && !event.altKey && !event.metaKey
    && !event.shiftKey && event.key.toLowerCase() === "v";
}

/** Copy an xterm selection; without a selection Ctrl+C remains an interrupt. */
export function isClipboardCopyShortcut(event: Pick<KeyboardEvent, "type" | "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">, hasSelection: boolean): boolean {
  return hasSelection && event.type === "keydown" && event.ctrlKey && !event.altKey && !event.metaKey
    && !event.shiftKey && event.key.toLowerCase() === "c";
}

/** Preserve image-paste priority when clipboard data contains both formats. */
export function clipboardImageToUpload(clipboard: Pick<DataTransfer, "files"> | null): File | undefined {
  if (!clipboard) return undefined;
  return Array.from(clipboard.files).find((file) => file.type.startsWith("image/"));
}
