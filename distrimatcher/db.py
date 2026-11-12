"""Local SQLite storage – all data stays on this computer."""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import threading
from pathlib import Path

_lock = threading.RLock()


def data_dir() -> Path:
    env = os.environ.get("DISTRIMATCHER_DATA")
    if env:
        p = Path(env)
    elif sys.platform == "win32":
        p = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Distrimatcher"
    elif sys.platform == "darwin":
        p = Path.home() / "Library" / "Application Support" / "Distrimatcher"
    else:
        p = Path.home() / ".local" / "share" / "distrimatcher"
    p.mkdir(parents=True, exist_ok=True)
    return p


SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    sha256 TEXT UNIQUE NOT NULL,
    uploaded_at TEXT DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT,
    pages INTEGER,
    ocr_pages INTEGER,
    ocr_fixes TEXT,
    text TEXT,
    extraction TEXT,
    edited INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS universe (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    umbrella TEXT,
    fund_id TEXT,
    fund_name TEXT NOT NULL,
    class_id TEXT,
    class_name TEXT,
    isin TEXT,
    ticker TEXT,
    lei TEXT,
    currency TEXT,
    retro TEXT,
    origin TEXT,
    origin_url TEXT,
    loaded_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS watch (
    key TEXT PRIMARY KEY,
    first_seen TEXT DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'open',
    doc_id INTEGER,
    note TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),
    kind TEXT NOT NULL,
    message TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_universe ON universe(source, IFNULL(fund_id,''), fund_name, IFNULL(class_id,''), IFNULL(class_name,''), IFNULL(isin,''));
"""


class DB:
    def __init__(self, path: Path | None = None):
        self.path = path or data_dir() / "distrimatcher.sqlite"
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        with _lock:
            self.conn.executescript(SCHEMA)
            self.conn.execute("PRAGMA journal_mode=WAL")
            cols = {r[1] for r in self.conn.execute("PRAGMA table_info(universe)")}
            for col in ("retro", "origin", "origin_url"):  # migrate older databases
                if col not in cols:
                    self.conn.execute(f"ALTER TABLE universe ADD COLUMN {col} TEXT")
            self.conn.commit()

    # -------------------------------------------------------------- Dokumente
    def add_document(self, filename: str, sha256: str) -> tuple[int, bool]:
        with _lock:
            row = self.conn.execute("SELECT id FROM documents WHERE sha256=?", (sha256,)).fetchone()
            if row:
                return row["id"], False
            cur = self.conn.execute("INSERT INTO documents(filename, sha256) VALUES (?,?)", (filename, sha256))
            self.conn.commit()
            return cur.lastrowid, True

    def update_document(self, doc_id: int, **fields) -> None:
        if "extraction" in fields and not isinstance(fields["extraction"], str):
            fields["extraction"] = json.dumps(fields["extraction"], ensure_ascii=False)
        if "ocr_fixes" in fields and not isinstance(fields["ocr_fixes"], str):
            fields["ocr_fixes"] = json.dumps(fields["ocr_fixes"])
        cols = ", ".join(f"{k}=?" for k in fields)
        with _lock:
            self.conn.execute(f"UPDATE documents SET {cols} WHERE id=?", (*fields.values(), doc_id))
            self.conn.commit()

    def _doc(self, row: sqlite3.Row, with_text: bool) -> dict:
        d = dict(row)
        d["extraction"] = json.loads(d["extraction"]) if d.get("extraction") else None
        d["ocr_fixes"] = json.loads(d["ocr_fixes"]) if d.get("ocr_fixes") else []
        if not with_text:
            d.pop("text", None)
        return d

    def documents(self, with_text: bool = False) -> list[dict]:
        with _lock:
            rows = self.conn.execute("SELECT * FROM documents ORDER BY id").fetchall()
        return [self._doc(r, with_text) for r in rows]

    def document(self, doc_id: int) -> dict | None:
        with _lock:
            row = self.conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        return self._doc(row, True) if row else None

    def delete_document(self, doc_id: int) -> None:
        with _lock:
            self.conn.execute("DELETE FROM documents WHERE id=?", (doc_id,))
            self.conn.commit()

    # -------------------------------------------------------------- Universum
    def add_universe(self, records: list[dict]) -> int:
        cols = ["source", "umbrella", "fund_id", "fund_name", "class_id", "class_name", "isin", "ticker", "lei", "currency", "retro", "origin", "origin_url"]
        with _lock:
            before = self.conn.total_changes
            self.conn.executemany(
                f"INSERT OR IGNORE INTO universe({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                [tuple(r.get(c) for c in cols) for r in records],
            )
            self.conn.commit()
            return self.conn.total_changes - before

    def universe(self) -> list[dict]:
        with _lock:
            return [dict(r) for r in self.conn.execute("SELECT * FROM universe ORDER BY umbrella, fund_name, class_name")]

    def universe_summary(self) -> list[dict]:
        with _lock:
            return [dict(r) for r in self.conn.execute(
                "SELECT source, umbrella, COUNT(DISTINCT IFNULL(fund_id, fund_name)) AS funds, COUNT(*) AS classes, "
                "MAX(loaded_at) AS loaded_at FROM universe GROUP BY source, umbrella ORDER BY source, umbrella"
            )]

    def delete_universe(self, source: str | None = None, umbrella: str | None = None) -> None:
        q, args = "DELETE FROM universe WHERE 1=1", []
        if source:
            q += " AND source=?"
            args.append(source)
        if umbrella:
            q += " AND umbrella=?"
            args.append(umbrella)
        with _lock:
            self.conn.execute(q, args)
            self.conn.commit()

    # -------------------------------------------------------------- Watchlist
    def watch_states(self) -> dict[str, dict]:
        with _lock:
            return {r["key"]: dict(r) for r in self.conn.execute("SELECT * FROM watch")}

    def watch_seen(self, keys: list[str]) -> None:
        with _lock:
            self.conn.executemany("INSERT OR IGNORE INTO watch(key) VALUES (?)", [(k,) for k in keys])
            self.conn.commit()

    def watch_set(self, key: str, status: str, doc_id: int | None = None, note: str | None = None) -> None:
        with _lock:
            self.conn.execute("INSERT OR IGNORE INTO watch(key) VALUES (?)", (key,))
            self.conn.execute(
                "UPDATE watch SET status=?, doc_id=?, note=COALESCE(?, note), updated_at=datetime('now') WHERE key=?",
                (status, doc_id, note, key),
            )
            self.conn.commit()

    # -------------------------------------------------------------- Activity log
    def log(self, kind: str, message: str) -> None:
        with _lock:
            self.conn.execute("INSERT INTO events(kind, message) VALUES (?,?)", (kind, message))
            self.conn.commit()

    def events(self, limit: int = 500) -> list[dict]:
        with _lock:
            return [dict(r) for r in self.conn.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,))]

    def reset(self) -> None:
        with _lock:
            for t in ("documents", "universe", "watch", "events"):
                self.conn.execute(f"DELETE FROM {t}")
            self.conn.commit()
