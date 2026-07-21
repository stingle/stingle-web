import { browserDisplayBlob } from "./image-preview";

const THUMB_SIZE = 800;
export const MAX_BROWSER_UPLOAD_BYTES = 512 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "avif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "3gp", "mkv", "avi"]);

export interface PreparedBrowserMedia {
  original: Uint8Array;
  thumbnail: Uint8Array;
  filename: string;
  fileType: 2 | 3;
  videoDuration: number;
  dateCreated: number;
}

function extension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

export function browserMediaType(file: Pick<File, "name" | "type">): 2 | 3 | undefined {
  const ext = extension(file.name);
  if (file.type.startsWith("image/") && IMAGE_EXTENSIONS.has(ext)) return 2;
  if (file.type.startsWith("video/") && VIDEO_EXTENSIONS.has(ext)) return 3;
  if (!file.type && IMAGE_EXTENSIONS.has(ext)) return 2;
  if (!file.type && VIDEO_EXTENSIONS.has(ext)) return 3;
  return undefined;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("thumbnail could not be encoded")),
    "image/jpeg",
    0.72,
  ));
}

function scaledCanvas(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  if (!width || !height) throw new Error("media has invalid dimensions");
  const scale = Math.min(1, THUMB_SIZE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("browser canvas is unavailable");
  context.drawImage(source, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function imageThumbnail(original: Uint8Array, filename: string): Promise<Uint8Array> {
  const display = await browserDisplayBlob(original, filename);
  const bitmap = await createImageBitmap(display, { imageOrientation: "from-image" });
  try {
    return new Uint8Array(await (await canvasBlob(scaledCanvas(bitmap, bitmap.width, bitmap.height))).arrayBuffer());
  } finally {
    bitmap.close();
  }
}

function waitForMedia(video: HTMLVideoElement, event: "loadedmetadata" | "loadeddata" | "seeked", timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error("video thumbnail timed out")), timeoutMs);
    const finish = (error?: Error): void => {
      window.clearTimeout(timeout);
      video.removeEventListener(event, ready);
      video.removeEventListener("error", failed);
      if (error) reject(error); else resolve();
    };
    const ready = (): void => finish();
    const failed = (): void => finish(new Error("this browser cannot decode the video for a thumbnail"));
    video.addEventListener(event, ready, { once: true });
    video.addEventListener("error", failed, { once: true });
  });
}

async function videoThumbnail(file: File): Promise<{ thumbnail: Uint8Array; duration: number }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.playsInline = true;
  try {
    const metadata = waitForMedia(video, "loadedmetadata");
    video.src = url;
    video.load();
    await metadata;
    const durationSeconds = Number.isFinite(video.duration) ? video.duration : 0;
    const target = durationSeconds > 0.2 ? Math.min(1, durationSeconds / 2) : 0;
    if (target > 0) {
      const seeked = waitForMedia(video, "seeked");
      video.currentTime = target;
      await seeked;
    } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForMedia(video, "loadeddata");
    }
    const thumbnail = new Uint8Array(await (await canvasBlob(scaledCanvas(video, video.videoWidth, video.videoHeight))).arrayBuffer());
    return { thumbnail, duration: Math.min(0xffff_ffff, Math.max(0, Math.round(durationSeconds * 1000))) };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

async function videoPlaceholder(): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_SIZE;
  canvas.height = THUMB_SIZE;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("browser canvas is unavailable");
  context.fillStyle = "#15161a";
  context.fillRect(0, 0, THUMB_SIZE, THUMB_SIZE);
  context.fillStyle = "#e23b3b";
  context.beginPath();
  context.arc(THUMB_SIZE / 2, THUMB_SIZE / 2, 96, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "white";
  context.beginPath();
  context.moveTo(THUMB_SIZE / 2 - 25, THUMB_SIZE / 2 - 45);
  context.lineTo(THUMB_SIZE / 2 + 55, THUMB_SIZE / 2);
  context.lineTo(THUMB_SIZE / 2 - 25, THUMB_SIZE / 2 + 45);
  context.closePath();
  context.fill();
  return new Uint8Array(await (await canvasBlob(canvas)).arrayBuffer());
}

export async function prepareBrowserMedia(file: File): Promise<PreparedBrowserMedia> {
  const fileType = browserMediaType(file);
  if (!fileType) throw new Error(`${file.name} is not a supported photo or video.`);
  if (file.size < 1) throw new Error(`${file.name} is empty.`);
  if (file.size > MAX_BROWSER_UPLOAD_BYTES) throw new Error(`${file.name} is larger than the 512 MB browser upload limit.`);
  const original = new Uint8Array(await file.arrayBuffer());
  let thumbnail: Uint8Array;
  let videoDuration = 0;
  if (fileType === 2) {
    thumbnail = await imageThumbnail(original, file.name);
  } else {
    try {
      const video = await videoThumbnail(file);
      thumbnail = video.thumbnail;
      videoDuration = video.duration;
    } catch {
      thumbnail = await videoPlaceholder();
    }
  }
  return {
    original,
    thumbnail,
    filename: file.name.replaceAll("\\", "_").replaceAll("/", "_") || "upload",
    fileType,
    videoDuration,
    dateCreated: file.lastModified > 0 ? file.lastModified : Date.now(),
  };
}
