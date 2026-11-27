import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { JSX, PointerEvent as ReactPointerEvent } from "react";
import type { Pin, PinKind } from "../model.js";

export const FRAME_SANDBOX = "";

const FRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";

export function isolateHtml(html: string): string {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");
  return `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">${stripped}`;
}

export interface DrawnAnnotation {
  kind: PinKind;
  x: number;
  y: number;
  geometry?: Record<string, number | number[]>;
}

export interface FrameAnnotatorProps {
  title: string;
  kind?: "html" | "image";
  html: string;
  imagePath?: string | null;
  pins: Pin[];
  /** Optional unsaved draft shapes (e.g. inside inline proposal review before sending back). */
  draftPins?: Array<{ kind: PinKind; x: number; y: number; text: string; geometry?: Record<string, number | number[]> }>;
  drawTool: PinKind | null;
  accentHue?: number;
  canvasStyle?: React.CSSProperties;
  compact?: boolean;
  openPinId?: string | null;
  onSelectPin?: (pinIndex: number) => void;
  onDrawComplete?: (drawn: DrawnAnnotation) => void;
  resolveImage?: (imagePath: string) => Promise<string | null>;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

export function FrameAnnotator(props: FrameAnnotatorProps): JSX.Element {
  const {
    title,
    kind,
    html,
    imagePath,
    pins,
    draftPins = [],
    drawTool,
    accentHue = 220,
    canvasStyle,
    compact = false,
    onSelectPin,
    onDrawComplete,
    resolveImage,
  } = props;

  const markerId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [resolvedImg, setResolvedImg] = useState<string | null>(
    imagePath?.startsWith("data:image/") ? imagePath : null,
  );
  const [dragState, setDragState] = useState<{
    kind: PinKind;
    startX: number;
    startY: number;
    curX: number;
    curY: number;
    points: number[];
  } | null>(null);

  useEffect(() => {
    if (!imagePath) {
      setResolvedImg(null);
      return;
    }
    if (imagePath.startsWith("data:image/") || imagePath.startsWith("blob:")) {
      setResolvedImg(imagePath);
      return;
    }
    if (!resolveImage) {
      setResolvedImg(imagePath);
      return;
    }
    let alive = true;
    void resolveImage(imagePath)
      .then((uri) => {
        if (alive) setResolvedImg(uri ?? imagePath);
      })
      .catch(() => {
        if (alive) setResolvedImg(imagePath);
      });
    return () => {
      alive = false;
    };
  }, [imagePath, resolveImage]);

  const isolatedHtml = useMemo(() => isolateHtml(html), [html]);
  const isImage = kind === "image" || (Boolean(imagePath) && html.trim() === "");

  const pointFromEvent = (e: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const box = overlayRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return { x: 0.5, y: 0.5 };
    return {
      x: round4(clamp01((e.clientX - box.left) / box.width)),
      y: round4(clamp01((e.clientY - box.top) / box.height)),
    };
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawTool || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const pt = pointFromEvent(e);
    if (drawTool === "point" || drawTool === "step") {
      onDrawComplete?.({ kind: drawTool, x: pt.x, y: pt.y });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragState({
      kind: drawTool,
      startX: pt.x,
      startY: pt.y,
      curX: pt.x,
      curY: pt.y,
      points: [pt.x, pt.y],
    });
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState) return;
    const pt = pointFromEvent(e);
    setDragState((cur) => {
      if (!cur) return null;
      if (cur.kind === "path") {
        const lastX = cur.points[cur.points.length - 2] ?? cur.startX;
        const lastY = cur.points[cur.points.length - 1] ?? cur.startY;
        const dist = Math.hypot(pt.x - lastX, pt.y - lastY);
        const nextPts = dist >= 0.01 && cur.points.length < 160 ? [...cur.points, pt.x, pt.y] : cur.points;
        return { ...cur, curX: pt.x, curY: pt.y, points: nextPts };
      }
      return { ...cur, curX: pt.x, curY: pt.y };
    });
  };

  const handlePointerUp = () => {
    if (!dragState) return;
    const d = dragState;
    setDragState(null);
    if (d.kind === "rect") {
      const w = Math.max(0.05, round4(Math.abs(d.curX - d.startX)));
      const h = Math.max(0.05, round4(Math.abs(d.curY - d.startY)));
      const cx = round4(Math.min(d.startX, d.curX) + w / 2);
      const cy = round4(Math.min(d.startY, d.curY) + h / 2);
      onDrawComplete?.({ kind: "rect", x: clamp01(cx), y: clamp01(cy), geometry: { w, h } });
    } else if (d.kind === "arrow") {
      const moved = Math.hypot(d.curX - d.startX, d.curY - d.startY) >= 0.02;
      const tipX = moved ? d.curX : d.startX;
      const tipY = moved ? d.curY : d.startY;
      const tailX = moved ? d.startX : round4(clamp01(d.startX + 0.1));
      const tailY = moved ? d.startY : round4(clamp01(d.startY - 0.08));
      onDrawComplete?.({ kind: "arrow", x: tipX, y: tipY, geometry: { x2: tailX, y2: tailY } });
    } else if (d.kind === "path") {
      const pts = d.points.length >= 4 ? d.points : [d.startX, d.startY, d.curX, d.curY];
      onDrawComplete?.({ kind: "path", x: d.startX, y: d.startY, geometry: { points: pts } });
    }
  };

  const allShapes: Array<{
    key: string;
    kind: PinKind;
    x: number;
    y: number;
    geometry?: Record<string, number | number[]>;
    forAgents?: boolean;
    resolved?: boolean;
  }> = [
    ...pins.map((p, idx) => ({
      key: `pin:${idx}`,
      kind: p.kind ?? "point",
      x: p.x,
      y: p.y,
      geometry: p.geometry,
      forAgents: p.forAgents,
      resolved: p.resolved,
    })),
    ...draftPins.map((p, idx) => ({
      key: `draft:${idx}`,
      kind: p.kind,
      x: p.x,
      y: p.y,
      geometry: p.geometry,
      forAgents: true,
      resolved: false,
    })),
  ];

  const renderShape = (s: (typeof allShapes)[number]) => {
    if (s.resolved) return null;
    const cx = clamp01(s.x) * 100;
    const cy = clamp01(s.y) * 100;
    if (s.kind === "rect") {
      const w = Number(s.geometry?.w ?? 0.16) * 100;
      const h = Number(s.geometry?.h ?? 0.12) * 100;
      return (
        <rect
          key={s.key}
          x={Math.max(0, cx - w / 2)}
          y={Math.max(0, cy - h / 2)}
          width={w}
          height={h}
          rx={1.5}
          className={s.forAgents ? "pf-ann-shape is-agent" : "pf-ann-shape"}
        />
      );
    }
    if (s.kind === "arrow") {
      const x2 = Number(s.geometry?.x2 ?? clamp01(s.x + 0.1)) * 100;
      const y2 = Number(s.geometry?.y2 ?? clamp01(s.y - 0.08)) * 100;
      return (
        <line
          key={s.key}
          x1={x2}
          y1={y2}
          x2={cx}
          y2={cy}
          markerEnd={`url(#hc-arrow-${markerId})`}
          className={s.forAgents ? "pf-ann-arrow is-agent" : "pf-ann-arrow"}
        />
      );
    }
    if (s.kind === "path" && Array.isArray(s.geometry?.points) && s.geometry.points.length >= 4) {
      const pairs: string[] = [];
      for (let i = 0; i + 1 < s.geometry.points.length; i += 2) {
        pairs.push(`${(clamp01(s.geometry.points[i]!) * 100).toFixed(2)},${(clamp01(s.geometry.points[i + 1]!) * 100).toFixed(2)}`);
      }
      return (
        <polyline
          key={s.key}
          points={pairs.join(" ")}
          fill="none"
          className={s.forAgents ? "pf-ann-arrow is-agent" : "pf-ann-arrow"}
        />
      );
    }
    return null;
  };

  return (
    <div className={`pf-frame-canvas${compact ? " pf-frame-canvas-inline" : ""}`} style={canvasStyle}>
      {isImage && resolvedImg ? (
        <img src={resolvedImg} alt={title} className="pf-frame-img" />
      ) : (
        <iframe
          title={title}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          loading="lazy"
          srcDoc={isolatedHtml}
        />
      )}
      <div
        ref={overlayRef}
        className={`pf-pin-layer${drawTool ? " is-capturing" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <svg className="pf-pin-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <marker
              id={`hc-arrow-${markerId}`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 10 5 L 0 8.5 z" fill="currentColor" />
            </marker>
          </defs>
          {allShapes.map(renderShape)}
          {dragState?.kind === "rect" ? (
            <rect
              x={Math.min(dragState.startX, dragState.curX) * 100}
              y={Math.min(dragState.startY, dragState.curY) * 100}
              width={Math.max(1, Math.abs(dragState.curX - dragState.startX) * 100)}
              height={Math.max(1, Math.abs(dragState.curY - dragState.startY) * 100)}
              rx={1.5}
              className="pf-ann-shape is-agent"
            />
          ) : null}
          {dragState?.kind === "arrow" ? (
            <line
              x1={dragState.startX * 100}
              y1={dragState.startY * 100}
              x2={dragState.curX * 100}
              y2={dragState.curY * 100}
              markerEnd={`url(#hc-arrow-${markerId})`}
              className="pf-ann-arrow is-agent"
            />
          ) : null}
          {dragState?.kind === "path" && dragState.points.length >= 4 ? (
            <polyline
              points={dragState.points
                .reduce<string[]>((acc, val, i, arr) => {
                  if (i % 2 === 0 && i + 1 < arr.length) acc.push(`${(val * 100).toFixed(1)},${(arr[i + 1]! * 100).toFixed(1)}`);
                  return acc;
                }, [])
                .join(" ")}
              fill="none"
              className="pf-ann-arrow is-agent"
            />
          ) : null}
        </svg>

        {pins.map((pin, idx) => (
          <button
            key={`p:${idx}`}
            type="button"
            className={`pf-pin${pin.resolved ? " is-resolved" : ""}${pin.forAgents ? " is-agent" : ""}`}
            style={{
              left: `${(clamp01(pin.x) * 100).toFixed(2)}%`,
              top: `${(clamp01(pin.y) * 100).toFixed(2)}%`,
              borderColor: pin.resolved ? undefined : `hsl(${accentHue} 65% 45%)`,
            }}
            title={`${pin.forAgents ? "[for agents] " : ""}${pin.resolved ? "[resolved] " : ""}${pin.text}`}
            aria-label={`Pin ${idx + 1}: ${pin.text}`}
            onClick={(e) => {
              e.stopPropagation();
              onSelectPin?.(idx);
            }}
          >
            {pin.kind === "step" ? `S${idx + 1}` : idx + 1}
          </button>
        ))}

        {draftPins.map((pin, idx) => (
          <span
            key={`d:${idx}`}
            className="pf-pin pf-pin-new"
            style={{ left: `${(clamp01(pin.x) * 100).toFixed(2)}%`, top: `${(clamp01(pin.y) * 100).toFixed(2)}%` }}
            title={pin.text}
          >
            {pin.kind === "step" ? `S${idx + 1}` : idx + 1}
          </span>
        ))}
      </div>
    </div>
  );
}
