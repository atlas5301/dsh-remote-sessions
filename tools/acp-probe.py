#!/usr/bin/env python3
"""Standalone ACP-over-SSH probe — no DSH, no dependencies.

Speaks the Agent Client Protocol (JSON-RPC, newline-delimited) to a remote
`dsh --profile acp` child over ssh, mirroring the official
@deepseek-ai/dsh-subagent-acp client flow:

    initialize -> session/new -> session/prompt -> collect session/update

Usage:  python3 acp-probe.py ["ssh","user@host","/home/user/bin/dsh-acp"]
"""
import json
import subprocess
import sys
import tempfile
import time

PROTOCOL_VERSION = 1
TIMEOUT_S = 240


def main() -> int:
    cmd = sys.argv[1:] or ["ssh", "-o", "BatchMode=yes", "user@host", "/home/user/bin/dsh-acp"]
    task = "Reply with exactly: DL1-ACP-OK"
    if "--task" in sys.argv:
        task = sys.argv[sys.argv.index("--task") + 1]

    err_path = tempfile.NamedTemporaryFile(prefix="acp-probe-stderr-", delete=False)
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err_path)

    texts: list[str] = []
    thoughts: list[str] = []
    tools: list[str] = []
    config_state: list[dict] = []
    next_client_request_id = 10_000

    def send(obj: dict) -> None:
        proc.stdin.write((json.dumps(obj) + "\n").encode())
        proc.stdin.flush()

    def dispatch_other(msg: dict) -> None:
        nonlocal next_client_request_id
        if msg.get("method") == "session/update":
            u = msg.get("params", {}).get("update", {})
            kind = u.get("sessionUpdate")
            if kind == "agent_message_chunk":
                c = u.get("content", {})
                if c.get("type") == "text":
                    texts.append(c.get("text", ""))
            elif kind == "agent_thought_chunk":
                thoughts.append(u.get("content", {}).get("text", ""))
            elif kind == "config_option_update":
                config_state.append(u)
            elif kind == "tool_call":
                tools.append(f"{u.get('title') or u.get('kind')}")
            return
        if "method" in msg and "id" in msg:
            # a server->client request (e.g. session/request_permission): decline politely
            send({
                "jsonrpc": "2.0",
                "id": msg["id"],
                "result": {"outcome": {"outcome": "cancelled"}},
            })
            next_client_request_id += 1

    def request(rid: int, method: str, params: dict) -> dict:
        send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        while True:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("ACP child closed stdout unexpectedly")
            msg = json.loads(line)
            if msg.get("id") == rid and ("result" in msg or "error" in msg):
                if "error" in msg:
                    raise RuntimeError(f"{method} error: {msg['error']}")
                return msg["result"]
            dispatch_other(msg)

    deadline = time.monotonic() + TIMEOUT_S
    try:
        t0 = time.monotonic()
        init = request(1, "initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": {},
        })
        print(f"[ok] initialize in {time.monotonic()-t0:.1f}s — server: "
              f"{init.get('authMethods', '')} protocol={init.get('protocolVersion')}")

        t0 = time.monotonic()
        new = request(2, "session/new", {"cwd": "/home/ubuntu", "mcpServers": []})
        sid = new.get("sessionId")
        if not isinstance(sid, str):
            raise RuntimeError(f"no sessionId in session/new result: {new}")
        print(f"[ok] session/new in {time.monotonic()-t0:.1f}s — sessionId={sid}")

        # pin the model route before the first turn (value = JSON [provider, model])
        model_value = json.dumps(["deepinfra", "zai-org/GLM-5.3"], separators=(",", ":"))
        request(4, "session/set_config_option", {
            "sessionId": sid, "configId": "model", "value": model_value,
        })
        print(f"[ok] session/set_config_option — model={model_value}")

        t0 = time.monotonic()
        result = request(3, "session/prompt", {
            "sessionId": sid,
            "prompt": [{"type": "text", "text": task}],
        })
        elapsed = time.monotonic() - t0
        if time.monotonic() > deadline:
            raise RuntimeError("probe exceeded its deadline")
        print(f"[ok] session/prompt in {elapsed:.1f}s — stopReason={result.get('stopReason')}")
        answer = "".join(texts).strip()
        print(f"--- agent message ({len(answer)} chars) ---")
        print(answer[:1000])
        if thoughts:
            print(f"--- reasoning chunks: {sum(len(t) for t in thoughts)} chars ---")
        if tools:
            print(f"--- tool calls: {tools} ---")
        ok = result.get("stopReason") == "end_turn" and "DL1-ACP-OK" in answer
        print(f"VERDICT: {'PASS' if ok else 'CHECK'} (stopReason={result.get('stopReason')})")
        return 0 if ok else 1
    except Exception as exc:
        print(f"FAIL: {exc}")
        if config_state:
            for st in config_state[-1:]:
                for opt in st.get("configOptions", []):
                    if opt.get("id") == "model":
                        groups = opt.get("options", opt.get("choices", []))
                        vals = [o.get("value") for g in (groups if isinstance(groups, list) else []) for o in (g.get("options", []) if isinstance(g, dict) else [])]
                        print("advertised model values:", vals[:12])
                        break
        print("--- remote stderr (tail) ---")
        err_path.flush()
        with open(err_path.name, "rb") as fh:
            print(fh.read()[-3000:].decode("utf-8", "replace"))
        return 2
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
