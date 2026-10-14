//! Pure planning logic: parse the user's cut list and turn it into ffmpeg invocations.
//! Nothing here touches the filesystem except checking for existing output names.

use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Cut at points: N points -> N+1 files.
    Split,
    /// Keep ranges: one file per range.
    Extract,
    /// Delete ranges: one file with the remaining audio joined.
    Remove,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimRequest {
    pub input: String,
    pub mode: Mode,
    /// Raw text from the UI: one point or range per line (commas also separate).
    pub cuts: String,
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

/// Parses "90", "1:30", "1:30.25" or "1:02:03.5" into seconds.
pub fn parse_time(s: &str) -> Result<f64, String> {
    let s = s.trim();
    let invalid = || format!("Invalid time \"{s}\" (use e.g. 90, 1:30 or 1:02:03.5)");
    let parts: Vec<&str> = s.split(':').collect();
    if s.is_empty() || parts.len() > 3 {
        return Err(invalid());
    }
    let mut total = 0.0;
    for (i, part) in parts.iter().enumerate() {
        let part = part.trim();
        if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit() || c == '.') {
            return Err(invalid());
        }
        let v: f64 = part.parse().map_err(|_| invalid())?;
        if i > 0 && v >= 60.0 {
            return Err(invalid());
        }
        total = total * 60.0 + v;
    }
    Ok(total)
}

pub fn format_time(secs: f64) -> String {
    let ms = (secs * 1000.0).round() as u64;
    let (h, m, s, ms) = (ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}.{ms:03}")
    } else {
        format!("{m}:{s:02}.{ms:03}")
    }
}

fn entries(text: &str) -> impl Iterator<Item = &str> {
    text.split(['\n', ',']).map(str::trim).filter(|l| !l.is_empty())
}

pub fn parse_points(text: &str) -> Result<Vec<f64>, String> {
    let mut points = entries(text).map(parse_time).collect::<Result<Vec<_>, _>>()?;
    points.sort_by(f64::total_cmp);
    points.dedup();
    Ok(points)
}

/// Parses "start - end" lines. `end` may be the word "end" (returned as `None`).
pub fn parse_ranges(text: &str) -> Result<Vec<(f64, Option<f64>)>, String> {
    entries(text)
        .map(|line| {
            let (a, b) = line
                .split_once('-')
                .ok_or_else(|| format!("Invalid range \"{line}\" (use e.g. 0:10 - 0:45)"))?;
            let start = parse_time(a)?;
            let end = if b.trim().eq_ignore_ascii_case("end") {
                None
            } else {
                Some(parse_time(b)?)
            };
            if end.is_some_and(|e| e <= start) {
                return Err(format!("Range \"{line}\" ends before it starts"));
            }
            Ok((start, end))
        })
        .collect()
}

