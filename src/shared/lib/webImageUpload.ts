/** Safari-compatible image normalization for the existing bounded Web operation. */
export async function prepareWebImage(file: File): Promise<{ fileName: string; dataBase64: string }> {
  let upload = file;
  if (!upload.size) throw new Error("empty_image");
  // Decode through a normal image element: supported by Safari even when
  // createImageBitmap is absent. Convert phone formats to JPEG when needed.
  if (upload.size > 180_000 || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(upload.type)) {
    const url = URL.createObjectURL(upload);
    try {
      const picture = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("unsupported_image"));
        image.src = url;
      });
      const canvas = document.createElement("canvas");
      let scale = Math.min(1, 1600 / Math.max(picture.naturalWidth, picture.naturalHeight));
      let blob: Blob | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("image_canvas_unavailable");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(picture, 0, 0, canvas.width, canvas.height);
        blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.72));
        if (blob && blob.size <= 180_000) break;
        scale *= 0.7;
      }
      if (!blob || blob.size > 180_000) throw new Error("image_too_large_for_web_upload");
      upload = new File([blob], "web-image.jpg", { type: "image/jpeg" });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const bytes = new Uint8Array(await upload.arrayBuffer());
  if (bytes.byteLength > 180_000) throw new Error("image_too_large_for_web_upload");
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return { fileName: upload.name || "web-image.jpg", dataBase64: btoa(binary) };
}
