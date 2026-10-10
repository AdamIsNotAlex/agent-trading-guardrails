"""Hermes native plugin: authorize intents through the bundled Node HTTP adapter."""

import json
import os
from pathlib import Path
import shutil
import subprocess
from urllib.parse import urlsplit


_PREFIX = "guardrails_"
_REQUIRED_ENV = ("GUARDRAIL_URL", "GUARDRAIL_PRINCIPAL", "GUARDRAIL_ENV")
_ENVIRONMENTS = ("dev", "paper", "testnet", "canary_live", "production")


def _failure(message):
    return json.dumps({
        "success": False,
        "outcome": "deny",
        "intentId": "",
        "correlationId": "",
        "error": message,
        "reasons": [{"rule": "bridge_error", "message": message}],
    })


def _handler(tool_name, node, bridge, child_env, timeout):
    def invoke(args, **kwargs):
        if not isinstance(args, dict):
            return _failure("Guardrail tool arguments must be an object.")
        try:
            payload = json.dumps({"toolName": tool_name, "params": args}, allow_nan=False)
            if len(payload.encode("utf-8")) > 1_048_576:
                return _failure("Guardrail tool arguments exceed the request size limit.")
            completed = subprocess.run(
                [node, str(bridge)],
                input=payload,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=timeout,
                env=child_env,
                check=False,
            )
            if completed.returncode != 0:
                return _failure("Guardrail bridge failed; no execution was attempted.")
            result = json.loads(completed.stdout)
            if (not isinstance(result, dict)
                    or result.get("outcome") not in ("allow", "deny", "needs_human")
                    or not isinstance(result.get("success"), bool)):
                return _failure("Guardrail bridge returned an invalid result.")
            # A policy denial/needs_human is a valid result, not permission to execute.
            return json.dumps(result, ensure_ascii=False, allow_nan=False)
        except subprocess.TimeoutExpired:
            return _failure("Guardrail request timed out; no execution was attempted.")
        except (OSError, ValueError, TypeError):
            # Do not expose child stderr, environment contents, or raw HTTP responses.
            return _failure("Guardrail request failed; no execution was attempted.")

    return invoke


def register(ctx):
    # Bind operator configuration at load time. Model-supplied args never select identity,
    # environment, executable, or endpoint. Do not load a service .env in this process.
    config = {name: os.environ.get(name, "").strip() for name in _REQUIRED_ENV}
    if not all(config.values()):
        raise ValueError("GUARDRAIL_URL, GUARDRAIL_PRINCIPAL and GUARDRAIL_ENV are required.")
    url = urlsplit(config["GUARDRAIL_URL"])
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
        raise ValueError("GUARDRAIL_URL must be a trusted HTTP(S) base URL.")
    if config["GUARDRAIL_ENV"] not in _ENVIRONMENTS:
        raise ValueError("GUARDRAIL_ENV is invalid.")
    timeout_ms = int(os.environ.get("GUARDRAIL_TIMEOUT_MS", "30000"))
    if not 1 <= timeout_ms <= 60000:
        raise ValueError("GUARDRAIL_TIMEOUT_MS must be from 1 to 60000.")
    node = shutil.which(os.environ.get("GUARDRAIL_NODE_BINARY", "node"))
    root = Path(__file__).resolve().parent
    bridge = root / "bridge.mjs"
    if node is None or not bridge.is_file():
        raise ValueError("Trading guardrails requires Node and the packaged bridge.mjs.")
    # Only runtime necessities and this plugin's connection settings reach the child.
    child_env = {name: os.environ[name] for name in (
        "PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "NODE_EXTRA_CA_CERTS"
    ) if name in os.environ}
    child_env.update(config)
    child_env["GUARDRAIL_TIMEOUT_MS"] = str(timeout_ms)
    definitions = json.loads((root / "tools.json").read_text(encoding="utf-8"))
    for definition in definitions:
        name = definition["name"]
        schema = {**definition, "name": _PREFIX + name}
        ctx.register_tool(
            name=schema["name"],
            toolset="trading_guardrails",
            schema=schema,
            handler=_handler(name, node, bridge, child_env, timeout_ms / 1000 + 5),
            description=definition["description"],
        )
