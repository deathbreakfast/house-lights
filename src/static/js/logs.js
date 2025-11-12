const details = document.querySelector("[data-log-panel]");

if (details) {
  const logOutput = details.querySelector("[data-log-output]");
  const statusEl = details.querySelector("[data-log-status]");
  const refreshButton = details.querySelector('[data-action="refresh"]');
  const liveButton = details.querySelector('[data-action="toggle-live"]');
  const autoScrollCheckbox = details.querySelector('[data-action="auto-scroll"]');
  const STORAGE_KEY = "houselights.logPanelOpen";
  const EMPTY_MESSAGE = "No log entries yet.";

  let eventSource = null;

  const isEmptyPayload = (payload) => {
    const trimmed = payload.trim();
    return trimmed.length === 0 || trimmed === "-- No entries --";
  };

  const setStatus = (message, state = "info") => {
    if (!statusEl) {
      return;
    }
    statusEl.textContent = message;
    statusEl.dataset.state = state;
  };

  const markEmpty = (isEmpty) => {
    if (!logOutput) {
      return;
    }

    logOutput.dataset.empty = String(isEmpty);
    if (isEmpty) {
      logOutput.textContent = EMPTY_MESSAGE;
    } else if (logOutput.textContent === EMPTY_MESSAGE) {
      logOutput.textContent = "";
    }
  };

  const scrollToBottom = () => {
    if (!logOutput || autoScrollCheckbox?.checked !== true) {
      return;
    }
    logOutput.scrollTop = logOutput.scrollHeight;
  };

  const resetLogView = () => {
    if (logOutput) {
      markEmpty(true);
    }
  };

  const refreshLogs = async () => {
    if (!logOutput) {
      return;
    }

    setStatus("Loading recent logs…");
    try {
      const response = await fetch("/api/logs/recent", {
        headers: {
          Accept: "text/plain",
        },
      });

      const payload = await response.text();
      if (!response.ok) {
        throw new Error(payload || `Log request failed with status ${response.status}`);
      }

      if (isEmptyPayload(payload)) {
        markEmpty(true);
      } else {
        markEmpty(false);
        logOutput.textContent = payload;
        scrollToBottom();
      }

      setStatus(`Updated at ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      console.error("Failed to refresh logs", error);
      resetLogView();
      setStatus(
        error instanceof Error ? error.message : "Unable to load logs.",
        "error",
      );
    }
  };

  const stopLiveTail = (notify = true) => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (liveButton) {
      liveButton.textContent = "Start live tail";
      liveButton.dataset.state = "idle";
      liveButton.disabled = false;
    }
    if (notify) {
      setStatus("Live tail stopped.");
    }
  };

  const appendLogLine = (line) => {
    if (!logOutput) {
      return;
    }
    if (!line) {
      return;
    }
    if (isEmptyPayload(line)) {
      return;
    }
    if (logOutput.dataset.empty === "true") {
      markEmpty(false);
    }

    const needsLeadingNewline =
      logOutput.textContent.length > 0 && !logOutput.textContent.endsWith("\n");
    logOutput.textContent += (needsLeadingNewline ? "\n" : "") + line;
    scrollToBottom();
  };

  const persistOpenState = () => {
    try {
      if (details.open) {
        window.localStorage.setItem(STORAGE_KEY, "true");
      } else {
        window.localStorage.setItem(STORAGE_KEY, "false");
      }
    } catch (error) {
      console.warn("Unable to persist log panel state", error);
    }
  };

  const restoreOpenState = () => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "true") {
        details.open = true;
      }
    } catch (error) {
      console.warn("Unable to restore log panel state", error);
    }
  };

  const startLiveTail = () => {
    if (eventSource || !liveButton) {
      return;
    }

    try {
      liveButton.textContent = "Stop live tail";
      liveButton.dataset.state = "live";
      liveButton.disabled = false;

      eventSource = new EventSource("/api/logs/live");
      setStatus("Streaming live logs…");

      eventSource.onmessage = (event) => {
        appendLogLine(event.data);
      };

      eventSource.addEventListener("error", () => {
        stopLiveTail(false);
        setStatus("Live stream unavailable.", "error");
      });

      eventSource.addEventListener("stream-end", () => {
        stopLiveTail(false);
        setStatus("Log stream ended.", "error");
      });
    } catch (error) {
      console.error("Failed to start live log stream", error);
      stopLiveTail(false);
      setStatus(
        error instanceof Error ? error.message : "Unable to start live tail.",
        "error",
      );
    }
  };

  details.addEventListener("toggle", () => {
    if (details.open) {
      refreshLogs();
    } else {
      stopLiveTail(false);
    }
    persistOpenState();
  });

  refreshButton?.addEventListener("click", (event) => {
    event.preventDefault();
    refreshLogs();
  });

  liveButton?.addEventListener("click", (event) => {
    event.preventDefault();
    if (liveButton.dataset.state === "live") {
      stopLiveTail();
    } else {
      startLiveTail();
    }
  });

  resetLogView();
  restoreOpenState();
  if (details.open) {
    refreshLogs();
  }
}

const SCROLL_STORAGE_KEY = "houselights.scrollPosition";

const restoreScrollPosition = () => {
  try {
    const saved = window.sessionStorage.getItem(SCROLL_STORAGE_KEY);
    if (!saved) {
      return;
    }
    const y = Number.parseInt(saved, 10);
    if (Number.isFinite(y)) {
      window.scrollTo({ top: y });
    }
    window.sessionStorage.removeItem(SCROLL_STORAGE_KEY);
  } catch (error) {
    console.warn("Unable to restore scroll position", error);
  }
};

const persistScrollPosition = () => {
  try {
    window.sessionStorage.setItem(SCROLL_STORAGE_KEY, String(window.scrollY));
  } catch (error) {
    console.warn("Unable to persist scroll position", error);
  }
};

window.addEventListener("beforeunload", persistScrollPosition);
restoreScrollPosition();

