# Kusanagi

Desktop audio cutter (Tauri 2 + React/TypeScript + Rust) with a waveform editor and a built-in MCP server so AI
agents can drive it. FFmpeg is bundled as a Tauri sidecar. Targets: Windows x64 and macOS Apple Silicon.
Open work is tracked in GitHub issues (this repo, plus the owner's private planning repo), not here.

## Commands

```sh
./scripts/fetch-ffmpeg.sh            # once after cloning: downloads FFmpeg into src-tauri/binaries/ (git-ignored)
npm run tauri dev                    # run the app with hot reload
npx tsc --noEmit                     # typecheck the frontend
cd src-tauri && cargo test --lib     # Rust unit tests
cd src-tauri && cargo test --lib -- --include-ignored   # + end-to-end test against the real FFmpeg binary
python3 scripts/mcp_smoke_test.py --ffmpeg src-tauri/binaries/ffmpeg-aarch64-apple-darwin   # drive a running app over MCP
npm run tauri build -- --bundles dmg # local release build (macOS)
```

## Architecture

- **Edit model** (`src/lib/edit.ts`): cut points divide a file into parts; each part is kept or removed. All edit
  operations are pure and return the same object when nothing changes. Export sends kept segments to Rust.
- **UI** (`src/App.tsx`, `src/components/`): file sidebar, toolbar, canvas `Waveform` (owns zoom/scroll), parts list,
  export panel. Per-file undo history lives in `App` state. `<audio>` plays files via Tauri's asset protocol.
- **Rust** (`src-tauri/src/`):
  - `trim.rs`: pure, unit-tested logic. Waveform peak reduction (`PeakAccumulator`), `plan()` turning an
    `ExportRequest` into FFmpeg args (stream copy vs re-encode, `atrim`+`concat` with 5 ms fades for joins), and
    loudness analysis parsing for agents.
  - `lib.rs`: Tauri commands (`load_waveform` returns raw bytes: u32 sample count + 1 peak byte per 10 ms at 8 kHz;
    `export_file`; `agent_respond`; `agent_status`). FFmpeg always runs via the `ffmpeg` sidecar.
  - `agent.rs`: MCP server (`rmcp`, Streamable HTTP) on `127.0.0.1:39231/mcp`. Editing tools are forwarded to the
    webview as `agent-request` events and answered via `agent_respond`, so agent edits go through the UI's undo
    history and show up live. `analyze_audio` runs FFmpeg in Rust. Browser `Origin`s are rejected.
- **Agent tool handlers** (`src/lib/agent.ts`): execute forwarded MCP calls against editor state; validate inputs and
  return agent-readable errors.

## Conventions

- UI work: follow the `frontend-design` skill (`.claude/skills/frontend-design/SKILL.md`): dark theme only, every
  colour is a CSS variable in `:root` of `src/App.css`, no hard-coded colours elsewhere.
- Keep FFmpeg-arg building and parsing pure in `trim.rs` with unit tests; keep Tauri/IO glue thin.
- Times are seconds (`f64`/`number`) everywhere; `formatTime`/`parseTime` in `src/lib/time.ts` for display/input.
- When adding an MCP tool: add it in `agent.rs`, handle it in `src/lib/agent.ts`, document it in the README table,
  and extend `scripts/mcp_smoke_test.py` if it's on the core path.

## CI and releases (`.github/workflows/build.yml`)

- Every push to `main`: build (macOS dmg, Windows NSIS exe) → install each on a fresh runner, launch it, run
  `scripts/mcp_smoke_test.py` against it, screenshot the desktop (artifacts `smoke-test-*`).
- Release: bump `version` in `src-tauri/tauri.conf.json`, commit, `git tag vX.Y.Z && git push origin main vX.Y.Z`.
  The tag must match the config version. The release (`Kusanagi-X.Y.Z-Windows-Setup.exe`, `Kusanagi-X.Y.Z-macOS.dmg`)
  is published only if both smoke tests pass.

## Gotchas

- The bundled FFmpeg builds are GPL (see "Third-party software" in the README).
- Builds are unsigned: macOS users right-click → Open; Windows shows SmartScreen.
- Bundle identifier is `com.nrupesh.kusanagi`; changing it makes OSes treat the app as a new one.
- The MCP port 39231 is fixed; if it's taken the sidebar panel shows the error instead of the URL.
- Edition 2024 Rust: `gen` is a reserved keyword.
- Headless Chrome previews (stubbing `window.__TAURI_INTERNALS__`) are handy for checking UI without the native
  window; macOS may block screenshots of the real window without Screen Recording permission.
