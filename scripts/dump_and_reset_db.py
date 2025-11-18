#!/usr/bin/env python3
"""Dump SQLite database data and optionally reset it."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from database import _init_db


def get_db_path() -> Path:
    """Get the database path from environment variable or default location."""
    # Check DATABASE_PATH environment variable first (same as Flask app)
    db_path_env = os.getenv("DATABASE_PATH")
    if db_path_env:
        return Path(db_path_env)
    
    # Default to user's .houselights directory
    db_dir = Path.home() / ".houselights"
    return db_dir / "houselights_v2.db"


def dump_database(db_path: Path, output_file: Path | None = None) -> None:
    """Dump all data from the database to a JSON file."""
    if not db_path.exists():
        print(f"Database not found at {db_path}")
        return

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # Get all table names
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    tables = [row[0] for row in cursor.fetchall()]

    dump_data = {
        "dumped_at": datetime.now().isoformat(),
        "database_path": str(db_path),
        "tables": {},
    }

    for table in tables:
        cursor.execute(f"SELECT * FROM {table}")
        rows = cursor.fetchall()
        dump_data["tables"][table] = [dict(row) for row in rows]
        print(f"Dumped {len(rows)} rows from {table}")

    conn.close()

    # Write to file
    if output_file is None:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_file = db_path.parent / f"houselights_v2_dump_{timestamp}.json"

    with open(output_file, "w") as f:
        json.dump(dump_data, f, indent=2, default=str)

    print(f"\nDatabase dump saved to: {output_file}")


def reset_database(db_path: Path, backup: bool = True) -> None:
    """Reset the database by dropping all tables and recreating schema."""
    if not db_path.exists():
        print(f"Database not found at {db_path}")
        return

    if backup:
        print("Creating backup before reset...")
        backup_path = db_path.parent / f"{db_path.name}.backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        import shutil
        shutil.copy2(db_path, backup_path)
        print(f"Backup created at: {backup_path}")

    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()

    # Get all table names
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    tables = [row[0] for row in cursor.fetchall()]

    # Drop all tables (in reverse dependency order to avoid foreign key issues)
    # We'll disable foreign keys temporarily
    cursor.execute("PRAGMA foreign_keys = OFF")
    
    for table in tables:
        cursor.execute(f"DROP TABLE IF EXISTS {table}")
        print(f"Dropped table: {table}")

    # Re-enable foreign keys
    cursor.execute("PRAGMA foreign_keys = ON")

    # Recreate schema
    print("\nRecreating database schema...")
    _init_db(conn)
    conn.commit()
    conn.close()

    print(f"\nDatabase reset complete: {db_path}")


def show_database_stats(db_path: Path) -> None:
    """Show statistics about the database."""
    if not db_path.exists():
        print(f"Database not found at {db_path}")
        return

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # Get all table names
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    tables = [row[0] for row in cursor.fetchall()]

    print(f"\nDatabase: {db_path}")
    print("=" * 60)
    
    for table in tables:
        cursor.execute(f"SELECT COUNT(*) as count FROM {table}")
        count = cursor.fetchone()["count"]
        print(f"{table:30} {count:>10} rows")

    # Check for duplicate local devices
    print("\n" + "=" * 60)
    print("Local Device Check:")
    cursor.execute("""
        SELECT scene_id, COUNT(*) as count
        FROM devices
        WHERE device_type = 'local'
        GROUP BY scene_id
        HAVING count > 1
    """)
    duplicates = cursor.fetchall()
    if duplicates:
        print("⚠️  Found duplicate local devices:")
        for row in duplicates:
            print(f"   Scene {row['scene_id']}: {row['count']} local devices")
    else:
        print("✓ No duplicate local devices found")

    # Show all local devices
    cursor.execute("""
        SELECT id, scene_id, ip_address, created_at
        FROM devices
        WHERE device_type = 'local'
        ORDER BY scene_id, created_at
    """)
    local_devices = cursor.fetchall()
    if local_devices:
        print(f"\nAll local devices ({len(local_devices)}):")
        for row in local_devices:
            print(f"   {row['id']} (scene: {row['scene_id']}, ip: {row['ip_address']}, created: {row['created_at']})")

    conn.close()


def main():
    parser = argparse.ArgumentParser(
        description="Dump and reset SQLite database for House Lights v2"
    )
    parser.add_argument(
        "--db-path",
        type=Path,
        default=None,
        help="Path to database file (default: DATABASE_PATH env var or ~/.houselights/houselights_v2.db)",
    )
    parser.add_argument(
        "--dump",
        action="store_true",
        help="Dump database to JSON file",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output file for dump (default: auto-generated with timestamp)",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Reset database (drops all tables and recreates schema)",
    )
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="Skip backup when resetting (not recommended)",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip confirmation prompt (use with caution)",
    )
    parser.add_argument(
        "--stats",
        action="store_true",
        help="Show database statistics",
    )

    args = parser.parse_args()

    db_path = args.db_path or get_db_path()

    if args.stats:
        show_database_stats(db_path)
    elif args.dump:
        dump_database(db_path, args.output)
    elif args.reset:
        if args.yes:
            reset_database(db_path, backup=not args.no_backup)
        else:
            confirm = input(
                f"⚠️  This will DELETE ALL DATA from {db_path}\n"
                "Are you sure you want to continue? (yes/no): "
            )
            if confirm.lower() == "yes":
                reset_database(db_path, backup=not args.no_backup)
            else:
                print("Reset cancelled.")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()

