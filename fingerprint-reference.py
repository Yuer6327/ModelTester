#!/usr/bin/env python
"""
Fingerprint reference comparator (dev tool).

Loads one or more usage snapshots produced by fingerprint-drill.mjs, tokenizes
the same probe texts locally with each vendor's OFFICIAL tokenizer.json
(HF tokenizers lib), and compares the delta vectors to identify which
tokenizer family the target model's usage accounting matches.

Usage:
  python fingerprint-reference.py <snapshot.json> [older-snapshot.json]

Tokenizer reference files are read from .attr-corpus/tokenizers-json/<vendor>.json
(download from the vendors' HF repos once; see .attr-corpus/tokenizers/ notes).
"""
import json
import sys
import glob
import os
from pathlib import Path

ROOT = Path(__file__).parent
REF_DIR = ROOT / ".attr-corpus" / "tokenizers-json"


def local_counts(vendor: str, tok, texts: dict) -> dict:
    out = {}
    for tid, text in texts.items():
        try:
            out[tid] = len(tok.encode(text).ids)
        except Exception as exc:  # noqa: BLE001
            out[tid] = None
    return out


def deltas_of(counts: dict) -> dict:
    base = counts.get("T0")
    if base is None:
        return {}
    return {k: v - base for k, v in counts.items() if k != "T0" and v is not None}


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    from tokenizers import Tokenizer  # noqa: PLC0415

    snap_paths = sys.argv[1:]
    snaps = [json.loads(Path(p).read_text(encoding="utf-8")) for p in snap_paths]
    texts = json.loads((ROOT / "fingerprint-texts.json").read_text(encoding="utf-8"))["texts"]

    # Sanity: snapshot text lengths should match local probe texts. JS snapshots
    # may count UTF-16 code units instead of code points — warn, don't skip.
    for snap in snaps:
        if snap.get("chars") != {k: len(v) for k, v in texts.items()}:
            print("WARNING: snapshot char lengths differ from fingerprint-texts.json (UTF-16 vs code points?) — continuing")

    refs = {}
    for f in sorted(REF_DIR.glob("*.json")):
        vendor = f.stem
        try:
            refs[vendor] = Tokenizer.from_file(str(f))
        except Exception as exc:  # noqa: BLE001
            print(f"(skip {vendor}: {exc})")
    if not refs:
        print(f"No tokenizer.json references found in {REF_DIR}")
        sys.exit(2)

    for snap in snaps:
        usage = snap.get("usage", {})
        if any(k not in usage for k in ("T0", "T1", "T2", "T3", "T4", "T5")):
            print(f"--- {snap.get('model')}: incomplete usage, skipping")
            continue
        api_delta = snap.get("deltas", {})
        print(f"\n=== {snap.get('model')} @ {snap.get('capturedAt')} | api deltas {api_delta}")
        rows = []
        for vendor, tok in refs.items():
            counts = local_counts(vendor, tok, texts)
            ref_delta = deltas_of(counts)
            if set(ref_delta) != set(api_delta):
                continue
            l1 = sum(abs(ref_delta[k] - api_delta[k]) for k in api_delta)
            rows.append((l1, vendor, counts, ref_delta))
        rows.sort(key=lambda r: r[0])
        for l1, vendor, counts, ref_delta in rows:
            mark = "  <-- MATCH" if l1 == 0 else ""
            print(f"  {vendor:<10} L1={l1:<3} ref deltas {ref_delta}{mark}")
        if rows and rows[0][0] == 0:
            print(f"  >>> verdict: tokenizer family = {rows[0][1]} (exact delta match)")
        else:
            print("  >>> verdict: no exact match — gateway counter or wrapper normalization differs")


if __name__ == "__main__":
    main()
