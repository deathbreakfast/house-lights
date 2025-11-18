"""Database models and initialization for House Lights v2."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any
from uuid import uuid4

from flask import Flask, g
import logging

logger = logging.getLogger(__name__)


def get_db(app: Flask) -> sqlite3.Connection:
    """
    Get or create database connection.
    
    Connection is automatically reused within the same Flask request context
    via Flask's 'g' object and closed at the end of the request.
    """
    if "db" not in g:
        db_path = app.config.get("DATABASE_PATH")
        if not db_path:
            # Default to user's .houselights directory
            db_dir = Path.home() / ".houselights"
            db_dir.mkdir(parents=True, exist_ok=True)
            db_path = db_dir / "houselights_v2.db"
        # Connection is created once per request and reused via Flask's g object
        # No need to log every connection - it's expected behavior
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
    # Note: scene_id column is deprecated and will be removed by migration (devices are now global)
    
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
    
    # These indexes are only created if scene_id columns exist (before migration)
    # They will be dropped during migration if they exist
    try:
        # Check if table exists and has scene_id column
        bg_info = db.execute("PRAGMA table_info(background_images)").fetchall()
        if bg_info:  # Table exists
            bg_columns = [row[1] for row in bg_info]
            if "scene_id" in bg_columns:
                db.execute("""
                    CREATE INDEX IF NOT EXISTS idx_background_images_scene_id 
                    ON background_images(scene_id)
                """)
    except sqlite3.OperationalError:
        pass
    
    try:
        # Check if table exists and has scene_id column
        devices_info = db.execute("PRAGMA table_info(devices)").fetchall()
        if devices_info:  # Table exists
            device_columns = [row[1] for row in devices_info]
            if "scene_id" in device_columns:
                db.execute("""
                    CREATE INDEX IF NOT EXISTS idx_devices_scene_id 
                    ON devices(scene_id)
                """)
    except sqlite3.OperationalError:
        pass
    
    db.execute("""
        CREATE INDEX IF NOT EXISTS idx_led_strips_device_id 
        ON led_strips(device_id)
    """)
    
    db.execute("""
        CREATE INDEX IF NOT EXISTS idx_leds_strip_id 
        ON leds(strip_id)
    """)

    db.execute("""
        CREATE TABLE IF NOT EXISTS device_handshakes (
            id TEXT PRIMARY KEY,
            device_id TEXT,
            ip_address TEXT,
            hardware_id TEXT,
            firmware_version TEXT,
            capabilities TEXT,
            strip_summary TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            clock_skew_ms INTEGER,
            requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            responded_at TIMESTAMP,
            error TEXT,
            FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
        )
    """)
    db.execute("""
        CREATE INDEX IF NOT EXISTS idx_device_handshakes_device_id
        ON device_handshakes(device_id)
    """)

    db.execute("""
        CREATE TABLE IF NOT EXISTS device_health (
            device_id TEXT PRIMARY KEY,
            last_seen_at TIMESTAMP,
            last_heartbeat_at TIMESTAMP,
            last_latency_ms INTEGER,
            clock_skew_ms INTEGER,
            ws_connected INTEGER NOT NULL DEFAULT 0,
            playlist_hash TEXT,
            metadata TEXT,
            FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
        )
    """)

    db.execute("""
        CREATE TABLE IF NOT EXISTS device_playlists (
            id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            playlist_hash TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            downloaded_at TIMESTAMP,
            expires_at TIMESTAMP,
            FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
        )
    """)
    db.execute("""
        CREATE INDEX IF NOT EXISTS idx_device_playlists_device_hash
        ON device_playlists(device_id, playlist_hash)
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
    
    # Migration: Remove scene_id from devices table (global devices)
    try:
        # Check if scene_id column exists
        devices_info = db.execute("PRAGMA table_info(devices)").fetchall()
        device_columns = [row[1] for row in devices_info]
        if "scene_id" in device_columns:
            # Create new table without scene_id
            db.execute("""
                CREATE TABLE IF NOT EXISTS devices_new (
                    id TEXT PRIMARY KEY,
                    position_x REAL NOT NULL,
                    position_y REAL NOT NULL,
                    ip_address TEXT NOT NULL,
                    device_type TEXT NOT NULL,
                    strip_mode TEXT NOT NULL DEFAULT 'auto',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            # Copy existing data (keep most recent device per device_id)
            db.execute("""
                INSERT INTO devices_new (id, position_x, position_y, ip_address, 
                                       device_type, strip_mode, created_at, updated_at)
                SELECT id, position_x, position_y, ip_address, device_type, strip_mode,
                       MIN(created_at) as created_at, MAX(updated_at) as updated_at
                FROM devices
                GROUP BY id
            """)
            # Drop old table and rename
            db.execute("DROP TABLE devices")
            db.execute("ALTER TABLE devices_new RENAME TO devices")
            # Drop old index
            try:
                db.execute("DROP INDEX IF EXISTS idx_devices_scene_id")
            except sqlite3.OperationalError:
                pass
    except sqlite3.OperationalError:
        # Migration already applied or table doesn't exist yet
        pass
    
    # Migration: Remove scene_id from background_images table (global background)
    try:
        # Check if scene_id column exists
        bg_info = db.execute("PRAGMA table_info(background_images)").fetchall()
        bg_columns = [row[1] for row in bg_info]
        if "scene_id" in bg_columns:
            # Create new table without scene_id
            db.execute("""
                CREATE TABLE IF NOT EXISTS background_images_new (
                    id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    content_type TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    scale INTEGER DEFAULT 100,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            # Copy existing data (keep studio background or most recent)
            db.execute("""
                INSERT INTO background_images_new (id, filename, content_type, file_path, scale, created_at)
                SELECT id, filename, content_type, file_path, scale, created_at
                FROM background_images
                ORDER BY 
                    CASE WHEN scene_id = '__studio_background__' THEN 0 ELSE 1 END,
                    created_at DESC
                LIMIT 1
            """)
            # Drop old table and rename
            db.execute("DROP TABLE background_images")
            db.execute("ALTER TABLE background_images_new RENAME TO background_images")
            # Drop old index
            try:
                db.execute("DROP INDEX IF EXISTS idx_background_images_scene_id")
            except sqlite3.OperationalError:
                pass
    except sqlite3.OperationalError:
        # Migration already applied or table doesn't exist yet
        pass
    
    # Ensure at least one default scene exists
    _ensure_default_scene(db)
    
    db.commit()


def _ensure_default_scene(db: sqlite3.Connection) -> None:
    """Ensure at least one default scene exists in the database."""
    # Check if any scenes exist (excluding studio background scene)
    # Try to import the constant, but fall back to hardcoded value for script contexts
    try:
        from .server.config import STUDIO_BACKGROUND_SCENE_ID
    except ImportError:
        # Fallback for when running outside package context (e.g., from scripts)
        STUDIO_BACKGROUND_SCENE_ID = "__studio_background__"
    
    row = db.execute(
        """
        SELECT COUNT(*) as count
        FROM scenes
        WHERE id != ?
        """,
        (STUDIO_BACKGROUND_SCENE_ID,),
    ).fetchone()
    
    # Handle both Row objects (from Flask context) and tuples (from scripts)
    if row is None:
        scene_count = 0
    else:
        # Try to access as Row object first, fall back to tuple index
        try:
            scene_count = row["count"]
        except (TypeError, KeyError):
            # If it's a tuple, access by index
            scene_count = row[0] if row else 0
    
    # If no scenes exist, create a default one
    if scene_count == 0:
        scene_id = f"scene-{uuid4().hex}"
        db.execute(
            """
            INSERT INTO scenes (id, name, power_on, data)
            VALUES (?, ?, 0, ?)
            """,
            (scene_id, "Scene 1", "{}"),
        )
        logger.info("Created default scene: %s", scene_id)


def init_app(app: Flask) -> None:
    """Initialize database for Flask app."""
    app.teardown_appcontext(close_db)

