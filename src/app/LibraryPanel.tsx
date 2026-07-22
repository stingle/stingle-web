import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type { AuthService, AuthSession } from "../auth/auth-service";
import type { DecryptedFileSummary, EncryptedAlbumDescriptor } from "../auth/vault-core";
import { registerMediaSession, registerRemoteMediaSession, type MediaSessionHandle } from "../media/client";
import { browserDisplayBlob } from "../media/image-preview";
import { prepareBrowserMedia } from "../media/upload-preparation";
import { PriorityTaskPool } from "../media/task-pool";
import type { LocalAlbum, LocalFile, SyncSummary } from "../sync/model";
import { MirrorStore, type FileDateGroup } from "../sync/mirror-store";
import { SyncEngine } from "../sync/sync-engine";
import stingleLogo from "../assets/stingle-logo.png";
import { VirtualizedFileGrid } from "./VirtualizedFileGrid";
import { ZoomablePhoto } from "./ZoomablePhoto";

type LibraryView = "gallery" | "albums" | "shared" | "trash";
const BLANK_ALBUM_COVER = "__b__";
const VIRTUALIZE_AFTER = 500;
const MAX_MEMORY_THUMBNAILS = 750;

interface ViewerState {
  file: LocalFile;
  metadata: DecryptedFileSummary;
  set: number;
  album?: EncryptedAlbumDescriptor;
  loading: boolean;
  previewUrl?: string;
  url?: string;
  isVideo: boolean;
  error?: string;
  mediaSession?: MediaSessionHandle;
  transport?: "memory" | "remote-range";
  index?: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function fileKey(set: "gallery" | "trash" | "album", file: LocalFile): string {
  return set === "album" ? `album:${file.albumId}:${file.file}` : `${set}:${file.file}`;
}

function dateLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (left: Date, right: Date): boolean =>
    left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function groupFilesByDate(files: LocalFile[]): Array<{ label: string; files: LocalFile[] }> {
  const groups: Array<{ label: string; files: LocalFile[] }> = [];
  let previous = "";
  for (const file of files) {
    const date = new Date(file.dateCreated);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (key !== previous) {
      groups.push({ label: dateLabel(file.dateCreated), files: [] });
      previous = key;
    }
    groups.at(-1)!.files.push(file);
  }
  return groups;
}

function upsertNewest(files: LocalFile[], uploaded: LocalFile): LocalFile[] {
  return [uploaded, ...files.filter((file) => file.file !== uploaded.file || file.albumId !== uploaded.albumId)]
    .sort((left, right) => right.dateCreated - left.dateCreated);
}

function albumDescriptor(album: LocalAlbum): EncryptedAlbumDescriptor {
  return { albumId: album.albumId, publicKey: album.publicKey, encPrivateKey: album.encPrivateKey, metadata: album.metadata };
}

function mimeType(filename: string, video: boolean): string {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (video) {
    if (extension === "webm") return "video/webm";
    if (extension === "mov") return "video/quicktime";
    return "video/mp4";
  }
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "avif") return "image/avif";
  return "image/jpeg";
}

function NavIcon({ name }: { name: LibraryView }) {
  if (name === "gallery") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m5 18 5-5 3 3 2-2 4 4"/></svg>;
  if (name === "albums") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 5V3h8v2M7 16l3-3 2 2 2-2 3 3"/></svg>;
  if (name === "shared") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c.3-4 2-6 5-6s4.7 2 5 6M14 15c3.5-.7 6 1.2 6 4"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 3h6l1 4H8l1-4ZM7 7l1 14h8l1-14M10 11v6M14 11v6"/></svg>;
}

