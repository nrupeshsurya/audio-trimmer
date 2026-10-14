//! Pure logic: waveform peak reduction and turning an edit into ffmpeg invocations.
//! Nothing here touches the filesystem except checking for existing output names.

use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Sample rate the waveform is decoded at, and how many peaks per second we keep.
pub const WAVEFORM_RATE: usize = 8000;
pub const PEAKS_PER_SEC: usize = 100;

/// Fade applied at each join so concatenated parts don't click.
const JOIN_FADE: f64 = 0.005;

/// A kept part of the input. `end: None` means "to the end of the file".
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct Segment {
    pub start: f64,
    pub end: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub input: String,
    /// Kept parts, in order.
    pub segments: Vec<Segment>,
    /// Join all segments into one file instead of writing one file per segment.
    pub join: bool,
    /// Empty means "next to the input file".
    pub output_dir: String,
    /// "same" or an output extension such as "mp3", "wav", "flac", "m4a".
    pub format: String,
    /// Re-encode for sample-accurate cuts instead of stream copying.
    pub precise: bool,
}

#[derive(Debug)]
pub struct Job {
    pub args: Vec<String>,
    pub output: PathBuf,
}

/// Reduces a stream of mono s16le samples to one peak byte (0-255) per bin.
/// The output starts with the total sample count as a little-endian u32.
pub struct PeakAccumulator {
    per_bin: usize,
    in_bin: usize,
    max: u16,
    samples: u32,
    carry: Option<u8>,
    out: Vec<u8>,
}

impl PeakAccumulator {
    pub fn new() -> Self {
        Self {
            per_bin: WAVEFORM_RATE / PEAKS_PER_SEC,
            in_bin: 0,
            max: 0,
            samples: 0,
            carry: None,
            out: vec![0; 4],
        }
    }

    pub fn push(&mut self, mut bytes: &[u8]) {
        if let Some(lo) = self.carry.take() {
            let Some((&hi, rest)) = bytes.split_first() else {
                self.carry = Some(lo);
                return;
            };
            self.sample(i16::from_le_bytes([lo, hi]));
            bytes = rest;
        }
        let mut pairs = bytes.chunks_exact(2);
        for pair in &mut pairs {
            self.sample(i16::from_le_bytes([pair[0], pair[1]]));
        }
        self.carry = pairs.remainder().first().copied();
    }

    fn sample(&mut self, s: i16) {
        self.max = self.max.max(s.unsigned_abs());
        self.samples += 1;
        self.in_bin += 1;
        if self.in_bin == self.per_bin {
            self.flush_bin();
        }
    }

    fn flush_bin(&mut self) {
        self.out.push((self.max >> 7).min(255) as u8);
        self.max = 0;
        self.in_bin = 0;
    }

    pub fn finish(mut self) -> Vec<u8> {
        if self.in_bin > 0 {
            self.flush_bin();
        }
        self.out[..4].copy_from_slice(&self.samples.to_le_bytes());
        self.out
    }
}

pub fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

fn codec_args(ext: &str, copy: bool) -> Vec<&'static str> {
    match (copy, ext) {
        (true, _) => vec!["-c:a", "copy"],
        (false, "mp3") => vec!["-c:a", "libmp3lame", "-q:a", "2"],
        (false, "m4a" | "aac") => vec!["-c:a", "aac", "-b:a", "192k"],
        // Let ffmpeg pick the default encoder for the container (wav -> pcm, flac -> flac, ...).
        (false, _) => vec![],
    }
}

fn unique_path(dir: &Path, name: &str, ext: &str, taken: &mut HashSet<PathBuf>) -> PathBuf {
    let mut path = dir.join(format!("{name}.{ext}"));
    let mut n = 1;
    while path.exists() || taken.contains(&path) {
        path = dir.join(format!("{name} ({n}).{ext}"));
        n += 1;
    }
    taken.insert(path.clone());
    path
}

