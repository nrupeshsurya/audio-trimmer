//! MCP server that lets AI agents drive the running app over Streamable HTTP
//! on localhost. Editing tools are forwarded to the UI so changes show up live
//! in the editor and can be undone like any other edit; audio analysis runs here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use rmcp::{ServerHandler, schemars, tool, tool_handler, tool_router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::trim;

pub const PORT: u16 = 39231;
const UI_TIMEOUT: Duration = Duration::from_secs(300);

const INSTRUCTIONS: &str = "\
Kusanagi is a desktop audio editor the user has open. Your edits appear live in their editor and they can undo them.

Model: cut points divide a file into parts; each part is kept or removed. Export writes the kept parts as one joined file or one file per part. combine_files joins several files (or their kept parts) into one. All times are in seconds.

Typical workflow:
1. open_files (or use list_files to see what the user already has open).
2. analyze_audio to understand the file: you can't hear it, but the loudness timeline, silences and quiet sections show its structure (intros, pauses, breakdowns, outros).
3. Edit with remove_range / keep_only_range / add_cuts / set_part_removed. Prefer cut points on silences or section boundaries.
4. Summarise the edit for the user (get_edit) and export only when they want files written. Export never overwrites existing files.";

/// Forwards tool calls to the webview and waits for its answer.
pub struct Bridge {
    app: AppHandle,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    status: Mutex<Result<String, String>>,
}

