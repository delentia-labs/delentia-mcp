"""
Standalone Python script proving the REVERSE direction of the TS<->Python
bridge for real: this script (real Python, run as its own process, not
mocked) makes real HTTP calls against a real running TS/Cloudflare Worker
dev server (packages/intent-loop, started via `wrangler dev --local` by
tests/reverse_bridge.test.mjs) to query GET /rctdb/query - the reverse of
every other bridge in this repo, which all have TS calling INTO Python.

Exits 0 and prints a JSON summary on success; exits 1 with a message on
any assertion failure. Invoked as:
    python reverse_bridge_check.py <base_url> <correct_api_key>
"""

import json
import sys
import urllib.error
import urllib.request


def http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def main():
    base_url = sys.argv[1]
    correct_key = sys.argv[2]
    results = {}

    # 1. No API key at all -> 401, not a silent bypass.
    status, body = http_get(f"{base_url}/rctdb/query?session_id=py-reverse-test")
    assert status == 401, f"expected 401 with no key, got {status}: {body}"
    results["no_key_rejected"] = True

    # 2. Wrong API key -> 401, real comparison, not "any non-empty header".
    status, body = http_get(
        f"{base_url}/rctdb/query?session_id=py-reverse-test",
        headers={"x-bridge-api-key": "definitely-wrong-key"},
    )
    assert status == 401, f"expected 401 with wrong key, got {status}: {body}"
    results["wrong_key_rejected"] = True

    # 3. Correct key but missing session_id -> 400, real validation.
    status, body = http_get(f"{base_url}/rctdb/query", headers={"x-bridge-api-key": correct_key})
    assert status == 400, f"expected 400 with missing session_id, got {status}: {body}"
    results["missing_session_id_rejected"] = True

    # 4. Correct key + a real (never-used) session_id -> 200 with a
    # genuinely empty entries list. This is Python making a real,
    # successful, authenticated HTTP call into the TS kernel's own RCTDB
    # Durable Object and getting back its real (honestly empty, since
    # nothing has ever been logged for this session_id - no real
    # OPENROUTER_API_KEY is available in this environment to drive a full
    # run_intent_loop call that would populate real entries) response.
    status, body = http_get(
        f"{base_url}/rctdb/query?session_id=py-reverse-test",
        headers={"x-bridge-api-key": correct_key},
    )
    assert status == 200, f"expected 200 with correct key + session_id, got {status}: {body}"
    assert body["session_id"] == "py-reverse-test"
    assert body["entries"]["entries"] == []
    assert body["entries"]["total"] == 0
    results["authenticated_query_succeeded"] = True

    print(json.dumps(results))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
