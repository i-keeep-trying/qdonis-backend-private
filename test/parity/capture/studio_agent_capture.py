"""Capture qdonis-core Studio agent behaviour as parity fixtures.

Runs the REAL ``qdonis_backend.studio_agent.stream_agent_step`` from a
qdonis-core checkout with the Bedrock client replaced by a recorder, so no
Bedrock call is made. For every input in ``fixtures/studio-agent/inputs`` it
writes ``fixtures/studio-agent/<name>.json`` holding the exact Converse
request Python would send (modelId, system, messages, inferenceConfig,
toolConfig) and the SSE events it emits for the scripted Bedrock stream.

Usage (see README.md):
    <qdonis-core>\\.venv\\Scripts\\python.exe test\\parity\\capture\\studio_agent_capture.py [--core PATH]

qdonis-core is only imported, never modified (no bytecode is written).
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
BACKEND_ROOT = HERE.parents[2]
FIXTURES = BACKEND_ROOT / "test" / "parity" / "fixtures" / "studio-agent"
INPUTS = FIXTURES / "inputs"
DEFAULT_CORE = BACKEND_ROOT.parent / "qdonis-core"

# Used when an input does not script its own Bedrock stream.
DEFAULT_STREAM: List[Dict[str, Any]] = [
    {"messageStart": {"role": "assistant"}},
    {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "OK"}}},
    {"contentBlockStop": {"contentBlockIndex": 0}},
    {"messageStop": {"stopReason": "end_turn"}},
    {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}},
]


class RecordingClient:
    """Stands in for the boto3 bedrock-runtime client."""

    def __init__(self, stream: List[Dict[str, Any]], error: Optional[Dict[str, Any]]):
        self.stream = stream
        self.error = error
        self.request: Optional[Dict[str, Any]] = None

    def converse_stream(self, **kwargs: Any) -> Dict[str, Any]:
        # Snapshot through JSON so later mutation cannot leak into the fixture.
        self.request = json.loads(json.dumps(kwargs, ensure_ascii=False))
        if self.error and self.error.get("on_call"):
            raise RuntimeError(self.error["message"])
        return {"stream": self._events()}

    def _events(self) -> Iterator[Dict[str, Any]]:
        limit = self.error.get("after_events") if self.error else None
        for index, event in enumerate(self.stream):
            if limit is not None and index >= limit:
                break
            yield copy.deepcopy(event)
        if self.error:
            raise RuntimeError(self.error["message"])


def git(core: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(core), *args], capture_output=True, text=True, check=True
    ).stdout.strip()


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def main() -> int:
    # Hash-ordered sets in the core (missing tool results) must be reproducible.
    if os.environ.get("PYTHONHASHSEED") != "0":
        env = {**os.environ, "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1"}
        return subprocess.call([sys.executable, *sys.argv], env=env)

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--core", type=Path, default=DEFAULT_CORE, help="qdonis-core checkout")
    args = parser.parse_args()
    core = args.core.resolve()
    if not (core / "qdonis_backend" / "studio_agent.py").is_file():
        print(f"qdonis-core not found at {core}", file=sys.stderr)
        return 2

    sys.path.insert(0, str(core))
    from qdonis_backend import studio_agent  # noqa: E402
    from qdonis_backend.data_utils import list_builtin_topologies  # noqa: E402

    # bedrock_client loads core's .env on import; the model must be the default.
    os.environ.pop("BEDROCK_MODEL_ID", None)

    captured_from = {
        "repo": "qdonis-core",
        "commit": git(core, "rev-parse", "HEAD"),
        "branch": git(core, "rev-parse", "--abbrev-ref", "HEAD"),
    }
    topology_ids = list_builtin_topologies()
    write_json(FIXTURES / "topology-ids.json", topology_ids)

    inputs = sorted(INPUTS.glob("*.json"))
    for path in inputs:
        spec = json.loads(path.read_text(encoding="utf-8"))
        messages = spec["messages"]
        # Same request checks as api_server.studio_agent_step.
        if not isinstance(messages, list) or not messages:
            raise SystemExit(f"{path.name}: messages must be a non-empty list")
        raw_state = spec.get("project_state")
        project_state = raw_state if isinstance(raw_state, dict) else {}

        stream = spec.get("bedrock_stream", DEFAULT_STREAM)
        client = RecordingClient(stream, spec.get("bedrock_error"))
        studio_agent.get_bedrock_client = lambda streaming=False, _c=client: _c
        events = list(studio_agent.stream_agent_step(messages, project_state, topology_ids))
        if client.request is None:
            raise SystemExit(f"{path.name}: no Bedrock request was built")

        fixture = {
            "name": spec["name"],
            "description": spec["description"],
            "captured_from": captured_from,
            "topology_ids": topology_ids,
            "input": {"messages": messages, "project_state": raw_state},
            "bedrock_stream": stream,
            "bedrock_error": spec.get("bedrock_error"),
            "expected_request": client.request,
            # Through JSON like the SSE writer (json.dumps per event).
            "expected_events": json.loads(json.dumps(events, default=str)),
        }
        if spec.get("wire_invalid"):
            # Accepted by Python, rejected by the stricter Nest DTO (400).
            fixture["wire_invalid"] = spec["wire_invalid"]
        write_json(FIXTURES / f"{spec['name']}.json", fixture)
        print(f"captured {spec['name']}: {len(client.request['messages'])} messages, {len(events)} events")

    print(f"{len(inputs)} fixtures, {len(topology_ids)} topology ids, core {captured_from['commit'][:7]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
