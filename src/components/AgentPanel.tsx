import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon";

/** Sidebar footer showing whether AI agents can connect over MCP, and what they last did. */
export default function AgentPanel({ activity }: { activity: string | null }) {
  const [status, setStatus] = useState<{ url?: string; error?: string }>({});
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // The server starts alongside the app, so poll briefly until it reports in.
    let tries = 0;
    const check = () =>
      invoke<string>("agent_status").then(
        (url) => setStatus({ url }),
        (error) => {
          setStatus({ error: String(error) });
          if (tries++ < 10) setTimeout(check, 500);
        },
      );
    check();
  }, []);

  const copy = async () => {
    if (!status.url) return;
    await navigator.clipboard.writeText(`claude mcp add --transport http audio-trimmer ${status.url}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="agent-panel">
      <div className="agent-head">
        <span className={`dot ${status.url ? "on" : "off"}`} />
        <h2>AI agents</h2>
      </div>
      {activity ? (
        <p className="agent-activity">
          <Icon name="wave" size={12} /> {activity}
        </p>
      ) : status.url ? (
        <>
          <code className="agent-url" title="MCP server (Streamable HTTP)">{status.url}</code>
          <button className="ghost agent-copy" onClick={copy} title="Copy the command to add this app to Claude Code">
            {copied ? "Copied" : "Copy Claude Code command"}
          </button>
        </>
      ) : (
        <p className="agent-error">{status.error ?? "Starting…"}</p>
      )}
    </div>
  );
}
