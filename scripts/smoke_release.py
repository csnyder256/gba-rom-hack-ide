"""Start the compiled local app and check the frontend's API/isolation boundary."""
import json, subprocess, time, urllib.request
from pathlib import Path
root = Path(__file__).resolve().parents[1]
p = subprocess.Popen(["node", "scripts/start-release.mjs"], cwd=root)
try:
    for attempt in range(40):
        try:
            with urllib.request.urlopen("http://127.0.0.1:5173/", timeout=2) as r:
                assert r.headers["Cross-Origin-Opener-Policy"] == "same-origin"
                assert r.headers["Cross-Origin-Embedder-Policy"] == "require-corp"
                assert b'<html' in r.read().lower()
            with urllib.request.urlopen("http://127.0.0.1:5173/api/health", timeout=3) as api:
                assert api.status == 200
            break
        except OSError: time.sleep(1)
    else: raise RuntimeError("Frontend failed to start")
    with urllib.request.urlopen("http://127.0.0.1:5173/api/health", timeout=3) as r:
        assert r.status == 200
    print("Compiled frontend, API proxy and isolation headers verified")
finally:
    p.terminate()
    p.wait(timeout=15)
