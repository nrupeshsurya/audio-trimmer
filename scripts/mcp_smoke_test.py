#!/usr/bin/env python3
"""End-to-end smoke test for a running Kusanagi, driven over MCP like an AI agent would.

Generates a 20 s test file (tone, 4 s of silence, tone), then asks the app to find the
silence, remove it and export, combine the edit with a second file, and checks the results with ffmpeg.

Usage: python3 scripts/mcp_smoke_test.py --ffmpeg PATH [--workdir DIR]
Uses only the standard library so it runs on a bare CI machine.
"""

import argparse
import json
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

URL = "http://127.0.0.1:39231/mcp"
EXPECTED_TOOLS = {
    "list_files", "open_files", "analyze_audio", "get_edit", "add_cuts", "remove_cut", "remove_range",
    "keep_only_range", "set_part_removed", "undo", "clear_edits", "export", "combine_files",
}


class McpClient:
    def __init__(self, url: str):
        self.url = url
        self.session = None
        self.next_id = 1

    def _post(self, message: dict):
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self.session:
            headers["Mcp-Session-Id"] = self.session
            headers["MCP-Protocol-Version"] = "2025-06-18"
        request = urllib.request.Request(self.url, json.dumps(message).encode(), headers)
        with urllib.request.urlopen(request, timeout=300) as response:
            self.session = self.session or response.headers.get("mcp-session-id")
            body = response.read().decode()
        # Responses come either as plain JSON or as server-sent events.
        for line in body.splitlines():
            if line.startswith("data:") and line[5:].strip():
                parsed = json.loads(line[5:])
                if "id" in parsed:
                    return parsed
        return json.loads(body) if body.strip().startswith("{") else None

    def request(self, method: str, params: dict | None = None):
        self.next_id += 1
        reply = self._post({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}})
        if "error" in reply:
            raise RuntimeError(f"{method} failed: {reply['error']}")
        return reply["result"]

    def connect(self):
        self.request("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "kusanagi-smoke-test", "version": "1"},
        })
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def call(self, tool: str, **arguments):
        result = self.request("tools/call", {"name": tool, "arguments": arguments})
        text = result["content"][0]["text"]
        if result.get("isError"):
            raise RuntimeError(f"{tool} returned an error: {text}")
        return json.loads(text)


def wait_for_server(timeout: float) -> None:
    deadline = time.time() + timeout
    while True:
        try:
            urllib.request.urlopen(URL, timeout=2)
            return
        except urllib.error.HTTPError:
            return  # Any HTTP response means the server is up.
        except OSError:
            if time.time() > deadline:
                raise SystemExit(f"FAIL: no MCP server at {URL} after {timeout:.0f}s; is the app running?")
            time.sleep(1)


def media_duration(ffmpeg: str, path: Path) -> float:
    """Decodes the file and returns its exact length from ffmpeg's final progress line."""
    log = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-i", str(path), "-f", "null", "-"],
                         capture_output=True, text=True, check=True).stderr
    clock = log.rsplit("time=", 1)[1].split()[0]
    h, m, s = clock.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def check(condition: bool, message: str) -> None:
    print(("PASS " if condition else "FAIL ") + message, flush=True)
    if not condition:
        raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ffmpeg", required=True, help="ffmpeg used to create and verify test audio")
    parser.add_argument("--workdir", help="where to write test files (default: a temp dir)")
    parser.add_argument("--wait", type=float, default=120, help="seconds to wait for the app's MCP server")
    args = parser.parse_args()

    workdir = Path(args.workdir or tempfile.mkdtemp(prefix="kusanagi-smoke-"))
    workdir.mkdir(parents=True, exist_ok=True)
    source = workdir / "tone-gap-tone.wav"
    subprocess.run([
        args.ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=6:sample_rate=44100",
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=4",
        "-f", "lavfi", "-i", "sine=frequency=660:duration=10:sample_rate=44100",
        "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", str(source),
    ], check=True)
    print(f"Test file: {source} (6 s tone, 4 s silence, 10 s tone)")
    jingle = workdir / "jingle.mp3"
    subprocess.run([
        args.ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=880:duration=5:sample_rate=48000", "-ac", "2", str(jingle),
    ], check=True)

    wait_for_server(args.wait)
    client = McpClient(URL)
    client.connect()

    tools = {t["name"] for t in client.request("tools/list")["tools"]}
    check(EXPECTED_TOOLS <= tools, f"server lists all {len(EXPECTED_TOOLS)} tools")

    opened = client.call("open_files", paths=[str(source)])
    check(abs(opened[0].get("duration", 0) - 20) < 0.05, f"open_files loads the file (duration {opened[0].get('duration')})")

    analysis = client.call("analyze_audio", file=str(source))
    silences = analysis["silences"]
    check(len(silences) == 1 and abs(silences[0]["start"] - 6) < 0.1 and abs(silences[0]["end"] - 10) < 0.1,
          f"analyze_audio finds the silence ({silences})")

    gap = silences[0]
    edit = client.call("remove_range", file=str(source), start=gap["start"], end=gap["end"])
    check(len(edit["parts"]) == 3 and edit["parts"][1]["removed"], "remove_range cuts out the silence")
    check(abs(edit["kept_duration"] - 16) < 0.1, f"16 s kept ({edit['kept_duration']})")

    try:
        client.call("remove_range", file=str(source), start=30, end=40)
        check(False, "out-of-range edit is rejected")
    except RuntimeError as e:
        check("duration" in str(e), "out-of-range edit is rejected with a helpful message")

    out_dir = workdir / "out"
    out_dir.mkdir(exist_ok=True)
    joined = client.call("export", file=str(source), mode="joined", format="wav", output_dir=str(out_dir))["outputs"]
    check(len(joined) == 1 and Path(joined[0]).is_file(), f"joined export writes one file ({Path(joined[0]).name})")
    length = media_duration(args.ffmpeg, Path(joined[0]))
    check(abs(length - 16) < 0.05, f"joined file is 16 s long ({length:.3f} s)")

    parts = client.call("export", file=str(source), mode="separate", format="mp3", output_dir=str(out_dir))["outputs"]
    lengths = [media_duration(args.ffmpeg, Path(p)) for p in parts]
    check(len(parts) == 2 and abs(lengths[0] - 6) < 0.1 and abs(lengths[1] - 10) < 0.1,
          f"separate MP3 export writes 6 s and 10 s files ({', '.join(f'{x:.2f}' for x in lengths)})")

    combined = client.call("combine_files", files=[str(source), str(jingle)], transition="crossfade",
                           transition_seconds=1, format="wav", output_dir=str(out_dir))
    length = media_duration(args.ffmpeg, Path(combined["output"]))
    check(abs(length - 20) < 0.1, f"combine_files joins the 16 s edit and a 5 s MP3 with a 1 s crossfade ({length:.3f} s)")

    try:
        client.call("combine_files", files=[str(source), str(jingle)], transition="crossfade", transition_seconds=10)
        check(False, "too-long crossfade is rejected")
    except RuntimeError as e:
        check("too short" in str(e), "too-long crossfade is rejected with a helpful message")

    listed = client.call("list_files")
    check(any(f["file"] == str(source) and f["kept_parts"] == 2 for f in listed), "list_files reports the edit")

    print("All checks passed.")


if __name__ == "__main__":
    main()
