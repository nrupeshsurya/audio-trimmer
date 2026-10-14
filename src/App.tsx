import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import Icon, { IconName } from "./components/Icon";
import AgentPanel from "./components/AgentPanel";
import TimeInput from "./components/TimeInput";
import Waveform, { Range } from "./components/Waveform";
import * as E from "./lib/edit";
import { formatTime } from "./lib/time";
import { AgentRequest, handleAgentRequest } from "./lib/agent";
import "./App.css";

const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "wma", "aiff", "aif"];
/** Must match trim::WAVEFORM_RATE in Rust. */
const WAVEFORM_RATE = 8000;

type AudioData =
  | { state: "loading" }
  | { state: "ready"; peaks: Uint8Array; duration: number }
  | { state: "error"; message: string };

type ExportStatus =
  | { state: "running" }
  | { state: "done"; outputs: string[] }
  | { state: "error"; message: string };

interface ExportOptions {
  join: boolean;
  format: string;
  outputDir: string;
  precise: boolean;
}

export interface History {
  past: E.Edit[];
  present: E.Edit;
  future: E.Edit[];
}

export const freshHistory = (): History => ({ past: [], present: E.EMPTY_EDIT, future: [] });
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function loadWaveform(path: string) {
  const buf = await invoke<ArrayBuffer>("load_waveform", { path });
  const samples = new DataView(buf).getUint32(0, true);
  if (samples === 0) throw new Error("The file contains no audio");
  return { peaks: new Uint8Array(buf, 4), duration: samples / WAVEFORM_RATE };
}

/** A toolbar button that doesn't take focus, so Space keeps controlling playback. */
function ToolButton(props: { icon: IconName; label?: string; title: string; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <button
      className={`tool ${props.active ? "active" : ""}`}
      title={props.title}
      onClick={props.onClick}
      disabled={props.disabled}
      onMouseDown={(e) => e.preventDefault()}
    >
      <Icon name={props.icon} />
      {props.label && <span>{props.label}</span>}
    </button>
  );
}

