---
name: frontend-design
description: Design rules for this app's UI (Tauri + React desktop app). Use before writing or changing any CSS, layout, component markup, colours, or styling in src/.
---

# Frontend design rules

This is a desktop utility. It should feel like a calm, focused native tool, not a web page.

## Theme: one theme only
- The app is **dark only**. Do not add `prefers-color-scheme` branches or a light variant.
- Set `color-scheme: dark` on `:root` so native controls (select, checkbox, scrollbars, file dialogs) match.
- The window theme in `src-tauri/tauri.conf.json` is `"Dark"` so the title bar matches.

## Colour tokens: never hard-code colours in rules
All colours live as CSS variables in `:root` in `src/App.css`. Rules reference variables only.
- Surfaces, darkest to lightest: `--bg` (window) → `--surface` (cards) → `--surface-2` (inputs, rows) → `--surface-3` (hover).
- Text: `--text` (primary), `--text-dim` (secondary), `--text-faint` (hints, placeholders).
- `--border` for hairlines; `--border-strong` for focus/hover outlines.
- One accent, `--accent`, for primary action, selection and focus. `--accent-ink` is text on accent.
- Status colours (`--ok`, `--warn`, `--err`) are used as text plus a ~14% tint background (`--ok-bg`, ...). Never use a light pastel badge on a dark surface.
- Use at most one accent hue. Status colours appear only for status.

## Layout & spacing
- 4px grid: use 4, 8, 12, 16, 20, 24, 32.
- Group the flow into numbered steps (1 Files → 2 Cuts → 3 Output) so it reads top to bottom.
- Keep the primary action pinned at the bottom of the window, always visible.
- Radii: 6px controls, 10px cards, 999px pills.

## Typography
- System UI font; 13px base. Section labels: 11px, uppercase, 0.08em tracking, `--text-dim`.
- Monospace (`ui-monospace, SF Mono, Menlo, Consolas`) for timestamps, cut lists and file paths.
- Use `font-variant-numeric: tabular-nums` wherever numbers line up.

## Controls
- Every interactive element has a visible `:hover`, `:focus-visible` (2px accent ring) and `:disabled` state.
- Use segmented controls for mutually exclusive options (≤4); use selects for longer lists.
- Only one solid accent button per screen. Secondary buttons are `--surface-2` with a border; tertiary are text-only.
- Transitions: 120–160ms on colour/background/border only. Nothing bounces.

## Content
- Empty states say what to do ("Drop audio files here").
- Errors are shown inline next to the thing that failed, in monospace, and selectable.
- Labels are sentence case and short.

## Before finishing a UI change
- grep `src/App.css` for hex colours outside `:root`; there should be none.
- Check hover, focus, disabled, empty, running, done and error states all look intentional.
