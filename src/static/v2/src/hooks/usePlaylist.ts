/** Hook for managing scene playlist. */

import { useState, useEffect, useRef, useCallback } from "react";
import type { ScenePlaylistEntry } from "../types/editor";
import { createClientId } from "../utils/devices";

export const usePlaylist = () => {
  const [playlistEntries, setPlaylistEntries] = useState<ScenePlaylistEntry[]>([]);
  const playlistSaveTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const loadPlaylist = async () => {
      try {
        const response = await fetch("/api/v2/scene-playlist");
        if (response.ok) {
          const data = await response.json();
          setPlaylistEntries(
            data.map((entry: ScenePlaylistEntry, index: number) => ({
              ...entry,
              position: entry.position ?? index,
            }))
          );
        }
      } catch (error) {
        console.error("Error loading scene playlist:", error);
      }
    };
    loadPlaylist();

    return () => {
      if (playlistSaveTimeoutRef.current !== null) {
        window.clearTimeout(playlistSaveTimeoutRef.current);
      }
    };
  }, []);

  const queuePlaylistSave = useCallback(
    (entries: ScenePlaylistEntry[]) => {
      if (playlistSaveTimeoutRef.current !== null) {
        window.clearTimeout(playlistSaveTimeoutRef.current);
      }
      playlistSaveTimeoutRef.current = window.setTimeout(() => {
        fetch("/api/v2/scene-playlist", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ entries }),
        }).catch((error) =>
          console.error("Error saving scene playlist:", error)
        );
      }, 400);
    },
    []
  );

  const handlePlaylistReorder = useCallback(
    (entries: ScenePlaylistEntry[]) => {
      const normalized = entries.map((entry, index) => ({
        ...entry,
        position: index,
      }));
      setPlaylistEntries(normalized);
      queuePlaylistSave(normalized);
    },
    [queuePlaylistSave]
  );

  const handleAddSceneToPlaylist = useCallback(
    (sceneId: string) => {
      setPlaylistEntries((prev) => {
        const newEntry: ScenePlaylistEntry = {
          id: createClientId("playlist"),
          sceneId,
          position: prev.length,
          playDurationSeconds: 60,
          fadeDurationSeconds: 5,
        };
        const next = [...prev, newEntry].map((entry, index) => ({
          ...entry,
          position: index,
        }));
        queuePlaylistSave(next);
        return next;
      });
    },
    [queuePlaylistSave]
  );

  const handleUpdatePlaylistEntry = useCallback(
    (
      entryId: string,
      updates: Partial<
        Pick<ScenePlaylistEntry, "playDurationSeconds" | "fadeDurationSeconds">
      >
    ) => {
      setPlaylistEntries((prev) => {
        const next = prev.map((entry) =>
          entry.id === entryId ? { ...entry, ...updates } : entry
        );
        queuePlaylistSave(next);
        return next;
      });
    },
    [queuePlaylistSave]
  );

  const handleRemovePlaylistEntry = useCallback(
    (entryId: string) => {
      setPlaylistEntries((prev) => {
        const filtered = prev
          .filter((entry) => entry.id !== entryId)
          .map((entry, index) => ({ ...entry, position: index }));
        queuePlaylistSave(filtered);
        return filtered;
      });
    },
    [queuePlaylistSave]
  );

  const handleRemovePlaylistEntriesBySceneId = useCallback(
    (sceneId: string) => {
      setPlaylistEntries((prev) => {
        const filtered = prev
          .filter((entry) => entry.sceneId !== sceneId)
          .map((entry, index) => ({ ...entry, position: index }));
        queuePlaylistSave(filtered);
        return filtered;
      });
    },
    [queuePlaylistSave]
  );

  return {
    playlistEntries,
    handlePlaylistReorder,
    handleAddSceneToPlaylist,
    handleUpdatePlaylistEntry,
    handleRemovePlaylistEntry,
    handleRemovePlaylistEntriesBySceneId,
  };
};

