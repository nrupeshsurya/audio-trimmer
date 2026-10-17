import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Edit, partAt, parts } from "../lib/edit";
import { formatTime } from "../lib/time";
import Icon from "./Icon";

export const PEAKS_PER_SEC = 100;
const MAX_PX_PER_SEC = 1500;
const RULER_HEIGHT = 24;
const WAVE_HEIGHT = 196;
const OVERVIEW_HEIGHT = 40;
const TICK_STEPS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export interface Range {
  start: number;
  end: number;
}

interface View {
  start: number;
  pxPerSec: number;
}

type Drag =
  | { kind: "cut"; index: number }
  | { kind: "select"; anchor: number; x: number; moved: boolean }
  | { kind: "overview" };

interface Props {
  peaks: Uint8Array;
  duration: number;
  edit: Edit;
  time: number;
  playing: boolean;
  selection: Range | null;
  selectedCut: number | null;
  onSeek: (t: number) => void;
  onSelect: (range: Range | null) => void;
  onSelectCut: (index: number | null) => void;
  onCutDragStart: (index: number) => void;
  onCutDrag: (index: number, t: number) => void;
  onAddCut: (t: number) => void;
  onTogglePart: (index: number) => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Draws mirrored peak bars; `colorAt` picks the colour for the time at each column. */
function drawPeaks(
  canvas: HTMLCanvasElement,
  peaks: Uint8Array,
  view: View,
  width: number,
  height: number,
  colorAt: (t: number) => string,
) {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const mid = height / 2;
  const binsPerPx = PEAKS_PER_SEC / view.pxPerSec;
  for (let x = 0; x < width; x++) {
    const t = view.start + x / view.pxPerSec;
    const i0 = Math.floor(t * PEAKS_PER_SEC);
    const i1 = Math.max(i0 + 1, Math.floor(i0 + binsPerPx));
    if (i0 >= peaks.length) break;
    let v = 0;
    for (let i = i0; i < i1 && i < peaks.length; i++) v = Math.max(v, peaks[i]);
    const amp = Math.max(0.5, Math.pow(v / 255, 0.6) * mid * 0.92);
    ctx.fillStyle = colorAt(t);
    ctx.fillRect(x, mid - amp, 1, amp * 2);
  }
}

export default function Waveform(props: Props) {
  const { peaks, duration, edit, time, playing, selection, selectedCut } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overviewRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const [width, setWidth] = useState(0);
  const [rawView, setRawView] = useState<View | null>(null);

  useLayoutEffect(() => {
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(wrapRef.current!);
    return () => ro.disconnect();
  }, []);

  // The view is always derived through clampView so it stays valid as the width changes.
  const fitPxPerSec = width > 0 ? width / duration : 1;
  const clampView = (start: number, pxPerSec: number): View => {
    const pps = clamp(pxPerSec, fitPxPerSec, Math.max(MAX_PX_PER_SEC, fitPxPerSec));
    return { start: clamp(start, 0, Math.max(0, duration - width / pps)), pxPerSec: pps };
  };
  const view = clampView(rawView?.start ?? 0, rawView?.pxPerSec ?? fitPxPerSec);
  const span = width / view.pxPerSec;
  const xOf = (t: number) => (t - view.start) * view.pxPerSec;
  const timeAt = (clientX: number) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    return clamp(view.start + (clientX - rect.left) / view.pxPerSec, 0, duration);
  };
  const zoom = (factor: number, anchor = view.start + span / 2) => {
    const pps = clamp(view.pxPerSec * factor, fitPxPerSec, Math.max(MAX_PX_PER_SEC, fitPxPerSec));
    setRawView(clampView(anchor - xOf(anchor) / pps, pps));
  };

  // Keep the playhead in view while playing.
  useEffect(() => {
    if (playing && width && (time < view.start || time > view.start + span * 0.98)) {
      setRawView(clampView(time - span * 0.02, view.pxPerSec));
    }
  });

