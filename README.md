# Audio Trimmer

Desktop app (Tauri + React) for splitting, extracting and removing parts of audio files, using a bundled FFmpeg.

## Download

Grab the latest build from [Releases](../../releases) (or the artifacts of the latest [Build](../../actions/workflows/build.yml) run).

- **Windows**: run the `.exe` installer. If SmartScreen warns, click *More info → Run anyway*.
- **macOS (Apple Silicon)**: open the `.dmg` and drag the app to Applications. The app isn't notarized, so the first time
  macOS may refuse to open it. Right-click → *Open*, or run `xattr -dr com.apple.quarantine "/Applications/Audio Trimmer.app"`.

FFmpeg is bundled inside the app; nothing else needs installing.

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

Every push to `main` builds the Windows and macOS apps in GitHub Actions. Pushing a tag such as `v0.2.0` also creates a
draft GitHub Release with the installers attached.

## Third-party software

The app bundles an unmodified build of [FFmpeg](https://ffmpeg.org), licensed under the GPL. The builds come from
[martin-riedl.de](https://ffmpeg.martin-riedl.de) (macOS) and [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) (Windows);
FFmpeg source code is available at <https://ffmpeg.org/download.html>.
