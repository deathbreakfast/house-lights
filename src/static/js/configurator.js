const patternNameInput = document.querySelector("[data-pattern-name]");
const patternDescriptionInput = document.querySelector("[data-pattern-description]");
const patternStatusEl = document.querySelector("[data-pattern-status]");
const patternIdBadge = document.querySelector("[data-pattern-id]");
const patternSaveButton = document.querySelector('[data-action="pattern-save"]');
const patternSaveAsButton = document.querySelector('[data-action="pattern-save-as"]');
const patternNewButton = document.querySelector('[data-action="pattern-new"]');
const stripListEl = document.querySelector("[data-strip-list]");
const stripTitleEl = document.querySelector("[data-strip-title]");
const simBanner = document.querySelector("[data-sim-banner]");
const simControls = document.querySelector("[data-sim-controls]");
const simLedCountInput = document.querySelector("[data-sim-led-count]");
const simAddButton = document.querySelector('[data-action="sim-add-strip"]');
const simHint = document.querySelector("[data-sim-hint]");
const visualizationStageEl = document.querySelector("[data-visualization-stage]");
const visualizationSurfaceEl = document.querySelector("[data-layout-surface]");
const zoomInButton = document.querySelector('[data-action="zoom-in"]');
const zoomOutButton = document.querySelector('[data-action="zoom-out"]');
const zoomResetButton = document.querySelector('[data-action="zoom-reset"]');
const ledOnInput = document.querySelector("[data-led-on]");
const ledColorInput = document.querySelector("[data-led-color]");
const ledBrightnessInput = document.querySelector("[data-led-brightness]");
const ledStatusEl = document.querySelector("[data-led-status]");
const toggleField = document.querySelector(".toggle-field");
const colorField = document.querySelector(".color-field");
const brightnessField = document.querySelector(".brightness-field");
const testButton = document.querySelector('[data-action="test-led"]');
const applyButton = document.querySelector('[data-action="apply-led"]');
const timelineSuite = document.querySelector("[data-timeline-suite]");
const timelineSlider = document.querySelector("[data-timeline-slider]");
const timelineScrubs = document.querySelectorAll("[data-timeline-scrub]");
const keyframeTrack = document.querySelector("[data-keyframe-track]");
const timelineAxis = document.querySelector("[data-timeline-axis]");
const timelineExpandButton = document.querySelector('[data-action="timeline-expand"]');
const framerateSelect = document.querySelector("[data-timeline-framerate]");
const addKeyframeButton = document.querySelector('[data-action="timeline-add-keyframe"]');
const durationLabel = document.querySelector("[data-timeline-duration]");
const playButton = document.querySelector("[data-action=\"timeline-play\"]");
const timelineZoom = document.querySelector("[data-timeline-zoom]");
const timelineScroll = document.querySelector("[data-timeline-scroll]");
const timelineScrollThumb = document.querySelector("[data-timeline-scroll-thumb]");

const SVG_NS = "http://www.w3.org/2000/svg";

const state = {
  strips: [],
  selectedStripPin: null,
  selectedLedKeys: new Set(),
  nodesByKey: new Map(),
  ledOverrides: new Map(), // key: `${pin}:${index}` -> { on: boolean, color: string }
  requestInFlight: false,
  simulatorMode: false,
  limits: {
    max_strips: 2,
    max_leds_per_strip: 250,
  },
  pattern: {
    id: null,
    name: "",
    loop: true,
    metadata: { description: "" },
    strips: [],
    isDirty: false,
    isSaving: false,
    isLoading: false,
  },
  timeline: {
    duration: 30,
    frameRate: 8,
    currentTime: 0,
    activeKeyframeId: null,
    keyframes: [],
    viewStart: 0,
    viewSpan: 10,
  },
  playback: {
    isPlaying: false,
    direction: 1,
    rafHandle: null,
    lastFrameTime: null,
    accumulator: 0,
  },
  visualization: {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    width: 640,
    height: 180,
    padding: 32,
    svgEl: null,
    contentGroup: null,
    surfaceEl: visualizationSurfaceEl,
    hover: false,
    panKeyActive: false,
    panPointerId: null,
    panStart: { x: 0, y: 0 },
    panOffsetStart: { x: 0, y: 0 },
  },
};

const MIN_VISUALIZATION_SCALE = 0.5;
const MAX_VISUALIZATION_SCALE = 5;

let scrollDragContext = null;
const urlSearchParams = new URLSearchParams(window.location.search);
const initialPatternId = urlSearchParams.get("pattern");
let suppressPatternFieldUpdates = false;

function getOverrideKey(pin, index) {
  return `${pin}:${index}`;
}

function makeLedKey(pin, index) {
  return `${pin}:${index}`;
}

