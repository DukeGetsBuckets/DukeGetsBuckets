// Client-side resize + re-encode before upload: faster uploads, and re-encoding
// through a canvas drops EXIF/GPS metadata (the server strips it again regardless).

const MAX_EDGE = 2048;
const QUALITY = 0.85;

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
}

export async function compressImage(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    // WEBP where the browser can encode it, JPEG otherwise (older Safari returns PNG for webp).
    let blob = await toBlob(canvas, "image/webp");
    if (!blob || blob.type !== "image/webp") blob = await toBlob(canvas, "image/jpeg");
    if (!blob) return file;
    // Keep the original only if it's already small and the re-encode didn't help.
    if (blob.size >= file.size && scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const ext = blob.type === "image/webp" ? "webp" : "jpg";
    return new File([blob], `photo.${ext}`, { type: blob.type });
  } catch {
    return file; // server still validates and strips metadata
  }
}