/// Extracts the duration and checks for an audio stream in `ffmpeg -i <file>` output.
pub fn probe_duration(ffmpeg_info: &str) -> Result<Option<f64>, String> {
    if !ffmpeg_info.contains("Audio:") {
        return Err(format!("No audio stream found.\n{}", tail(ffmpeg_info, 3)));
    }
    let duration = ffmpeg_info
        .split_once("Duration: ")
        .and_then(|(_, rest)| rest.split(',').next())
        .and_then(|d| parse_time(d).ok());
    Ok(duration)
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

pub fn plan(req: &TrimRequest, duration: Option<f64>) -> Result<Vec<Job>, String> {
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
    let past_end = |t: f64| duration.is_some_and(|d| t >= d);
    let len_msg = || duration.map(format_time).unwrap_or_default();
    let mut taken = HashSet::new();

    let base = |start: f64, end: Option<f64>| {
        let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];
        if start > 0.0 {
            args.extend(["-ss".into(), format!("{start:.3}")]);
        }
        if let Some(end) = end {
            args.extend(["-to".into(), format!("{end:.3}")]);
        }
        args.extend(["-i".into(), req.input.clone()]);
        args
    };

    let segments: Vec<(f64, Option<f64>)> = match req.mode {
        Mode::Split => {
            let points = parse_points(&req.cuts)?;
            if points.is_empty() {
                return Err("Enter at least one cut point".into());
            }
            if let Some(&p) = points.iter().find(|&&p| p <= 0.0 || past_end(p)) {
                return Err(format!(
                    "Cut point {} is outside the file (length {})",
                    format_time(p),
                    len_msg()
                ));
            }
            let mut bounds = vec![0.0];
            bounds.extend(&points);
            bounds
                .iter()
                .enumerate()
                .map(|(i, &s)| (s, points.get(i).copied()))
                .collect()
        }
        Mode::Extract => {
            let ranges = parse_ranges(&req.cuts)?;
            if ranges.is_empty() {
                return Err("Enter at least one range".into());
            }
            if let Some(&(s, _)) = ranges.iter().find(|(s, _)| past_end(*s)) {
                return Err(format!(
                    "Range starting at {} is past the end of the file (length {})",
                    format_time(s),
                    len_msg()
                ));
            }
            ranges
        }
        Mode::Remove => {
            let mut ranges = parse_ranges(&req.cuts)?;
            if ranges.is_empty() {
                return Err("Enter at least one range to remove".into());
            }
            ranges.sort_by(|a, b| a.0.total_cmp(&b.0));
            // Complement of the (merged) removed ranges = what we keep.
            let mut keeps: Vec<(f64, Option<f64>)> = vec![];
            let mut cursor = Some(0.0);
            for (s, e) in ranges {
                let Some(c) = cursor else { break };
                if s > c {
                    keeps.push((c, Some(s)));
                }
                cursor = e.map(|e| e.max(c));
            }
            if let Some(c) = cursor.filter(|&c| !past_end(c)) {
                keeps.push((c, None));
            }
            if keeps.is_empty() {
                return Err("Those ranges remove the whole file".into());
            }
            let mut filter = String::new();
            let mut labels = String::new();
            for (i, (s, e)) in keeps.iter().enumerate() {
                let end = e.map(|e| format!(":end={e:.3}")).unwrap_or_default();
                filter += &format!("[0:a]atrim=start={s:.3}{end},asetpts=PTS-STARTPTS[a{i}];");
                labels += &format!("[a{i}]");
            }
            filter += &format!("{labels}concat=n={}:v=0:a=1[out]", keeps.len());

            let output = unique_path(&out_dir, &format!("{stem}_trimmed"), &ext, &mut taken);
            let mut args = base(0.0, None);
            args.extend(["-filter_complex".into(), filter, "-map".into(), "[out]".into()]);
            args.extend(["-map_metadata".into(), "0".into()]);
            args.extend(codec_args(&ext, false).into_iter().map(String::from));
            args.push(output.to_string_lossy().into_owned());
            return Ok(vec![Job { args, output }]);
        }
    };

    let copy = !req.precise && ext == in_ext;
    let width = segments.len().to_string().len().max(2);
    Ok(segments
        .iter()
        .enumerate()
        .map(|(i, &(s, e))| {
            let name = format!("{stem}_part{:0width$}", i + 1);
            let output = unique_path(&out_dir, &name, &ext, &mut taken);
            let mut args = base(s, e);
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

    fn req(mode: Mode, cuts: &str) -> TrimRequest {
        TrimRequest {
            input: "/nonexistent/dir/song.mp3".into(),
            mode,
            cuts: cuts.into(),
            output_dir: String::new(),
            format: "same".into(),
            precise: false,
        }
    }

    #[test]
    fn parses_times() {
        assert_eq!(parse_time("90").unwrap(), 90.0);
        assert_eq!(parse_time("1:30").unwrap(), 90.0);
        assert_eq!(parse_time("1:02:03.5").unwrap(), 3723.5);
        assert_eq!(parse_time(" 0:05.25 ").unwrap(), 5.25);
        for bad in ["", "1:75", "abc", "1:2:3:4", "-5", "inf", "1e3", "1::2"] {
            assert!(parse_time(bad).is_err(), "{bad} should fail");
        }
    }

    #[test]
    fn parses_ranges() {
        let r = parse_ranges("0:10 - 0:45\n1:20-end, 2:00 - 2:30").unwrap();
        assert_eq!(r, vec![(10.0, Some(45.0)), (80.0, None), (120.0, Some(150.0))]);
        assert!(parse_ranges("0:45 - 0:10").is_err());
        assert!(parse_ranges("0:45").is_err());
    }

    #[test]
    fn probes_duration() {
        let info = "  Duration: 00:03:21.45, start: 0.000000, bitrate: 128 kb/s\n  Stream #0:0: Audio: mp3";
        assert_eq!(probe_duration(info).unwrap(), Some(201.45));
        assert!(probe_duration("song.mp3: No such file or directory").is_err());
    }

    #[test]
    fn split_makes_n_plus_one_parts() {
        let jobs = plan(&req(Mode::Split, "2:00\n1:00"), Some(300.0)).unwrap();
        assert_eq!(jobs.len(), 3);
        assert!(jobs[0].output.ends_with("song_part01.mp3"));
        assert!(jobs[0].args.windows(2).any(|w| w == ["-to", "60.000"]));
        assert!(!jobs[0].args.contains(&"-ss".to_string()));
        assert!(jobs[1].args.windows(2).any(|w| w == ["-ss", "60.000"]));
        assert!(!jobs[2].args.contains(&"-to".to_string()));
        assert!(jobs[2].args.windows(2).any(|w| w == ["-c:a", "copy"]));
    }

    #[test]
    fn split_rejects_points_past_end() {
        assert!(plan(&req(Mode::Split, "6:00"), Some(300.0)).is_err());
    }

    #[test]
    fn precise_or_format_change_reencodes() {
        let mut r = req(Mode::Extract, "0:10 - 0:20");
        r.precise = true;
        let jobs = plan(&r, Some(300.0)).unwrap();
        assert!(jobs[0].args.contains(&"libmp3lame".to_string()));

        let mut r = req(Mode::Extract, "0:10 - 0:20");
        r.format = "wav".into();
        let jobs = plan(&r, Some(300.0)).unwrap();
        assert!(jobs[0].output.ends_with("song_part01.wav"));
        assert!(!jobs[0].args.contains(&"copy".to_string()));
    }

    #[test]
    fn remove_keeps_the_complement() {
        let jobs = plan(&req(Mode::Remove, "0:00 - 0:05\n1:00 - 1:30\n1:20 - 2:00"), Some(300.0)).unwrap();
        assert_eq!(jobs.len(), 1);
        let filter = &jobs[0].args[jobs[0].args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert_eq!(
            filter,
            "[0:a]atrim=start=5.000:end=60.000,asetpts=PTS-STARTPTS[a0];\
             [0:a]atrim=start=120.000,asetpts=PTS-STARTPTS[a1];\
             [a0][a1]concat=n=2:v=0:a=1[out]"
        );
        assert!(jobs[0].output.ends_with("song_trimmed.mp3"));
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
        let ffmpeg_out = |args: &[String]| {
            let out = Command::new(&ffmpeg).args(args).output().unwrap();
            (out.status.success(), String::from_utf8_lossy(&out.stderr).into_owned())
        };
        let duration_of = |path: &Path| {
            let (_, info) = ffmpeg_out(&["-hide_banner".into(), "-i".into(), path.to_string_lossy().into()]);
            probe_duration(&info).unwrap().unwrap()
        };

        let dir = std::env::temp_dir().join(format!("audiotrimmer-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("tone.wav");
        let make_tone = ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=10"];
        let mut make_tone: Vec<String> = make_tone.map(String::from).to_vec();
        make_tone.push(input.to_string_lossy().into());
        assert!(ffmpeg_out(&make_tone).0);

        let cases = [
            (Mode::Split, "2.5\n0:06", "same", vec![2.5, 3.5, 4.0]),
            (Mode::Extract, "1 - 2.5\n0:08 - end", "mp3", vec![1.5, 2.0]),
            (Mode::Remove, "0 - 1\n4 - 6", "flac", vec![7.0]),
        ];
        for (mode, cuts, format, expected) in cases {
            let r = TrimRequest {
                input: input.to_string_lossy().into(),
                mode,
                cuts: cuts.into(),
                output_dir: String::new(),
                format: format.into(),
                precise: false,
            };
            let jobs = plan(&r, Some(duration_of(&input))).unwrap();
            assert_eq!(jobs.len(), expected.len(), "{mode:?}");
            for (job, want) in jobs.iter().zip(expected) {
                let (ok, log) = ffmpeg_out(&job.args);
                assert!(ok, "{mode:?} failed: {}", tail(&log, 5));
                let got = duration_of(&job.output);
                // mp3 adds encoder padding of a frame or two.
                assert!((got - want).abs() < 0.06, "{mode:?}: {} is {got}s, want {want}s", job.output.display());
            }
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn remove_everything_is_an_error() {
        assert!(plan(&req(Mode::Remove, "0:00 - end"), Some(300.0)).is_err());
        assert!(plan(&req(Mode::Remove, "0:00 - 5:00"), Some(300.0)).is_err());
    }
}
