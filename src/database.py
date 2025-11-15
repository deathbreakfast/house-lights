"""Database models and initialization for House Lights v2."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from flask import Flask, g


def get_db(app: Flask) -> sqlite3.Connection:
    """Get or create database connection."""
    if "db" not in g:
        db_path = app.config.get("DATABASE_PATH")
        if not db_path:
            # Default to user's .houselights directory
            db_dir = Path.home() / ".houselights"
            db_dir.mkdir(parents=True, exist_ok=True)
            db_path = db_dir / "houselights_v2.db"
        
        g.db = sqlite3.connect(str(db_path), check_same_thread=False)
        g.db.row_factory = sqlite3.Row
        _init_db(g.db)
    
    return g.db


def close_db(_error: Any = None) -> None:
    """Close database connection."""
    db = g.pop("db", None)
    if db is not None:
        db.close()


def _init_db(db: sqlite3.Connection) -> None:
    """Initialize database schema."""
    db.execute("""
        CREATE TABLE IF NOT EXISTS scenes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            power_on INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            data TEXT NOT NULL
        )
    """)
    
    # Add power_on column if it doesn't exist (migration for existing databases)
    try:
        db.execute("ALTER TABLE scenes ADD COLUMN power_on INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        # Column already exists, ignore
        pass
    
    db.execute("""
        CREATE TABLE IF NOT EXISTS background_images (
            id TEXT PRIMARY KEY,
            scene_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            content_type TEXT NOT NULL,
            file_path TEXT NOT NULL,
            scale INTEGER DEFAULT 100,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
        )
    """)
    
    db.execute("""
        CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY,
            scene_id TEXT NOT NULL,
            position_x REAL NOT NULL,
            position_y REAL NOT NULL,
            ip_address TEXT NOT NULL,
            device_type TEXT NOT NULL,
            strip_mode TEXT NOT NULL DEFAULT 'auto',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
        )
    """)
    
    db.execute("""
        CREATE TABLE IF NOT EXISTS led_strips (
            id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            gpio_pin INTEGER NOT NULL,
            led_count INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
        )
    """)
    
    db.execute("""
        CREATE TABLE IF NOT EXISTS leds (
            id TEXT PRIMARY KEY,
            strip_id TEXT NOT NULL,
            position_x REAL NOT NULL,
            position_y REAL NOT NULL,
            color TEXT NOT NULL DEFAULT '#ffffff',
            opacity REAL NOT NULL DEFAULT 1.0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (strip_id) REFERENCES led_strips(id) ON DELETE CASCADE
        )
    """)
    
    db.execute("""
        CREATE INDEX IF NOT EXISTS idx_background_images_scene_id 
        ON background_images(scene_id)
    """)
    
    db.execute("""
        CREATE INDEX IF NOT EXISTS idx_devices_scene_id 
        ON devices(scene_id)
    """)
    
    db.execute("""
        CREATE INDEX IF NOT EXISTS idx_led_strips_device_id 
        ON led_strips(device_id)
    """)
    
    db.execute("""
        CREATE INDEX IF NOT EXISTS idx_leds_strip_id 
        ON leds(strip_id)
    """)
    
    db.execute("""
        CREATE TABLE IF NOT EXISTS scene_keyframes (
            id TEXT PRIMARY KEY,
            scene_id TEXT NOT NULL,
            timestamp_ms INTEGER NOT NULL,
            effects_fade_in INTEGER DEFAULT 0,
            effects_fade_out INTEGER DEFAULT 0,
            led_states TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
        )
    """)
    
    db.execute("""
        CREATE INDEX IF NOT EXISTS idx_keyframes_scene_id
        ON scene_keyframes(scene_id)
    """)
    
    db.execute("""
        DELETE FROM scene_keyframes
        WHERE rowid NOT IN (
            SELECT MAX(rowid)
            FROM scene_keyframes
            GROUP BY scene_id, timestamp_ms
        )
    """)
    
    db.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS idx_keyframes_scene_timestamp
        ON scene_keyframes(scene_id, timestamp_ms)
    """)
    
    db.execute("""
        CREATE TABLE IF NOT EXISTS scene_playlist_entries (
            id TEXT PRIMARY KEY,
            scene_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            play_duration_seconds INTEGER NOT NULL DEFAULT 60,
            fade_duration_seconds INTEGER NOT NULL DEFAULT 5,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
        )
    """)
    
    db.execute("""
        CREATE INDEX IF NOT EXISTS idx_scene_playlist_position
        ON scene_playlist_entries(position)
    """)
    
    # Add scale column if it doesn't exist (migration for existing databases)
    try:
        db.execute("ALTER TABLE background_images ADD COLUMN scale INTEGER DEFAULT 100")
    except sqlite3.OperationalError:
        # Column already exists, ignore
        pass
    
    db.commit()


def init_app(app: Flask) -> None:
    """Initialize database for Flask app."""
    app.teardown_appcontext(close_db)