  // Wheel: scroll horizontally; with Cmd/Ctrl (or trackpad pinch) zoom around the pointer.
  const onWheel = useRef<(e: WheelEvent) => void>(() => {});
  onWheel.current = (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoom(Math.exp(-e.deltaY * 0.01), timeAt(e.clientX));
    } else {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      setRawView(clampView(view.start + delta / view.pxPerSec, view.pxPerSec));
    }
  };
  useEffect(() => {
    const el = surfaceRef.current!;
    const handler = (e: WheelEvent) => onWheel.current(e);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const allParts = parts(edit, duration);

  // Redraw every render: cheap at window widths, and keeps the played colour in sync.
  useEffect(() => {
    if (!width) return;
    const style = getComputedStyle(wrapRef.current!);
    const color = (name: string) => style.getPropertyValue(name).trim();
    const [wave, played, removed] = [color("--wave"), color("--wave-played"), color("--wave-removed")];
    const removedAt = (t: number) => edit.removed[partAt(edit, t)];
    drawPeaks(canvasRef.current!, peaks, view, width, WAVE_HEIGHT, (t) =>
      removedAt(t) ? removed : t <= time ? played : wave,
    );
    drawPeaks(overviewRef.current!, peaks, { start: 0, pxPerSec: width / duration }, width, OVERVIEW_HEIGHT, (t) =>
      removedAt(t) ? removed : wave,
    );
  });

  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (e.button !== 0 || target.closest("[data-chip], .zoom")) return;
    surfaceRef.current!.setPointerCapture(e.pointerId);
    const cutEl = target.closest<HTMLElement>("[data-cut]");
    if (cutEl) {
      const index = Number(cutEl.dataset.cut);
      drag.current = { kind: "cut", index };
      props.onSelect(null);
      props.onSelectCut(index);
      props.onCutDragStart(index);
    } else {
      drag.current = { kind: "select", anchor: timeAt(e.clientX), x: e.clientX, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d?.kind === "cut") props.onCutDrag(d.index, timeAt(e.clientX));
    if (d?.kind === "select") {
      if (!d.moved && Math.abs(e.clientX - d.x) < 4) return;
      d.moved = true;
      const t = timeAt(e.clientX);
      props.onSelectCut(null);
      props.onSelect({ start: Math.min(d.anchor, t), end: Math.max(d.anchor, t) });
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "select" && !d.moved) {
      props.onSelect(null);
      props.onSelectCut(null);
      props.onSeek(d.anchor);
    }
  };

  const overviewSeek = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * duration;
    setRawView(clampView(t - span / 2, view.pxPerSec));
  };

  // Ruler ticks: the smallest step that leaves ~80px between labels.
  const step = TICK_STEPS.find((s) => s * view.pxPerSec >= 80) ?? 3600;
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const ticks: number[] = [];
  for (let k = Math.ceil(view.start / step); k * step <= view.start + span; k++) ticks.push(k * step);

  const visible = (a: number, b: number) => b >= view.start && a <= view.start + span;
  let keptNo = 0;

  return (
    <div className="waveform" ref={wrapRef} data-tour="waveform">
      <div
        className="wave-surface"
        ref={surfaceRef}
        style={{ height: RULER_HEIGHT + WAVE_HEIGHT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest("[data-chip], [data-cut], .zoom")) props.onAddCut(timeAt(e.clientX));
        }}
      >
        <div className="ruler" style={{ height: RULER_HEIGHT }}>
          {ticks.map((t) => (
            <span key={t} className="tick" style={{ left: xOf(t) }}>
              {formatTime(t, decimals)}
            </span>
          ))}
        </div>
        <canvas ref={canvasRef} style={{ top: RULER_HEIGHT, width, height: WAVE_HEIGHT }} />

        {allParts.map((p) => {
          if (!p.removed) keptNo++;
          if (!visible(p.start, p.end)) return null;
          const left = Math.max(0, xOf(p.start));
          const right = Math.min(width, xOf(p.end));
          return (
            <div key={p.index}>
              {p.removed && <div className="removed-overlay" style={{ left: xOf(p.start), width: (p.end - p.start) * view.pxPerSec }} />}
              {right - left > 64 && (
                <button
                  data-chip
                  className={`part-chip ${p.removed ? "removed" : ""}`}
                  style={{ left: (left + right) / 2 }}
                  onClick={() => props.onTogglePart(p.index)}
                  title={p.removed ? "Restore this part" : "Remove this part"}
                >
                  {p.removed ? (
                    <>
                      <Icon name="undo" size={12} /> Restore
                    </>
                  ) : (
                    <>
                      Part {keptNo} <Icon name="close" size={11} />
                    </>
                  )}
                </button>
              )}
            </div>
          );
        })}

        {selection && visible(selection.start, selection.end) && (
          <div className="selection" style={{ left: xOf(selection.start), width: (selection.end - selection.start) * view.pxPerSec }}>
            <span className="selection-label">{formatTime(selection.end - selection.start)}</span>
          </div>
        )}

        {edit.cuts.map((c, i) =>
          visible(c - 1, c + 1) ? (
            <div key={i} data-cut={i} className={`cut ${selectedCut === i ? "selected" : ""}`} style={{ left: xOf(c) }}>
              <span className="cut-handle">{formatTime(c, 2)}</span>
            </div>
          ) : null,
        )}

        {visible(time, time) && <div className="playhead" style={{ left: xOf(time) }} />}

        <div className="zoom">
          <button onClick={() => zoom(1 / 1.6)} disabled={view.pxPerSec <= fitPxPerSec} title="Zoom out">
            <Icon name="minus" size={14} />
          </button>
          <button onClick={() => setRawView(null)} disabled={view.pxPerSec <= fitPxPerSec} title="Fit whole file">
            <Icon name="fit" size={14} />
          </button>
          <button onClick={() => zoom(1.6)} disabled={view.pxPerSec >= MAX_PX_PER_SEC} title="Zoom in">
            <Icon name="plus" size={14} />
          </button>
        </div>
      </div>

      <div
        className="overview"
        style={{ height: OVERVIEW_HEIGHT }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { kind: "overview" };
          overviewSeek(e);
        }}
        onPointerMove={(e) => drag.current?.kind === "overview" && overviewSeek(e)}
        onPointerUp={() => (drag.current = null)}
      >
        <canvas ref={overviewRef} style={{ width, height: OVERVIEW_HEIGHT }} />
        <div
          className="overview-window"
          style={{ left: (view.start / duration) * width, width: Math.max(4, (span / duration) * width) }}
        />
        <div className="overview-playhead" style={{ left: (time / duration) * width }} />
      </div>
    </div>
  );
}
