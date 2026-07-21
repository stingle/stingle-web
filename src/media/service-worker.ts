/// <reference lib="webworker" />

import { decryptPlaintextRange, MemoryByteSource, type EncryptedByteSource, type OpenedFileHeader } from "../crypto/file";
import { ready } from "../crypto/sodium";
import { HttpRangeSource } from "./http-source";
import { MEDIA_PATH_PREFIX, type MediaWorkerMessage, type MediaWorkerReply } from "./protocol";
import { parseRangeHeader } from "./range";

interface MediaSession {
  mimeType: string;
  source: EncryptedByteSource;
  header: OpenedFileHeader;
}

const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const sessions = new Map<string, MediaSession>();

function streamPlaintextRange(
  session: MediaSession,
  start: bigint,
  endInclusive: bigint,
): ReadableStream<Uint8Array> {
  let offset = start;
  const chunkSize = BigInt(session.header.chunkSize);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset > endInclusive) {
        controller.close();
        return;
      }
      // End each emitted block at an authenticated Stingle chunk boundary.
      // This lets the media element receive its first bytes after one storage
      // range request instead of waiting for an open-ended request to decrypt
      // the whole video, and avoids decrypting a chunk twice.
      const chunkEnd = ((offset / chunkSize) + 1n) * chunkSize - 1n;
      const blockEnd = chunkEnd < endInclusive ? chunkEnd : endInclusive;
      try {
        controller.enqueue(await decryptPlaintextRange(session.source, session.header, offset, blockEnd));
        offset = blockEnd + 1n;
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

worker.addEventListener("install", (event) => {
  event.waitUntil(Promise.all([ready(), worker.skipWaiting()]));
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(worker.clients.claim());
});

worker.addEventListener("message", (event: ExtendableMessageEvent) => {
  const message = event.data as MediaWorkerMessage;
  const reply = (value: MediaWorkerReply): void => event.ports[0]?.postMessage(value);
  if (message.type === "register-media-session") {
    sessions.set(message.sessionId, {
      mimeType: message.mimeType,
      source: new MemoryByteSource(message.encryptedBlob),
      header: message.header,
    });
    reply({ ok: true });
    return;
  }
  if (message.type === "register-remote-media-session") {
    const task = (async () => {
      try {
        const remote = new URL(message.remoteUrl);
        if (remote.protocol !== "https:" || remote.username || remote.password) throw new Error("unsafe remote media URL");
        const source = new HttpRangeSource(remote.toString(), message.header);
        await source.read(0n, 38n);
        sessions.set(message.sessionId, { mimeType: message.mimeType, source, header: message.header });
        reply({ ok: true });
      } catch (error) {
        void ready().then((sodium) => sodium.memzero(message.header.symmetricKey));
        reply({ ok: false, error: error instanceof Error ? error.message : "remote media registration failed" });
      }
    })();
    event.waitUntil(task);
    return;
  }
  if (message.type === "close-media-session") {
    const session = sessions.get(message.sessionId);
    if (session) {
      void ready().then((sodium) => sodium.memzero(session.header.symmetricKey));
      sessions.delete(message.sessionId);
    }
    reply({ ok: true });
  }
});

worker.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.origin !== worker.location.origin || !url.pathname.startsWith(MEDIA_PATH_PREFIX)) return;
  event.respondWith(handleMediaRequest(event.request, url.pathname.slice(MEDIA_PATH_PREFIX.length)));
});

async function handleMediaRequest(request: Request, sessionId: string): Promise<Response> {
  const session = sessions.get(sessionId);
  if (!session || (request.method !== "GET" && request.method !== "HEAD")) {
    return new Response(null, { status: 404 });
  }
  const total = session.header.dataSize;
  const baseHeaders = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Type": session.mimeType,
    "X-Stingle-Media-Transport": "encrypted-range-stream",
  });
  try {
    const requested = parseRangeHeader(request.headers.get("range"), total);
    const range = requested ?? { start: 0n, endInclusive: total - 1n };
    const length = range.endInclusive - range.start + 1n;
    baseHeaders.set("Content-Length", length.toString());
    if (requested) {
      baseHeaders.set("Content-Range", `bytes ${range.start}-${range.endInclusive}/${total}`);
    }
    if (request.method === "HEAD") {
      return new Response(null, { status: requested ? 206 : 200, headers: baseHeaders });
    }
    return new Response(streamPlaintextRange(session, range.start, range.endInclusive), {
      status: requested ? 206 : 200,
      statusText: requested ? "Partial Content" : "OK",
      headers: baseHeaders,
    });
  } catch {
    baseHeaders.set("Content-Range", `bytes */${total}`);
    baseHeaders.set("Content-Length", "0");
    return new Response(null, {
      status: 416,
      statusText: "Range Not Satisfiable",
      headers: baseHeaders,
    });
  }
}
