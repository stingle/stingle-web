import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { LocalFile } from "../sync/model";

const GRID_GAP = 8;
const MIN_DESKTOP_TILE = 148;
const SECTION_HEADER_HEIGHT = 33;
const OVERSCAN_ROWS = 3;
const MAX_CACHED_FILE_RECORDS = 500;

export interface VirtualFileSection {
  label: string;
  count: number;
}

interface SectionLayout extends VirtualFileSection {
  start: number;
  headerTop: number;
  itemsTop: number;
  end: number;
}

interface GridLayout {
  columns: number;
  tileSize: number;
  rowHeight: number;
  totalHeight: number;
  start: number;
  count: number;
  visibleStart: number;
  visibleEnd: number;
  sections: SectionLayout[];
  renderedSections: SectionLayout[];
}

interface FileRecordCache {
  key: string;
  files: Map<number, LocalFile>;
}

export interface VirtualizedFileGridProps {
  totalCount: number;
  sections: VirtualFileSection[];
  resetKey: string;
  reloadToken: number;
  loadRange(offset: number, limit: number): Promise<LocalFile[]>;
  onRangeLoaded(files: LocalFile[], offset: number, visibleStart: number, visibleEnd: number): void;
  renderFile(file: LocalFile, absoluteIndex: number, style: CSSProperties): ReactNode;
}

function sameLayout(left: GridLayout, right: GridLayout): boolean {
  return left.columns === right.columns && left.tileSize === right.tileSize && left.totalHeight === right.totalHeight &&
    left.start === right.start && left.count === right.count && left.visibleStart === right.visibleStart &&
    left.visibleEnd === right.visibleEnd && left.sections.length === right.sections.length &&
    left.sections.every((section, index) => {
      const candidate = right.sections[index];
      return section.label === candidate?.label && section.count === candidate.count &&
        section.start === candidate.start && section.headerTop === candidate.headerTop;
    }) && left.renderedSections.length === right.renderedSections.length &&
    left.renderedSections.every((section, index) => section.start === right.renderedSections[index]?.start);
}

function fileRange(
  sections: SectionLayout[],
  columns: number,
  rowHeight: number,
  top: number,
  bottom: number,
  totalCount: number,
): { start: number; end: number } {
  let start = totalCount;
  let end = 0;
  for (const section of sections) {
    const rows = Math.ceil(section.count / columns);
    const sectionBottom = section.itemsTop + rows * rowHeight - GRID_GAP;
    if (sectionBottom < top || section.headerTop > bottom) continue;
    const firstRow = Math.max(0, Math.floor((Math.max(top, section.itemsTop) - section.itemsTop) / rowHeight));
    const lastRow = Math.min(rows, Math.max(0, Math.ceil((bottom - section.itemsTop) / rowHeight)));
    if (lastRow <= firstRow) continue;
    start = Math.min(start, section.start + firstRow * columns);
    end = Math.max(end, Math.min(section.end, section.start + lastRow * columns));
  }
  return start === totalCount ? { start: 0, end: 0 } : { start, end };
}