function parseLedKey(key) {
  const [pinPart, indexPart] = key.split(":");
  return { pin: Number(pinPart), index: Number(indexPart) };
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexToRgb(hex) {
  const normalized = hex.trim().replace(/^#/, "");
  if (normalized.length !== 6) {
    return { r: 255, g: 255, b: 255 };
  }
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return { r, g, b };
}

function rgbToHex(r, g, b) {
  return `#${clampByte(r).toString(16).padStart(2, "0")}${clampByte(g)
    .toString(16)
    .padStart(2, "0")}${clampByte(b).toString(16).padStart(2, "0")}`;
}

function applyBrightnessToHex(hex, brightnessPercent) {
  const brightness = Math.max(0, Math.min(100, Number(brightnessPercent)));
  const factor = brightness / 100;
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r * factor, g * factor, b * factor);
}

async function init() {
  wirePatternControls();
  wireSimulatorControls();
  initVisualizationControls();
  initTimelineControls();
  await loadStrips();
  await loadInitialPattern(initialPatternId);
  renderStrips();
  updateLedInspector();
  updateTimelineDisabled(state.strips.length === 0);
}

function wirePatternControls() {
  if (patternNameInput) {
    patternNameInput.addEventListener("input", () => {
      if (suppressPatternFieldUpdates) {
        return;
      }
      state.pattern.name = patternNameInput.value;
      markDirty();
      updatePatternFormUi();
    });
  }
  if (patternDescriptionInput) {
    patternDescriptionInput.addEventListener("input", () => {
      if (suppressPatternFieldUpdates) {
        return;
      }
      state.pattern.metadata.description = patternDescriptionInput.value;
      markDirty();
      updatePatternFormUi();
    });
  }
  if (patternSaveButton) {
    patternSaveButton.addEventListener("click", () => {
      if (!state.pattern.isSaving) {
        void savePattern({ duplicate: false });
      }
    });
  }
  if (patternSaveAsButton) {
    patternSaveAsButton.addEventListener("click", () => {
      if (!state.pattern.isSaving) {
        void savePattern({ duplicate: true });
      }
    });
  }
  if (patternNewButton) {
    patternNewButton.addEventListener("click", () => {
      if (state.pattern.isSaving) {
        return;
      }
      if (state.pattern.isDirty) {
        const confirmed = window.confirm(
          "Discard unsaved changes and start a new pattern?"
        );
        if (!confirmed) {
          return;
        }
      }
      initializeNewPattern({ announce: true });
    });
  }
  updatePatternFormUi();
}

function snapshotCurrentStrips() {
  return state.strips.map((strip) => ({
    pin: strip.pin,
    led_count: strip.led_count,
    name: strip.name,
    simulated: Boolean(strip.simulated),
  }));
}

function setPatternStatus(message, tone = "info") {
  if (!patternStatusEl) return;
  patternStatusEl.textContent = message || "";
  if (message) {
    patternStatusEl.dataset.tone = tone;
  } else {
    patternStatusEl.removeAttribute("data-tone");
  }
}

function updatePatternFormUi() {
  const { pattern } = state;
  if (patternNameInput) {
    suppressPatternFieldUpdates = true;
    patternNameInput.value = pattern.name ?? "";
    patternNameInput.disabled = pattern.isSaving || pattern.isLoading;
    suppressPatternFieldUpdates = false;
  }
  if (patternDescriptionInput) {
    suppressPatternFieldUpdates = true;
    patternDescriptionInput.value = pattern.metadata?.description ?? "";
    patternDescriptionInput.disabled = pattern.isSaving || pattern.isLoading;
    suppressPatternFieldUpdates = false;
  }
  if (patternIdBadge) {
    if (pattern.id) {
      patternIdBadge.textContent = `Pattern ID: ${pattern.id}`;
    } else {
      patternIdBadge.textContent = "Unsaved pattern";
    }
  }
  const trimmedName = (pattern.name ?? "").trim();
  if (patternSaveButton) {
    patternSaveButton.disabled =
      pattern.isSaving || pattern.isLoading || !pattern.isDirty || !trimmedName;
  }
  if (patternSaveAsButton) {
    patternSaveAsButton.disabled =
      pattern.isSaving || pattern.isLoading || !trimmedName;
  }
  if (patternNewButton) {
    patternNewButton.disabled = pattern.isSaving;
  }
}

function markDirty() {
  state.pattern.isDirty = true;
  updatePatternFormUi();
  setPatternStatus("Unsaved changes", "info");
}

function markClean(message) {
  state.pattern.isDirty = false;
  updatePatternFormUi();
  if (message) {
    setPatternStatus(message, "success");
  } else if (!state.pattern.isSaving && !state.pattern.isLoading) {
    setPatternStatus("", "info");
  }
}

function setPatternSaving(isSaving) {
  state.pattern.isSaving = isSaving;
  updatePatternFormUi();
}

function setPatternLoading(isLoading) {
  state.pattern.isLoading = isLoading;
  updatePatternFormUi();
}

function updateUrlPatternId(patternId) {
  const url = new URL(window.location.href);
  if (patternId) {
    url.searchParams.set("pattern", patternId);
  } else {
    url.searchParams.delete("pattern");
  }
  window.history.replaceState({}, "", url);
}

function initializeNewPattern({ announce = false } = {}) {
  state.pattern.id = null;
  state.pattern.name = "";
  state.pattern.loop = true;
  state.pattern.metadata = { description: "" };
  state.pattern.strips = snapshotCurrentStrips();
  state.pattern.isDirty = false;
  state.pattern.isSaving = false;
  state.pattern.isLoading = false;
  state.timeline.duration = 30;
  state.timeline.frameRate = 8;
  state.timeline.currentTime = 0;
  state.timeline.viewStart = 0;
  state.timeline.viewSpan = Math.min(state.timeline.viewSpan, state.timeline.duration);
  state.timeline.keyframes = [];
  state.timeline.activeKeyframeId = null;
  state.selectedLedKeys.clear();
  state.selectedStripPin = state.strips[0]?.pin ?? null;
  state.ledOverrides.clear();
  updatePatternFormUi();
  updateTimelineView();
  updateLedInspector();
  renderVisualization();
  updateTimelineDisabled(state.strips.length === 0);
  updateUrlPatternId(null);
  if (announce) {
    setPatternStatus("Draft pattern ready. Add keyframes to begin.", "info");
  }
}

async function loadInitialPattern(patternId) {
  if (!patternId) {
    initializeNewPattern({ announce: true });
    return;
  }
  setPatternLoading(true);
  setPatternStatus(`Loading pattern "${patternId}"…`, "info");
  try {
    const response = await fetch(`/api/patterns/${encodeURIComponent(patternId)}`, {
      headers: {
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      const message = errorPayload?.description || errorPayload?.message || response.statusText;
      throw new Error(message);
    }
    const pattern = await response.json();
    applyLoadedPattern(pattern, { announce: true });
  } catch (error) {
    console.error(error);
    setPatternStatus(
      `Failed to load pattern "${patternId}": ${error.message}`,
      "error"
    );
    initializeNewPattern();
  } finally {
    setPatternLoading(false);
  }
}

function generateKeyframeId() {
  return `kf-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function applyLoadedPattern(pattern, { announce = false } = {}) {
  if (!pattern || typeof pattern !== "object") {
    initializeNewPattern();
    return;
  }
  state.pattern.id = pattern.id ?? null;
  state.pattern.name = pattern.name ?? "";
  state.pattern.loop = pattern.loop !== false;
  const metadata = pattern.metadata && typeof pattern.metadata === "object" ? { ...pattern.metadata } : {};
  if (typeof metadata.description !== "string") {
    metadata.description = metadata.description ? String(metadata.description) : "";
  }
  state.pattern.metadata = metadata;
  const strips = Array.isArray(pattern.strips) ? pattern.strips.map((strip) => ({ ...strip })) : snapshotCurrentStrips();
  state.pattern.strips = strips.length ? strips : snapshotCurrentStrips();

  const duration = Number(pattern.duration);
  state.timeline.duration = Number.isFinite(duration) && duration > 0 ? duration : 30;
  const frameRate = Number(pattern.frame_rate);
  state.timeline.frameRate = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 8;
  state.timeline.currentTime = 0;
  state.timeline.viewStart = 0;
  state.timeline.viewSpan = Math.min(Math.max(state.timeline.viewSpan, getTimelineStep()), state.timeline.duration);

  const keyframes = Array.isArray(pattern.keyframes) ? pattern.keyframes : [];
  state.timeline.keyframes = keyframes
    .map((frame) => {
      const time = Number(frame?.time);
      const overridesSource =
        frame?.overrides && typeof frame.overrides === "object" ? frame.overrides : {};
      const overrides = new Map(
        Object.entries(overridesSource).map(([key, value]) => [
          key,
          {
            on:
              value && typeof value === "object"
                ? "on" in value
                  ? value.on !== false
                  : true
                : false,
            color:
              value && typeof value === "object" && typeof value.color === "string"
                ? value.color
                : "#ffffff",
            brightness:
              value && typeof value === "object" && typeof value.brightness === "number"
                ? Math.max(0, Math.min(100, value.brightness))
                : 100,
          },
        ])
      );
      return {
        id: frame?.id || generateKeyframeId(),
        time: Number.isFinite(time) ? time : 0,
        overrides,
      };
    })
    .sort((a, b) => a.time - b.time);
  state.timeline.activeKeyframeId = null;
  state.selectedLedKeys.clear();
  state.ledOverrides.clear();
  updatePatternFormUi();
  updateTimelineView();
  updateLedInspector();
  renderVisualization();
  updateVisualizationToolbar();
  updateTimelineDisabled(state.strips.length === 0);
  updateUrlPatternId(state.pattern.id);
  if (announce) {
    const name = state.pattern.name || state.pattern.id || "Pattern";
    markClean(`Loaded "${name}".`);
  } else {
    markClean();
  }
}

function serializeKeyframe(frame) {
  const entries =
    frame.overrides instanceof Map
      ? Array.from(frame.overrides.entries())
      : Object.entries(frame.overrides || {});
  const overrides = Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      {
        on: value?.on !== false,
        color: value?.color ?? "#ffffff",
        brightness:
          typeof value?.brightness === "number"
            ? Math.max(0, Math.min(100, value.brightness))
            : 100,
      },
    ])
  );
  return {
    id: frame.id || generateKeyframeId(),
    time: Number(frame.time) || 0,
    overrides,
  };
}

function serializeCurrentPattern() {
  const metadata = {
    ...(state.pattern.metadata || {}),
  };
  if (typeof metadata.description !== "string") {
    metadata.description = metadata.description ? String(metadata.description) : "";
  }
  const currentStrips = snapshotCurrentStrips();
  const strips =
    currentStrips.length > 0
      ? currentStrips
      : Array.isArray(state.pattern.strips)
        ? state.pattern.strips.map((strip) => ({ ...strip }))
        : [];
  return {
    name: (state.pattern.name ?? "").trim(),
    frame_rate: state.timeline.frameRate,
    duration: state.timeline.duration,
    loop: state.pattern.loop,
    strips,
    keyframes: state.timeline.keyframes.map(serializeKeyframe),
    metadata,
  };
}

async function savePattern({ duplicate = false } = {}) {
  const trimmedName = (state.pattern.name ?? "").trim();
  if (!trimmedName) {
    if (patternNameInput) {
      patternNameInput.focus();
    }
    setPatternStatus("Enter a pattern name before saving.", "error");
    return;
  }

  const payload = serializeCurrentPattern();
  payload.name = trimmedName;

  const isUpdate = !duplicate && state.pattern.id;
  const url = isUpdate
    ? `/api/patterns/${encodeURIComponent(state.pattern.id)}`
    : "/api/patterns";
  const method = isUpdate ? "PUT" : "POST";

  setPatternSaving(true);
  setPatternStatus("Saving…", "info");

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      const message = errorPayload?.description || errorPayload?.message || response.statusText;
      throw new Error(message);
    }
    const saved = await response.json();
    applyLoadedPattern(saved);
    const message = duplicate ? `Saved copy "${saved.name}".` : `Saved "${saved.name}".`;
    markClean(message);
  } catch (error) {
    console.error(error);
    setPatternStatus(`Save failed: ${error.message}`, "error");
  } finally {
    setPatternSaving(false);
  }
}

function wireSimulatorControls() {
  if (simAddButton) {
    simAddButton.addEventListener("click", async () => {
      if (!simLedCountInput) return;
      const desired = Number.parseInt(simLedCountInput.value, 10);
      await createSimulatedStrip(desired);
    });
  }
}

function initVisualizationControls() {
  if (zoomInButton) {
    zoomInButton.addEventListener("click", () => adjustVisualizationScale(1.2));
  }
  if (zoomOutButton) {
    zoomOutButton.addEventListener("click", () => adjustVisualizationScale(1 / 1.2));
  }
  if (zoomResetButton) {
    zoomResetButton.addEventListener("click", () => resetVisualizationView());
  }
  if (visualizationSurfaceEl) {
    visualizationSurfaceEl.addEventListener("wheel", handleVisualizationWheel, { passive: false });
    visualizationSurfaceEl.addEventListener("pointerdown", handleVisualizationPointerDown);
    visualizationSurfaceEl.addEventListener("pointermove", handleVisualizationPointerMove);
    visualizationSurfaceEl.addEventListener("pointerup", handleVisualizationPointerUp);
    visualizationSurfaceEl.addEventListener("pointerleave", handleVisualizationPointerUp);
    visualizationSurfaceEl.addEventListener("mouseenter", () => {
      state.visualization.hover = true;
      updateVisualizationCursorState();
    });
    visualizationSurfaceEl.addEventListener("mouseleave", () => {
      state.visualization.hover = false;
      endVisualizationPan();
      updateVisualizationCursorState();
    });
  }
  window.addEventListener("keydown", handleVisualizationKeyDown);
  window.addEventListener("keyup", handleVisualizationKeyUp);
  updateVisualizationToolbar();
  updateVisualizationCursorState();
}

async function loadStrips() {
  try {
    const response = await fetch("/api/strips", { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Failed to load strips: ${response.status}`);
    }
    const payload = await response.json();
    const strips = Array.isArray(payload?.strips) ? payload.strips : [];
    state.strips = strips;
    state.simulatorMode = payload?.mode === "simulator" || strips.length === 0;
    state.limits = {
      max_strips: payload?.limits?.max_strips ?? 2,
      max_leds_per_strip: payload?.limits?.max_leds_per_strip ?? 250,
    };
    updateSimulatorUi();
  } catch (error) {
    console.error(error);
    state.strips = [];
    state.simulatorMode = true;
    if (stripListEl) {
      stripListEl.innerHTML =
        '<li class="strip-list-empty">Unable to load configured strips. Verify environment variables and refresh.</li>';
    }
    updateSimulatorUi();
  }
}

