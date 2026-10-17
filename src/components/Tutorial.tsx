import { ReactNode, useEffect, useRef, useState } from "react";
import Icon, { IconName } from "./Icon";

const STORAGE_KEY = "kusanagi.tutorialDismissed";
const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

/** Whether the user asked not to see the tutorial at launch. Storage can be unavailable, so failures mean "not dismissed". */
export function tutorialDismissed() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function setDismissed(dismissed: boolean) {
  try {
    if (dismissed) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not remembered; the tutorial shows again next launch.
  }
}

interface Step {
  icon: IconName;
  title: string;
  body: ReactNode;
  /** `data-tour` value of the element to highlight while this step is shown, if it's on screen. */
  target?: string;
}

const STEPS: Step[] = [
  {
    icon: "wave",
    title: "Welcome to Kusanagi",
    body: <p>A quick tour of cutting, combining and exporting audio. It takes about a minute.</p>,
  },
  {
    icon: "plus",
    title: "Add audio files",
    body: (
      <p>
        Drop files anywhere on the window, or click <strong>+</strong> next to Files. MP3, WAV, FLAC, M4A, OGG and more.
        Each file keeps its own edits and undo history.
      </p>
    ),
    target: "files",
  },
  {
    icon: "cut",
    title: "Cut on the waveform",
    body: (
      <ul>
        <li>Click to move the playhead, <kbd>Space</kbd> to play</li>
        <li>Drag to select a range</li>
        <li>Double-click or press <kbd>C</kbd> to add a cut; drag a marker to adjust it</li>
        <li>
          <kbd>{MOD}</kbd> + scroll to zoom
        </li>
      </ul>
    ),
    target: "waveform",
  },
  {
    icon: "crop",
    title: "Keep what you want",
    body: (
      <p>
        Select a range and press <kbd>⌫</kbd> to remove it, or <kbd>K</kbd> to keep only that range. Removed parts are hatched
        and can be restored from the Parts list. <kbd>{MOD}</kbd> <kbd>Z</kbd> undoes anything.
      </p>
    ),
    target: "parts",
  },
  {
    icon: "folder",
    title: "Export",
    body: (
      <p>
        Pick one joined file or a file per part, the format and the folder, then click <strong>Export</strong>. Your originals
        are never changed and existing files are never overwritten.
      </p>
    ),
    target: "export",
  },
  {
    icon: "layers",
    title: "Combine clips",
    body: (
      <p>
        Join several files into one, each used whole or with its edits, with an optional fade, crossfade or gap between them.
      </p>
    ),
    target: "combine",
  },
  {
    icon: "spark",
    title: "Let an AI agent help",
    body: (
      <p>
        Kusanagi has a built-in MCP server. Copy the Claude Code command from this panel, then ask things like
        <em> “remove the long silences from podcast.mp3”</em>. Every edit shows up live and can be undone.
      </p>
    ),
    target: "agents",
  },
];

export default function Tutorial({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [dontShow, setDontShow] = useState(tutorialDismissed);
  const nextRef = useRef<HTMLButtonElement>(null);
  const current = STEPS[step];
  const last = step === STEPS.length - 1;

  const close = () => {
    setDismissed(dontShow);
    onClose();
  };
  const go = (by: number) => {
    if (by > 0 && last) return close();
    setStep((s) => Math.min(Math.max(s + by, 0), STEPS.length - 1));
  };

  // Highlight the part of the app this step talks about, when it's on screen.
  useEffect(() => {
    const el = current.target && document.querySelector(`[data-tour="${current.target}"]`);
    if (!el) return;
    el.classList.add("tour-target");
    return () => el.classList.remove("tour-target");
  }, [current]);

  useEffect(() => nextRef.current?.focus(), [step]);

  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowLeft") go(-1);
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="tour-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
        <div className="tour-icon">
          <Icon name={current.icon} size={22} />
        </div>
        <div className="tour-text">
          <span className="tour-count">
            {step + 1} of {STEPS.length}
          </span>
          <h1 id="tour-title">{current.title}</h1>
          <div className="tour-body">{current.body}</div>
        </div>
        <div className="tour-dots" aria-hidden>
          {STEPS.map((_, i) => (
            <button key={i} className={i === step ? "on" : ""} tabIndex={-1} onClick={() => setStep(i)} />
          ))}
        </div>
        <div className="tour-actions">
          <label className="check">
            <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
            Don't show at startup
          </label>
          <div className="spacer" />
          {step === 0 ? (
            <button className="ghost" onClick={close}>
              Skip
            </button>
          ) : (
            <button className="secondary" onClick={() => go(-1)}>
              Back
            </button>
          )}
          <button ref={nextRef} className="primary tour-next" onClick={() => go(1)}>
            {last ? "Get started" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
