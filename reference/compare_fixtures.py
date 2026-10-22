"""Compare regenerated fixtures with the committed ones.

Byte-identical files are reported as such. Otherwise every number must agree to 1e-12 relative (NumPy may pick
different SIMD kernels on another CPU, which can change the last bits); structure and text must match exactly.
Usage: python reference/compare_fixtures.py <committed_dir> <regenerated_dir>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

RTOL = 1e-12


def compare(a, b, path: str, worst: list) -> None:
    if isinstance(a, dict) and isinstance(b, dict):
        if a.keys() != b.keys():
            raise AssertionError(f"{path}: keys differ")
        for k in a:
            compare(a[k], b[k], f"{path}.{k}", worst)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            raise AssertionError(f"{path}: lengths differ ({len(a)} vs {len(b)})")
        for i, (x, y) in enumerate(zip(a, b)):
            compare(x, y, f"{path}[{i}]", worst)
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        scale = max(abs(a), abs(b), 1e-300)
        rel = abs(a - b) / scale
        if rel > worst[0]:
            worst[0] = rel
        if rel > RTOL and abs(a - b) > 1e-300:
            raise AssertionError(f"{path}: {a} vs {b} (relative {rel:.2e})")
    elif a != b:
        raise AssertionError(f"{path}: {a!r} vs {b!r}")


def main() -> int:
    committed, regenerated = Path(sys.argv[1]), Path(sys.argv[2])
    failed = False
    for old in sorted(committed.glob("*.json")):
        new = regenerated / old.name
        if not new.exists():
            print(f"MISSING  {old.name}")
            failed = True
            continue
        if old.read_bytes() == new.read_bytes():
            print(f"identical  {old.name}")
            continue
        worst = [0.0]
        try:
            compare(json.loads(old.read_text()), json.loads(new.read_text()), old.name, worst)
            print(f"equal within {RTOL:g}  {old.name} (largest relative difference {worst[0]:.1e})")
        except AssertionError as e:
            print(f"DIFFERENT  {e}")
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