function updateSimulatorUi() {
  if (!simBanner || !simControls || !simHint || !stripTitleEl) {
    return;
  }

  const showSimulatorControls = state.simulatorMode || state.strips.length === 0;

  if (showSimulatorControls) {
    simBanner.hidden = false;
    simControls.hidden = false;
    stripTitleEl.textContent = state.simulatorMode ? "LED Strips (Simulator)" : "LED Strips";
    const remaining = Math.max(state.limits.max_strips - state.strips.length, 0);
    simHint.textContent = `Simulator supports two strips (PWM channels 18 & 13). Slots remaining: ${remaining}.`;
    if (simLedCountInput) {
      simLedCountInput.max = String(state.limits.max_leds_per_strip);
    }
  } else {
    simBanner.hidden = true;
    simControls.hidden = true;
    stripTitleEl.textContent = "LED Strips";
  }
}

function renderStrips() {
  if (!stripListEl) {
    return;
  }

  stripListEl.innerHTML = "";

  if (!state.strips.length) {
    const empty = document.createElement("li");
    empty.className = "strip-list-empty";
    empty.textContent = "No strips configured. Add a simulated strip to begin.";
    stripListEl.appendChild(empty);
    updateTimelineDisabled(true);
    renderVisualization();
    return;
  }

  state.strips.forEach((strip) => {
    const li = document.createElement("li");
    li.className = "strip-list-item";

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "strip-list-button";
    selectButton.dataset.pin = strip.pin;

    const infoWrapper = document.createElement("div");
    infoWrapper.className = "strip-info";

    const labelSpan = document.createElement("span");
    labelSpan.className = "strip-label";
    labelSpan.textContent = strip.label;

    const metaSpan = document.createElement("span");
    metaSpan.className = "strip-meta";
    const metaSegments = [`Pin ${strip.pin}`, `${strip.led_count} LEDs`];
    if (strip.simulated) {
      metaSegments.push("Simulated");
    }
    metaSpan.textContent = metaSegments.join(" • ");

    infoWrapper.appendChild(labelSpan);
    infoWrapper.appendChild(metaSpan);
    selectButton.appendChild(infoWrapper);

    selectButton.addEventListener("click", () => selectStrip(strip.pin));
    li.appendChild(selectButton);

    if (state.simulatorMode) {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "strip-remove";
      removeButton.textContent = "Remove";
      removeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        removeSimulatedStrip(strip.pin);
      });
      li.appendChild(removeButton);
    }

    stripListEl.appendChild(li);
  });

  const stillSelected = state.strips.some((strip) => strip.pin === state.selectedStripPin);
  if (!stillSelected) {
    state.selectedStripPin = state.strips[0]?.pin ?? null;
    state.selectedLedKeys.clear();
  }

  updateStripButtonHighlights();
  renderVisualization();
  updateLedInspector();
  updateTimelineView();
}

function updateStripButtonHighlights() {
  if (!stripListEl) return;
  const buttons = stripListEl.querySelectorAll(".strip-list-button");
  buttons.forEach((button) => {
    button.classList.toggle("selected", Number(button.dataset.pin) === state.selectedStripPin);
  });
}

