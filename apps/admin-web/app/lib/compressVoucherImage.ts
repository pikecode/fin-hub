const MAX_BYTES = 500 * 1024;

/** Keep originals that fit; flatten large images to JPEG for manual attachment storage. */
export async function compressVoucherImage(file: File): Promise<File> {
  if (file.size <= MAX_BYTES) return file;
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => { throw new Error("图片无法读取，请使用有效的 JPG 或 PNG 图片"); });
    let scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法压缩图片，请更换浏览器后重试");
    for (let attempt = 0; attempt < 8; attempt++, scale *= 0.75) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.9, 0.8, 0.7, 0.6]) {
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
        if (!blob) throw new Error("图片压缩失败，请换一张图片重试");
        if (blob.size <= MAX_BYTES) {
          return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg", lastModified: file.lastModified });
        }
      }
    }
    throw new Error("图片压缩后仍超过500KB，请裁剪后重新上传");
  } finally {
    URL.revokeObjectURL(url);
  }
}
