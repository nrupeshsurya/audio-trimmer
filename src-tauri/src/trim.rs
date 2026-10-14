//! Pure logic: waveform peak reduction and turning an edit into ffmpeg invocations.
//! Nothing here touches the filesystem except checking for existing output names.

use serde::{Deserialize, Serialize};
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

/// Loudness profile of a file, built from ffmpeg `astats` + `silencedetect` output.
#[derive(Debug, Serialize, PartialEq)]
pub struct Analysis {
    pub duration: f64,
    pub window_seconds: f64,
    /// RMS level per window in dBFS (silence is reported as -99).
    pub loudness_db: Vec<f64>,
    pub mean_db: f64,
    pub median_db: f64,
    /// Ranges below the silence threshold.
    pub silences: Vec<Range>,
    /// Stretches of at least 2 s that are 1.5 dB+ quieter than the median, e.g. intros,
    /// breakdowns, pauses. Small level differences matter in heavily compressed music.
    pub quiet_sections: Vec<Range>,
}

#[derive(Debug, Serialize, PartialEq, Clone, Copy)]
pub struct Range {
    pub start: f64,
    pub end: f64,
}

/// Most windows we return, so long files don't flood an agent's context.
const MAX_WINDOWS: usize = 1200;
const SILENT_DB: f64 = -99.0;
const QUIET_BELOW_MEDIAN_DB: f64 = 1.5;
const MIN_QUIET_SECONDS: f64 = 2.0;
/// Loudness is smoothed over this span before finding quiet sections, and quiet
/// sections closer together than this are merged, so beat-level wobble doesn't fragment them.
const QUIET_SMOOTHING_SECONDS: f64 = 3.0;

/// Loudness is always measured at this step; the reported timeline is coarsened from it.
const ANALYSIS_STEP: f64 = 0.5;

/// The ffmpeg filter chain whose log output `parse_analysis` understands.
pub fn analysis_filter(silence_db: f64, min_silence: f64) -> String {
    let n = (ANALYSIS_STEP * WAVEFORM_RATE as f64) as usize;
    format!(
        "aresample={WAVEFORM_RATE},silencedetect=n={silence_db}dB:d={min_silence},\
         asetnsamples=n={n}:p=0,astats=metadata=1:reset=1,\
         ametadata=print:key=lavfi.astats.Overall.RMS_level"
    )
}

/// Parses `analysis_filter` output; the loudness timeline is reported in `window_seconds` steps.
pub fn parse_analysis(log: &str, window_seconds: f64) -> Analysis {
    let mut loudness = vec![];
    let mut silences = vec![];
    let mut silence_start = None;
    let mut decoded = None;
    for line in log.lines() {
        // ffmpeg's progress lines ("... time=00:03:53.79 ...") end with the exact decoded length.
        if let Some((_, rest)) = line.rsplit_once("time=") {
            decoded = rest.split_whitespace().next().and_then(|t| parse_clock(t)).or(decoded);
        }
        if let Some((_, v)) = line.split_once("lavfi.astats.Overall.RMS_level=") {
            loudness.push(v.trim().parse::<f64>().ok().filter(|v| v.is_finite()).unwrap_or(SILENT_DB).max(SILENT_DB));
        } else if let Some((_, v)) = line.split_once("silence_start: ") {
            silence_start = v.trim().parse::<f64>().ok();
        } else if let Some((_, v)) = line.split_once("silence_end: ") {
            let end = v.split('|').next().and_then(|e| e.trim().parse::<f64>().ok());
            if let (Some(start), Some(end)) = (silence_start.take(), end) {
                silences.push(Range { start: start.max(0.0), end });
            }
        }
    }

    let fine = loudness;
    // Coarsen to the requested window (in the power domain), and to at most MAX_WINDOWS.
    let group = ((window_seconds / ANALYSIS_STEP).round() as usize).max(fine.len().div_ceil(MAX_WINDOWS)).max(1);
    let window = ANALYSIS_STEP * group as f64;
    let loudness: Vec<f64> = fine
        .chunks(group)
        .map(|c| {
            let power = c.iter().map(|db| 10f64.powf(db / 10.0)).sum::<f64>() / c.len() as f64;
            round1((10.0 * power.log10()).max(SILENT_DB))
        })
        .collect();
    let duration = round3(decoded.unwrap_or(fine.len() as f64 * ANALYSIS_STEP));
    if let (Some(start), true) = (silence_start, duration > 0.0) {
        silences.push(Range { start, end: duration });
    }

    let mut audible: Vec<f64> = fine.iter().copied().filter(|&db| db > SILENT_DB).collect();
    audible.sort_by(f64::total_cmp);
    let (mean_db, median_db) = if audible.is_empty() {
        (SILENT_DB, SILENT_DB)
    } else {
        let mean = 10.0 * (audible.iter().map(|db| 10f64.powf(db / 10.0)).sum::<f64>() / audible.len() as f64).log10();
        (round1(mean), round1(audible[audible.len() / 2]))
    };

    let quiet_sections = quiet_sections(&fine, ANALYSIS_STEP, median_db - QUIET_BELOW_MEDIAN_DB, duration);

    Analysis { duration, window_seconds: round3(window), loudness_db: loudness, mean_db, median_db, silences, quiet_sections }
}