function selectStrip(pin) {
  if (state.selectedStripPin !== pin) {
    state.selectedStripPin = pin;
    const filteredKeys = new Set();
    state.selectedLedKeys.forEach((key) => {
      if (parseLedKey(key).pin === pin) {
        filteredKeys.add(key);
      }
    });
    state.selectedLedKeys = filteredKeys;
  }
  updateStripButtonHighlights();
  renderVisualization();
  clampCurrentTimeInView();
  updateTimelineView();
  updateLedInspector();
}

function renderVisualization() {
  if (!visualizationSurfaceEl) {
    return;
  }
  const surface = visualizationSurfaceEl;
  surface.innerHTML = "";
  state.nodesByKey.clear();
  state.visualization.surfaceEl = surface;

  const uploadButton = document.createElement("button");
  uploadButton.type = "button";
  uploadButton.className = "layout-upload";
  uploadButton.disabled = true;
  uploadButton.dataset.tooltip = "Uploading reference imagery is coming soon.";
  uploadButton.textContent = "Upload Reference Image";
  surface.appendChild(uploadButton);

  if (!state.strips.length) {
    const placeholder = document.createElement("p");
    placeholder.className = "visualization-placeholder";
    placeholder.textContent = "Add a strip to begin.";
    surface.appendChild(placeholder);
    updateTimelineDisabled(true);
    state.visualization.scale = 1;
    state.visualization.offsetX = 0;
    state.visualization.offsetY = 0;
    state.visualization.contentGroup = null;
    updateVisualizationToolbar();
    updateVisualizationCursorState();
    return;
  }

  const stageRect = visualizationStageEl?.getBoundingClientRect();
  const availableWidth = Math.max(stageRect?.width || surface.clientWidth || 640, 320);
  const width = availableWidth;
  const padding = 48;
  const minHeight = Math.max(visualizationStageEl?.clientHeight || 200, 200);
  const rowSpacing = 110;
  const totalStrips = state.strips.length;
  const baseHeight = padding * 2 + rowSpacing * Math.max(totalStrips - 1, 0);
  const totalHeight = Math.max(baseHeight, minHeight);
  const usableWidth = Math.max(width - padding * 2, 1);
  const trackSpan = totalHeight - padding * 2;
  const stepY = totalStrips > 1 ? trackSpan / (totalStrips - 1) : 0;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${totalHeight}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "LED Strip Layout");
  svg.classList.add("strip-svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", String(totalHeight));

  const contentGroup = document.createElementNS(SVG_NS, "g");
  svg.appendChild(contentGroup);

  state.strips.forEach((strip, stripIndex) => {
    const group = document.createElementNS(SVG_NS, "g");
    const baseY = totalStrips > 1 ? padding + stepY * stripIndex : totalHeight / 2;
    group.classList.add("strip-plot");
    if (strip.pin === state.selectedStripPin) {
      group.classList.add("is-selected");
    }
    contentGroup.appendChild(group);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", String(padding));
    label.setAttribute("y", String(baseY - 28));
    label.setAttribute("class", "strip-label-text");
    label.textContent = strip.name || `Pin ${strip.pin}`;
    group.appendChild(label);

    const rail = document.createElementNS(SVG_NS, "line");
    rail.setAttribute("x1", String(padding));
    rail.setAttribute("y1", String(baseY));
    rail.setAttribute("x2", String(width - padding));
    rail.setAttribute("y2", String(baseY));
    rail.classList.add("strip-rail");
    if (strip.pin === state.selectedStripPin) {
      rail.classList.add("is-selected");
    }
    group.appendChild(rail);

    const ledCount = Math.max(1, Number(strip.led_count) || 1);
    const step = ledCount > 1 ? usableWidth / (ledCount - 1) : 0;

    for (let index = 0; index < ledCount; index += 1) {
      const circle = document.createElementNS(SVG_NS, "circle");
      const cx = padding + step * index;
      circle.setAttribute("cx", String(cx));
      circle.setAttribute("cy", String(baseY));
      circle.setAttribute("r", "10");
      circle.classList.add("led-node");
      applyNodeAppearance(circle, strip.pin, index);
      circle.addEventListener("click", (event) => {
        if (state.visualization.panPointerId != null || state.visualization.panKeyActive) {
          return;
        }
        const additive = event.shiftKey || event.metaKey || event.ctrlKey;
        if (additive) {
          toggleLedSelection(strip.pin, index, true);
        } else {
          selectLed(strip.pin, index);
        }
      });
      group.appendChild(circle);
      const key = makeLedKey(strip.pin, index);
      state.nodesByKey.set(key, circle);
    }
  });

  surface.appendChild(svg);

  state.visualization.scale = 1;
  state.visualization.offsetX = 0;
  state.visualization.offsetY = 0;
  state.visualization.width = width;
  state.visualization.height = totalHeight;
  state.visualization.padding = padding;
  state.visualization.svgEl = svg;
  state.visualization.contentGroup = contentGroup;

  applyVisualizationTransform();
  updateVisualizationToolbar();
  updateSelectedStyling();
  updateVisualizationCursorState();
  updateTimelineDisabled(false);
  const activeFrame = getActiveKeyframe() || findKeyframeForTime(state.timeline.currentTime);
  applyKeyframeToVisualization(activeFrame);
}

function selectLed(pin, index) {
  state.selectedStripPin = pin;
  state.selectedLedKeys.clear();
  state.selectedLedKeys.add(makeLedKey(pin, index));
  updateSelectedStyling();
  updateLedInspector();
}

function toggleLedSelection(pin, index, additive = false) {
  if (!additive || state.selectedStripPin !== pin) {
    state.selectedStripPin = pin;
    state.selectedLedKeys.clear();
  }
  const key = makeLedKey(pin, index);
  if (state.selectedLedKeys.has(key) && additive) {
    state.selectedLedKeys.delete(key);
  } else {
    state.selectedLedKeys.add(key);
  }
  updateSelectedStyling();
  updateLedInspector();
}

function updateSelectedStyling() {
  const multiple = state.selectedLedKeys.size > 1;
  state.nodesByKey.forEach((circle, key) => {
    const isSelected = state.selectedLedKeys.has(key);
    circle.classList.toggle("selected", isSelected);
    circle.classList.toggle("multiple", isSelected && multiple);
  });
}

function applyVisualizationTransform() {
  const group = state.visualization.contentGroup;
  if (!group) {
    return;
  }
  const { offsetX, offsetY, scale } = state.visualization;
  group.setAttribute("transform", `translate(${offsetX} ${offsetY}) scale(${scale})`);
}

function updateVisualizationToolbar() {
  const hasContent = !!state.visualization.contentGroup;
  if (zoomInButton) {
    zoomInButton.disabled = !hasContent || state.visualization.scale >= MAX_VISUALIZATION_SCALE - 0.01;
  }
  if (zoomOutButton) {
    zoomOutButton.disabled = !hasContent || state.visualization.scale <= MIN_VISUALIZATION_SCALE + 0.01;
  }
  if (zoomResetButton) {
    zoomResetButton.disabled = !hasContent;
  }
}

function resetVisualizationView() {
  state.visualization.scale = 1;
  state.visualization.offsetX = 0;
  state.visualization.offsetY = 0;
  applyVisualizationTransform();
  updateVisualizationToolbar();
}

function adjustVisualizationScale(factor) {
  if (!state.visualization.contentGroup) {
    return;
  }
  const surface = state.visualization.surfaceEl || visualizationSurfaceEl;
  const rect = surface?.getBoundingClientRect();
  const anchor = rect ? { x: rect.width / 2, y: rect.height / 2 } : null;
  setVisualizationScale(state.visualization.scale * factor, anchor);
}

