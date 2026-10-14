# Audio Trimmer

Desktop app (Tauri + React) for splitting, extracting and removing parts of audio files, using a bundled FFmpeg.

## Setup

```sh
npm install
./scripts/fetch-ffmpeg.sh        # downloads FFmpeg into src-tauri/binaries/
npm run tauri dev                # run in development
npm run tauri build              # build the app/installer for this OS
```

## Modes

- **Split at points**: `1:30` per line. N cut points give N+1 files.
- **Extract ranges**: `0:10 - 0:45` per line. Each range becomes its own file; `end` means end of file.
- **Remove ranges**: `0:00 - 0:05` per line. The rest is joined into one file.

Times can be written as `90`, `1:30` or `1:02:03.5`.

## Tests

```sh
cd src-tauri
cargo test                       # planning/parsing unit tests
cargo test -- --ignored          # end-to-end against the real FFmpeg binary
```
