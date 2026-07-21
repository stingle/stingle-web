export function isHeicFilename(filename: string): boolean {
  return /\.(?:heic|heif)$/i.test(filename.trim());
}

export function imageMimeType(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "avif") return "image/avif";
  if (extension === "heic" || extension === "heif") return "image/heic";
  return "image/jpeg";
}

export async function browserDisplayBlob(bytes: Uint8Array, filename: string): Promise<Blob> {
  const source = new Blob([bytes.slice().buffer], { type: imageMimeType(filename) });
  if (!isHeicFilename(filename)) return source;
  // The CSP build avoids unsafe-eval. Conversion happens locally after the
  // encrypted original has been opened in this browser.
  const { heicTo } = await import("heic-to/csp");
  return heicTo({ blob: source, type: "image/jpeg", quality: 0.92 });
}