function setVisualizationScale(newScale, anchorPx) {
  const clamped = clamp(newScale, MIN_VISUALIZATION_SCALE, MAX_VISUALIZATION_SCALE);
  const viz = state.visualization;
  const oldScale = viz.scale || 1;
  if (anchorPx) {
    const { coordX, coordY } = screenToBaseCoords(anchorPx.x, anchorPx.y);
    viz.offsetX = ((coordX + viz.offsetX) * oldScale) / clamped - coordX;
    viz.offsetY = ((coordY + viz.offsetY) * oldScale) / clamped - coordY;
  }
  viz.scale = clamped;
  applyVisualizationTransform();
  updateVisualizationToolbar();
}

function handleVisualizationWheel(event) {
  if (!event.ctrlKey) {
    return;
  }
  if (!state.visualization.contentGroup || !visualizationSurfaceEl) {
    return;
  }
  event.preventDefault();
  const rect = visualizationSurfaceEl.getBoundingClientRect();
  const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
  setVisualizationScale(state.visualization.scale * factor, anchor);
}

function handleVisualizationPointerDown(event) {
  if (!state.visualization.panKeyActive || event.button !== 0) {
    return;
  }
  if (!state.visualization.contentGroup || !visualizationSurfaceEl) {
    return;
  }
  state.visualization.panPointerId = event.pointerId;
  state.visualization.panStart = { x: event.clientX, y: event.clientY };
  state.visualization.panOffsetStart = {
    x: state.visualization.offsetX,
    y: state.visualization.offsetY,
  };
  visualizationSurfaceEl.setPointerCapture(event.pointerId);
  visualizationSurfaceEl.classList.add("is-panning");
  event.preventDefault();
}

function handleVisualizationPointerMove(event) {
  if (
    state.visualization.panPointerId == null ||
    event.pointerId !== state.visualization.panPointerId
  ) {
    return;
  }
  if (!state.visualization.contentGroup) {
    return;
  }
  const { dx, dy } = pixelsToCoords(
    event.clientX - state.visualization.panStart.x,
    event.clientY - state.visualization.panStart.y
  );
  state.visualization.offsetX = state.visualization.panOffsetStart.x + dx;
  state.visualization.offsetY = state.visualization.panOffsetStart.y + dy;
  applyVisualizationTransform();
  event.preventDefault();
}

function handleVisualizationPointerUp(event) {
  if (
    state.visualization.panPointerId != null &&
    event.pointerId === state.visualization.panPointerId
  ) {
    if (visualizationSurfaceEl?.hasPointerCapture(event.pointerId)) {
      visualizationSurfaceEl.releasePointerCapture(event.pointerId);
    }
    endVisualizationPan();
  }
  updateVisualizationCursorState();
}

function endVisualizationPan() {
  state.visualization.panPointerId = null;
  state.visualization.panStart = { x: 0, y: 0 };
  state.visualization.panOffsetStart = { x: 0, y: 0 };
  visualizationSurfaceEl?.classList.remove("is-panning");
  updateVisualizationCursorState();
}

function updateVisualizationCursorState() {
  if (!visualizationSurfaceEl) {
    return;
  }
  const canPan = state.visualization.contentGroup != null;
  if (state.visualization.panKeyActive && state.visualization.hover && canPan) {
    visualizationSurfaceEl.classList.add("is-pan-ready");
  } else {
    visualizationSurfaceEl.classList.remove("is-pan-ready");
  }
}

function handleVisualizationKeyDown(event) {
  if (event.code === "Space" && !event.repeat) {
    if (state.visualization.hover) {
      event.preventDefault();
      state.visualization.panKeyActive = true;
      updateVisualizationCursorState();
    }
  }
}

function handleVisualizationKeyUp(event) {
  if (event.code === "Space") {
    state.visualization.panKeyActive = false;
    if (state.visualization.panPointerId != null) {
      endVisualizationPan();
    }
    updateVisualizationCursorState();
  }
}

function pixelsToCoords(dxPx, dyPx) {
  const surface = state.visualization.surfaceEl || visualizationSurfaceEl;
  const displayWidth = surface?.clientWidth || state.visualization.width || 1;
  const displayHeight = surface?.clientHeight || state.visualization.height || 1;
  const width = state.visualization.width || displayWidth;
  const height = state.visualization.height || displayHeight;
  const scale = state.visualization.scale || 1;
  return {
    dx: (dxPx / displayWidth) * (width / scale),
    dy: (dyPx / displayHeight) * (height / scale),
  };
}

function screenToBaseCoords(px, py) {
  const surface = state.visualization.surfaceEl || visualizationSurfaceEl;
  const displayWidth = surface?.clientWidth || state.visualization.width || 1;
  const displayHeight = surface?.clientHeight || state.visualization.height || 1;
  const width = state.visualization.width || displayWidth;
  const height = state.visualization.height || displayHeight;
  const scale = state.visualization.scale || 1;
  const coordX = ((px / displayWidth) * width) / scale - state.visualization.offsetX;
  const coordY = ((py / displayHeight) * height) / scale - state.visualization.offsetY;
  return { coordX, coordY };
}

function getLedOverride(pin, index) {
  return state.ledOverrides.get(getOverrideKey(pin, index));
}

function applyNodeAppearance(node, pin, index) {
  const override = getLedOverride(pin, index);
  if (!override || override.on === false) {
    node.style.setProperty("--led-color", "#94a3b8");
    node.setAttribute("data-led-on", "false");
    node.removeAttribute("data-led-color");
    node.removeAttribute("data-led-brightness");
  } else {
    const baseColor = override.color || "#ffffff";
    const brightness = typeof override.brightness === "number" ? override.brightness : 100;
    const displayColor = applyBrightnessToHex(baseColor, brightness);
    node.style.setProperty("--led-color", displayColor);
    node.setAttribute("data-led-on", "true");
    node.setAttribute("data-led-color", baseColor);
    node.setAttribute("data-led-brightness", String(brightness));
  }
}

function updateLedInspector() {
  const hasSelection = state.selectedLedKeys.size > 0;

  testButton.disabled = !hasSelection || state.requestInFlight;
  applyButton.disabled = !hasSelection || state.requestInFlight;
  ledOnInput.disabled = !hasSelection;
  ledColorInput.disabled = !hasSelection;
  if (ledBrightnessInput) {
    ledBrightnessInput.disabled = !hasSelection;
  }
  if (toggleField) {
    toggleField.classList.toggle("is-disabled", !hasSelection);
  }
  if (colorField) {
    colorField.classList.toggle("is-disabled", !hasSelection);
  }
  if (brightnessField) {
    brightnessField.classList.toggle("is-disabled", !hasSelection);
  }

  if (!hasSelection) {
    ledStatusEl.textContent = "Pick an LED to enable controls.";
    ledStatusEl.classList.add("is-inactive");
    ledStatusEl.classList.remove("is-active");
    ledOnInput.checked = true;
    ledColorInput.value = "#ffffff";
    if (ledBrightnessInput) {
      ledBrightnessInput.value = "100";
    }
    return;
  }

  const entries = Array.from(state.selectedLedKeys).map((key) => parseLedKey(key));
  if (!entries.length) {
    return;
  }
  const pin = entries[0].pin;
  const index = entries[0].index;
  const minIndex = entries.reduce((acc, entry) => Math.min(acc, entry.index), index);
  state.selectedStripPin = pin;

  const override = getLedOverride(pin, index);
  ledOnInput.checked = override ? override.on !== false : true;
  ledColorInput.value = override && override.color ? override.color : "#ffffff";
  if (ledBrightnessInput) {
    const brightnessValue = override && typeof override.brightness === "number" ? override.brightness : 100;
    ledBrightnessInput.value = String(brightnessValue);
  }

  const selectionCount = state.selectedLedKeys.size;
  const labelText =
    selectionCount === 1
      ? `Ready to test LED #${index} on pin ${pin}.`
      : `Ready to test ${selectionCount} LEDs starting at #${minIndex} on pin ${pin}.`;
  ledStatusEl.textContent = labelText;
  ledStatusEl.classList.remove("is-inactive");
  ledStatusEl.classList.add("is-active");
  updateSelectedStyling();
}

