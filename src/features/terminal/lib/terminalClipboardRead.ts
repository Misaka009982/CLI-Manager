export interface ClipboardImages {
  paths: string[];
  hadFiles: boolean;
  rejectedCount: number;
  rejectionCode?: string | null;
}

interface ClipboardReader {
  files: () => Promise<string[]>;
  images: () => Promise<ClipboardImages>;
  text: () => Promise<string>;
}

// 明确优先级和失败边界，避免原生图片读取失败后悄悄粘贴其他文字。
export async function readTerminalClipboard(reader: ClipboardReader, imageOnly = false) {
  if (!imageOnly) {
    const paths = (await reader.files()).filter(Boolean);
    if (paths.length) return { kind: "paths" as const, paths };
  }
  const images = await reader.images();
  if (images.paths.length) return { kind: "paths" as const, paths: images.paths };
  if (images.hadFiles || images.rejectionCode || imageOnly) {
    throw new Error(images.rejectionCode || "clipboard_image_unsupported");
  }
  return { kind: "text" as const, text: await reader.text() };
}
