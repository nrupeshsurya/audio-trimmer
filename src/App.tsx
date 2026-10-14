import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import "./App.css";

type Mode = "split" | "extract" | "remove";

type FileStatus =
  | { state: "pending" }
  | { state: "running" }
  | { state: "done"; outputs: string[] }
  | { state: "error"; message: string };

const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "wma", "aiff", "aif"];

const MODES: Record<Mode, { label: string; help: string; placeholder: string }> = {
  split: {
    label: "Split at points",
    help: "One cut point per line. N cuts give N+1 files.",
    placeholder: "1:30\n3:45\n10:00",
  },
  extract: {
    label: "Extract ranges",
    help: "One range per line; each becomes its own file. Use \"end\" for the end of the file.",
    placeholder: "0:10 - 0:45\n1:20 - 2:00\n5:00 - end",
  },
  remove: {
    label: "Remove ranges",
    help: "Ranges to delete. Everything else is joined into one file.",
    placeholder: "0:00 - 0:05\n12:00 - 13:30",
  },
};

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export default function App() {
  const [files, setFiles] = useState<string[]>([]);
  const [status, setStatus] = useState<Record<string, FileStatus>>({});
  const [mode, setMode] = useState<Mode>("split");
  const [cuts, setCuts] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [format, setFormat] = useState("same");
  const [precise, setPrecise] = useState(false);
  const [running, setRunning] = useState(false);
  const [dragging, setDragging] = useState(false);

  const addFiles = (paths: string[]) =>
    setFiles((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))]);

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "over" || payload.type === "enter") setDragging(true);
      else setDragging(false);
      if (payload.type === "drop") addFiles(payload.paths);
    });
    return () => void unlisten.then((fn) => fn());
  }, []);

  const pickFiles = async () => {
    const picked = await open({
      multiple: true,
      filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
    });
    if (picked) addFiles(picked);
  };

  const pickOutputDir = async () => {
    const dir = await open({ directory: true });
    if (dir) setOutputDir(dir);
  };

  const removeFile = (path: string) => setFiles((prev) => prev.filter((p) => p !== path));

  const run = async () => {
    setRunning(true);
    setStatus(Object.fromEntries(files.map((f) => [f, { state: "pending" }])));
    for (const input of files) {
      setStatus((s) => ({ ...s, [input]: { state: "running" } }));
      try {
        const outputs = await invoke<string[]>("trim_file", {
          req: { input, mode, cuts, outputDir, format, precise },
        });
        setStatus((s) => ({ ...s, [input]: { state: "done", outputs } }));
      } catch (e) {
        setStatus((s) => ({ ...s, [input]: { state: "error", message: String(e) } }));
      }
    }
    setRunning(false);
  };

  const doneCount = Object.values(status).filter((st) => st.state === "done").length;
  const failCount = Object.values(status).filter((st) => st.state === "error").length;

  return (
    <main className={dragging ? "dragging" : ""}>
      <header>
        <h1>Audio Trimmer</h1>
        <p>Split, extract or remove parts of audio files.</p>
      </header>

      <div className="steps">
        <section className="card">
          <div className="card-head">
            <span className="step">1</span>
            <h2>Files</h2>
            <div className="spacer" />
            {files.length > 0 && (
              <button className="ghost" onClick={() => { setFiles([]); setStatus({}); }} disabled={running}>
                Clear
              </button>
            )}
            <button className="secondary" onClick={pickFiles} disabled={running}>Add files…</button>
          </div>
          {files.length === 0 ? (
            <button className="dropzone" onClick={pickFiles}>
              <strong>Drop audio files here</strong>
              <span>or click to choose · MP3, WAV, FLAC, M4A, OGG…</span>
            </button>
          ) : (
            <ul className="files">
              {files.map((f) => {
                const st = status[f];
                return (
                  <li key={f}>
                    <div className="row">
                      <span className="name" title={f}>{fileName(f)}</span>
                      <div className="spacer" />
                      {st?.state === "pending" && <span className="pill">Queued</span>}
                      {st?.state === "running" && <span className="pill accent"><i className="spinner" />Working</span>}
                      {st?.state === "done" && (
                        <>
                          <span className="pill ok">{st.outputs.length} file{st.outputs.length === 1 ? "" : "s"}</span>
                          <button className="ghost" onClick={() => revealItemInDir(st.outputs[0])}>Show</button>
                        </>
                      )}
                      {st?.state === "error" && <span className="pill err">Failed</span>}
                      {!running && (
                        <button className="icon" onClick={() => removeFile(f)} aria-label={`Remove ${fileName(f)}`}>✕</button>
                      )}
                    </div>
                    {st?.state === "error" && <pre className="error">{st.message}</pre>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <span className="step">2</span>
            <h2>Cuts</h2>
          </div>
          <div className="segmented" role="radiogroup">
            {(Object.keys(MODES) as Mode[]).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={mode === m}
                className={mode === m ? "selected" : ""}
                onClick={() => setMode(m)}
              >
                {MODES[m].label}
              </button>
            ))}
          </div>
          <textarea
            rows={4}
            value={cuts}
            placeholder={MODES[mode].placeholder}
            onChange={(e) => setCuts(e.target.value)}
            spellCheck={false}
          />
          <p className="hint">
            {MODES[mode].help} Times can be <code>90</code>, <code>1:30</code> or <code>1:02:03.5</code>.
            {files.length > 1 && " The same cuts are applied to every file."}
          </p>
        </section>

        <section className="card">
          <div className="card-head">
            <span className="step">3</span>
            <h2>Output</h2>
          </div>
          <div className="field">
            <span className="label">Folder</span>
            <span className={`path ${outputDir ? "" : "muted"}`} title={outputDir}>
              {outputDir || "Same folder as each input file"}
            </span>
            {outputDir && <button className="ghost" onClick={() => setOutputDir("")}>Reset</button>}
            <button className="secondary" onClick={pickOutputDir}>Choose…</button>
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
            <div className="spacer" />
            <label
              className="check"
              title="Re-encodes so cuts land on the exact sample. Fast mode copies audio losslessly, but MP3/AAC cuts can be off by about 25 ms."
            >
              <input
                type="checkbox"
                checked={precise || mode === "remove"}
                disabled={mode === "remove"}
                onChange={(e) => setPrecise(e.target.checked)}
              />
              Precise cuts (re-encode)
            </label>
          </div>
        </section>
      </div>

      <footer>
        <span className="summary">
          {running
            ? `Processing ${doneCount + failCount + 1} of ${files.length}…`
            : doneCount + failCount > 0
              ? `${doneCount} done${failCount ? `, ${failCount} failed` : ""}`
              : files.length
                ? `${files.length} file${files.length === 1 ? "" : "s"} ready`
                : "Add files to get started"}
        </span>
        <button className="primary" onClick={run} disabled={running || !files.length || !cuts.trim()}>
          {running ? "Working…" : "Trim"}
        </button>
      </footer>
    </main>
  );
}
