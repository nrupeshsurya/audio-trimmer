import Icon from "./Icon";
import OutputFields from "./OutputFields";
import * as C from "../lib/combine";
import { formatTime } from "../lib/time";

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** A clip's state as the panel shows it: its length once loaded, and whether it has edits to use. */
export type ClipInfo =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; length: number; hasEdits: boolean };

export default function CombinePanel(props: {
  clips: C.CombineClip[];
  info: (clip: C.CombineClip) => ClipInfo;
  onClips: (clips: C.CombineClip[]) => void;
  /** Files open in the app, offered as clips. */
  files: string[];
  onAdd: (paths: string[]) => void;
  onChooseFiles: () => void;
  transition: C.Transition;
  onTransition: (t: C.Transition) => void;
  totalLength: number | null;
  format: string;
  onFormat: (format: string) => void;
  outputDir: string;
  onPickDir: () => void;
  onClearDir: () => void;
}) {
  const { clips, transition } = props;
  const move = (i: number, by: number) => {
    const next = [...clips];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    props.onClips(next);
  };
  const update = (id: number, change: Partial<C.CombineClip>) =>
    props.onClips(clips.map((c) => (c.id === id ? { ...c, ...change } : c)));
  const hint = C.TRANSITIONS.find((t) => t.kind === transition.kind)?.hint;

  return (
    <>
      <header className="file-header">
        <div className="file-title">
          <h1>Combine clips</h1>
          <p className="subtitle">Join clips end to end into one new file. Edit a file first to use only part of it.</p>
        </div>
      </header>

      <div className="panels">
        <section className="card">
          <div className="card-head">
            <h2>Clips</h2>
            <span className="card-sub">
              {clips.length} {clips.length === 1 ? "clip" : "clips"}
              {props.totalLength !== null && clips.length > 0 && ` · ${formatTime(props.totalLength)}`}
            </span>
          </div>

          {clips.length === 0 ? (
            <p className="clips-empty">Add open files below, or choose files to combine.</p>
          ) : (
            <ol className="clips">
              {clips.map((clip, i) => {
                const info = props.info(clip);
                const edited = info.state === "ready" && info.hasEdits && clip.useEdits;
                return (
                  <li key={clip.id} className="clip" title={clip.path}>
                    <span className="part-no">{i + 1}</span>
                    <span className="clip-name">{fileName(clip.path)}</span>
                    <div className="segmented small" role="radiogroup" title="Use the whole file, or only its kept parts">
                      <button role="radio" aria-checked={!edited} className={!edited ? "selected" : ""} onClick={() => update(clip.id, { useEdits: false })}>
                        Whole
                      </button>
                      <button
                        role="radio"
                        aria-checked={edited}
                        className={edited ? "selected" : ""}
                        disabled={info.state !== "ready" || !info.hasEdits}
                        title={info.state === "ready" && !info.hasEdits ? "This file has no edits" : undefined}
                        onClick={() => update(clip.id, { useEdits: true })}
                      >
                        Edited
                      </button>
                    </div>
                    <span className="part-len">
                      {info.state === "loading" && "Loading…"}
                      {info.state === "error" && <span className="err-text">Can't read</span>}
                      {info.state === "ready" && formatTime(info.length)}
                    </span>
                    <div className="clip-actions">
                      <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                        <Icon name="up" size={14} />
                      </button>
                      <button className="icon-btn" title="Move down" disabled={i === clips.length - 1} onClick={() => move(i, 1)}>
                        <Icon name="down" size={14} />
                      </button>
                      <button className="icon-btn danger" title="Remove clip" onClick={() => props.onClips(clips.filter((c) => c.id !== clip.id))}>
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="clip-add">
            <select
              value=""
              onChange={(e) => e.target.value && props.onAdd([e.target.value])}
              disabled={props.files.length === 0}
              title="Add a file that's open in the sidebar"
            >
              <option value="">{props.files.length ? "Add an open file…" : "No open files"}</option>
              {props.files.map((f) => (
                <option key={f} value={f}>
                  {fileName(f)}
                </option>
              ))}
            </select>
            <button className="secondary" onClick={() => props.onAdd(props.files)} disabled={props.files.length === 0}>
              Add all open
            </button>
            <button className="secondary" onClick={props.onChooseFiles}>
              Choose files…
            </button>
          </div>
        </section>

        <section className="card export-card">
          <div className="card-head">
            <h2>Join</h2>
          </div>
          <div className="segmented" role="radiogroup">
            {C.TRANSITIONS.map((t) => (
              <button
                key={t.kind}
                role="radio"
                aria-checked={transition.kind === t.kind}
                className={transition.kind === t.kind ? "selected" : ""}
                onClick={() => props.onTransition({ ...transition, kind: t.kind })}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="card-note">{hint}</p>
          {transition.kind !== "none" && (
            <div className="field">
              <span className="label">Length</span>
              <input
                className="num-input"
                type="number"
                min={0.1}
                max={C.MAX_TRANSITION}
                step="any"
                value={transition.seconds}
                onChange={(e) => props.onTransition({ ...transition, seconds: e.target.valueAsNumber })}
              />
              <span className="dim">seconds</span>
            </div>
          )}
          <OutputFields
            format={props.format}
            onFormat={props.onFormat}
            outputDir={props.outputDir}
            onPickDir={props.onPickDir}
            onClearDir={props.onClearDir}
            source="first clip"
          />
        </section>
      </div>
    </>
  );
}
