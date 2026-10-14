mod trim;

use tauri::AppHandle;
use tauri::ipc::Response;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

fn ffmpeg(app: &AppHandle) -> Result<tauri_plugin_shell::process::Command, String> {
    app.shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("Could not find bundled ffmpeg: {e}"))
}

/// Decodes the file and returns its waveform: a u32 LE sample count (at
/// `WAVEFORM_RATE`) followed by one peak byte per 1/`PEAKS_PER_SEC` second.
#[tauri::command]
async fn load_waveform(app: AppHandle, path: String) -> Result<Response, String> {
    let rate = trim::WAVEFORM_RATE.to_string();
    let args = [
        "-hide_banner", "-nostdin", "-v", "error", "-i", &path, "-map", "0:a:0", "-ac", "1", "-ar",
        &rate, "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1",
    ];
    let (mut events, _child) = ffmpeg(&app)?
        .args(args)
        .set_raw_out(true)
        .spawn()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;

    let mut peaks = trim::PeakAccumulator::new();
    let mut stderr = Vec::new();
    let mut code = None;
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => peaks.push(&bytes),
            CommandEvent::Stderr(bytes) => stderr.extend(bytes),
            CommandEvent::Terminated(status) => code = status.code,
            CommandEvent::Error(e) => return Err(e),
            _ => {}
        }
    }
    if code != Some(0) {
        let log = String::from_utf8_lossy(&stderr);
        return Err(format!("Could not read audio:\n{}", trim::tail(&log, 4)));
    }
    Ok(Response::new(peaks.finish()))
}

/// Writes the kept parts of one file; returns the paths written.
#[tauri::command]
async fn export_file(app: AppHandle, req: trim::ExportRequest) -> Result<Vec<String>, String> {
    let mut outputs = vec![];
    for job in trim::plan(&req)? {
        let output = ffmpeg(&app)?
            .args(&job.args)
            .output()
            .await
            .map_err(|e| format!("Could not run ffmpeg: {e}"))?;
        if !output.status.success() {
            let log = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ffmpeg failed:\n{}", trim::tail(&log, 6)));
        }
        outputs.push(job.output.to_string_lossy().into_owned());
    }
    Ok(outputs)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![load_waveform, export_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