async function sendLedUpdate(mode) {
  if (state.selectedLedKeys.size === 0 || state.requestInFlight) {
    return;
  }

  const entries = Array.from(state.selectedLedKeys).map((key) => parseLedKey(key));
  if (!entries.length) {
    return;
  }
  const pin = entries[0].pin;
  const sortedIndices = entries.map((entry) => entry.index).sort((a, b) => a - b);
  const firstIndex = sortedIndices[0] ?? 0;
  const selectionCount = sortedIndices.length;

  const isOn = ledOnInput.checked;
  const color = ledColorInput.value || "#ffffff";
  const brightnessRaw = ledBrightnessInput ? Number.parseInt(ledBrightnessInput.value, 10) : 100;
  const brightness = Number.isFinite(brightnessRaw) ? Math.max(0, Math.min(100, brightnessRaw)) : 100;
  const effectiveColor = isOn ? applyBrightnessToHex(color, brightness) : "#000000";

  state.requestInFlight = true;
  state.selectedStripPin = pin;
  updateLedInspector();
  ledStatusEl.textContent = `${mode} in progress…`;
  ledStatusEl.classList.remove("is-inactive");
  ledStatusEl.classList.remove("is-active");

  try {
    const requests = sortedIndices.map((ledIndex) =>
      fetch(`/api/strips/${pin}/led/${ledIndex}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ on: isOn, color: effectiveColor }),
      })
    );
    const responses = await Promise.all(requests);
    const failed = responses.find((response) => !response.ok);
    if (failed) {
      const errorPayload = await failed.json().catch(() => ({}));
      const message = errorPayload?.message || failed.statusText || "Unknown error";
      throw new Error(message);
    }

    const activeKeyframe = getActiveKeyframe();
    sortedIndices.forEach((ledIndex) => {
      const overrideKey = getOverrideKey(pin, ledIndex);
      if (isOn) {
        state.ledOverrides.set(overrideKey, { on: true, color, brightness });
      } else {
        state.ledOverrides.set(overrideKey, { on: false, color: "#000000", brightness });
      }
      if (activeKeyframe) {
        if (isOn) {
          activeKeyframe.overrides.set(overrideKey, { on: true, color, brightness });
        } else {
          activeKeyframe.overrides.set(overrideKey, { on: false, color: "#000000", brightness });
        }
      }
      const node = state.nodesByKey.get(makeLedKey(pin, ledIndex));
      if (node) {
        applyNodeAppearance(node, pin, ledIndex);
        node.classList.add("flash");
        window.setTimeout(() => node.classList.remove("flash"), 250);
      }
    });

    markDirty();

    const actionWord = mode === "Apply" ? "applied" : "tested";
    ledStatusEl.textContent =
      selectionCount === 1
        ? `Successfully ${actionWord} LED #${firstIndex}.`
        : `Successfully ${actionWord} ${selectionCount} LEDs.`;
    ledStatusEl.classList.add("is-active");
  } catch (error) {
    console.error(error);
    ledStatusEl.textContent = `LED update failed: ${error.message}`;
    ledStatusEl.classList.remove("is-active");
    ledStatusEl.classList.remove("is-inactive");
  } finally {
    state.requestInFlight = false;
    updateLedInspector();
  }
}

if (testButton) {
  testButton.addEventListener("click", () => sendLedUpdate("Test"));
}
if (applyButton) {
  applyButton.addEventListener("click", () => sendLedUpdate("Apply"));
}

window.addEventListener("DOMContentLoaded", init);

function updateTimelineDisabled(isDisabled) {
  if (!timelineSuite) return;
  timelineSuite.dataset.disabled = String(isDisabled);
  [timelineSlider, framerateSelect, timelineExpandButton, addKeyframeButton, timelineZoom, playButton].forEach((control) => {
    if (control) {
      control.disabled = isDisabled;
    }
  });
  if (timelineScrollThumb) {
    timelineScrollThumb.classList.toggle("is-disabled", isDisabled);
  }
}

function initTimelineControls() {
  syncViewWithDuration();
  if (timelineSlider) {
    timelineSlider.addEventListener("input", handleTimelineSliderInput);
    timelineSlider.addEventListener("change", handleTimelineSliderInput);
  }
  if (timelineExpandButton) {
    timelineExpandButton.addEventListener("click", handleTimelineExpand);
  }
  if (framerateSelect) {
    framerateSelect.addEventListener("change", handleFrameRateChange);
  }
  if (addKeyframeButton) {
    addKeyframeButton.addEventListener("click", handleAddKeyframe);
  }
  if (timelineZoom) {
    timelineZoom.addEventListener("input", handleTimelineZoomChange);
  }
  if (playButton) {
    playButton.addEventListener("click", togglePlayback);
  }
  setupScrollDrag();
  updateTimelineView();
}

function handleTimelineSliderInput(event) {
  if (!timelineSlider) return;
  const value = Number.parseFloat(event.target.value);
  const relative = clamp(Number.isFinite(value) ? value : 0, 0, state.timeline.viewSpan);
  state.timeline.currentTime = clampTimeToStep(state.timeline.viewStart + relative);
  clampCurrentTimeInView();
  updateScrubPosition();
  highlightKeyframeAtCurrentTime();
}

function handleTimelineExpand() {
  setDuration(state.timeline.duration + 30);
  updateTimelineView();
  markDirty();
}

function handleFrameRateChange(event) {
  const value = Number.parseInt(event.target.value, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return;
  }
  state.timeline.frameRate = value;
  updateTimelineView();
  markDirty();
}

function handleTimelineZoomChange(event) {
  const requested = Number.parseFloat(event.target.value);
  if (!Number.isFinite(requested)) {
    return;
  }
  setViewSpan(requested);
  updateTimelineView();
}

function setDuration(value) {
  state.timeline.duration = Math.max(value, getTimelineStep());
  if (timelineZoom) {
    timelineZoom.max = String(state.timeline.duration);
  }
  syncViewWithDuration();
}

function setViewSpan(value) {
  const minSpan = getTimelineStep();
  const duration = state.timeline.duration;
  state.timeline.viewSpan = clamp(value, minSpan, duration);
  syncViewWithDuration();
}

function setViewStart(value) {
  const duration = Math.max(state.timeline.duration, getTimelineStep());
  const maxStart = Math.max(duration - state.timeline.viewSpan, 0);
  const newStart = clamp(value, 0, maxStart);
  if (Math.abs(newStart - state.timeline.viewStart) > 0.0001) {
    state.timeline.viewStart = newStart;
    clampCurrentTimeInView();
    return true;
  }
  return false;
}

function clampCurrentTimeInView() {
  const start = state.timeline.viewStart;
  const end = getViewEnd();
  state.timeline.currentTime = clamp(state.timeline.currentTime, start, end);
}

function updateTimelineView() {
  syncViewWithDuration();
  updateTimelineSlider();
  renderTimelineAxis();
  renderKeyframes();
  updateScrubPosition();
  updateScrollThumb();
  highlightKeyframeAtCurrentTime();
  updateDurationLabel();
  if (playButton) {
    playButton.dataset.state = state.playback.isPlaying ? "playing" : "idle";
    playButton.textContent = state.playback.isPlaying ? "Pause" : "Play";
  }
}

function updateTimelineSlider() {
  if (!timelineSlider) return;
  timelineSlider.min = "0";
  timelineSlider.max = String(state.timeline.viewSpan);
  timelineSlider.step = String(getTimelineStep());
  const relative = clamp(state.timeline.currentTime - state.timeline.viewStart, 0, state.timeline.viewSpan);
  timelineSlider.value = String(relative);
}

function updateScrubPosition() {
  const viewSpan = state.timeline.viewSpan || 1;
  const relative = clamp(state.timeline.currentTime - state.timeline.viewStart, 0, viewSpan);
  const percent = (relative / viewSpan) * 100;
  timelineScrubs.forEach((scrub) => {
    scrub.style.left = `${percent}%`;
  });
}

function updateScrollThumb() {
  if (!timelineScrollThumb || !timelineScroll) return;
  const duration = Math.max(state.timeline.duration, getTimelineStep());
  const span = Math.min(state.timeline.viewSpan, duration);
  const widthPercent = duration ? (span / duration) * 100 : 100;
  const clampedWidth = Math.min(widthPercent, 100);
  const maxStart = Math.max(duration - span, 0);
  const startPercent = duration ? (state.timeline.viewStart / duration) * 100 : 0;
  const boundedStart = Math.min(startPercent, 100 - clampedWidth);
  timelineScrollThumb.style.width = `${clampedWidth}%`;
  timelineScrollThumb.style.left = `${Math.max(boundedStart, 0)}%`;
  timelineScrollThumb.classList.toggle("is-disabled", clampedWidth >= 99.9);
}

function scrollViewToTime(time) {
  const start = state.timeline.viewStart;
  const end = getViewEnd();
  let changed = false;
  if (time < start) {
    changed = setViewStart(time) || changed;
  } else if (time > end) {
    changed = setViewStart(time - state.timeline.viewSpan) || changed;
  }
  return changed;
}

function updatePlaybackUi(repositionKeyframes = false) {
  updateTimelineSlider();
  updateScrubPosition();
  if (repositionKeyframes) {
    renderKeyframes();
  }
  highlightKeyframeAtCurrentTime();
  updateScrollThumb();
}

function renderTimelineAxis() {
  if (!timelineAxis) return;
  const ticks = 5;
  const start = state.timeline.viewStart;
  const span = state.timeline.viewSpan;
  timelineAxis.innerHTML = "";
  for (let i = 0; i <= ticks; i += 1) {
    const value = start + (span / ticks) * i;
    const tick = document.createElement("span");
    tick.textContent = `${value.toFixed(1)}s`;
    timelineAxis.appendChild(tick);
  }
}

function renderKeyframes() {
  if (!keyframeTrack) return;
  keyframeTrack.innerHTML = "";
  if (state.timeline.keyframes.length === 0) {
    return;
  }
  const start = state.timeline.viewStart;
  const end = getViewEnd();
  const span = state.timeline.viewSpan || 1;
  state.timeline.keyframes
    .filter((frame) => frame.time >= start && frame.time <= end)
    .forEach((frame) => {
      const button = document.createElement("button");
      button.type = "button";
      const percent = ((frame.time - start) / span) * 100;
      button.style.left = `${percent}%`;
      button.dataset.id = frame.id;
      button.title = `Keyframe at ${frame.time.toFixed(2)}s`;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        state.timeline.currentTime = frame.time;
        clampCurrentTimeInView();
        state.timeline.activeKeyframeId = frame.id;
        updateTimelineView();
      });
      keyframeTrack.appendChild(button);
    });
  updateKeyframeActiveStates();
}

