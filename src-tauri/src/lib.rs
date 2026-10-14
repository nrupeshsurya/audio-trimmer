mod trim;

use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

/// Runs the bundled ffmpeg sidecar, returning (success, stderr).
async fn run_ffmpeg(app: &AppHandle, args: &[String]) -> Result<(bool, String), String> {
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("Could not find bundled ffmpeg: {e}"))?
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    ))
}

/// Trims one input file according to the request; returns the paths written.
#[tauri::command]
async fn trim_file(app: AppHandle, req: trim::TrimRequest) -> Result<Vec<String>, String> {
    let probe = ["-hide_banner", "-nostdin", "-i", &req.input].map(String::from);
    let (_, info) = run_ffmpeg(&app, &probe).await?;
    let duration = trim::probe_duration(&info)?;

    let mut outputs = vec![];
    for job in trim::plan(&req, duration)? {
        let (ok, log) = run_ffmpeg(&app, &job.args).await?;
        if !ok {
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
        .invoke_handler(tauri::generate_handler![trim_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
