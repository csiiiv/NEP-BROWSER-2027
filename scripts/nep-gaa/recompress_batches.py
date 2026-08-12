"""Recompress plain nep_*_batch_*.json files to .json.gz and remove originals."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from json_io import read_json, write_json

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


def recompress_dir(items_dir: Path, *, delete_plain: bool = True) -> int:
    count = 0
    for path in sorted(items_dir.glob("nep_*_batch_*.json")):
        if path.name.endswith(".gz"):
            continue
        out = path.with_name(path.name + ".gz")
        print(f"  {path.name} -> {out.name} ...", flush=True)
        data = read_json(path)
        write_json(out, data)
        before = path.stat().st_size
        after = out.stat().st_size
        print(f"    {before/1e6:.1f} MB -> {after/1e6:.1f} MB", flush=True)
        if delete_plain:
            path.unlink()
        count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data", type=Path,
        default=Path(__file__).resolve().parent.parent.parent / "data",
    )
    parser.add_argument("--keep-plain", action="store_true")
    args = parser.parse_args()

    budget = args.data / "budget"
    total = 0
    for year_dir in sorted(budget.iterdir()):
        items = year_dir / "items"
        if not items.is_dir():
            continue
        print(f"[{year_dir.name}] {items}", flush=True)
        total += recompress_dir(items, delete_plain=not args.keep_plain)
    print(f"Done. Recompressed {total} batch file(s).", flush=True)


if __name__ == "__main__":
    main()