export default function App() {
  const [files, setFiles] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [audio, setAudio] = useState<Record<string, AudioData>>({});
  const [histories, setHistories] = useState<Record<string, History>>({});
  const [exports, setExports] = useState<Record<string, ExportStatus>>({});
  const [selection, setSelection] = useState<Range | null>(null);
  const [selectedCut, setSelectedCut] = useState<number | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  const [skipRemoved, setSkipRemoved] = useState(true);
  const [join, setJoin] = useState(true);
  const [format, setFormat] = useState("same");
  const [outputDir, setOutputDir] = useState("");
  const [precise, setPrecise] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  /** Waveform loads by path, so agent calls can wait for a file to finish loading. */
  const loads = useRef(new Map<string, Promise<{ peaks: Uint8Array; duration: number }>>());
  const [agentActivity, setAgentActivity] = useState<string | null>(null);

  const data = active ? audio[active] : undefined;
  const ready = data?.state === "ready" ? data : null;
  const duration = ready?.duration ?? 0;
  const history = (active && histories[active]) || null;
  const edit = history?.present ?? E.EMPTY_EDIT;
  const allParts = useMemo(() => (ready ? E.parts(edit, duration) : []), [edit, duration, ready]);
  const kept = allParts.filter((p) => !p.removed);
  const keptDuration = kept.reduce((sum, p) => sum + p.end - p.start, 0);
  const currentPart = E.partAt(edit, time);
  const joinedSegments = ready ? E.keptSegments(edit, duration, true).length : 0;
  const forcedPrecise = join && joinedSegments > 1;
  const editedFiles = files.filter((f) => audio[f]?.state === "ready" && histories[f] && E.hasChanges(histories[f].present));
  const status = active ? exports[active] : undefined;

  // ---- Files ----

  const addFiles = (paths: string[]) => {
    if (!paths.length) return;
    setFiles((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))]);
    setActive((a) => a ?? paths[0]);
    setHistories((h) => ({ ...h, ...Object.fromEntries(paths.filter((p) => !h[p]).map((p) => [p, freshHistory()])) }));
    for (const path of paths) {
      if (loads.current.has(path)) continue;
      const load = loadWaveform(path);
      loads.current.set(path, load);
      setAudio((a) => ({ ...a, [path]: { state: "loading" } }));
      load.then(
        (d) => setAudio((a) => ({ ...a, [path]: { state: "ready", ...d } })),
        (e) => setAudio((a) => ({ ...a, [path]: { state: "error", message: String(e?.message ?? e) } })),
      );
    }
  };

  const removeFile = (path: string) => {
    const rest = files.filter((f) => f !== path);
    setFiles(rest);
    if (active === path) setActive(rest[Math.min(files.indexOf(path), rest.length - 1)] ?? null);
  };

  const pickFiles = async () => {
    const picked = await open({ multiple: true, filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }] });
    if (picked) addFiles(picked);
  };

  const pickOutputDir = async () => {
    const dir = await open({ directory: true });
    if (dir) setOutputDir(dir);
  };

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      setDragging(payload.type === "enter" || payload.type === "over");
      if (payload.type === "drop") addFiles(payload.paths);
    });
    return () => void unlisten.then((fn) => fn());
  }, []);

  // Reset transient state when switching files.
  useEffect(() => {
    audioRef.current?.pause();
    setTime(0);
    setSelection(null);
    setSelectedCut(null);
    setPlaybackError(false);
  }, [active]);

  // ---- Editing with undo history ----

  const updateHistory = (fn: (h: History) => History) => {
    if (active) setHistories((hs) => ({ ...hs, [active]: fn(hs[active] ?? freshHistory()) }));
  };
  const commit = (fn: (e: E.Edit) => E.Edit) =>
    updateHistory((h) => {
      const next = fn(h.present);
      return next === h.present ? h : { past: [...h.past, h.present].slice(-200), present: next, future: [] };
    });
  /** Saves an undo point before a drag; the drag then updates `present` in place. */
  const checkpoint = () => updateHistory((h) => ({ past: [...h.past, h.present], present: h.present, future: [] }));
  const replace = (fn: (e: E.Edit) => E.Edit) => updateHistory((h) => ({ ...h, present: fn(h.present) }));
  const undo = () => {
    setSelectedCut(null);
    updateHistory((h) =>
      h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h,
    );
  };
  const redo = () => {
    setSelectedCut(null);
    updateHistory((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h));
  };

  const cutAt = (t: number) => commit((e) => E.addCut(e, t, duration));
  const removeSelection = () => {
    if (!selection) return;
    commit((e) => E.removeRange(e, selection.start, selection.end, duration));
    setSelection(null);
  };
  const keepSelection = () => {
    if (!selection) return;
    commit((e) => E.keepOnlyRange(e, selection.start, selection.end, duration));
    setSelection(null);
  };
  const deleteCut = (i: number) => {
    commit((e) => E.removeCut(e, i));
    setSelectedCut(null);
  };
  const togglePart = (i: number) => commit((e) => E.togglePart(e, i));
  const resetEdits = () => {
    commit(() => E.EMPTY_EDIT);
    setSelection(null);
    setSelectedCut(null);
  };

  // ---- Playback ----

  const seek = (t: number) => {
    const clamped = Math.min(Math.max(t, 0), duration);
    if (audioRef.current) audioRef.current.currentTime = clamped;
    setTime(clamped);
  };

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a || !ready) return;
    if (playing) return a.pause();
    if (time >= duration - 0.05) seek(0);
    a.play().catch(() => setPlaybackError(true));
  };

  // While playing, follow the audio element and jump over removed parts.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      if (!a) return;
      let t = a.currentTime;
      const part = allParts[E.partAt(edit, t)];
      if (skipRemoved && part?.removed) {
        const next = allParts.find((p) => p.index > part.index && !p.removed);
        if (next) a.currentTime = t = next.start;
        else {
          a.pause();
          t = part.start;
        }
      }
      setTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, allParts, edit, skipRemoved]);

  // ---- Keyboard shortcuts ----

  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    if (!ready || (e.target instanceof Element && e.target.closest("input, textarea, select"))) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (mod && key === "y") {
      e.preventDefault();
      redo();
    } else if (mod) {
      return;
    } else if (key === " ") {
      e.preventDefault();
      togglePlay();
    } else if (key === "c") {
      cutAt(time);
    } else if (key === "backspace" || key === "delete") {
      e.preventDefault();
      if (selection) removeSelection();
      else if (selectedCut !== null) deleteCut(selectedCut);
      else togglePart(currentPart);
    } else if (key === "k" && selection) {
      keepSelection();
    } else if (key === "escape") {
      setSelection(null);
      setSelectedCut(null);
    } else if (key === "arrowleft" || key === "arrowright") {
      e.preventDefault();
      const dir = key === "arrowleft" ? -1 : 1;
      if (selectedCut !== null) {
        const t = edit.cuts[selectedCut] + dir * (e.shiftKey ? 0.001 : 0.01);
        commit((ed) => E.moveCut(ed, selectedCut, t, duration));
      } else seek(time + dir * (e.shiftKey ? 5 : 1));
    } else if (key === "home") {
      seek(0);
    } else if (key === "end") {
      seek(duration);
    }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ---- Export ----

  const settings: ExportOptions = { join, format, outputDir, precise };

  /** Exports one file and records its status; returns the written paths or throws. */
  const exportFile = async (path: string, edit: E.Edit, duration: number, opts: ExportOptions) => {
    const segments = E.keptSegments(edit, duration, opts.join);
    setExports((s) => ({ ...s, [path]: { state: "running" } }));
    try {
      const outputs = await invoke<string[]>("export_file", { req: { input: path, segments, ...opts } });
      setExports((s) => ({ ...s, [path]: { state: "done", outputs } }));
      return outputs;
    } catch (e) {
      setExports((s) => ({ ...s, [path]: { state: "error", message: String(e) } }));
      throw e;
    }
  };

  const exportMany = async (paths: string[]) => {
    setExporting(true);
    for (const p of paths) {
      const d = audio[p];
      if (d?.state === "ready" && histories[p]) await exportFile(p, histories[p].present, d.duration, settings).catch(() => {});
    }
    setExporting(false);
  };

  // ---- AI agents (MCP) ----

  // Agent calls arrive asynchronously, so they read the latest state through this ref.
  const latest = useRef({ files, histories, settings });
  latest.current = { files, histories, settings };

  const agentHandler = useRef<(req: AgentRequest) => Promise<unknown>>(async () => null);
  agentHandler.current = (req) =>
    handleAgentRequest(req, {
      files: () => latest.current.files,
      settings: () => latest.current.settings,
      history: (path) => latest.current.histories[path] ?? freshHistory(),
      setHistory: (path, h) => {
        latest.current.histories = { ...latest.current.histories, [path]: h };
        setHistories((hs) => ({ ...hs, [path]: h }));
      },
      open: async (paths) => {
        addFiles(paths);
        setActive(paths[0]);
        return Promise.allSettled(paths.map((p) => loads.current.get(p)!));
      },
      loaded: (paths) => Promise.allSettled(paths.map((p) => loads.current.get(p)!)),
      focus: (path) => setActive(path),
      exportFile,
      activity: setAgentActivity,
    });

  useEffect(() => {
    const unlisten = listen<AgentRequest>("agent-request", async ({ payload }) => {
      try {
        const result = await agentHandler.current(payload);
        await invoke("agent_respond", { id: payload.id, ok: true, result: result ?? null });
      } catch (e) {
        await invoke("agent_respond", { id: payload.id, ok: false, result: e instanceof Error ? e.message : String(e) });
      }
    });
    return () => void unlisten.then((fn) => fn());
  }, []);

  // Agent activity notes fade after a few seconds.
  useEffect(() => {
    if (!agentActivity) return;
    const timer = setTimeout(() => setAgentActivity(null), 6000);
    return () => clearTimeout(timer);
  }, [agentActivity]);

  // ---- Render ----

  let keptNo = 0;

  return (
    <main className={`app ${dragging ? "dragging" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <h2>Files</h2>
          <button className="icon-btn" onClick={pickFiles} title="Add files">
            <Icon name="plus" />
          </button>
        </div>
        {files.length === 0 ? (
          <p className="sidebar-empty">No files yet</p>
        ) : (
          <ul className="file-list">
            {files.map((f) => {
              const d = audio[f];
              const h = histories[f]?.present;
              const ex = exports[f];
              const cuts = h?.cuts.length ?? 0;
              const removed = h?.removed.filter(Boolean).length ?? 0;
              return (
                <li key={f} className={f === active ? "active" : ""} onClick={() => setActive(f)} title={f}>
                  <div className="file-name">{fileName(f)}</div>
                  <div className="file-meta">
                    {d?.state === "loading" && <span>Loading…</span>}
                    {d?.state === "error" && <span className="err-text">Can't read file</span>}
                    {d?.state === "ready" && (
                      <span>
                        {formatTime(d.duration, 0)}
                        {cuts > 0 && ` · ${plural(cuts, "cut")}`}
                        {removed > 0 && ` · ${removed} removed`}
                      </span>
                    )}
                    {ex?.state === "running" && <span className="pill accent"><i className="spinner" /></span>}
                    {ex?.state === "done" && <span className="pill ok">Exported</span>}
                    {ex?.state === "error" && <span className="pill err">Failed</span>}
                  </div>
                  <button
                    className="file-remove"
                    title="Remove from list"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile(f);
                    }}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <AgentPanel activity={agentActivity} />
      </aside>

      <section className="workspace">
        {!active ? (
          <button className="empty-state" onClick={pickFiles}>
            <Icon name="wave" size={32} />
            <strong>Drop audio files here</strong>
            <span>or click to choose · MP3, WAV, FLAC, M4A, OGG…</span>
          </button>
        ) : (
          <>
            <header className="file-header">
              <div className="file-title">
                <h1>{fileName(active)}</h1>
                <p>{active}</p>
              </div>
            </header>

            {data?.state === "loading" && <div className="placeholder">Reading audio…</div>}
            {data?.state === "error" && <pre className="placeholder error">{data.message}</pre>}

            {ready && (
              <>
                <div className="toolbar">
                  <ToolButton icon={playing ? "pause" : "play"} title="Play / pause (Space)" onClick={togglePlay} />
                  <span className="clock">
                    {formatTime(time)}
                    <span> / {formatTime(duration)}</span>
                  </span>
                  <div className="divider" />
                  <ToolButton icon="cut" label="Cut" title="Cut at playhead (C)" onClick={() => cutAt(time)} />
                  <ToolButton
                    icon="trash"
                    label="Remove"
                    title="Remove the selected range (Delete)"
                    onClick={removeSelection}
                    disabled={!selection}
                  />
                  <ToolButton icon="crop" label="Keep only" title="Keep only the selected range (K)" onClick={keepSelection} disabled={!selection} />
                  {selectedCut !== null && (
                    <ToolButton icon="close" label="Delete cut" title="Delete the selected cut (Delete)" onClick={() => deleteCut(selectedCut)} />
                  )}
                  <div className="spacer" />
                  <ToolButton icon="undo" title="Undo (⌘Z / Ctrl+Z)" onClick={undo} disabled={!history?.past.length} />
                  <ToolButton icon="redo" title="Redo (⇧⌘Z / Ctrl+Y)" onClick={redo} disabled={!history?.future.length} />
                </div>

                <Waveform
                  key={active}
                  peaks={ready.peaks}
                  duration={duration}
                  edit={edit}
                  time={time}
                  playing={playing}
                  selection={selection}
                  selectedCut={selectedCut}
                  onSeek={seek}
                  onSelect={setSelection}
                  onSelectCut={setSelectedCut}
                  onCutDragStart={checkpoint}
                  onCutDrag={(i, t) => replace((e) => E.moveCut(e, i, t, duration))}
                  onAddCut={cutAt}
                  onTogglePart={togglePart}
                />

                <p className="hint">
                  Click to move the playhead · drag to select · double-click or <kbd>C</kbd> to cut · drag a marker to adjust it ·{" "}
                  <kbd>⌫</kbd> removes the selection or the part under the playhead · <kbd>⌘</kbd>+scroll to zoom
                  {playbackError && <span className="err-text"> · Playback isn't supported for this format, but editing and export still work.</span>}
                </p>

                <div className="panels">
                  <section className="card">
                    <div className="card-head">
                      <h2>Parts</h2>
                      <span className="card-sub">
                        {plural(kept.length, "part")} kept · {formatTime(keptDuration)}
                      </span>
                      <div className="spacer" />
                      <label className="check" title="Jump over removed parts while playing">
                        <input type="checkbox" checked={skipRemoved} onChange={(e) => setSkipRemoved(e.target.checked)} />
                        Skip removed when playing
                      </label>
                      <button className="ghost" onClick={resetEdits} disabled={!E.hasChanges(edit)}>
                        Reset
                      </button>
                    </div>
                    <div className="parts">
                      {allParts.map((p) => (
                        <div
                          key={p.index}
                          className={`part ${p.removed ? "removed" : ""} ${p.index === currentPart ? "current" : ""}`}
                          onClick={() => seek(p.start)}
                        >
                          <span className="part-no">{p.removed ? "–" : ++keptNo}</span>
                          <TimeInput
                            value={p.start}
                            disabled={p.index === 0}
                            onCommit={(t) => commit((e) => E.moveCut(e, p.index - 1, t, duration))}
                          />
                          <span className="arrow">→</span>
                          <TimeInput
                            value={p.end}
                            disabled={p.index === allParts.length - 1}
                            onCommit={(t) => commit((e) => E.moveCut(e, p.index, t, duration))}
                          />
                          <span className="part-len">{formatTime(p.end - p.start)}</span>
                          <button
                            className={`part-toggle ${p.removed ? "restore" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              togglePart(p.index);
                            }}
                          >
                            {p.removed ? "Restore" : "Remove"}
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="card export-card">
                    <div className="card-head">
                      <h2>Export</h2>
                    </div>
                    <div className="segmented" role="radiogroup">
                      <button role="radio" aria-checked={join} className={join ? "selected" : ""} onClick={() => setJoin(true)}>
                        One file
                      </button>
                      <button role="radio" aria-checked={!join} className={!join ? "selected" : ""} onClick={() => setJoin(false)}>
                        File per part
                      </button>
                    </div>
                    <div className="field">
                      <span className="label">Format</span>
                      <select value={format} onChange={(e) => setFormat(e.target.value)}>
                        <option value="same">Same as input</option>
                        <option value="mp3">MP3</option>
                        <option value="m4a">M4A (AAC)</option>
                        <option value="wav">WAV</option>
                        <option value="flac">FLAC</option>
                      </select>
                    </div>
                    <div className="field">
                      <span className="label">Folder</span>
                      <button className="path-btn" onClick={pickOutputDir} title={outputDir || "Choose output folder"}>
                        <Icon name="folder" size={14} />
                        <span>{outputDir ? fileName(outputDir) : "Next to original"}</span>
                      </button>
                      {outputDir && (
                        <button className="icon-btn" onClick={() => setOutputDir("")} title="Save next to the original">
                          <Icon name="close" size={12} />
                        </button>
                      )}
                    </div>
                    <label
                      className="check"
                      title="Re-encodes so cuts land on the exact sample. Otherwise audio is copied losslessly, but MP3/AAC cuts can be off by about 25 ms. Joining several parts always re-encodes."
                    >
                      <input
                        type="checkbox"
                        checked={precise || forcedPrecise}
                        disabled={forcedPrecise}
                        onChange={(e) => setPrecise(e.target.checked)}
                      />
                      Precise cuts (re-encode)
                    </label>
                  </section>
                </div>
              </>
            )}
          </>
        )}
      </section>

      <footer>
        <div className="status">
          {status?.state === "running" && (
            <span>
              <i className="spinner" /> Exporting…
            </span>
          )}
          {status?.state === "done" && (
            <span className="ok-text">
              Saved {plural(status.outputs.length, "file")}
              <button className="link" onClick={() => revealItemInDir(status.outputs[0])}>
                Show in folder
              </button>
            </span>
          )}
          {status?.state === "error" && <pre className="footer-error">{status.message}</pre>}
          {!status && ready && (
            <span className="dim">
              {E.hasChanges(edit)
                ? `${plural(kept.length, "part")} kept · ${formatTime(keptDuration)} of ${formatTime(duration)}`
                : "Add a cut or select a range to start editing"}
            </span>
          )}
        </div>
        {editedFiles.length > 1 && (
          <button className="secondary" onClick={() => exportMany(editedFiles)} disabled={exporting}>
            Export all edited ({editedFiles.length})
          </button>
        )}
        <button
          className="primary"
          onClick={() => active && exportMany([active])}
          disabled={exporting || !ready || !E.hasChanges(edit) || kept.length === 0}
        >
          {exporting ? "Exporting…" : "Export"}
        </button>
      </footer>

      <audio
        ref={audioRef}
        src={active ? convertFileSrc(active) : undefined}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setPlaybackError(true)}
      />
    </main>
  );
}