/// Finds stretches whose smoothed loudness is below `threshold_db`.
fn quiet_sections(loudness: &[f64], window: f64, threshold_db: f64, duration: f64) -> Vec<Range> {
    let half = ((QUIET_SMOOTHING_SECONDS / window / 2.0).floor() as usize).min(loudness.len());
    let power: Vec<f64> = loudness.iter().map(|db| 10f64.powf(db / 10.0)).collect();
    let smoothed = (0..loudness.len()).map(|i| {
        let around = &power[i.saturating_sub(half)..(i + half + 1).min(power.len())];
        10.0 * (around.iter().sum::<f64>() / around.len() as f64).log10()
    });

    let mut sections: Vec<Range> = vec![];
    let mut run_start = None;
    for (i, db) in smoothed.chain([f64::INFINITY]).enumerate() {
        match (db < threshold_db, run_start) {
            (true, None) => run_start = Some(i),
            (false, Some(mut s)) => {
                // Smoothing blurs edges; tighten them back to where the raw level is quiet.
                let mut e = i;
                while s < e && loudness[s] >= threshold_db {
                    s += 1;
                }
                while e > s && loudness[e - 1] >= threshold_db {
                    e -= 1;
                }
                run_start = None;
                if s == e {
                    continue;
                }
                let (start, end) = (s as f64 * window, (e as f64 * window).min(duration));
                match sections.last_mut() {
                    Some(prev) if start - prev.end <= QUIET_SMOOTHING_SECONDS => prev.end = end,
                    _ => sections.push(Range { start, end }),
                }
            }
            _ => {}
        }
    }
    sections
        .into_iter()
        .filter(|r| r.end - r.start >= MIN_QUIET_SECONDS)
        .map(|r| Range { start: round3(r.start), end: round3(r.end) })
        .collect()
}

/// Parses ffmpeg's "HH:MM:SS.xx" clock format.
fn parse_clock(text: &str) -> Option<f64> {
    let mut total = 0.0;
    for part in text.split(':') {
        total = total * 60.0 + part.parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0)?;
    }
    Some(total)
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
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

    #[test]
    fn parses_analysis_log() {
        // Each RMS line is one 0.5 s analysis step.
        let rms = |db: &str| format!("frame:0 pts:0 pts_time:0\nlavfi.astats.Overall.RMS_level={db}\n");
        let mut log = String::from("[silencedetect @ 0x1] silence_start: 0\n");
        log += &rms("-inf");
        log += "[silencedetect @ 0x1] silence_end: 0.4 | silence_duration: 0.4\n";
        // 19 s loud, an 8 s breakdown with one louder beat in it, then 20 s loud.
        let levels = [vec!["-12.0"; 37], vec!["-30.0"; 6], vec!["-14.0"; 2], vec!["-30.0"; 8], vec!["-12.0"; 40]].concat();
        for db in &levels {
            log += &rms(db);
        }
        log += "[silencedetect @ 0x1] silence_start: 46.9\n";
        log += "size=N/A time=00:00:46.95 bitrate=N/A speed= 500x\n";

        let a = parse_analysis(&log, 1.0);
        assert_eq!(a.window_seconds, 1.0);
        assert_eq!(a.loudness_db.len(), 47);
        assert_eq!(&a.loudness_db[..3], &[-15.0, -12.0, -12.0]);
        assert_eq!(a.duration, 46.95);
        assert_eq!(a.silences, vec![Range { start: 0.0, end: 0.4 }, Range { start: 46.9, end: 46.95 }]);
        assert_eq!(a.median_db, -12.0);
        // The breakdown is one section despite the louder beat; the 0.5 s silent intro is too short.
        assert_eq!(a.quiet_sections, vec![Range { start: 19.0, end: 27.0 }]);
    }

    #[test]
    fn analysis_merges_long_files() {
        // 2400 steps of 0.5 s = 20 minutes; at most 1200 windows come back.
        let log: String = (0..2400).map(|_| "lavfi.astats.Overall.RMS_level=-20\n").collect();
        let a = parse_analysis(&log, 0.5);
        assert_eq!(a.loudness_db.len(), 1200);
        assert_eq!(a.window_seconds, 1.0);
        assert_eq!(a.duration, 1200.0);
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