function updateKeyframeActiveStates() {
  if (!keyframeTrack) return;
  const activeId = state.timeline.activeKeyframeId;
  keyframeTrack.querySelectorAll("button").forEach((button) => {
    button.dataset.active = String(button.dataset.id === activeId);
  });
}

function highlightKeyframeAtCurrentTime() {
  const frame = findKeyframeForTime(state.timeline.currentTime);
  if (frame) {
    state.timeline.activeKeyframeId = frame.id;
    if (state.selectedStripPin != null) {
      applyKeyframeOverrides(frame);
    }
  } else {
    state.timeline.activeKeyframeId = null;
    if (state.selectedStripPin != null) {
      applyKeyframeOverrides(null);
    }
  }
  if (state.selectedStripPin != null) {
    applyKeyframeToVisualization(frame);
  }
  updateKeyframeActiveStates();
}

function findKeyframeAtTime(time) {
  const epsilon = getTimelineStep() / 2;
  return (
    state.timeline.keyframes.find((frame) => Math.abs(frame.time - time) <= epsilon) ?? null
  );
}

function findKeyframeForTime(time) {
  const epsilon = getTimelineStep() / 2;
  let result = null;
  for (const frame of state.timeline.keyframes) {
    if (frame.time <= time + epsilon) {
      result = frame;
    } else {
      break;
    }
  }
  return result;
}

function handleAddKeyframe() {
  if (state.selectedStripPin == null) {
    return;
  }
  const time = clampTimeToStep(state.timeline.currentTime);
  let keyframe = findKeyframeAtTime(time);
  if (!keyframe) {
    keyframe = createKeyframe(time);
    state.timeline.keyframes.push(keyframe);
    state.timeline.keyframes.sort((a, b) => a.time - b.time);
    state.timeline.activeKeyframeId = keyframe.id;
    clearOverridesForCurrentStrip(keyframe);
    applyKeyframeOverrides(null);
  } else {
    state.timeline.activeKeyframeId = keyframe.id;
  }
  state.timeline.currentTime = keyframe.time;
  clampCurrentTimeInView();
  updateTimelineView();
  markDirty();
}

function clearOverridesForCurrentStrip(frame) {
  if (!frame || state.selectedStripPin == null) return;
  if (!(frame.overrides instanceof Map)) {
    const entries =
      frame.overrides && typeof frame.overrides === "object"
        ? Object.entries(frame.overrides)
        : [];
    frame.overrides = new Map(entries);
  }
  const prefix = `${state.selectedStripPin}:`;
  for (const key of Array.from(frame.overrides.keys())) {
    if (key.startsWith(prefix)) {
      frame.overrides.delete(key);
    }
  }
}

function createKeyframe(time) {
  return {
    id: generateKeyframeId(),
    time,
    overrides: new Map(),
  };
}

function applyKeyframeOverrides(frame) {
  state.ledOverrides.clear();
  if (frame) {
    frame.overrides.forEach((value, key) => {
      state.ledOverrides.set(key, { ...value });
    });
  }
  state.nodesByKey.forEach((node, key) => {
    const { pin, index } = parseLedKey(key);
    applyNodeAppearance(node, pin, index);
  });
  updateLedInspector();
}

function applyKeyframeToVisualization(frame) {
  if (!frame) {
    state.nodesByKey.forEach((node, key) => {
      const { pin, index } = parseLedKey(key);
      applyNodeAppearance(node, pin, index);
    });
    updateSelectedStyling();
    return;
  }
  state.nodesByKey.forEach((node, key) => {
    const override = frame.overrides.get(key);
    if (!override || override.on === false) {
      node.style.setProperty("--led-color", "#94a3b8");
      node.setAttribute("data-led-on", "false");
      node.removeAttribute("data-led-color");
      node.removeAttribute("data-led-brightness");
    } else {
      const baseColor = override.color || "#ffffff";
      const brightness = typeof override.brightness === "number" ? override.brightness : 100;
      const displayColor = applyBrightnessToHex(baseColor, brightness);
      node.style.setProperty("--led-color", displayColor);
      node.setAttribute("data-led-on", "true");
      node.setAttribute("data-led-color", baseColor);
      node.setAttribute("data-led-brightness", String(brightness));
    }
  });
  updateSelectedStyling();
}

