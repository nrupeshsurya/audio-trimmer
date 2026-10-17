/**
 * Combining clips: an ordered list of files, each used whole or with its edits applied,
 * joined into one new file with a transition between clips.
 */
import * as E from "./edit";

export type TransitionKind = "none" | "fade" | "crossfade" | "gap";

export interface Transition {
  kind: TransitionKind;
  seconds: number;
}

export interface CombineClip {
  id: number;
  path: string;
  /** Use only the file's kept parts; otherwise the whole file. */
  useEdits: boolean;
}

/** One clip as the Rust `combine_files` command expects it (trim::Clip). */
export interface ClipSpec {
  input: string;
  segments: E.Segment[];
  duration: number;
}

export const TRANSITIONS: { kind: TransitionKind; label: string; hint: string }[] = [
  { kind: "none", label: "None", hint: "Clips play back to back." },
  { kind: "fade", label: "Fade", hint: "Each clip fades out, then the next fades in." },
  { kind: "crossfade", label: "Crossfade", hint: "Clips overlap, one fading into the next." },
  { kind: "gap", label: "Gap", hint: "Silence between clips." },
];

/** Must match trim::MAX_TRANSITION in Rust. */
export const MAX_TRANSITION = 60;

let nextId = 1;
export const newClip = (path: string, useEdits: boolean): CombineClip => ({ id: nextId++, path, useEdits });

export const clipSpec = (path: string, edit: E.Edit, duration: number, useEdits: boolean): ClipSpec => ({
  input: path,
  segments: useEdits ? E.keptSegments(edit, duration, true) : [{ start: 0, end: null }],
  duration,
});

export const clipLength = (clip: ClipSpec) => clip.segments.reduce((sum, s) => sum + (s.end ?? clip.duration) - s.start, 0);

export function combinedLength(lengths: number[], t: Transition) {
  const total = lengths.reduce((sum, len) => sum + len, 0);
  const joins = Math.max(lengths.length - 1, 0);
  if (t.kind === "crossfade") return total - joins * t.seconds;
  if (t.kind === "gap") return total + joins * t.seconds;
  return total;
}

/** Why a transition can't join clips of these lengths, or null. Mirrors trim::plan_combine. */
export function transitionProblem(lengths: number[], t: Transition): string | null {
  if (t.kind === "none") return null;
  if (!(t.seconds > 0 && t.seconds <= MAX_TRANSITION)) return `Transition length must be more than 0 and at most ${MAX_TRANSITION} s`;
  if (t.kind === "gap") return null;
  const last = lengths.length - 1;
  const short = lengths.findIndex((len, k) => (Number(k > 0) + Number(k < last)) * t.seconds > len);
  return short < 0 ? null : `Clip ${short + 1} is too short for a ${t.seconds} s ${t.kind}`;
}

/** The transition as serde expects trim::Transition. */
export const wireTransition = (t: Transition) => (t.kind === "none" ? { kind: "none" } : t);
