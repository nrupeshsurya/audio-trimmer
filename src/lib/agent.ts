/**
 * Executes MCP tool calls forwarded from the Rust agent server against the editor state.
 * Edits go through the normal undo history, so the user sees them live and can undo them.
 */
import type { History } from "../App";
import * as E from "./edit";
import * as C from "./combine";
import { formatTime } from "./time";

export interface AgentRequest {
  id: number;
  tool: string;
  args: Record<string, unknown>;
}

interface ExportOptions {
  join: boolean;
  format: string;
  outputDir: string;
  precise: boolean;
}

export interface AgentContext {
  files: () => string[];
  settings: () => ExportOptions;
  history: (path: string) => History;
  setHistory: (path: string, h: History) => void;
  /** Opens files (if needed), focuses the first, and resolves when all have loaded or failed. */
  open: (paths: string[]) => Promise<PromiseSettledResult<{ duration: number }>[]>;
  /** Waits for already-open files to load, without changing what the user is looking at. */
  loaded: (paths: string[]) => Promise<PromiseSettledResult<{ duration: number }>[]>;
  focus: (path: string) => void;
  exportFile: (path: string, edit: E.Edit, duration: number, opts: ExportOptions) => Promise<string[]>;
  /** Shows these clips and transition in the combine view. */
  showCombine: (clips: C.CombineClip[], transition: C.Transition) => void;
  combine: (specs: C.ClipSpec[], transition: C.Transition, opts: { format: string; outputDir: string }) => Promise<string>;
  activity: (text: string) => void;
}

const FORMATS = ["same", "mp3", "m4a", "wav", "flac"];
const round = (t: number) => Math.round(t * 1000) / 1000;
const name = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** A compact, agent-readable view of a file's edit. */
export function describeEdit(file: string, edit: E.Edit, duration: number) {
  const parts = E.parts(edit, duration).map((p) => ({
    index: p.index,
    start: round(p.start),
    end: round(p.end),
    duration: round(p.end - p.start),
    removed: p.removed,
  }));
  const kept = parts.filter((p) => !p.removed);
  return {
    file,
    duration: round(duration),
    cuts: edit.cuts.map(round),
    parts,
    kept_parts: kept.length,
    kept_duration: round(kept.reduce((sum, p) => sum + p.duration, 0)),
  };
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new Error(`"${key}" must be a non-empty string`);
  return v;
}

function num(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`"${key}" must be a number of seconds`);
  return v;
}