export function LibraryPanel({ auth, session }: { auth: AuthService; session: AuthSession }) {
  const storeRef = useRef<MirrorStore | undefined>(undefined);
  const engineRef = useRef<SyncEngine | undefined>(undefined);
  const [summary, setSummary] = useState<SyncSummary>();
  const [syncing, setSyncing] = useState(true);
  const [error, setError] = useState<string>();
  const [signingOut, setSigningOut] = useState(false);
  const [view, setView] = useState<LibraryView>("gallery");
  const viewRef = useRef<LibraryView>("gallery");
  const [gallery, setGallery] = useState<LocalFile[]>([]);
  const [trash, setTrash] = useState<LocalFile[]>([]);
  const [galleryCount, setGalleryCount] = useState(0);
  const [trashCount, setTrashCount] = useState(0);
  const [galleryDateGroups, setGalleryDateGroups] = useState<FileDateGroup[]>([]);
  const [trashDateGroups, setTrashDateGroups] = useState<FileDateGroup[]>([]);
  const [albums, setAlbums] = useState<LocalAlbum[]>([]);
  const [albumFiles, setAlbumFiles] = useState<LocalFile[]>([]);
  const [albumFileCount, setAlbumFileCount] = useState(0);
  const [albumDateGroups, setAlbumDateGroups] = useState<FileDateGroup[]>([]);
  const [fileWindowVersion, setFileWindowVersion] = useState(0);
  const [albumCoverFiles, setAlbumCoverFiles] = useState<Record<string, LocalFile>>({});
  const [selectedAlbum, setSelectedAlbum] = useState<LocalAlbum>();
  const selectedAlbumRef = useRef<LocalAlbum | undefined>(undefined);
  const [albumNames, setAlbumNames] = useState<Record<string, string>>({});
  const [fileMetadata, setFileMetadata] = useState<Record<string, DecryptedFileSummary>>({});
  const fileMetadataRef = useRef<Record<string, DecryptedFileSummary>>({});
  const metadataRequestsRef = useRef(new Set<string>());
  const virtualFileKeysRef = useRef(new Set<string>());
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const thumbnailUrlsRef = useRef(new Map<string, string>());
  const thumbnailPoolRef = useRef(new PriorityTaskPool(32));
  const visibleThumbnailKeysRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const [viewer, setViewer] = useState<ViewerState>();
  const viewerRef = useRef<ViewerState | undefined>(undefined);
  const viewerRequestRef = useRef(0);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const selectedFilesRef = useRef(new Map<string, LocalFile>());
  const [mutation, setMutation] = useState<string>();
  const [showCreateAlbum, setShowCreateAlbum] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");
  const [albumPickerMode, setAlbumPickerMode] = useState<"copy" | "move">();
  const uploadInputRef = useRef<HTMLInputElement>(null);

  function updateViewer(next?: ViewerState): void {
    viewerRef.current = next;
    setViewer(next);
  }

  function mergeFileMetadata(entries: Record<string, DecryptedFileSummary>): void {
    fileMetadataRef.current = { ...fileMetadataRef.current, ...entries };
    setFileMetadata(fileMetadataRef.current);
  }

  async function loadThumbnails(
    files: LocalFile[],
    set: number,
    keySet: "gallery" | "trash" | "album",
    album?: EncryptedAlbumDescriptor,
    priority = 10,
  ): Promise<void> {
    const store = storeRef.current;
    if (!store) return;
    for (const file of files) {
      const key = fileKey(keySet, file);
      if (thumbnailUrlsRef.current.has(key)) continue;
      thumbnailPoolRef.current.enqueue(key, priority, async (signal) => {
        if (thumbnailUrlsRef.current.has(key)) return;
        let plaintext: Uint8Array | undefined;
        let encrypted = await store.getEncryptedThumbnail(key, file).catch(() => undefined);
        if (encrypted) {
          try {
            plaintext = await auth.decryptFileBlob(encrypted, file.headers, true, album);
          } catch {
            encrypted.fill(0);
            encrypted = undefined;
            await store.removeEncryptedThumbnail(key).catch(() => undefined);
          }
        }
        if (!plaintext) {
          encrypted = await auth.downloadEncrypted(file.file, set, true, signal);
          try {
            if (signal.aborted) throw new DOMException("Thumbnail download aborted.", "AbortError");
            plaintext = await auth.decryptFileBlob(encrypted, file.headers, true, album);
            if (!signal.aborted) await store.putEncryptedThumbnail(key, file, encrypted).catch(() => undefined);
          } finally {
            encrypted.fill(0);
          }
        } else {
          encrypted?.fill(0);
        }
        if (signal.aborted) {
          plaintext.fill(0);
          throw new DOMException("Thumbnail download aborted.", "AbortError");
        }
        const displayBytes = plaintext.slice();
        plaintext.fill(0);
        const blob = new Blob([displayBytes.buffer], { type: "image/jpeg" });
        displayBytes.fill(0);
        if (!mountedRef.current) return;
        const url = URL.createObjectURL(blob);
        thumbnailUrlsRef.current.set(key, url);
        const evicted: string[] = [];
        if (thumbnailUrlsRef.current.size > MAX_MEMORY_THUMBNAILS) {
          for (const [candidate, candidateUrl] of thumbnailUrlsRef.current) {
            if (thumbnailUrlsRef.current.size <= MAX_MEMORY_THUMBNAILS) break;
            if (candidate === key || visibleThumbnailKeysRef.current.has(candidate)) continue;
            URL.revokeObjectURL(candidateUrl);
            thumbnailUrlsRef.current.delete(candidate);
            evicted.push(candidate);
          }
        }
        setThumbnailUrls((current) => {
          const next = { ...current, [key]: url };
          for (const candidate of evicted) delete next[candidate];
          return next;
        });
      });
    }
  }

  async function loadLibrary(): Promise<void> {
    const store = storeRef.current;
    if (!store) return;
    const stats = await store.getStats();
    const [nextGallery, nextTrash, nextAlbums, nextGalleryDateGroups, nextTrashDateGroups] = await Promise.all([
      stats.files > 0 && stats.files <= VIRTUALIZE_AFTER ? store.listFiles("files", stats.files) : Promise.resolve([]),
      stats.trash > 0 && stats.trash <= VIRTUALIZE_AFTER ? store.listFiles("trash", stats.trash) : Promise.resolve([]),
      store.listAlbums(),
      stats.files > VIRTUALIZE_AFTER ? store.listFileDateGroups("files") : Promise.resolve([]),
      stats.trash > VIRTUALIZE_AFTER ? store.listFileDateGroups("trash") : Promise.resolve([]),
    ]);
    const decrypted = await auth.decryptLibrary(
      nextAlbums.map((album) => ({ albumId: album.albumId, publicKey: album.publicKey, encPrivateKey: album.encPrivateKey, metadata: album.metadata })),
      [
        ...nextGallery.map((file) => ({ id: fileKey("gallery", file), headers: file.headers })),
        ...nextTrash.map((file) => ({ id: fileKey("trash", file), headers: file.headers })),
      ],
    );
    setGallery(nextGallery);
    setTrash(nextTrash);
    setGalleryCount(stats.files);
    setTrashCount(stats.trash);
    setGalleryDateGroups(nextGalleryDateGroups);
    setTrashDateGroups(nextTrashDateGroups);
    setAlbums(nextAlbums);
    setFileWindowVersion((current) => current + 1);
    setAlbumNames(Object.fromEntries(decrypted.albums.flatMap((album) => album.name ? [[album.albumId, album.name]] : [])));
    mergeFileMetadata(Object.fromEntries(decrypted.files.map((file) => [file.id, file])));
    if (nextGallery.length) {
      void loadThumbnails(nextGallery, 0, "gallery", undefined,
        !selectedAlbumRef.current && viewRef.current === "gallery" ? 0 : 10);
    }
    const covers = (await Promise.all(nextAlbums
      .filter((album) => album.cover !== BLANK_ALBUM_COVER)
      .map(async (album) => {
        const explicit = album.cover ? await store.getAlbumFile(album.albumId, album.cover) : undefined;
        const file = explicit ?? (await store.listAlbumFiles(album.albumId, 1))[0];
        return { album, file };
      })))
      .filter((entry): entry is { album: LocalAlbum; file: LocalFile } => Boolean(entry.file));
    setAlbumCoverFiles(Object.fromEntries(covers.map(({ album, file }) => [album.albumId, file])));
    for (const { album, file } of covers) {
      const coversAreVisible = !selectedAlbumRef.current && !album.isHidden &&
        album.isShared === (viewRef.current === "shared") && ["albums", "shared"].includes(viewRef.current);
      void loadThumbnails([file], 2, "album", albumDescriptor(album), coversAreVisible ? 0 : 10);
    }
  }

  function activeFileContext(): string {
    return selectedAlbumRef.current ? `album:${selectedAlbumRef.current.albumId}` : viewRef.current;
  }

  async function loadVirtualRange(offset: number, limit: number): Promise<LocalFile[]> {
    const store = storeRef.current;
    if (!store) return [];
    const album = selectedAlbumRef.current;
    if (album) return store.listAlbumFiles(album.albumId, limit, offset);
    return store.listFiles(viewRef.current === "trash" ? "trash" : "files", limit, offset);
  }

  function prepareVirtualRange(
    files: LocalFile[],
    offset: number,
    visibleStart: number,
    visibleEnd: number,
  ): void {
    const context = activeFileContext();
    const album = selectedAlbumRef.current;
    const keySet = album ? "album" : viewRef.current === "trash" ? "trash" : "gallery";
    const set = album ? 2 : viewRef.current === "trash" ? 1 : 0;
    if (album) setAlbumFiles(files);
    else if (viewRef.current === "trash") setTrash(files);
    else setGallery(files);

    const keepKeys = new Set(files.map((file) => fileKey(keySet, file)));
    virtualFileKeysRef.current = keepKeys;
    const prefix = album ? `album:${album.albumId}:` : `${keySet}:`;
    const currentViewer = viewerRef.current;
    const viewerKey = currentViewer ? fileKey(keySet, currentViewer.file) : undefined;
    const nextMetadata = { ...fileMetadataRef.current };
    let metadataChanged = false;
    for (const key of Object.keys(nextMetadata)) {
      if (key.startsWith(prefix) && !keepKeys.has(key) && !selectedKeys.has(key) && viewerKey !== key) {
        delete nextMetadata[key];
        metadataChanged = true;
      }
    }
    if (metadataChanged) {
      fileMetadataRef.current = nextMetadata;
      setFileMetadata(nextMetadata);
    }

    const missing = files.filter((file) => {
      const key = fileKey(keySet, file);
      if (fileMetadataRef.current[key] || metadataRequestsRef.current.has(key)) return false;
      metadataRequestsRef.current.add(key);
      return true;
    });
    if (missing.length) {
      void auth.decryptLibrary(
        album ? [albumDescriptor(album)] : [],
        missing.map((file) => ({
          id: fileKey(keySet, file),
          ...(album ? { albumId: album.albumId } : {}),
          headers: file.headers,
        })),
      ).then((decrypted) => {
        if (activeFileContext() !== context) return;
        mergeFileMetadata(Object.fromEntries(decrypted.files
          .filter((file) => virtualFileKeysRef.current.has(file.id) || selectedKeys.has(file.id))
          .map((file) => [file.id, file])));
      }).catch(() => undefined).finally(() => {
        for (const file of missing) metadataRequestsRef.current.delete(fileKey(keySet, file));
      });
    }

    const visibleFrom = Math.max(0, visibleStart - offset);
    const visibleTo = Math.min(files.length, visibleEnd - offset);
    const visibleFiles = files.slice(visibleFrom, visibleTo);
    const rangeThumbnailKeys = new Set(files.map((file) => fileKey(keySet, file)));
    visibleThumbnailKeysRef.current = new Set(visibleFiles.map((file) => fileKey(keySet, file)));
    thumbnailPoolRef.current.retain(rangeThumbnailKeys);
    thumbnailPoolRef.current.reprioritizeAll(10);
    void loadThumbnails(files, set, keySet, album ? albumDescriptor(album) : undefined, 5);
    void loadThumbnails(visibleFiles, set, keySet, album ? albumDescriptor(album) : undefined, 0);
  }

  async function sync(): Promise<void> {
    if (!engineRef.current) return;
    setSyncing(true);
    setError(undefined);
    try {
      setSummary(await engineRef.current.syncOnce());
      await loadLibrary();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setSyncing(false);
    }
  }

  async function openAlbum(album: LocalAlbum): Promise<void> {
    if (!storeRef.current) return;
    window.scrollTo({ top: 0 });
    thumbnailPoolRef.current.reprioritizeAll(10);
    selectedAlbumRef.current = album;
    setSelectedAlbum(album);
    setSyncing(true);
    try {
      const count = await storeRef.current.countAlbumFiles(album.albumId);
      const [files, dateGroups] = await Promise.all([
        count > 0 && count <= VIRTUALIZE_AFTER
          ? storeRef.current.listAlbumFiles(album.albumId, count)
          : Promise.resolve([]),
        count > VIRTUALIZE_AFTER
          ? storeRef.current.listAlbumFileDateGroups(album.albumId)
          : Promise.resolve([]),
      ]);
      const decrypted = await auth.decryptLibrary(
        [{ albumId: album.albumId, publicKey: album.publicKey, encPrivateKey: album.encPrivateKey, metadata: album.metadata }],
        files.map((file) => ({ id: fileKey("album", file), albumId: album.albumId, headers: file.headers })),
      );
      setAlbumFiles(files);
      setAlbumFileCount(count);
      setAlbumDateGroups(dateGroups);
      setFileWindowVersion((current) => current + 1);
      mergeFileMetadata(Object.fromEntries(decrypted.files.map((file) => [file.id, file])));
      if (files.length) void loadThumbnails(files, 2, "album", albumDescriptor(album), 0);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setSyncing(false);
    }
  }

  async function openFile(file: LocalFile, metadata: DecryptedFileSummary, index?: number): Promise<void> {
    const requestId = ++viewerRequestRef.current;
    const album = selectedAlbum ? albumDescriptor(selectedAlbum) : undefined;
    const set = selectedAlbum ? 2 : view === "trash" ? 1 : 0;
    const isVideo = metadata.fileType === 3;
    const indexed = index !== undefined ? { index } : {};
    const thumbnailSet = selectedAlbum ? "album" : view === "trash" ? "trash" : "gallery";
    const previewUrl = thumbnailUrlsRef.current.get(fileKey(thumbnailSet, file));
    if (!previewUrl) void loadThumbnails([file], set, thumbnailSet, album, 0);
    updateViewer({
      file, metadata, set, ...(album ? { album } : {}), ...(previewUrl ? { previewUrl } : {}),
      ...indexed, loading: true, isVideo,
    });
    try {
      if (isVideo) {
        const header = await auth.openMediaHeader(file.headers, false, album);
        let mediaSession: MediaSessionHandle;
        try {
          try {
            const signedUrl = await auth.getDownloadUrl(file.file, set);
            mediaSession = await registerRemoteMediaSession(signedUrl, header, mimeType(metadata.filename ?? "video.mp4", true));
          } catch {
            const encrypted = await auth.downloadEncrypted(file.file, set, false);
            mediaSession = await registerMediaSession(encrypted, header, mimeType(metadata.filename ?? "video.mp4", true));
          }
        } finally {
          // postMessage gives the worker its own key copy. Erase the page copy
          // after either transport has accepted it (or after registration fails).
          header.symmetricKey.fill(0);
        }
        if (requestId !== viewerRequestRef.current) { await mediaSession.close(); return; }
        updateViewer({ file, metadata, set, ...(album ? { album } : {}), ...indexed, loading: false, isVideo, url: mediaSession.url, mediaSession, transport: mediaSession.transport });
      } else {
        const encrypted = await auth.downloadEncrypted(file.file, set, false);
        if (requestId !== viewerRequestRef.current) return;
        const plaintext = await auth.decryptFileBlob(encrypted, file.headers, false, album);
        const url = URL.createObjectURL(await browserDisplayBlob(plaintext, metadata.filename ?? "photo.jpg"));
        if (requestId !== viewerRequestRef.current) { URL.revokeObjectURL(url); return; }
        updateViewer({ file, metadata, set, ...(album ? { album } : {}), ...(previewUrl ? { previewUrl } : {}), ...indexed, loading: false, isVideo, url });
      }
    } catch (caught) {
      if (requestId !== viewerRequestRef.current) return;
      updateViewer({ file, metadata, set, ...(album ? { album } : {}), ...(previewUrl ? { previewUrl } : {}), ...indexed, loading: false, isVideo, error: message(caught) });
    }
  }

  function closeViewer(): void {
    viewerRequestRef.current += 1;
    const current = viewerRef.current;
    updateViewer(undefined);
    releaseViewer(current);
  }

  function releaseViewer(current?: ViewerState): void {
    if (current?.mediaSession) void current.mediaSession.close().catch(() => {});
    else if (current?.url) URL.revokeObjectURL(current.url);
  }

  async function navigateViewer(direction: -1 | 1): Promise<void> {
    const current = viewerRef.current;
    if (!current) return;
    const total = selectedAlbum ? albumFileCount : view === "trash" ? trashCount : galleryCount;
    if (current.index !== undefined && total > VIRTUALIZE_AFTER) {
      const nextIndex = current.index + direction;
      if (nextIndex < 0 || nextIndex >= total) return;
      const [next] = await loadVirtualRange(nextIndex, 1);
      if (!next || viewerRef.current !== current) return;
      const keySet = selectedAlbum ? "album" : view === "trash" ? "trash" : "gallery";
      const key = fileKey(keySet, next);
      let metadata = fileMetadataRef.current[key];
      if (!metadata) {
        const decrypted = await auth.decryptLibrary(
          selectedAlbum ? [albumDescriptor(selectedAlbum)] : [],
          [{ id: key, ...(selectedAlbum ? { albumId: selectedAlbum.albumId } : {}), headers: next.headers }],
        );
        metadata = decrypted.files[0];
        if (metadata) mergeFileMetadata({ [key]: metadata });
      }
      if (!metadata || metadata.error || viewerRef.current !== current) return;
      viewerRequestRef.current += 1;
      releaseViewer(current);
      await openFile(next, metadata, nextIndex);
      return;
    }
    const files = selectedAlbum ? albumFiles : view === "trash" ? trash : gallery;
    const keySet = selectedAlbum ? "album" : view === "trash" ? "trash" : "gallery";
    const index = files.findIndex((file) => file.file === current.file.file && file.albumId === current.file.albumId);
    const next = files[index + direction];
    if (!next) return;
    const metadata = fileMetadata[fileKey(keySet, next)];
    if (!metadata || metadata.error) return;
    viewerRequestRef.current += 1;
    releaseViewer(current);
    await openFile(next, metadata);
  }

  function chooseView(next: LibraryView): void {
    window.scrollTo({ top: 0 });
    thumbnailPoolRef.current.reprioritizeAll(10);
    viewRef.current = next;
    selectedAlbumRef.current = undefined;
    setView(next);
    setSelectedAlbum(undefined);
    setSelectionMode(false);
    setSelectedKeys(new Set());
    if (next === "trash" && trashCount <= VIRTUALIZE_AFTER) void loadThumbnails(trash, 1, "trash", undefined, 0);
    if (next === "gallery" && galleryCount <= VIRTUALIZE_AFTER) void loadThumbnails(gallery, 0, "gallery", undefined, 0);
    if (next === "albums" || next === "shared") {
      for (const album of albums.filter((candidate) => !candidate.isHidden && candidate.isShared === (next === "shared"))) {
        const cover = albumCoverFiles[album.albumId];
        if (cover) void loadThumbnails([cover], 2, "album", albumDescriptor(album), 0);
      }
    }
  }

  function closeAlbum(): void {
    window.scrollTo({ top: 0 });
    thumbnailPoolRef.current.reprioritizeAll(10);
    selectedAlbumRef.current = undefined;
    setSelectedAlbum(undefined);
    setSelectionMode(false);
    setSelectedKeys(new Set());
    for (const album of albums.filter((candidate) =>
      !candidate.isHidden && candidate.isShared === (viewRef.current === "shared"))) {
      const cover = albumCoverFiles[album.albumId];
      if (cover) void loadThumbnails([cover], 2, "album", albumDescriptor(album), 0);
    }
  }

  function toggleSelection(key: string, file: LocalFile): void {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
        selectedFilesRef.current.delete(key);
      } else {
        next.add(key);
        selectedFilesRef.current.set(key, file);
      }
      return next;
    });
  }

  async function runMutation(label: string, operation: () => Promise<void>): Promise<void> {
    setMutation(label);
    setError(undefined);
    try {
      await operation();
      setSelectedKeys(new Set());
      setSelectionMode(false);
      setAlbumPickerMode(undefined);
      await sync();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setMutation(undefined);
    }
  }

  async function removeAcceptedSourceFiles(files: LocalFile[], sourceSet: 0 | 2): Promise<void> {
    if (!files.length) return;
    const removed = new Set(files.map((file) => `${file.albumId ?? ""}:${file.file}`));
    await Promise.all(files.map((file) => storeRef.current?.removeFile(
      sourceSet === 2 ? "albumFiles" : "files",
      file.file,
      file.albumId,
    )));
    if (sourceSet === 2) {
      setAlbumFileCount((current) => Math.max(0, current - files.length));
      const remaining = albumFiles.filter((file) => !removed.has(`${file.albumId ?? ""}:${file.file}`));
      setAlbumFiles(remaining);
      if (selectedAlbum && albumCoverFiles[selectedAlbum.albumId] && removed.has(
        `${albumCoverFiles[selectedAlbum.albumId]!.albumId ?? ""}:${albumCoverFiles[selectedAlbum.albumId]!.file}`,
      )) {
        setAlbumCoverFiles((covers) => {
          const next = { ...covers };
          const replacement = remaining[0];
          if (replacement) next[selectedAlbum.albumId] = replacement;
          else delete next[selectedAlbum.albumId];
          return next;
        });
      }
    } else {
      setGalleryCount((current) => Math.max(0, current - files.length));
      setGallery((current) => current.filter((file) => !removed.has(`:${file.file}`)));
    }
    setFileWindowVersion((current) => current + 1);
    const removedKeys = files.map((file) => fileKey(sourceSet === 2 ? "album" : "gallery", file));
    await Promise.all(removedKeys.map((key) => storeRef.current?.removeEncryptedThumbnail(key)));
    for (const key of removedKeys) {
      const thumbnail = thumbnailUrlsRef.current.get(key);
      if (thumbnail) URL.revokeObjectURL(thumbnail);
      thumbnailUrlsRef.current.delete(key);
    }
    setThumbnailUrls((urls) => {
      const next = { ...urls };
      for (const key of removedKeys) delete next[key];
      return next;
    });
  }

  async function createAlbum(): Promise<void> {
    const name = newAlbumName.trim();
    if (!name) return;
    await runMutation("Creating album…", async () => {
      await auth.createAlbum(name);
      setNewAlbumName("");
      setShowCreateAlbum(false);
      setView("albums");
    });
  }

  async function uploadFiles(files: FileList): Promise<void> {
    if (!files.length || mutation) return;
    const targetAlbum = selectedAlbum ? albumDescriptor(selectedAlbum) : undefined;
    setError(undefined);
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files.item(index);
        if (!file) continue;
        setMutation(`Preparing ${index + 1} of ${files.length}…`);
        const prepared = await prepareBrowserMedia(file);
        const dataSize = prepared.original.byteLength;
        const previewUrl = URL.createObjectURL(new Blob([prepared.thumbnail.slice().buffer], { type: "image/jpeg" }));
        let previewAccepted = false;
        try {
          setMutation(`Uploading ${index + 1} of ${files.length}…`);
          const uploaded = await auth.upload(
            prepared.original,
            prepared.thumbnail,
            prepared.filename,
            prepared.fileType,
            prepared.videoDuration,
            prepared.dateCreated,
            targetAlbum,
          );
          const localFile: LocalFile = {
            ...uploaded,
            isLocal: false,
            isRemote: true,
            reupload: false,
          };
          await storeRef.current?.putUploadedFile(localFile);
          const keySet = selectedAlbum ? "album" : "gallery";
          const key = fileKey(keySet, localFile);
          thumbnailUrlsRef.current.set(key, previewUrl);
          previewAccepted = true;
          setThumbnailUrls((current) => ({ ...current, [key]: previewUrl }));
          mergeFileMetadata({
            [key]: {
              id: key,
              filename: prepared.filename,
              fileType: prepared.fileType,
              dataSize: dataSize.toString(),
              videoDuration: prepared.videoDuration,
            },
          });
          if (selectedAlbum) {
            setAlbumFileCount((current) => current + 1);
            setAlbumFiles((current) => upsertNewest(current, localFile));
            if (selectedAlbum.cover !== BLANK_ALBUM_COVER && !selectedAlbum.cover) {
              setAlbumCoverFiles((current) => ({ ...current, [selectedAlbum.albumId]: localFile }));
            }
          } else {
            setGalleryCount((current) => current + 1);
            setGallery((current) => upsertNewest(current, localFile));
          }
          setFileWindowVersion((current) => current + 1);
        } finally {
          if (!previewAccepted) URL.revokeObjectURL(previewUrl);
          if (prepared.original.byteLength) prepared.original.fill(0);
          if (prepared.thumbnail.byteLength) prepared.thumbnail.fill(0);
        }
      }
      setMutation("Syncing uploaded items…");
      await sync();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setMutation(undefined);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  }

  async function saveViewerFile(): Promise<void> {
    const current = viewerRef.current;
    if (!current || mutation) return;
    setMutation("Saving item…");
    setError(undefined);
    let plaintext: Uint8Array | undefined;
    try {
      const encrypted = await auth.downloadEncrypted(current.file.file, current.set, false);
      plaintext = await auth.decryptFileBlob(encrypted, current.file.headers, false, current.album);
      const blob = new Blob([plaintext.slice().buffer], {
        type: mimeType(current.metadata.filename ?? (current.isVideo ? "video.mp4" : "photo.jpg"), current.isVideo),
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = current.metadata.filename ?? (current.isVideo ? "video.mp4" : "photo.jpg");
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (caught) {
      setError(message(caught));
    } finally {
      plaintext?.fill(0);
      setMutation(undefined);
    }
  }

  function moveViewerFile(): void {
    const current = viewerRef.current;
    if (!current) return;
    const keySet = current.set === 2 ? "album" : current.set === 1 ? "trash" : "gallery";
    setSelectedKeys(new Set([fileKey(keySet, current.file)]));
    setSelectionMode(true);
    closeViewer();
    setAlbumPickerMode("move");
  }

  async function trashViewerFile(): Promise<void> {
    const current = viewerRef.current;
    if (!current || mutation || !window.confirm("Move this item to trash?")) return;
    closeViewer();
    await runMutation("Moving to trash…", async () => {
      await auth.moveFiles({
        files: [{ file: current.file.file, headers: current.file.headers, isRemote: current.file.isRemote }],
        setFrom: current.set as 0 | 2,
        setTo: 1,
        ...(current.album ? { sourceAlbum: current.album } : {}),
        isMoving: true,
      });
      await removeAcceptedSourceFiles([current.file], current.set as 0 | 2);
    });
  }

  async function restoreViewerFile(): Promise<void> {
    const current = viewerRef.current;
    if (!current || mutation) return;
    closeViewer();
    await runMutation("Restoring item…", () => auth.moveFiles({
      files: [{ file: current.file.file, headers: current.file.headers, isRemote: current.file.isRemote }],
      setFrom: 1,
      setTo: 0,
      isMoving: true,
    }));
  }

  async function deleteViewerFile(): Promise<void> {
    const current = viewerRef.current;
    if (!current || mutation || !window.confirm("Permanently delete this item? This cannot be undone.")) return;
    closeViewer();
    await runMutation("Deleting item…", () => auth.deleteFiles([
      { file: current.file.file, headers: current.file.headers, isRemote: current.file.isRemote },
    ]));
  }

  useEffect(() => {
    let cancelled = false;
    void MirrorStore.open(session.homeFolder).then((store) => {
      if (cancelled) return store.close();
      storeRef.current = store;
      engineRef.current = new SyncEngine(auth, store);
      return sync();
    }).catch((caught: unknown) => { if (!cancelled) { setError(message(caught)); setSyncing(false); } });
    return () => { cancelled = true; engineRef.current = undefined; storeRef.current?.close(); storeRef.current = undefined; };
  }, [auth, session.homeFolder]);

  useEffect(() => () => {
    mountedRef.current = false;
    thumbnailPoolRef.current.clearPending();
    viewerRequestRef.current += 1;
    const current = viewerRef.current;
    releaseViewer(current);
    for (const url of thumbnailUrlsRef.current.values()) URL.revokeObjectURL(url);
  }, []);

  useEffect(() => {
    if (!viewer) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeViewer();
      else if (event.key === "ArrowLeft") { event.preventDefault(); void navigateViewer(-1); }
      else if (event.key === "ArrowRight") { event.preventDefault(); void navigateViewer(1); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewer, gallery, trash, albumFiles, fileMetadata, selectedAlbum, view]);

  const visibleAlbums = albums.filter((album) => !album.isHidden && (view === "shared" ? album.isShared : !album.isShared));
  const visibleFiles = selectedAlbum ? albumFiles : view === "trash" ? trash : gallery;
  const visibleTotal = selectedAlbum ? albumFileCount : view === "trash" ? trashCount : galleryCount;
  const visibleDateGroups = selectedAlbum ? albumDateGroups : view === "trash" ? trashDateGroups : galleryDateGroups;
  const virtualSections = useMemo(
    () => visibleDateGroups.map((group) => ({ label: dateLabel(group.dateCreated), count: group.count })),
    [visibleDateGroups],
  );
  const virtualizedFiles = visibleTotal > VIRTUALIZE_AFTER;
  const visibleSet = selectedAlbum ? "album" : view === "trash" ? "trash" : "gallery";
  const selectedFiles = [...selectedKeys].flatMap((key) => {
    const selected = selectedFilesRef.current.get(key) ?? visibleFiles.find((file) => fileKey(visibleSet, file) === key);
    return selected ? [selected] : [];
  });
  const mutationFiles = selectedFiles.map((file) => ({ file: file.file, headers: file.headers, isRemote: file.isRemote }));
  const sourceAlbum = selectedAlbum ? albumDescriptor(selectedAlbum) : undefined;
  const writableAlbums = albums.filter((album) => !album.isHidden && album.isOwner && album.albumId !== selectedAlbum?.albumId);
  const viewerIndex = viewer?.index ?? (viewer
    ? visibleFiles.findIndex((file) => file.file === viewer.file.file && file.albumId === viewer.file.albumId)
    : -1);
  const viewerPreviewUrl = viewer
    ? thumbnailUrls[fileKey(viewer.album ? "album" : viewer.set === 1 ? "trash" : "gallery", viewer.file)] ?? viewer.previewUrl
    : undefined;
  const visibleFileGroups = virtualizedFiles
    ? []
    : selectedAlbum ? [{ label: "", files: visibleFiles }] : groupFilesByDate(visibleFiles);

  const moveSelectedToAlbum = (target: LocalAlbum, isMoving: boolean): Promise<void> => runMutation(
    isMoving ? "Moving items…" : "Copying items…",
    () => auth.moveFiles({
      files: mutationFiles,
      setFrom: selectedAlbum ? 2 : 0,
      setTo: 2,
      ...(sourceAlbum ? { sourceAlbum } : {}),
      targetAlbum: albumDescriptor(target),
      isMoving,
    }),
  );

  const moveSelectedToGallery = (isMoving: boolean): Promise<void> => runMutation(
    isMoving ? "Moving items…" : "Copying items…",
    () => auth.moveFiles({ files: mutationFiles, setFrom: 2, setTo: 0, ...(sourceAlbum ? { sourceAlbum } : {}), isMoving }),
  );

  const trashSelected = (): Promise<void> => runMutation("Moving to trash…", async () => {
    await auth.moveFiles({
      files: mutationFiles,
      setFrom: selectedAlbum ? 2 : 0,
      setTo: 1,
      ...(sourceAlbum ? { sourceAlbum } : {}),
      isMoving: true,
    });
    await removeAcceptedSourceFiles(selectedFiles, selectedAlbum ? 2 : 0);
  });

  const renderFileTile = (file: LocalFile, absoluteIndex?: number, position?: CSSProperties) => {
    const key = fileKey(visibleSet, file);
    const metadata = fileMetadata[key];
    const thumbnail = thumbnailUrls[key];
    const isSelected = selectedKeys.has(key);
    return <button
      type="button"
      className={`file-tile ${isSelected ? "selected" : ""}`}
      aria-label={metadata?.filename ?? "Encrypted item"}
      aria-pressed={selectionMode ? isSelected : undefined}
      disabled={!metadata || Boolean(metadata.error) || Boolean(mutation)}
      onClick={() => metadata && !metadata.error
        ? selectionMode ? toggleSelection(key, file) : void openFile(file, metadata, absoluteIndex)
        : undefined}
      key={`${visibleSet}-${file.albumId ?? ""}-${file.file}`}
      {...(position ? { style: position } : {})}
      {...(absoluteIndex !== undefined ? { "data-file-index": absoluteIndex } : {})}
    >
      <div className={`file-preview ${metadata?.fileType === 3 ? "video" : "photo"} ${thumbnail ? "loaded" : ""}`} style={thumbnail ? { backgroundImage: `url(${thumbnail})` } : undefined}><span className={metadata?.fileType === 3 ? "video-badge" : "photo-placeholder"}>{metadata?.fileType === 3 ? "▶" : "▧"}</span></div>
      {selectionMode ? <span className="selection-mark" aria-hidden="true">{isSelected ? "✓" : ""}</span> : null}
    </button>;
  };

  return <main className="library-shell">
    <aside className="library-sidebar">
      <div><div className="sidebar-brand"><img src={stingleLogo} alt="" /><strong>Stingle Photos</strong></div><h2 className="account-email">{session.email}</h2><small className="backup-state">{session.isKeyBackedUp ? "Encrypted backup enabled" : "Device only"}</small></div>
      <nav aria-label="Library">
        {(["gallery", "albums", "shared", "trash"] as LibraryView[]).map((item) => <button key={item} className={view === item && !selectedAlbum ? "active" : ""} type="button" onClick={() => chooseView(item)}><NavIcon name={item} />{item === "gallery" ? "Gallery" : item === "albums" ? "Albums" : item === "shared" ? "Shared albums" : "Trash"}</button>)}
      </nav>
      <div className="sidebar-status"><span>{syncing ? "Syncing…" : summary?.caughtUp ? "Up to date" : "Synced"}</span><button type="button" disabled={syncing} onClick={() => void sync()}>Sync now</button></div>
      <button className="signout-link" type="button" disabled={signingOut} onClick={() => { setSigningOut(true); void auth.logout().catch((caught: unknown) => setError(message(caught))).finally(() => setSigningOut(false)); }}>{signingOut ? "Signing out…" : "Sign out"}</button>
    </aside>
    <section className="library-content">
      <header className="library-header"><div>{selectedAlbum ? <button className="back-link" type="button" onClick={closeAlbum}>← Back to albums</button> : null}<h1>{selectedAlbum ? albumNames[selectedAlbum.albumId] ?? "Encrypted album" : view === "gallery" ? "Gallery" : view === "albums" ? "Albums" : view === "shared" ? "Shared albums" : "Trash"}</h1><p>{selectedAlbum ? `${albumFileCount} items` : view === "gallery" ? `${galleryCount} items` : view === "trash" ? `${trashCount} items` : "Your end-to-end encrypted collections"}</p></div><div className="header-actions"><span className="secure-pill">Keys isolated</span>{(!selectedAlbum && view === "gallery") || selectedAlbum?.isOwner ? <><input ref={uploadInputRef} className="file-input" type="file" accept="image/*,video/*,.heic,.heif,.m4v,.mkv,.avi,.3gp" multiple onChange={(event) => { if (event.currentTarget.files) void uploadFiles(event.currentTarget.files); }} /><button className="upload-button" type="button" disabled={Boolean(mutation)} onClick={() => uploadInputRef.current?.click()}>Upload</button></> : null}{!selectedAlbum && view === "albums" ? <button type="button" onClick={() => setShowCreateAlbum(true)}>New album</button> : null}{!selectedAlbum && view === "trash" && trashCount ? <button className="danger-button" type="button" disabled={Boolean(mutation)} onClick={() => { if (window.confirm("Permanently delete every item in trash?")) void runMutation("Emptying trash…", () => auth.emptyTrash()); }}>Empty trash</button> : null}{selectedAlbum?.isOwner ? <><button type="button" disabled={Boolean(mutation)} onClick={() => { if (window.confirm("Use a blank album cover?")) void runMutation("Setting blank cover…", () => auth.changeAlbumCover(selectedAlbum.albumId, BLANK_ALBUM_COVER)); }}>Blank cover</button><button className="danger-button" type="button" disabled={Boolean(mutation)} onClick={() => { if (window.confirm("Delete this album? Its album entries will be removed from your account.")) void runMutation("Deleting album…", async () => { await auth.deleteAlbum(selectedAlbum.albumId); selectedAlbumRef.current = undefined; setSelectedAlbum(undefined); }); }}>Delete album</button></> : null}</div></header>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {mutation ? <p className="mutation-status" role="status">{mutation}</p> : null}
      {(selectedAlbum || view === "gallery" || view === "trash") && (!selectedAlbum || selectedAlbum.isOwner) ? <div className="selection-toolbar">
        <button type="button" disabled={Boolean(mutation) || visibleTotal === 0} onClick={() => { setSelectionMode((current) => !current); setSelectedKeys(new Set()); }}>{selectionMode ? "Cancel selection" : "Select items"}</button>
        {selectionMode ? <><span>{selectedFiles.length} selected</span>{view === "trash" && !selectedAlbum ? <><button type="button" disabled={!selectedFiles.length || Boolean(mutation)} onClick={() => void runMutation("Restoring items…", () => auth.moveFiles({ files: mutationFiles, setFrom: 1, setTo: 0, isMoving: true }))}>Restore</button><button className="danger-button" type="button" disabled={!selectedFiles.length || Boolean(mutation)} onClick={() => { if (window.confirm(`Permanently delete ${selectedFiles.length} selected item(s)?`)) void runMutation("Deleting items…", () => auth.deleteFiles(mutationFiles)); }}>Delete permanently</button></> : <>{selectedAlbum?.isOwner ? <button type="button" disabled={selectedFiles.length !== 1 || Boolean(mutation)} onClick={() => void runMutation("Setting album cover…", () => auth.changeAlbumCover(selectedAlbum.albumId, selectedFiles[0]!.file))}>Set as cover</button> : null}<button type="button" disabled={!selectedFiles.length || !writableAlbums.length || Boolean(mutation)} onClick={() => setAlbumPickerMode("copy")}>Copy to album</button><button type="button" disabled={!selectedFiles.length || !writableAlbums.length || Boolean(mutation)} onClick={() => setAlbumPickerMode("move")}>Move to album</button>{selectedAlbum ? <><button type="button" disabled={!selectedFiles.length || Boolean(mutation)} onClick={() => void moveSelectedToGallery(false)}>Copy to gallery</button><button type="button" disabled={!selectedFiles.length || Boolean(mutation)} onClick={() => void moveSelectedToGallery(true)}>Move to gallery</button></> : null}<button className="danger-button" type="button" disabled={!selectedFiles.length || Boolean(mutation)} onClick={() => void trashSelected()}>Move to trash</button></>}</> : null}
      </div> : null}
      {!selectedAlbum && (view === "albums" || view === "shared") ? <div className="album-grid">
        {visibleAlbums.map((album) => { const coverFile = albumCoverFiles[album.albumId]; const coverUrl = coverFile ? thumbnailUrls[fileKey("album", coverFile)] : undefined; return <button className="album-tile" type="button" key={album.albumId} onClick={() => { setSelectionMode(false); setSelectedKeys(new Set()); void openAlbum(album); }}><span className={`album-art ${album.cover === BLANK_ALBUM_COVER ? "blank" : ""}`}>{coverUrl ? <img src={coverUrl} alt="" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m5 17 5-5 3 3 2-2 4 4"/></svg>}</span><strong>{albumNames[album.albumId] ?? "Encrypted album"}</strong><small>{album.isShared ? "Shared album" : "Private album"}</small></button>; })}
      </div> : virtualizedFiles ? <VirtualizedFileGrid
        totalCount={visibleTotal}
        sections={virtualSections}
        resetKey={selectedAlbum ? `album:${selectedAlbum.albumId}` : view}
        reloadToken={fileWindowVersion}
        loadRange={loadVirtualRange}
        onRangeLoaded={prepareVirtualRange}
        renderFile={(file, absoluteIndex, style) => renderFileTile(file, absoluteIndex, style)}
      /> : <div className="file-groups">
        {visibleFileGroups.map((group) => <section className="file-group" key={group.label || selectedAlbum?.albumId || "files"}>{group.label ? <h2>{group.label}</h2> : null}<div className="file-grid">{group.files.map((file) => renderFileTile(file))}</div></section>)}
      </div>}
    </section>
    {showCreateAlbum ? <div className="viewer-backdrop" role="dialog" aria-modal="true" aria-label="Create album"><form className="action-dialog" onSubmit={(event) => { event.preventDefault(); void createAlbum(); }}><h2>Create album</h2><label>Album name<input autoFocus maxLength={255} value={newAlbumName} onChange={(event) => setNewAlbumName(event.target.value)} /></label><div className="dialog-actions"><button type="button" onClick={() => { setShowCreateAlbum(false); setNewAlbumName(""); }}>Cancel</button><button type="submit" disabled={!newAlbumName.trim() || Boolean(mutation)}>Create</button></div></form></div> : null}
    {albumPickerMode ? <div className="viewer-backdrop" role="dialog" aria-modal="true" aria-label={`${albumPickerMode === "move" ? "Move" : "Copy"} item`}><div className="action-dialog"><h2>{albumPickerMode === "move" ? "Move" : "Copy"} item</h2><div className="album-choice-list">{selectedAlbum ? <button type="button" onClick={() => void moveSelectedToGallery(albumPickerMode === "move")}>Gallery</button> : null}{writableAlbums.map((album) => <button type="button" key={album.albumId} onClick={() => void moveSelectedToAlbum(album, albumPickerMode === "move")}>{albumNames[album.albumId] ?? "Encrypted album"}</button>)}</div><div className="dialog-actions"><button type="button" onClick={() => setAlbumPickerMode(undefined)}>Cancel</button></div></div></div> : null}
    {viewer ? <div className="media-viewer" role="dialog" aria-modal="true" aria-label={viewer.metadata.filename ?? "Media viewer"} data-media-transport={viewer.transport} onClick={closeViewer}>
      <button className="viewer-close" type="button" aria-label="Close viewer" onClick={(event) => { event.stopPropagation(); closeViewer(); }}>×</button>
      <div className="viewer-actions" onClick={(event) => event.stopPropagation()}>
        {viewer.set !== 1 ? <button type="button" disabled title="Encrypted Stingle sharing will be added in a later phase">👥 Share</button> : null}
        <button type="button" disabled={Boolean(mutation)} onClick={() => void saveViewerFile()}>⤓ Save</button>
        {viewer.set === 1 ? <><button type="button" disabled={Boolean(mutation)} onClick={() => void restoreViewerFile()}>↶ Restore</button><button className="danger-button" type="button" disabled={Boolean(mutation)} onClick={() => void deleteViewerFile()}>🗑 Delete</button></> : (!selectedAlbum || selectedAlbum.isOwner) ? <><button type="button" disabled={Boolean(mutation) || (!selectedAlbum && writableAlbums.length === 0)} onClick={moveViewerFile}>→ Move</button><button className="danger-button" type="button" disabled={Boolean(mutation)} onClick={() => void trashViewerFile()}>🗑 Delete</button></> : null}
      </div>
      {viewerIndex > 0 ? <button className="viewer-nav viewer-prev" type="button" aria-label="Previous item" onClick={(event) => { event.stopPropagation(); void navigateViewer(-1); }}>‹</button> : null}
      {viewer.isVideo ? viewer.loading ? <div className="viewer-message">Preparing encrypted video…</div> : viewer.error ? <p className="error" role="alert">{viewer.error}</p> : viewer.url ? <video src={viewer.url} controls autoPlay preload="auto" playsInline onClick={(event) => event.stopPropagation()} /> : null : viewer.url || viewerPreviewUrl ? <ZoomablePhoto key={`${viewer.file.albumId ?? "gallery"}:${viewer.file.file}`} {...(viewerPreviewUrl ? { previewUrl: viewerPreviewUrl } : {})} {...(viewer.url ? { originalUrl: viewer.url } : {})} loading={viewer.loading} alt={viewer.metadata.filename ?? "Decrypted photo"} /> : viewer.loading ? <div className="viewer-message">Downloading encrypted original…</div> : viewer.error ? <p className="error" role="alert">{viewer.error}</p> : null}
      {viewer.error && (viewer.url || viewer.previewUrl) ? <p className="viewer-photo-error" role="alert">{viewer.error}</p> : null}
      {viewerIndex >= 0 && viewerIndex < visibleTotal - 1 ? <button className="viewer-nav viewer-next" type="button" aria-label="Next item" onClick={(event) => { event.stopPropagation(); void navigateViewer(1); }}>›</button> : null}
      <div className="viewer-count" aria-live="polite">{viewerIndex + 1} / {visibleTotal}</div>
    </div> : null}
  </main>;
}
