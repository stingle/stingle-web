import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";

interface Size {
  width: number;
  height: number;
}

interface Position {
  x: number;
  y: number;
}

function clampScale(value: number): number {
  return Math.min(8, Math.max(1, value));
}

export function ZoomablePhoto({
  previewUrl,
  originalUrl,
  loading,
  alt,
}: {
  previewUrl?: string;
  originalUrl?: string;
  loading: boolean;
  alt: string;
}) {
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });
  const [natural, setNatural] = useState<Size>();
  const [originalRendered, setOriginalRendered] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Position | undefined>(undefined);

  useEffect(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
    setNatural(undefined);
    setOriginalRendered(false);
  }, [previewUrl]);

  useEffect(() => {
    setOriginalRendered(false);
  }, [originalUrl]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      setScale((current) => {
        const next = clampScale(current * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
        if (next === 1) setPosition({ x: 0, y: 0 });
        return next;
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  const fit = useMemo(() => {
    if (!natural) return undefined;
    const ratio = Math.min((window.innerWidth * 0.92) / natural.width, (window.innerHeight * 0.88) / natural.height);
    return { width: Math.round(natural.width * ratio), height: Math.round(natural.height * ratio) };
  }, [natural]);

  function rememberSize(event: SyntheticEvent<HTMLImageElement>): void {
    const image = event.currentTarget;
    if (image.naturalWidth && image.naturalHeight) {
      setNatural((current) => current ?? { width: image.naturalWidth, height: image.naturalHeight });
    }
  }

  function reset(): void {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }

  return (
    <>
      <div
        ref={stageRef}
        className="zoom-stage"
        data-zoom={scale.toFixed(2)}
        onClick={(event) => { if (event.target !== event.currentTarget) event.stopPropagation(); }}
        onDoubleClick={(event) => { event.stopPropagation(); if (scale > 1) reset(); else setScale(2); }}
        onMouseDown={(event) => {
          if (event.button === 0 && scale > 1) dragRef.current = { x: event.clientX - position.x, y: event.clientY - position.y };
        }}
        onMouseMove={(event) => {
          const drag = dragRef.current;
          if (drag) setPosition({ x: event.clientX - drag.x, y: event.clientY - drag.y });
        }}
        onMouseUp={() => { dragRef.current = undefined; }}
        onMouseLeave={() => { dragRef.current = undefined; }}
      >
        {fit ? (
          <div
            className="zoom-inner"
            style={{ width: fit.width, height: fit.height, transform: `translate(${position.x}px, ${position.y}px) scale(${scale})` }}
          >
            {previewUrl ? <img className="zoom-preview" src={previewUrl} alt={alt} draggable={false} onLoad={rememberSize} /> : null}
            {originalUrl ? <img className="zoom-original" src={originalUrl} alt={alt} draggable={false} onLoad={(event) => { rememberSize(event); setOriginalRendered(true); }} style={{ opacity: originalRendered ? 1 : 0 }} /> : null}
          </div>
        ) : (
          <img
            className="zoom-probe"
            src={previewUrl ?? originalUrl}
            alt={alt}
            draggable={false}
            onLoad={(event) => { rememberSize(event); if (!previewUrl) setOriginalRendered(true); }}
          />
        )}
      </div>
      <div className="zoom-controls" onClick={(event) => event.stopPropagation()}>
        <button type="button" aria-label="Zoom out" onClick={() => setScale((current) => { const next = clampScale(current / 1.3); if (next === 1) setPosition({ x: 0, y: 0 }); return next; })}>−</button>
        <button type="button" aria-label="Reset zoom" onClick={reset}>{Math.round(scale * 100)}%</button>
        <button type="button" aria-label="Zoom in" onClick={() => setScale((current) => clampScale(current * 1.3))}>＋</button>
      </div>
      {(loading || (Boolean(originalUrl) && !originalRendered)) ? <span className="viewer-spinner" role="status" aria-label="Loading full-resolution photo" /> : null}
    </>
  );
}
