import type { OpenedFileHeader } from "../crypto/file";
import { MEDIA_PATH_PREFIX, type MediaWorkerMessage, type MediaWorkerReply } from "./protocol";

function randomSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function activeWorker(): Promise<ServiceWorker> {
  let timeout = 0;
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => {
      timeout = window.setTimeout(() => reject(new Error("media service worker is not ready")), 10_000);
    }),
  ]).finally(() => window.clearTimeout(timeout));
  const target = navigator.serviceWorker.controller ?? registration.active;
  if (!target) throw new Error("media service worker is not active");
  return target;
}

async function send(message: MediaWorkerMessage, transfer: Transferable[] = []): Promise<void> {
  const worker = await activeWorker();
  const channel = new MessageChannel();
  const response = new Promise<MediaWorkerReply>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("media worker response timed out")), 10_000);
    channel.port1.onmessage = (event: MessageEvent<MediaWorkerReply>) => {
      window.clearTimeout(timeout);
      resolve(event.data);
    };
  });
  worker.postMessage(message, [channel.port2, ...transfer]);
  const reply = await response;
  if (!reply.ok) throw new Error(reply.error ?? "media worker rejected request");
}

export interface MediaSessionHandle {
  id: string;
  url: string;
  transport: "memory" | "remote-range";
  close(): Promise<void>;
}

export async function registerMediaSession(
  encryptedBlob: Uint8Array,
  header: OpenedFileHeader,
  mimeType: string,
): Promise<MediaSessionHandle> {
  const id = randomSessionId();
  await send({ type: "register-media-session", sessionId: id, mimeType, encryptedBlob, header });
  return {
    id,
    url: `${MEDIA_PATH_PREFIX}${id}`,
    transport: "memory",
    close: () => send({ type: "close-media-session", sessionId: id }),
  };
}

export async function registerRemoteMediaSession(
  remoteUrl: string,
  header: OpenedFileHeader,
  mimeType: string,
): Promise<MediaSessionHandle> {
  const url = new URL(remoteUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("unsafe remote media URL");
  const id = randomSessionId();
  await send({ type: "register-remote-media-session", sessionId: id, mimeType, remoteUrl: url.toString(), header });
  return {
    id,
    url: `${MEDIA_PATH_PREFIX}${id}`,
    transport: "remote-range",
    close: () => send({ type: "close-media-session", sessionId: id }),
  };
}
