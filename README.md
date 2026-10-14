# Audio Trimmer

Desktop app (Tauri + React) for splitting, extracting and removing parts of audio files, using a bundled FFmpeg.

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