impl Bridge {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            status: Mutex::new(Err("Starting…".into())),
        }
    }

    async fn call_ui(&self, tool: &str, args: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let request = json!({ "id": id, "tool": tool, "args": args });
        if let Err(e) = self.app.emit_to("main", "agent-request", request) {
            self.pending.lock().unwrap().remove(&id);
            return Err(format!("Could not reach the app window: {e}"));
        }
        match tokio::time::timeout(UI_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            _ => {
                self.pending.lock().unwrap().remove(&id);
                Err("The app window didn't respond".into())
            }
        }
    }

    pub fn respond(&self, id: u64, result: Result<Value, String>) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(result);
        }
    }

    /// The MCP URL if the server is running, or why it isn't.
    pub fn status(&self) -> Result<String, String> {
        self.status.lock().unwrap().clone()
    }
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct OpenFilesArgs {
    /// Absolute paths of audio files to open.
    paths: Vec<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct FileArgs {
    /// Absolute path of the audio file. It is opened in the app if it isn't already.
    file: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct AnalyzeArgs {
    /// Absolute path of the audio file.
    file: String,
    /// Length of each loudness window in seconds (default 1, minimum 0.5). Long files are coarsened to at most 1200 windows.
    window_seconds: Option<f64>,
    /// Level below which audio counts as silence, in dBFS (default -40).
    silence_threshold_db: Option<f64>,
    /// Shortest silence to report, in seconds (default 0.5).
    min_silence_seconds: Option<f64>,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
pub struct CutsArgs {
    /// Absolute path of the audio file.
    file: String,
    /// Times in seconds to cut at.
    times: Vec<f64>,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
pub struct CutArgs {
    /// Absolute path of the audio file.
    file: String,
    /// Time in seconds of the cut to delete; the nearest cut within 0.1 s is removed.
    time: f64,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
pub struct RangeArgs {
    /// Absolute path of the audio file.
    file: String,
    /// Range start in seconds.
    start: f64,
    /// Range end in seconds.
    end: f64,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
pub struct PartArgs {
    /// Absolute path of the audio file.
    file: String,
    /// Part index as returned by get_edit (0-based, in time order).
    part: usize,
    /// true to remove the part, false to keep it.
    removed: bool,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
pub struct ExportArgs {
    /// Absolute path of the audio file.
    file: String,
    /// "joined" for one file, "separate" for one file per kept part. Defaults to the app's current setting.
    mode: Option<String>,
    /// Output format: "same", "mp3", "m4a", "wav" or "flac". Defaults to the app's current setting.
    format: Option<String>,
    /// Output folder. Defaults to the app's setting (next to the original unless the user chose one).
    output_dir: Option<String>,
    /// Re-encode for sample-accurate cuts. Defaults to the app's current setting.
    precise: Option<bool>,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
pub struct CombineArgs {
    /// Absolute paths of the audio files to join, in output order (at least two; a file may repeat).
    files: Vec<String>,
    /// true (default) to use each file's kept parts; files without edits are used whole. false uses every file whole.
    use_edits: Option<bool>,
    /// How clips join: "none" (default, back to back), "fade" (fade out then fade in), "crossfade" (overlap) or "gap" (silence).
    transition: Option<String>,
    /// Length of each fade, crossfade or gap in seconds (default 1, at most 60).
    transition_seconds: Option<f64>,
    /// Output format: "same" (the first file's), "mp3", "m4a", "wav" or "flac". Defaults to the app's current setting.
    format: Option<String>,
    /// Output folder. Defaults to the app's setting (next to the first file unless the user chose one).
    output_dir: Option<String>,
}

#[derive(Clone)]
pub struct AgentServer {
    bridge: Arc<Bridge>,
    tool_router: ToolRouter<Self>,
}

fn to_result(result: Result<Value, String>) -> CallToolResult {
    match result {
        Ok(value) => CallToolResult::success(vec![ContentBlock::text(
            serde_json::to_string_pretty(&value).unwrap_or_default(),
        )]),
        Err(message) => CallToolResult::error(vec![ContentBlock::text(message)]),
    }
}

#[tool_router]
impl AgentServer {
    fn new(bridge: Arc<Bridge>) -> Self {
        Self { bridge, tool_router: Self::tool_router() }
    }

    async fn ui(&self, tool: &str, args: impl Serialize) -> CallToolResult {
        to_result(self.bridge.call_ui(tool, serde_json::to_value(args).unwrap_or_default()).await)
    }

    #[tool(description = "List files open in the app with their duration and a summary of their edits.")]
    async fn list_files(&self) -> CallToolResult {
        self.ui("list_files", json!({})).await
    }

    #[tool(description = "Open audio files in the app and wait until they are loaded. Returns each file's duration.")]
    async fn open_files(&self, Parameters(args): Parameters<OpenFilesArgs>) -> CallToolResult {
        self.ui("open_files", json!({ "paths": args.paths })).await
    }

    #[tool(description = "Analyse a file's loudness over time: RMS level per window (dBFS), silences, and \
        sections quieter than the median. Use this to find structure (intro, pauses, breakdowns, outro) before cutting. \
        quiet_sections are approximate (to within a few seconds); refine edges with loudness_db, e.g. by re-running \
        with window_seconds 0.5, before placing precise cuts.")]
    async fn analyze_audio(&self, Parameters(args): Parameters<AnalyzeArgs>) -> CallToolResult {
        let window = args.window_seconds.unwrap_or(1.0).clamp(0.5, 60.0);
        let silence_db = args.silence_threshold_db.unwrap_or(-40.0).clamp(-90.0, 0.0);
        let min_silence = args.min_silence_seconds.unwrap_or(0.5).clamp(0.05, 60.0);
        let filter = trim::analysis_filter(silence_db, min_silence);
        let ffmpeg_args = ["-hide_banner", "-nostdin", "-i", &args.file, "-map", "0:a:0", "-af", &filter, "-f", "null", "-"];
        let result = match crate::run_ffmpeg(&self.bridge.app, &ffmpeg_args).await {
            Ok((true, log)) => {
                let mut value = serde_json::to_value(trim::parse_analysis(&log, window)).unwrap_or_default();
                value["file"] = json!(args.file);
                Ok(value)
            }
            Ok((false, log)) => Err(format!("Could not analyse audio:\n{}", trim::tail(&log, 4))),
            Err(e) => Err(e),
        };
        to_result(result)
    }

    #[tool(description = "Get a file's current edit: its cuts and every part with start, end and whether it is removed.")]
    async fn get_edit(&self, Parameters(args): Parameters<FileArgs>) -> CallToolResult {
        self.ui("get_edit", json!({ "file": args.file })).await
    }

    #[tool(description = "Add cut points (seconds). Cuts split parts; new parts inherit the kept/removed state of the part they split.")]
    async fn add_cuts(&self, Parameters(args): Parameters<CutsArgs>) -> CallToolResult {
        self.ui("add_cuts", args).await
    }

    #[tool(description = "Delete the cut nearest to a time, merging the parts on either side.")]
    async fn remove_cut(&self, Parameters(args): Parameters<CutArgs>) -> CallToolResult {
        self.ui("remove_cut", args).await
    }

    #[tool(description = "Remove a time range from the output: cuts at start and end and marks everything between as removed.")]
    async fn remove_range(&self, Parameters(args): Parameters<RangeArgs>) -> CallToolResult {
        self.ui("remove_range", args).await
    }

    #[tool(description = "Keep only a time range: cuts at start and end, keeps everything between and removes the rest.")]
    async fn keep_only_range(&self, Parameters(args): Parameters<RangeArgs>) -> CallToolResult {
        self.ui("keep_only_range", args).await
    }

    #[tool(description = "Mark one part (by index from get_edit) as removed or kept.")]
    async fn set_part_removed(&self, Parameters(args): Parameters<PartArgs>) -> CallToolResult {
        self.ui("set_part_removed", args).await
    }

    #[tool(description = "Undo the most recent edit to a file (the user can also undo in the app).")]
    async fn undo(&self, Parameters(args): Parameters<FileArgs>) -> CallToolResult {
        self.ui("undo", json!({ "file": args.file })).await
    }

    #[tool(description = "Remove all cuts and restore all parts of a file.")]
    async fn clear_edits(&self, Parameters(args): Parameters<FileArgs>) -> CallToolResult {
        self.ui("clear_edits", json!({ "file": args.file })).await
    }

    #[tool(description = "Export the kept parts of a file. Writes new files (never overwrites) and returns their paths. \
        Only export when the user wants files written.")]
    async fn export(&self, Parameters(args): Parameters<ExportArgs>) -> CallToolResult {
        self.ui("export", args).await
    }

    #[tool(description = "Join several files (or their kept parts) into one new file, with an optional fade, crossfade \
        or silence between them. Mixed formats are fine. Never overwrites; returns the new file's path. \
        Only combine when the user wants a file written.")]
    async fn combine_files(&self, Parameters(args): Parameters<CombineArgs>) -> CallToolResult {
        self.ui("combine_files", args).await
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for AgentServer {
    fn get_info(&self) -> ServerConfig {
        let mut info = Implementation::new("kusanagi", env!("CARGO_PKG_VERSION"));
        info.title = Some("Kusanagi".into());
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(info)
            .with_instructions(INSTRUCTIONS)
    }
}

/// Serves MCP on 127.0.0.1:PORT until the app exits.
pub async fn serve(bridge: Arc<Bridge>) {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", PORT)).await {
        Ok(listener) => listener,
        Err(e) => {
            *bridge.status.lock().unwrap() = Err(format!("Port {PORT} is unavailable: {e}"));
            return;
        }
    };
    let service: StreamableHttpService<AgentServer, LocalSessionManager> = StreamableHttpService::new(
        {
            let bridge = bridge.clone();
            move || Ok(AgentServer::new(bridge.clone()))
        },
        Default::default(),
        // Loopback Host only (the default) and reject any browser Origin, so web pages can't drive the app.
        StreamableHttpServerConfig::default().enforce_origin_validation(),
    );
    *bridge.status.lock().unwrap() = Ok(format!("http://127.0.0.1:{PORT}/mcp"));
    let router = axum::Router::new().nest_service("/mcp", service);
    if let Err(e) = axum::serve(listener, router).await {
        *bridge.status.lock().unwrap() = Err(format!("Agent server stopped: {e}"));
    }
}
