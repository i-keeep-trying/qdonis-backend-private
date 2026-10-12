"""Captures qdonis-core netlist-AI helpers on canned model replies (no LLM).

  ..\\qdonis-core\\.venv\\Scripts\\python.exe test\\parity\\capture\\netlist_ai_capture.py
Writes test/parity/fixtures/netlist-ai/vectors.json.
"""
import contextlib, io, json, os, re, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "fixtures" / "netlist-ai" / "vectors.json"

DECK = "* buck\r\nV1 in 0 12\r\nL1 in out 47u\r\nR1 out 0 10\r\n.end\r\n.control\r\ntran 1u 1m\r\nmeas tran v avg v(out)\r\n.endc\r\n"
REPLIES = [
    "```spice\n* fixed\nV1 in 0 12\nL1 in out 22u\nR1 out 0 10\n.end\n.control\nrun\n.endc\n```",
    "Here you go:\n```\nshort\n```\nand\n```cir\n* longer block\nV1 in 0 12\nL1 in out 10u\n```",
    "",
    "* plain\nV1 in 0 12\n\nL1 in out 33u\n\n\n",
]
MODIFY = [
    "<reasoning>\n### Why\nSmaller L1.\n</reasoning>\n<parameters>\n{\"L1\": \"10uH\", \"PWM1\": 0.45, \"N\": 3}\n</parameters>\n<netlist>\n* mod\nV1 in 0 12\nL1 in out 10u\n.control\nbad\n.endc\n</netlist>",
    "<parameters>not json</parameters>```\n* fenced\nV1 in 0 12\n```",
    "no tags at all",
]
VERIFY = [
    '{"status":"verified","summary":"  Vout is 12 V. ","evidence":[{"source":"x","analysis_type":"tran","claim":"c","observed":"o","supports":"verified"},"bad",{"supports":"maybe"}],"limitations":["", "l1", 5]}',
    '```json\n{"status":"failed","summary":"no","evidence":[]}\n```',
    '{"status":"great","summary":"s"}',
    '',
    'not json',
]


def main() -> int:
    if os.environ.get("PYTHONHASHSEED") != "0":
        env = {**os.environ, "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1"}
        return subprocess.call([sys.executable, "-B", *sys.argv], env=env)
    sys.path.insert(0, str(HERE.parents[3] / "qdonis-core"))
    with contextlib.redirect_stdout(io.StringIO()):
        from qdonis_backend import api_server as api
        from qdonis_backend import assistant_service as asv

    out = {"extract": [], "fix": [], "fix_prompt": [], "modify": [], "verify": []}
    for r in REPLIES:
        out["extract"].append({"raw": r, "text": api._extract_netlist_text(r)})
        original = DECK.replace("\r\n", "\n")
        cleaned = api._extract_netlist_text(r) or original
        _, tail = api._split_netlist_and_tail(original)
        if tail.strip():
            part, _ = api._split_netlist_and_tail(cleaned)
            cleaned = part.rstrip("\n") + "\n" + tail
        out["fix"].append({"reply": r, "deck": cleaned})
    for key, prompt in (("dc", ""), ("transient", "  add snubber  "), ("ac", "x")):
        out["fix_prompt"].append({"key": key, "prompt": prompt, "text": api._build_ai_fix_user_prompt(key, DECK, prompt)})
    params = {"Vin": "48 V", "n": 3, "x": 1.5, "é": ["ü"]}
    for raw in MODIFY:
        reasoning_match = re.search(r'<reasoning>(.*?)</reasoning>', raw, re.DOTALL)
        params_match = re.search(r'<parameters>(.*?)</parameters>', raw, re.DOTALL)
        parsed = {}
        if params_match:
            try:
                parsed = json.loads(params_match.group(1).strip())
            except Exception:
                parsed = {}
        netlist_match = re.search(r'<netlist>(.*?)</netlist>', raw, re.DOTALL)
        cleaned = netlist_match.group(1).strip() if netlist_match else (api._extract_netlist_text(raw) or DECK)
        original = DECK.replace("\r\n", "\n")
        _, tail = api._split_netlist_and_tail(original)
        if tail.strip():
            part, _ = api._split_netlist_and_tail(cleaned)
            cleaned = part.rstrip("\n") + "\n" + tail
        out["modify"].append({
            "raw": raw, "deck": cleaned,
            "reasoning": reasoning_match.group(1).strip() if reasoning_match else None,
            "parameters": parsed,
            "rows": [{"ref": k, "param": k, "before": None, "after": str(v)} for k, v in parsed.items()],
            "user": f"""
USER CONSTRAINTS:
{json.dumps(params, indent=2)}

USER MODIFICATION REQUEST:
make it better

CURRENT TRANSIENT NETLIST:
{DECK}
""",
        })
    for content in VERIFY:
        asv.bedrock_converse = lambda **kw: {"text": content, "usage": {}}
        asv.get_bedrock_model = lambda: "m"
        res = asv.verify_post_rerun("req", {"dc": "a"}, {"dc": "b"}, {"metadata": {}, "results": {}})
        v = res["verification"]
        if v["evidence"] and v["evidence"][0]["observed"] not in ("",) and v["status"] == "inconclusive" and len(v["evidence"]) == 1 and v["evidence"][0]["claim"].startswith("Verification could not"):
            v["evidence"][0]["observed"] = "<error>"  # exception text differs between languages
        out["verify"].append({"content": content, "verification": v})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
