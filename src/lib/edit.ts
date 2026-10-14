/**
 * An edit is a sorted list of cut points that divide the file into parts,
 * plus a removed flag per part (`removed.length === cuts.length + 1`).
 * All operations are pure and return the same object when nothing changes.
 */
export interface Edit {
  cuts: number[];
  removed: boolean[];
}

export interface Part {
  index: number;
  start: number;
  end: number;
  removed: boolean;
}

/** A kept range to export; `end: null` means "to the end of the file". */
export interface Segment {
  start: number;
  end: number | null;
}

/** Cuts closer than this to each other or to the file edges are ignored. */
export const MIN_GAP = 0.01;

export const EMPTY_EDIT: Edit = { cuts: [], removed: [false] };

export const hasChanges = (edit: Edit) => edit.cuts.length > 0 || edit.removed.some(Boolean);

export function parts(edit: Edit, duration: number): Part[] {
  const bounds = [0, ...edit.cuts, duration];
  return edit.removed.map((removed, i) => ({ index: i, start: bounds[i], end: bounds[i + 1], removed }));
}

/** Index of the part containing time `t`. */
export function partAt(edit: Edit, t: number): number {
  let i = 0;
  while (i < edit.cuts.length && t >= edit.cuts[i]) i++;
  return i;
}

export function addCut(edit: Edit, t: number, duration: number): Edit {
  if (t < MIN_GAP || t > duration - MIN_GAP) return edit;
  if (edit.cuts.some((c) => Math.abs(c - t) < MIN_GAP)) return edit;
  const i = partAt(edit, t);
  const cuts = [...edit.cuts];
  const removed = [...edit.removed];
  cuts.splice(i, 0, t);
  removed.splice(i, 0, edit.removed[i]);
  return { cuts, removed };
}

/** Removes cut `i`, merging the parts on either side. The merged part is only removed if both were. */
export function removeCut(edit: Edit, i: number): Edit {
  if (i < 0 || i >= edit.cuts.length) return edit;
  const cuts = edit.cuts.filter((_, j) => j !== i);
  const removed = [...edit.removed];
  removed.splice(i, 2, edit.removed[i] && edit.removed[i + 1]);
  return { cuts, removed };
}

/** Moves cut `i` to `t`, keeping it between its neighbours. */
export function moveCut(edit: Edit, i: number, t: number, duration: number): Edit {
  const lo = (i > 0 ? edit.cuts[i - 1] : 0) + MIN_GAP;
  const hi = (i < edit.cuts.length - 1 ? edit.cuts[i + 1] : duration) - MIN_GAP;
  const clamped = Math.min(Math.max(t, lo), hi);
  if (clamped === edit.cuts[i]) return edit;
  const cuts = [...edit.cuts];
  cuts[i] = clamped;
  return { ...edit, cuts };
}

export function togglePart(edit: Edit, i: number): Edit {
  const removed = [...edit.removed];
  removed[i] = !removed[i];
  return { ...edit, removed };
}

/** Cuts at `start` and `end`, then sets `removed` on parts inside the range and `outside` on the rest. */
function markRange(edit: Edit, start: number, end: number, duration: number, inside: boolean, outside?: boolean): Edit {
  const cut = addCut(addCut(edit, start, duration), end, duration);
  const removed = parts(cut, duration).map((p) =>
    p.start >= start - MIN_GAP && p.end <= end + MIN_GAP ? inside : (outside ?? p.removed),
  );
  return { ...cut, removed };
}

export const removeRange = (edit: Edit, start: number, end: number, duration: number) =>
  markRange(edit, start, end, duration, true);

export const keepOnlyRange = (edit: Edit, start: number, end: number, duration: number) =>
  markRange(edit, start, end, duration, false, true);

/** Kept parts to export. With `merge`, adjacent kept parts become one segment. */
export function keptSegments(edit: Edit, duration: number, merge: boolean): Segment[] {
  const segments: Segment[] = [];
  for (const p of parts(edit, duration)) {
    if (p.removed) continue;
    const end = p.index === edit.cuts.length ? null : p.end;
    const prev = segments[segments.length - 1];
    if (merge && prev && prev.end === p.start) prev.end = end;
    else segments.push({ start: p.start, end });
  }
  return segments;
}
