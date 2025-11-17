#!/usr/bin/env python3
"""
Migration script to refactor devices and background images from per-scene to global.

This script:
1. Consolidates duplicate devices across scenes (keeps most recent version per device_id)
2. Consolidates background images to single global record
3. Removes scene_id foreign key from devices and background_images tables
4. Drops scene_id indexes
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from typing import Any


def get_db_path() -> Path:
    """Get database path from environment or default location."""
    db_path_env = Path(os.getenv("DATABASE_PATH", ""))
    if db_path_env.exists():
        return db_path_env
    
    # Default to user's .houselights directory
    db_dir = Path.home() / ".houselights"
    db_path = db_dir / "houselights_v2.db"
    return db_path


def migrate_devices(db: sqlite3.Connection) -> None:
    """Migrate devices from per-scene to global."""
    print("Migrating devices to global scope...")
    
    # Get all devices grouped by device_id
    devices_by_id = {}
    rows = db.execute("""
        SELECT id, scene_id, position_x, position_y, ip_address, 
               device_type, strip_mode, updated_at, created_at
        FROM devices
        ORDER BY updated_at DESC, created_at DESC
    """).fetchall()
    
    for row in rows:
        device_id = row["id"]
        if device_id not in devices_by_id:
            # Keep first occurrence (most recent due to ORDER BY)
            devices_by_id[device_id] = row
            print(f"  Keeping device {device_id} (from scene {row['scene_id']})")
        else:
            print(f"  Skipping duplicate device {device_id} (from scene {row['scene_id']})")
    
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
    
    # Insert consolidated devices
    for device_id, row in devices_by_id.items():
        db.execute("""
            INSERT INTO devices_new (id, position_x, position_y, ip_address, 
                                   device_type, strip_mode, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            row["id"],
            row["position_x"],
            row["position_y"],
            row["ip_address"],
            row["device_type"],
            row["strip_mode"],
            row["created_at"],
            row["updated_at"],
        ))
    
    # Drop old table and rename new one
    db.execute("DROP TABLE IF EXISTS devices")
    db.execute("ALTER TABLE devices_new RENAME TO devices")
    
    # Drop scene_id index if it exists
    try:
        db.execute("DROP INDEX IF EXISTS idx_devices_scene_id")
    except sqlite3.OperationalError:
        pass
    
    print(f"  Migrated {len(devices_by_id)} devices to global scope")


def migrate_background_images(db: sqlite3.Connection, studio_scene_id: str) -> None:
    """Migrate background images from per-scene to global."""
    print("Migrating background images to global scope...")
    
    # Get all background images, prioritize studio background scene
    rows = db.execute("""
        SELECT id, scene_id, filename, content_type, file_path, scale, created_at
        FROM background_images
        ORDER BY 
            CASE WHEN scene_id = ? THEN 0 ELSE 1 END,
            created_at DESC
    """, (studio_scene_id,)).fetchall()
    
    if not rows:
        print("  No background images found")
        # Still create the new table structure
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
        db.execute("DROP TABLE IF EXISTS background_images")
        db.execute("ALTER TABLE background_images_new RENAME TO background_images")
        return
    
    # Keep the first one (studio background or most recent)
    kept = rows[0]
    print(f"  Keeping background image {kept['id']} (from scene {kept['scene_id']})")
    
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
    
    # Insert the kept background image
    db.execute("""
        INSERT INTO background_images_new (id, filename, content_type, file_path, scale, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        kept["id"],
        kept["filename"],
        kept["content_type"],
        kept["file_path"],
        kept["scale"],
        kept["created_at"],
    ))
    
    # Drop old table and rename new one
    db.execute("DROP TABLE IF EXISTS background_images")
    db.execute("ALTER TABLE background_images_new RENAME TO background_images")
    
    # Drop scene_id index if it exists
    try:
        db.execute("DROP INDEX IF EXISTS idx_background_images_scene_id")
    except sqlite3.OperationalError:
        pass
    
    print(f"  Migrated 1 background image to global scope")
    print(f"  Deleted {len(rows) - 1} duplicate background images")


def verify_migration(db: sqlite3.Connection) -> None:
    """Verify migration completed successfully."""
    print("\nVerifying migration...")
    
    # Check devices table structure
    devices_info = db.execute("PRAGMA table_info(devices)").fetchall()
    device_columns = [row[1] for row in devices_info]
    
    if "scene_id" in device_columns:
        print("  ERROR: devices table still has scene_id column")
        return False
    else:
        print("  ✓ devices table structure correct")
    
    # Check background_images table structure
    bg_info = db.execute("PRAGMA table_info(background_images)").fetchall()
    bg_columns = [row[1] for row in bg_info]
    
    if "scene_id" in bg_columns:
        print("  ERROR: background_images table still has scene_id column")
        return False
    else:
        print("  ✓ background_images table structure correct")
    
    # Check device count
    device_count = db.execute("SELECT COUNT(*) as cnt FROM devices").fetchone()["cnt"]
    print(f"  ✓ {device_count} devices in global scope")
    
    # Check background image count (should be 0 or 1)
    bg_count = db.execute("SELECT COUNT(*) as cnt FROM background_images").fetchone()["cnt"]
    if bg_count > 1:
        print(f"  WARNING: {bg_count} background images found (expected 0 or 1)")
    else:
        print(f"  ✓ {bg_count} background image(s) in global scope")
    
    return True


def main() -> int:
    """Run migration."""
    import os
    
    db_path = get_db_path()
    
    if not db_path.exists():
        print(f"ERROR: Database not found at {db_path}")
        return 1
    
    print(f"Migrating database: {db_path}")
    print("=" * 60)
    
    # Ask for confirmation
    response = input("\nThis will modify your database. Continue? (yes/no): ")
    if response.lower() not in {"yes", "y"}:
        print("Migration cancelled.")
        return 0
    
    # Create backup
    backup_path = db_path.with_suffix(".db.backup")
    print(f"\nCreating backup: {backup_path}")
    import shutil
    shutil.copy2(db_path, backup_path)
    print("  Backup created")
    
    try:
        # Connect to database
        db = sqlite3.connect(str(db_path))
        db.row_factory = sqlite3.Row
        
        # Run migrations
        migrate_devices(db)
        migrate_background_images(db, "__studio_background__")
        
        # Verify
        if not verify_migration(db):
            print("\nERROR: Migration verification failed!")
            db.rollback()
            return 1
        
        # Commit changes
        db.commit()
        db.close()
        
        print("\n" + "=" * 60)
        print("Migration completed successfully!")
        print(f"Backup saved at: {backup_path}")
        return 0
        
    except Exception as e:
        print(f"\nERROR: Migration failed: {e}")
        import traceback
        traceback.print_exc()
        print(f"\nDatabase backup available at: {backup_path}")
        return 1


if __name__ == "__main__":
    sys.exit(main())