function getActiveKeyframe() {
  if (!state.timeline.activeKeyframeId) {
    return null;
  }
  return state.timeline.keyframes.find((frame) => frame.id === state.timeline.activeKeyframeId) ?? null;
}

function getViewEnd() {
  return state.timeline.viewStart + state.timeline.viewSpan;
}

function getTimelineStep() {
  return Number((1 / state.timeline.frameRate).toFixed(4));
}

function clampTimeToStep(value) {
  const step = getTimelineStep();
  return Math.round(value / step) * step;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function syncViewWithDuration() {
  const duration = Math.max(state.timeline.duration, getTimelineStep());
  state.timeline.viewSpan = clamp(state.timeline.viewSpan, getTimelineStep(), duration);
  const maxStart = Math.max(duration - state.timeline.viewSpan, 0);
  state.timeline.viewStart = clamp(state.timeline.viewStart, 0, maxStart);
  clampCurrentTimeInView();
  if (timelineZoom) {
    const minZoom = Math.max(Number(timelineZoom.min) || getTimelineStep(), getTimelineStep());
    timelineZoom.min = String(minZoom);
    timelineZoom.max = String(duration);
    timelineZoom.value = String(state.timeline.viewSpan);
  }
}

function setupScrollDrag() {
  if (!timelineScrollThumb || !timelineScroll) {
    return;
  }

  timelineScrollThumb.addEventListener("pointerdown", (event) => {
    if (
      (timelineSuite && timelineSuite.dataset.disabled === "true") ||
      timelineScrollThumb.classList.contains("is-disabled")
    ) {
      return;
    }
    scrollDragContext = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startViewStart: state.timeline.viewStart,
    };
    timelineScrollThumb.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  timelineScrollThumb.addEventListener("pointermove", (event) => {
    if (!scrollDragContext || event.pointerId !== scrollDragContext.pointerId) {
      return;
    }
    const trackRect = timelineScroll.getBoundingClientRect();
    if (!trackRect.width) {
      return;
    }
    const deltaPx = event.clientX - scrollDragContext.startX;
    const deltaTime = (deltaPx / trackRect.width) * state.timeline.duration;
    setViewStart(scrollDragContext.startViewStart + deltaTime);
    updateTimelineView();
  });

  const endDrag = (event) => {
    if (scrollDragContext && event.pointerId === scrollDragContext.pointerId) {
      timelineScrollThumb.releasePointerCapture(event.pointerId);
      scrollDragContext = null;
    }
  };

  timelineScrollThumb.addEventListener("pointerup", endDrag);
  timelineScrollThumb.addEventListener("pointercancel", endDrag);
}

function updateDurationLabel() {
  if (!durationLabel) return;
  durationLabel.textContent = `Duration: ${state.timeline.duration}s`;
}

function togglePlayback() {
  if (state.playback.isPlaying) {
    stopPlayback();
  } else {
    startPlayback();
  }
}

function startPlayback() {
  if (timelineSuite && timelineSuite.dataset.disabled === "true") {
    return;
  }
  const duration = Math.max(state.timeline.duration, getTimelineStep());
  if (duration <= 0) {
    return;
  }
  if (state.timeline.currentTime >= duration) {
    state.timeline.currentTime = clampTimeToStep(0);
    scrollViewToTime(state.timeline.currentTime);
  }
  state.playback.accumulator = 0;
  state.playback.isPlaying = true;
  state.playback.lastFrameTime = null;
  state.playback.rafHandle = requestAnimationFrame(playbackStep);
  updateTimelineView();
}

function stopPlayback({ rewind = false } = {}) {
  if (state.playback.rafHandle != null) {
    cancelAnimationFrame(state.playback.rafHandle);
    state.playback.rafHandle = null;
  }
  state.playback.isPlaying = false;
  state.playback.lastFrameTime = null;
  state.playback.accumulator = 0;
  if (rewind) {
    state.timeline.currentTime = clampTimeToStep(0);
    scrollViewToTime(state.timeline.currentTime);
  }
  updateTimelineView();
}

function playbackStep(timestamp) {
  if (!state.playback.isPlaying) {
    return;
  }
  if (state.playback.lastFrameTime == null) {
    state.playback.lastFrameTime = timestamp;
    state.playback.rafHandle = requestAnimationFrame(playbackStep);
    return;
  }

  const dtSec = Math.max((timestamp - state.playback.lastFrameTime) / 1000, 0);
  state.playback.lastFrameTime = timestamp;
  const duration = Math.max(state.timeline.duration, getTimelineStep());
  if (duration <= 0) {
    stopPlayback();
    return;
  }

  const frameDuration = 1 / Math.max(state.timeline.frameRate, 1);
  state.playback.accumulator += dtSec;

  const lastKeyframeTime =
    state.timeline.keyframes.length > 0
      ? state.timeline.keyframes[state.timeline.keyframes.length - 1].time
      : duration;

  let advanced = false;
  while (state.playback.accumulator >= frameDuration) {
    state.playback.accumulator -= frameDuration;
    const nextTime = state.timeline.currentTime + frameDuration * state.playback.direction;
    if (nextTime > lastKeyframeTime) {
      state.timeline.currentTime = clampTimeToStep(lastKeyframeTime);
      advanced = true;
      const finalViewChange = scrollViewToTime(state.timeline.currentTime);
      updatePlaybackUi(finalViewChange);
      // Reset accumulation so that the next loop iteration starts from zero time
      state.playback.accumulator = 0;
      state.timeline.currentTime = clampTimeToStep(0);
      scrollViewToTime(state.timeline.currentTime);
      break;
    }
    state.timeline.currentTime = clampTimeToStep(nextTime);
    advanced = true;
  }

  const viewChanged = scrollViewToTime(state.timeline.currentTime);
  if (advanced || viewChanged) {
    updatePlaybackUi(viewChanged);
  }
  state.playback.rafHandle = requestAnimationFrame(playbackStep);
}

async function createSimulatedStrip(ledCount) {
  if (!state.simulatorMode) {
    return;
  }
  const limit = state.limits.max_leds_per_strip ?? 250;
  let count = Number.isFinite(ledCount) ? ledCount : 60;
  count = Math.max(1, Math.min(count, limit));
  const payload = {
    led_count: count,
  };
  try {
    const response = await fetch("/api/strips/simulator", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      const message = errorPayload?.message || response.statusText || "Unable to add simulated strip.";
      throw new Error(message);
    }
    await loadStrips();
    renderStrips();
    state.pattern.strips = snapshotCurrentStrips();
    markDirty();
  } catch (error) {
    console.error(error);
    if (simHint) {
      simHint.textContent = String(error.message || error);
    }
  }
}

async function removeSimulatedStrip(pin) {
  try {
    const response = await fetch(`/api/strips/simulator/${pin}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      const message = errorPayload?.message || response.statusText || "Unable to remove simulated strip.";
      throw new Error(message);
    }
    // Reset selection if removing current strip.
    if (state.selectedStripPin === pin) {
      state.selectedStripPin = null;
      state.selectedLedKeys.clear();
      state.timeline.activeKeyframeId = null;
      state.timeline.currentTime = clampTimeToStep(0);
    }
    await loadStrips();
    renderStrips();
    state.pattern.strips = snapshotCurrentStrips();
    markDirty();
    if (!state.strips.length) {
      stopPlayback({ rewind: true });
      renderVisualization();
      updateTimelineDisabled(true);
      updateLedInspector();
    } else if (state.selectedStripPin != null) {
      updateTimelineView();
      updateLedInspector();
    }
  } catch (error) {
    console.error(error);
    if (simHint) {
      simHint.textContent = String(error.message || error);
    }
  }
}