export function VirtualizedFileGrid({
  totalCount,
  sections,
  resetKey,
  reloadToken,
  loadRange,
  onRangeLoaded,
  renderFile,
}: VirtualizedFileGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const loadRangeRef = useRef(loadRange);
  const onRangeLoadedRef = useRef(onRangeLoaded);
  const frameRef = useRef<number | undefined>(undefined);
  const layoutRef = useRef<GridLayout | undefined>(undefined);
  const cacheKey = `${resetKey}:${reloadToken}`;
  const cacheKeyRef = useRef(cacheKey);
  const fileCacheRef = useRef<FileRecordCache>({ key: cacheKey, files: new Map() });
  const [layout, setLayout] = useState<GridLayout>({
    columns: 1, tileSize: MIN_DESKTOP_TILE, rowHeight: MIN_DESKTOP_TILE + GRID_GAP,
    totalHeight: 0, start: 0, count: 0, visibleStart: 0, visibleEnd: 0, sections: [], renderedSections: [],
  });
  const [fileCache, setFileCache] = useState<FileRecordCache>(fileCacheRef.current);

  loadRangeRef.current = loadRange;
  onRangeLoadedRef.current = onRangeLoaded;
  layoutRef.current = layout;
  cacheKeyRef.current = cacheKey;

  useEffect(() => {
    const update = (): void => {
      frameRef.current = undefined;
      const container = containerRef.current;
      if (!container) return;
      const width = container.clientWidth;
      const columns = window.innerWidth <= 820
        ? 2
        : Math.max(1, Math.floor((width + GRID_GAP) / (MIN_DESKTOP_TILE + GRID_GAP)));
      const tileSize = Math.max(1, (width - GRID_GAP * (columns - 1)) / columns);
      const rowHeight = tileSize + GRID_GAP;
      let fileStart = 0;
      let verticalOffset = 0;
      const sectionLayouts = sections.map((section): SectionLayout => {
        const headerTop = verticalOffset;
        const itemsTop = headerTop + SECTION_HEADER_HEIGHT;
        const end = Math.min(totalCount, fileStart + section.count);
        const result = { ...section, start: fileStart, end, headerTop, itemsTop };
        verticalOffset = itemsTop + Math.ceil(section.count / columns) * rowHeight;
        fileStart = end;
        return result;
      });
      const totalHeight = Math.max(0, verticalOffset - GRID_GAP);
      const gridTop = container.getBoundingClientRect().top + window.scrollY;
      const viewportTop = Math.max(0, window.scrollY - gridTop);
      const viewportBottom = viewportTop + window.innerHeight;
      const overscanTop = Math.max(0, viewportTop - OVERSCAN_ROWS * rowHeight);
      const overscanBottom = viewportBottom + OVERSCAN_ROWS * rowHeight;
      const range = fileRange(sectionLayouts, columns, rowHeight, overscanTop, overscanBottom, totalCount);
      const visible = fileRange(sectionLayouts, columns, rowHeight, viewportTop, viewportBottom, totalCount);
      const renderedSections = sectionLayouts.filter((section) => {
        const bottom = section.itemsTop + Math.ceil(section.count / columns) * rowHeight;
        return bottom >= overscanTop && section.headerTop <= overscanBottom;
      });
      const next: GridLayout = {
        columns,
        tileSize,
        rowHeight,
        totalHeight,
        start: range.start,
        count: Math.max(0, range.end - range.start),
        visibleStart: visible.start,
        visibleEnd: visible.end,
        sections: sectionLayouts,
        renderedSections,
      };
      setLayout((current) => sameLayout(current, next) ? current : next);
    };
    const schedule = (): void => {
      if (frameRef.current === undefined) frameRef.current = window.requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(schedule);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    };
  }, [totalCount, sections, resetKey]);

  useEffect(() => {
    if (layout.count === 0) return;
    const cached = fileCacheRef.current.key === cacheKey ? fileCacheRef.current.files : new Map<number, LocalFile>();
    const missing: Array<{ start: number; count: number }> = [];
    const end = layout.start + layout.count;
    let missingStart: number | undefined;
    for (let index = layout.start; index < end; index += 1) {
      if (!cached.has(index)) {
        missingStart ??= index;
      } else if (missingStart !== undefined) {
        missing.push({ start: missingStart, count: index - missingStart });
        missingStart = undefined;
      }
    }
    if (missingStart !== undefined) missing.push({ start: missingStart, count: end - missingStart });
    for (const range of missing) {
      void loadRangeRef.current(range.start, range.count).then((files) => {
        if (cacheKeyRef.current !== cacheKey) return;
        setFileCache((current) => {
          const next = new Map(current.key === cacheKey ? current.files : []);
          files.forEach((file, index) => next.set(range.start + index, file));
          if (next.size > MAX_CACHED_FILE_RECORDS) {
            const currentLayout = layoutRef.current;
            const center = currentLayout ? currentLayout.start + currentLayout.count / 2 : range.start;
            const keep = [...next.keys()]
              .sort((left, right) => Math.abs(left - center) - Math.abs(right - center))
              .slice(0, MAX_CACHED_FILE_RECORDS);
            const keepSet = new Set(keep);
            for (const index of next.keys()) if (!keepSet.has(index)) next.delete(index);
          }
          const result = { key: cacheKey, files: next };
          fileCacheRef.current = result;
          return result;
        });
      }).catch(() => undefined);
    }
  }, [layout.start, layout.count, reloadToken, resetKey]);

  useEffect(() => {
    if (fileCache.key !== cacheKey) return;
    const files = Array.from({ length: layout.count }, (_, slot) => fileCache.files.get(layout.start + slot));
    if (files.some((file) => !file)) return;
    onRangeLoadedRef.current(files as LocalFile[], layout.start, layout.visibleStart, layout.visibleEnd);
  }, [cacheKey, fileCache, layout.start, layout.count, layout.visibleStart, layout.visibleEnd]);

  const files = fileCache.key === cacheKey ? fileCache.files : new Map<number, LocalFile>();
  let sectionIndex = layout.sections.findIndex((section) => layout.start >= section.start && layout.start < section.end);
  const positioned = Array.from({ length: layout.count }, (_, slot) => {
    const absoluteIndex = layout.start + slot;
    while (sectionIndex >= 0 && absoluteIndex >= layout.sections[sectionIndex]!.end) sectionIndex += 1;
    const section = layout.sections[sectionIndex];
    if (!section) return undefined;
    const localIndex = absoluteIndex - section.start;
    const row = Math.floor(localIndex / layout.columns);
    const column = localIndex % layout.columns;
    const style: CSSProperties = {
      position: "absolute",
      top: section.itemsTop + row * layout.rowHeight,
      left: column * (layout.tileSize + GRID_GAP),
      width: layout.tileSize,
      height: layout.tileSize,
    };
    const file = files.get(absoluteIndex);
    return file
      ? renderFile(file, absoluteIndex, style)
      : <div className="file-tile virtual-placeholder" style={style} aria-hidden="true" key={`placeholder-${absoluteIndex}`} />;
  });

  return <div
    className="virtual-file-window"
    ref={containerRef}
    style={{ height: layout.totalHeight }}
    data-total-count={totalCount}
    data-visible-start={layout.visibleStart}
    data-visible-end={layout.visibleEnd}
  >
    {layout.renderedSections.map((section) =>
      <h2 className="virtual-date-section" style={{ top: section.headerTop }} key={`${section.start}-${section.label}`}>{section.label}</h2>)}
    {positioned}
  </div>;
}
