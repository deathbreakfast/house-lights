/** Hook for managing keyboard shortcuts. */

import { useEffect } from "react";
import type { Tool, EditorMode } from "../types/editor";

type UseKeyboardShortcutsOptions = {
  mode: EditorMode;
  selectedKeyframeId: string | null;
  setTool: (tool: Tool) => void;
  handleDeleteKeyframe: () => void;
  handlePlayPause: () => void;
  undo: () => void;
};

export const useKeyboardShortcuts = ({
  mode,
  selectedKeyframeId,
  setTool,
  handleDeleteKeyframe,
  handlePlayPause,
  undo,
}: UseKeyboardShortcutsOptions) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }

      const isUndoShortcut =
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "z";
      if (isUndoShortcut) {
        event.preventDefault();
        undo();
        return;
      }

      // Don't trigger if modifier keys are pressed (except for undo handled above)
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      switch (event.key.toLowerCase()) {
        case "p":
          event.preventDefault();
          setTool("pan");
          break;
        case "m":
          event.preventDefault();
          if (mode === "edit") {
            setTool("move");
          }
          break;
        case "s":
          event.preventDefault();
          setTool("select");
          break;
        case "b":
          if (mode === "paint") {
            event.preventDefault();
            setTool("paint");
          }
          break;
        case "f":
          if (mode === "paint") {
            event.preventDefault();
            setTool("bucket");
          }
          break;
        case "c":
          if (mode === "paint") {
            event.preventDefault();
            setTool("color-picker");
          }
          break;
        case "i":
          if (mode === "paint") {
            event.preventDefault();
            setTool("eyedropper");
          }
          break;
        case " ":
          event.preventDefault();
          handlePlayPause();
          break;
        case "delete":
          if (selectedKeyframeId) {
            event.preventDefault();
            handleDeleteKeyframe();
          }
          break;
        case "+":
        case "=":
          event.preventDefault();
          setTool("zoom-in");
          break;
        case "-":
        case "_":
          event.preventDefault();
          setTool("zoom-out");
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode, selectedKeyframeId, handleDeleteKeyframe, handlePlayPause, undo, setTool]);
};

