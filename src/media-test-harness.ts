import { equalBytes } from "./crypto/bytes";
import { decryptPlaintextRange, encryptFileBytes, MemoryByteSource } from "./crypto/file";
import { generateKeyPair } from "./crypto/keys";
import { registerMediaSession } from "./media/client";
import probeMp4Url from "../tests/fixtures/media/probe.mp4?url";
import probeWebmUrl from "../tests/fixtures/media/probe.webm?url";

export async function rangeRoundTrip(): Promise<boolean> {
  const keyPair = await generateKeyPair();
  // Deliberately spans three Stingle chunks so this probes chunk mapping, not
  // merely slicing a single decrypted block.
  const plaintext = Uint8Array.from({ length: 2_500_000 }, (_, index) => (index * 19 + 7) % 251);
  const encrypted = await encryptFileBytes(plaintext, {
    filename: "range-probe.mp4",
    fileType: 3,
    recipientPublicKey: keyPair.publicKey,
    videoDuration: 1,
  });
  const session = await registerMediaSession(encrypted.blob, encrypted.header, "video/mp4");
  try {
    const rangeStart = 900_000;
    const rangeEnd = 2_100_123;
    const response = await fetch(session.url, {
      headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
    });
    if (
      response.status !== 206 ||
      response.headers.get("x-stingle-media-transport") !== "encrypted-range-stream" ||
      response.headers.get("content-range") !==
        `bytes ${rangeStart}-${rangeEnd}/${plaintext.byteLength}`
    ) {
      return false;
    }
    return equalBytes(
      new Uint8Array(await response.arrayBuffer()),
      plaintext.slice(rangeStart, rangeEnd + 1),
    );
  } finally {
    await session.close();
  }
}

async function loadVideoFixture(): Promise<{ bytes: Uint8Array; mimeType: string; filename: string }> {
  const candidates = [
    { path: probeMp4Url, mimeType: "video/mp4", filename: "probe.mp4" },
    { path: probeWebmUrl, mimeType: "video/webm", filename: "probe.webm" },
  ];
  let fixture: (typeof candidates)[number] | undefined;
  for (const candidate of candidates) {
    if (await canLoadVideoMetadata(candidate.path)) {
      fixture = candidate;
      break;
    }
  }
  if (!fixture) throw new Error("browser could not decode the MP4 or WebM test fixture");
  const response = await fetch(fixture.path);
  if (!response.ok) throw new Error(`unable to load ${fixture.path}: ${response.status}`);
  return { ...fixture, bytes: new Uint8Array(await response.arrayBuffer()) };
}

async function canLoadVideoMetadata(path: string): Promise<boolean> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = path;
  document.body.append(video);
  try {
    await Promise.race([
      waitForEvent(video, "loadedmetadata", 5_000),
      waitForEvent(video, "error", 5_000).then(() => Promise.reject(new Error("decode failed"))),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    video.removeAttribute("src");
    video.load();
    video.remove();
  }
}

export async function nativeVideoPlaybackProbe(): Promise<{
  mimeType: string;
  duration: number;
  played: boolean;
  seeked: boolean;
  transport: "service-worker-range" | "decrypted-blob-fallback";
}> {
  const fixture = await loadVideoFixture();
  const keyPair = await generateKeyPair();
  const encrypted = await encryptFileBytes(fixture.bytes, {
    filename: fixture.filename,
    fileType: 3,
    recipientPublicKey: keyPair.publicKey,
    videoDuration: 1,
  });
  const session = await registerMediaSession(encrypted.blob, encrypted.header, fixture.mimeType);
  const video = document.createElement("video");
  // Forces a CORS-mode media request. WebKit otherwise filters request/response
  // headers on its no-CORS service-worker media path.
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = session.url;
  document.body.append(video);
  let objectUrl: string | undefined;
  let transport: "service-worker-range" | "decrypted-blob-fallback" = "service-worker-range";
  try {
    try {
      await waitForMediaMetadata(video, 4_000);
    } catch {
      // Some WebKit media pipelines cancel otherwise valid synthetic 206
      // responses. Fall back to a complete in-memory decrypt for compatibility.
      const plaintext = await decryptPlaintextRange(
        new MemoryByteSource(encrypted.blob),
        encrypted.header,
        0n,
        encrypted.header.dataSize - 1n,
      );
      const decryptedBlob = new Blob([plaintext.slice().buffer], { type: fixture.mimeType });
      transport = "decrypted-blob-fallback";
      video.removeAttribute("crossorigin");
      video.removeAttribute("src");
      try {
        // Safari/WebKit supports Blob-valued srcObject even though it is not
        // represented in the cross-browser TypeScript DOM definitions.
        (video as HTMLVideoElement & { srcObject: Blob | null }).srcObject = decryptedBlob;
        await waitForMediaMetadata(video, 4_000);
      } catch {
        (video as HTMLVideoElement & { srcObject: Blob | MediaStream | null }).srcObject = null;
        objectUrl = URL.createObjectURL(decryptedBlob);
        video.src = objectUrl;
        video.load();
        await waitForMediaMetadata(video, 20_000);
      }
    }
    await video.play();
    await waitUntil(() => video.currentTime > 0.1 || video.ended, 20_000);
    const played = video.currentTime > 0;
    const target = Math.max(0, video.duration * 0.5);
    video.currentTime = target;
    await waitForEvent(video, "seeked", 20_000);
    return {
      mimeType: fixture.mimeType,
      duration: video.duration,
      played,
      seeked: Math.abs(video.currentTime - target) < 0.35,
      transport,
    };
  } finally {
    video.pause();
    (video as HTMLVideoElement & { srcObject: Blob | MediaStream | null }).srcObject = null;
    video.removeAttribute("src");
    video.load();
    video.remove();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    await session.close();
  }
}

function waitForMediaMetadata(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", loaded);
      video.removeEventListener("error", failed);
    };
    const loaded = (): void => {
      cleanup();
      resolve();
    };
    const failed = (): void => {
      cleanup();
      reject(
        new Error(
          `media decode failed (code ${video.error?.code ?? "unknown"}): ${video.error?.message || "no detail"}`,
        ),
      );
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("loadedmetadata timed out"));
    }, timeoutMs);
    video.addEventListener("loadedmetadata", loaded, { once: true });
    video.addEventListener("error", failed, { once: true });
  });
}

function waitForEvent(target: EventTarget, name: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(`${name} timed out`)), timeoutMs);
    target.addEventListener(
      name,
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
}