pub fn plan(req: &ExportRequest) -> Result<Vec<Job>, String> {
    if req.segments.is_empty() {
        return Err("Nothing to export: every part is removed".into());
    }
    for (i, s) in req.segments.iter().enumerate() {
        let bad_end = s.end.is_some_and(|e| e <= s.start);
        let not_last_open = s.end.is_none() && i + 1 != req.segments.len();
        if s.start < 0.0 || !s.start.is_finite() || bad_end || not_last_open {
            return Err(format!("Invalid part {}", i + 1));
        }
    }

    let input = Path::new(&req.input);
    let stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or("Input has no file name")?;
    let in_ext = input
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let ext = if req.format == "same" {
        if in_ext.is_empty() {
            return Err("Input has no extension; pick an output format".into());
        }
        in_ext.clone()
    } else {
        req.format.to_lowercase()
    };
    let out_dir = if req.output_dir.is_empty() {
        input.parent().ok_or("Input has no parent folder")?.to_path_buf()
    } else {
        PathBuf::from(&req.output_dir)
    };
    let mut taken = HashSet::new();
    let base_args = || -> Vec<String> { vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()] };

    if req.join && req.segments.len() > 1 {
        let last = req.segments.len() - 1;
        let mut filter = String::new();
        let mut labels = String::new();
        for (i, s) in req.segments.iter().enumerate() {
            let end = s.end.map(|e| format!(":end={e:.3}")).unwrap_or_default();
            filter += &format!("[0:a]atrim=start={:.3}{end},asetpts=PTS-STARTPTS", s.start);
            if i > 0 {
                filter += &format!(",afade=t=in:d={JOIN_FADE}");
            }
            if let (true, Some(e)) = (i < last, s.end) {
                if e - s.start > 2.0 * JOIN_FADE {
                    filter += &format!(",afade=t=out:st={:.3}:d={JOIN_FADE}", e - s.start - JOIN_FADE);
                }
            }
            filter += &format!("[a{i}];");
            labels += &format!("[a{i}]");
        }
        filter += &format!("{labels}concat=n={}:v=0:a=1[out]", req.segments.len());

        let output = unique_path(&out_dir, &format!("{stem}_edited"), &ext, &mut taken);
        let mut args = base_args();
        args.extend(["-i".into(), req.input.clone(), "-filter_complex".into(), filter]);
        args.extend(["-map".into(), "[out]".into(), "-map_metadata".into(), "0".into()]);
        args.extend(codec_args(&ext, false).into_iter().map(String::from));
        args.push(output.to_string_lossy().into_owned());
        return Ok(vec![Job { args, output }]);
    }

    let copy = !req.precise && ext == in_ext;
    let single = req.segments.len() == 1;
    let width = req.segments.len().to_string().len().max(2);
    Ok(req
        .segments
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let name = if single {
                format!("{stem}_edited")
            } else {
                format!("{stem}_part{:0width$}", i + 1)
            };
            let output = unique_path(&out_dir, &name, &ext, &mut taken);
            let mut args = base_args();
            if s.start > 0.0 {
                args.extend(["-ss".into(), format!("{:.3}", s.start)]);
            }
            if let Some(end) = s.end {
                args.extend(["-to".into(), format!("{end:.3}")]);
            }
            args.extend(["-i".into(), req.input.clone()]);
            args.extend(["-map".into(), "0:a".into(), "-map_metadata".into(), "0".into()]);
            args.extend(codec_args(&ext, copy).into_iter().map(String::from));
            args.push(output.to_string_lossy().into_owned());
            Job { args, output }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f64, end: Option<f64>) -> Segment {
        Segment { start, end }
    }

    fn req(segments: Vec<Segment>, join: bool) -> ExportRequest {
        ExportRequest {
            input: "/nonexistent/dir/song.mp3".into(),
            segments,
            join,
            output_dir: String::new(),
            format: "same".into(),
            precise: false,
        }
    }

    fn has(args: &[String], pair: [&str; 2]) -> bool {
        args.windows(2).any(|w| w == pair)
    }

    #[test]
    fn peaks_handle_odd_chunk_boundaries() {
        let samples: Vec<i16> = (0..250).map(|i| if i == 100 { -32768 } else { 256 }).collect();
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut acc = PeakAccumulator::new();
        for chunk in bytes.chunks(7) {
            acc.push(chunk);
        }
        let out = acc.finish();
        assert_eq!(u32::from_le_bytes(out[..4].try_into().unwrap()), 250);
        // 80 samples per bin -> 4 bins (last one partial); the loud sample is in bin 1.
        assert_eq!(&out[4..], &[2, 255, 2, 2]);
    }

    #[test]
    fn separate_parts_get_numbered_files() {
        let r = req(vec![seg(0.0, Some(60.0)), seg(60.0, Some(120.0)), seg(120.0, None)], false);
        let jobs = plan(&r).unwrap();
        assert_eq!(jobs.len(), 3);
        assert!(jobs[0].output.ends_with("song_part01.mp3"));
        assert!(has(&jobs[0].args, ["-to", "60.000"]));
        assert!(!jobs[0].args.contains(&"-ss".to_string()));
        assert!(has(&jobs[1].args, ["-ss", "60.000"]));
        assert!(!jobs[2].args.contains(&"-to".to_string()));
        assert!(has(&jobs[2].args, ["-c:a", "copy"]));
    }

    #[test]
    fn single_part_is_named_edited() {
        let jobs = plan(&req(vec![seg(5.0, Some(10.0))], true)).unwrap();
        assert_eq!(jobs.len(), 1);
        assert!(jobs[0].output.ends_with("song_edited.mp3"));
        assert!(has(&jobs[0].args, ["-c:a", "copy"]));
    }

    #[test]
    fn precise_or_format_change_reencodes() {
        let mut r = req(vec![seg(10.0, Some(20.0))], false);
        r.precise = true;
        assert!(plan(&r).unwrap()[0].args.contains(&"libmp3lame".to_string()));

        let mut r = req(vec![seg(10.0, Some(20.0))], false);
        r.format = "wav".into();
        let jobs = plan(&r).unwrap();
        assert!(jobs[0].output.ends_with("song_edited.wav"));
        assert!(!jobs[0].args.contains(&"copy".to_string()));
    }

    #[test]
    fn join_concats_with_fades() {
        let jobs = plan(&req(vec![seg(5.0, Some(60.0)), seg(120.0, None)], true)).unwrap();
        assert_eq!(jobs.len(), 1);
        let args = &jobs[0].args;
        let filter = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert_eq!(
            filter,
            "[0:a]atrim=start=5.000:end=60.000,asetpts=PTS-STARTPTS,afade=t=out:st=54.995:d=0.005[a0];\
             [0:a]atrim=start=120.000,asetpts=PTS-STARTPTS,afade=t=in:d=0.005[a1];\
             [a0][a1]concat=n=2:v=0:a=1[out]"
        );
        assert!(jobs[0].output.ends_with("song_edited.mp3"));
    }

    #[test]
    fn rejects_bad_segments() {
        assert!(plan(&req(vec![], true)).is_err());
        assert!(plan(&req(vec![seg(10.0, Some(5.0))], true)).is_err());
        assert!(plan(&req(vec![seg(0.0, None), seg(10.0, Some(20.0))], false)).is_err());
    }

    /// Runs the planned commands with the real sidecar binary.
    /// `cargo test -- --ignored` (needs scripts/fetch-ffmpeg.sh to have run).
    #[test]
    #[ignore]
    fn end_to_end_with_real_ffmpeg() {
        use std::process::Command;
        let bin_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let ffmpeg = std::fs::read_dir(&bin_dir)
            .expect("run scripts/fetch-ffmpeg.sh first")
            .map(|e| e.unwrap().path())
            .find(|p| p.file_name().unwrap().to_string_lossy().starts_with("ffmpeg-"))
            .expect("no ffmpeg sidecar found");
        let run = |args: &[String]| Command::new(&ffmpeg).args(args).output().unwrap();
        // Decodes like the app's waveform loader and returns the exact duration.
        let duration_of = |path: &Path| {
            let args = ["-v", "error", "-i", &path.to_string_lossy(), "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"];
            let out = run(&args.map(String::from));
            assert!(out.status.success());
            let mut acc = PeakAccumulator::new();
            acc.push(&out.stdout);
            let peaks = acc.finish();
            u32::from_le_bytes(peaks[..4].try_into().unwrap()) as f64 / WAVEFORM_RATE as f64
        };

        let dir = std::env::temp_dir().join(format!("audiotrimmer-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("tone.wav");
        let make_tone = ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=10"];
        let mut make_tone: Vec<String> = make_tone.map(String::from).to_vec();
        make_tone.push(input.to_string_lossy().into());
        assert!(run(&make_tone).status.success());
        assert!((duration_of(&input) - 10.0).abs() < 0.001);

        let cases = [
            (vec![seg(0.0, Some(2.5)), seg(2.5, Some(6.0)), seg(6.0, None)], false, "same", vec![2.5, 3.5, 4.0]),
            (vec![seg(1.0, Some(2.5)), seg(8.0, None)], false, "mp3", vec![1.5, 2.0]),
            (vec![seg(1.0, Some(4.0)), seg(6.0, None)], true, "flac", vec![7.0]),
        ];
        for (segments, join, format, expected) in cases {
            let mut r = req(segments, join);
            r.input = input.to_string_lossy().into();
            r.format = format.into();
            let jobs = plan(&r).unwrap();
            assert_eq!(jobs.len(), expected.len());
            for (job, want) in jobs.iter().zip(expected) {
                let out = run(&job.args);
                assert!(out.status.success(), "{}", tail(&String::from_utf8_lossy(&out.stderr), 5));
                let got = duration_of(&job.output);
                // mp3 adds encoder padding of a frame or two.
                assert!((got - want).abs() < 0.06, "{} is {got}s, want {want}s", job.output.display());
            }
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
