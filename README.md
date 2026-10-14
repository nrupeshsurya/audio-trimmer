# Audio Trimmer

Desktop app (Tauri + React) for splitting, extracting and removing parts of audio files, using a bundled FFmpeg.

## Download

Grab the latest build from [Releases](../../releases) (or the artifacts of the latest [Build](../../actions/workflows/build.yml) run).

- **Windows**: run the `.exe` installer. If SmartScreen warns, click *More info → Run anyway*.
- **macOS (Apple Silicon)**: open the `.dmg` and drag the app to Applications. The app isn't notarized, so the first time
  macOS may refuse to open it. Right-click → *Open*, or run `xattr -dr com.apple.quarantine "/Applications/Audio Trimmer.app"`.

FFmpeg is bundled inside the app; nothing else needs installing.

## Use with AI agents (MCP)

While the app is open it runs an [MCP](https://modelcontextprotocol.io) server at `http://127.0.0.1:39231/mcp`
(Streamable HTTP, localhost only). Agents edit the same editor you see: their cuts appear live on the waveform and you
can undo them like your own.

**Claude Code**

```sh
claude mcp add --transport http audio-trimmer http://127.0.0.1:39231/mcp
```

(The *Copy Claude Code command* button in the app's sidebar copies this.)

**Claude Desktop, or clients that only support stdio servers**: bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "audio-trimmer": { "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:39231/mcp"] }
  }
}
```

Then ask things like *"Open ~/Downloads/podcast.mp3, remove the long silences and export it as MP3"*.

| Tool | What it does |
|---|---|
| `list_files`, `open_files` | See or open files in the app |
| `analyze_audio` | Loudness timeline, silences and quiet sections (agents can't listen, so this is how they find structure) |
| `get_edit` | Current cuts and parts |
| `add_cuts`, `remove_cut` | Place or delete cut points |
| `remove_range`, `keep_only_range` | Remove a range, or keep only a range |
| `set_part_removed` | Remove or restore one part |
| `undo`, `clear_edits` | Undo the last edit, or start over |
| `export` | Write the kept parts (joined or one file per part); never overwrites |

The server only accepts connections from this machine and rejects requests from web pages, so websites can't drive the app.

## Setup

```sh
npm install
./scripts/fetch-ffmpeg.sh        # downloads FFmpeg into src-tauri/binaries/
npm run tauri dev                # run in development
npm run tauri build              # build the app/installer for this OS
```

## Editing

Open one or more audio files, then edit each on its waveform:

- **Cut**: double-click the waveform or press `C` to cut at the playhead. Cuts divide the file into parts.
- **Remove / keep**: drag to select a range, then press `⌫` to remove it or `K` to keep only it. Each part can also be removed or restored from its chip or the parts list.
- **Adjust**: drag cut markers, nudge the selected one with ←/→, or type exact times in the parts list.
- **Preview**: Space plays and skips removed parts. Cmd/Ctrl + scroll zooms.
- **Export**: kept parts are joined into one file or written as one file per part.

## Tests

```sh
cd src-tauri
cargo test                       # planning/parsing unit tests
cargo test -- --ignored          # end-to-end against the real FFmpeg binary
```

## Releases

Every push to `main` builds the Windows and macOS apps in GitHub Actions, then installs each build on a fresh machine,
launches it, and drives it over MCP with [`scripts/mcp_smoke_test.py`](scripts/mcp_smoke_test.py): it opens a test file,
finds and removes a silence, exports, and checks the output. Screenshots of each run are saved as artifacts.

To release, bump the version in `src-tauri/tauri.conf.json` and push a matching tag (`git tag v0.2.0 && git push --tags`).
The release is published automatically once both platforms pass. You can run the smoke test locally against a running
app too: `python3 scripts/mcp_smoke_test.py --ffmpeg src-tauri/binaries/ffmpeg-<target>`.

## Third-party software

The app bundles an unmodified build of [FFmpeg](https://ffmpeg.org), licensed under the GPL. The builds come from
[martin-riedl.de](https://ffmpeg.martin-riedl.de) (macOS) and [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) (Windows);
FFmpeg source code is available at <https://ffmpeg.org/download.html>.
