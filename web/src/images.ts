import { LIMITS } from "@pocketed/shared";

const MAX_DIM = 900;
const JPEG_QUALITY = 0.78;

export async function fileToDataUrl(file: File): Promise<string> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });

  // Attempt client-side resize/compression so images stay small and sync fast.
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Invalid image"));
      el.src = rawDataUrl;
    });

    let { width, height } = img;
    if (width > MAX_DIM || height > MAX_DIM) {
      const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
      width = Math.max(1, Math.round(width * ratio));
      height = Math.max(1, Math.round(height * ratio));
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return rawDataUrl;
    ctx.drawImage(img, 0, 0, width, height);
    const compressed = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    if (compressed && compressed.length <= LIMITS.maxImageDataUrlChars) {
      return compressed;
    }
  } catch {
    // Fallback to rawDataUrl if canvas is unavailable
  }

  if (rawDataUrl.length > LIMITS.maxImageDataUrlChars) {
    throw new Error("Image is too large. Please choose a smaller image.");
  }
  return rawDataUrl;
}