export async function handleAgentRequest({ tool, args }: AgentRequest, ctx: AgentContext): Promise<unknown> {
  /** Opens and focuses the file, returning its duration. */
  const ensureOpen = async (file: string) => {
    const [result] = await ctx.open([file]);
    if (result.status === "rejected") throw new Error(`Could not open ${file}: ${String(result.reason?.message ?? result.reason)}`);
    ctx.focus(file);
    return result.value.duration;
  };

  /** Applies an edit with an undo point and returns the new edit. */
  const edit = async (fn: (e: E.Edit, duration: number) => E.Edit, describe: string) => {
    const file = str(args, "file");
    const duration = await ensureOpen(file);
    const h = ctx.history(file);
    const next = fn(h.present, duration);
    if (next !== h.present) ctx.setHistory(file, { past: [...h.past, h.present].slice(-200), present: next, future: [] });
    ctx.activity(describe);
    return describeEdit(file, next, duration);
  };

  const range = (duration: number) => {
    const start = num(args, "start");
    const end = num(args, "end");
    if (start < 0 || end > duration + 0.001 || end <= start) {
      throw new Error(`Range must satisfy 0 ≤ start < end ≤ ${round(duration)} (the file's duration)`);
    }
    return [start, Math.min(end, duration)] as const;
  };

  switch (tool) {
    case "list_files": {
      const files = ctx.files();
      const results = await ctx.loaded(files);
      return files.map((file, i) => {
        const r = results[i];
        if (r.status === "rejected") return { file, error: String(r.reason?.message ?? r.reason) };
        return describeEdit(file, ctx.history(file).present, r.value.duration);
      });
    }

    case "open_files": {
      const paths = args.paths;
      if (!Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === "string")) {
        throw new Error('"paths" must be a non-empty list of absolute file paths');
      }
      const results = await ctx.open(paths);
      ctx.activity(`Opened ${paths.length === 1 ? name(paths[0]) : `${paths.length} files`}`);
      return paths.map((file, i) => {
        const r = results[i];
        return r.status === "fulfilled"
          ? { file, duration: round(r.value.duration) }
          : { file, error: String(r.reason?.message ?? r.reason) };
      });
    }

    case "get_edit": {
      const file = str(args, "file");
      const duration = await ensureOpen(file);
      return describeEdit(file, ctx.history(file).present, duration);
    }

    case "add_cuts": {
      const times = args.times;
      if (!Array.isArray(times) || !times.every((t) => typeof t === "number" && Number.isFinite(t))) {
        throw new Error('"times" must be a list of numbers (seconds)');
      }
      return edit(
        (e, d) => times.reduce<E.Edit>((acc, t) => E.addCut(acc, t, d), e),
        `Added ${times.length === 1 ? `a cut at ${formatTime(times[0])}` : `${times.length} cuts`}`,
      );
    }

    case "remove_cut": {
      const time = num(args, "time");
      return edit((e) => {
        let best = -1;
        e.cuts.forEach((c, i) => {
          if (Math.abs(c - time) <= 0.1 && (best < 0 || Math.abs(c - time) < Math.abs(e.cuts[best] - time))) best = i;
        });
        if (best < 0) throw new Error(`No cut within 0.1 s of ${time}. Cuts are at: ${e.cuts.map(round).join(", ") || "none"}`);
        return E.removeCut(e, best);
      }, `Deleted the cut at ${formatTime(time)}`);
    }

    case "remove_range":
    case "keep_only_range": {
      const file = str(args, "file");
      const duration = await ensureOpen(file);
      const [start, end] = range(duration);
      const label = `${formatTime(start)}–${formatTime(end)}`;
      return tool === "remove_range"
        ? edit((e, d) => E.removeRange(e, start, end, d), `Removed ${label}`)
        : edit((e, d) => E.keepOnlyRange(e, start, end, d), `Kept only ${label}`);
    }

    case "set_part_removed": {
      const part = num(args, "part");
      const removed = args.removed;
      if (typeof removed !== "boolean") throw new Error('"removed" must be true or false');
      return edit((e) => {
        if (!Number.isInteger(part) || part < 0 || part >= e.removed.length) {
          throw new Error(`"part" must be an index from 0 to ${e.removed.length - 1}`);
        }
        return e.removed[part] === removed ? e : E.togglePart(e, part);
      }, `${removed ? "Removed" : "Restored"} part ${part + 1}`);
    }

    case "undo": {
      const file = str(args, "file");
      const duration = await ensureOpen(file);
      const h = ctx.history(file);
      if (!h.past.length) throw new Error("Nothing to undo");
      ctx.setHistory(file, { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] });
      ctx.activity("Undid the last edit");
      return describeEdit(file, h.past[h.past.length - 1], duration);
    }

    case "clear_edits":
      return edit(() => E.EMPTY_EDIT, "Cleared all edits");

    case "export": {
      const file = str(args, "file");
      const duration = await ensureOpen(file);
      const defaults = ctx.settings();
      const mode = args.mode ?? (defaults.join ? "joined" : "separate");
      if (mode !== "joined" && mode !== "separate") throw new Error('"mode" must be "joined" or "separate"');
      const format = (args.format as string | undefined) ?? defaults.format;
      if (!FORMATS.includes(format)) throw new Error(`"format" must be one of ${FORMATS.join(", ")}`);
      const opts: ExportOptions = {
        join: mode === "joined",
        format,
        outputDir: (args.output_dir as string | undefined) ?? defaults.outputDir,
        precise: (args.precise as boolean | undefined) ?? defaults.precise,
      };
      ctx.activity(`Exporting ${name(file)}…`);
      const outputs = await ctx.exportFile(file, ctx.history(file).present, duration, opts);
      ctx.activity(`Exported ${outputs.length} file${outputs.length === 1 ? "" : "s"}`);
      return { outputs };
    }

    case "combine_files": {
      const files = args.files;
      if (!Array.isArray(files) || files.length < 2 || !files.every((f) => typeof f === "string" && f)) {
        throw new Error('"files" must be a list of at least two absolute file paths, in output order');
      }
      const useEdits = (args.use_edits as boolean | undefined) ?? true;
      const kind = (args.transition as string | undefined) ?? "none";
      if (!C.TRANSITIONS.some((t) => t.kind === kind)) throw new Error(`"transition" must be one of ${C.TRANSITIONS.map((t) => t.kind).join(", ")}`);
      const transition: C.Transition = { kind: kind as C.TransitionKind, seconds: (args.transition_seconds as number | undefined) ?? 1 };
      const defaults = ctx.settings();
      const format = (args.format as string | undefined) ?? defaults.format;
      if (!FORMATS.includes(format)) throw new Error(`"format" must be one of ${FORMATS.join(", ")}`);
      const outputDir = (args.output_dir as string | undefined) ?? defaults.outputDir;

      const results = await ctx.open(files);
      const specs = files.map((file, i) => {
        const r = results[i];
        if (r.status === "rejected") throw new Error(`Could not open ${file}: ${String(r.reason?.message ?? r.reason)}`);
        return C.clipSpec(file, ctx.history(file).present, r.value.duration, useEdits);
      });
      const lengths = specs.map(C.clipLength);
      const empty = lengths.findIndex((len) => len === 0);
      if (empty >= 0) throw new Error(`${files[empty]} has every part removed; restore some or pass use_edits: false`);
      const problem = C.transitionProblem(lengths, transition);
      if (problem) throw new Error(`${problem}. Clip lengths: ${lengths.map(round).join(", ")} s`);

      ctx.showCombine(files.map((f) => C.newClip(f, useEdits)), transition);
      ctx.activity(`Combining ${files.length} clips…`);
      const output = await ctx.combine(specs, transition, { format, outputDir });
      ctx.activity(`Combined ${files.length} clips`);
      return {
        output,
        duration: round(C.combinedLength(lengths, transition)),
        clips: files.map((file, i) => ({ file, duration: round(lengths[i]), edited: useEdits && E.hasChanges(ctx.history(file).present) })),
      };
    }

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
