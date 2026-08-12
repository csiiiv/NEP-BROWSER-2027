"""Shared JSON / JSON.GZ helpers for NEP converters and browser assets."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any, Iterable, List, Union


def write_json(path: Path, data: Any, *, pretty: bool = False) -> None:
    """Write JSON. If path ends with .gz, write gzip-compressed JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if _is_gzip_path(path):
        with gzip.open(path, "wt", encoding="utf-8") as f:
            if pretty:
                json.dump(data, f, indent=2, ensure_ascii=False)
            else:
                json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    else:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)


def read_json(path: Path) -> Any:
    """Read JSON or gzip-compressed JSON."""
    if _is_gzip_path(path):
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def iter_json_array(path: Path) -> Iterable[Any]:
    """Yield elements from a top-level JSON array file (.json or .json.gz)."""
    data = read_json(path)
    if not isinstance(data, list):
        raise ValueError(f"Expected JSON array in {path}")
    for item in data:
        yield item


def find_batch_files(items_dir: Path, fiscal_year: str) -> List[Path]:
    """Prefer .json.gz batches; fall back to plain .json."""
    gz = sorted(items_dir.glob(f"nep_{fiscal_year}_batch_*.json.gz"))
    if gz:
        return gz
    return sorted(items_dir.glob(f"nep_{fiscal_year}_batch_*.json"))


def _is_gzip_path(path: Path) -> bool:
    name = path.name.lower()
    return name.endswith(".gz") or name.endswith(".json.gz")
