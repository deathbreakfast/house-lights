const details = document.querySelector("[data-log-panel]");

if (details) {
  const logOutput = details.querySelector("[data-log-output]");
  const statusEl = details.querySelector("[data-log-status]");
  const refreshButton = details.querySelector('[data-action="refresh"]');
  const liveButton = details.querySelector('[data-action="toggle-live"]');
  const autoScrollCheckbox = details.querySelector('[data-action="auto-scroll"]');

  let eventSource = null;

  const setStatus = (message, state = "info") => {
    if (!statusEl) {
      return;
    }
    statusEl.textContent = message;
    statusEl.dataset.state = state;
  };

  const markEmpty = (isEmpty) => {
    if (logOutput) {
      logOutput.dataset.empty = String(isEmpty);
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
      logOutput.textContent = "";
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

      logOutput.textContent = payload;
      markEmpty(payload.trim().length === 0);
      setStatus(`Updated at ${new Date().toLocaleTimeString()}`);
      scrollToBottom();
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
    const needsLeadingNewline =
      logOutput.textContent.length > 0 && !logOutput.textContent.endsWith("\n");
    logOutput.textContent += (needsLeadingNewline ? "\n" : "") + line;
    markEmpty(false);
    scrollToBottom();
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
}

