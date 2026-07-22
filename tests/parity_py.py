"""Parity-test helper.

Reads a JSON array of OpenSky state vectors on stdin and prints server.py's
normalized output as JSON on stdout. Kept tiny so the Node parity test
(parity.mjs) can diff it against the Edge Function's normalizeOpenSky().
server.py guards its listener behind `if __name__ == "__main__"`, so importing
_normalize_opensky here does not start the dev server.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from server import _normalize_opensky  # noqa: E402

print(json.dumps(_normalize_opensky(json.load(sys.stdin))))
