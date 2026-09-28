let recording = null;
let screenVideoEl = null;
let camVideoEl = null;
let previewCtx = null;
let zoomSegments = [];
let clickEvents = []; // cursorEvents filtered down to down/click, re-scanned every rendered frame
let durationMs = 0;
let previewTimeMs = 0;
let previewPlayback = null;
let pendingCutStart = null; // ms, set while marking an in-point, null when not marking

let cachedAudioCtx = null;
let screenAudioSource = null;
let camAudioSource = null;
let lastExportAudioDest = null;

const settings = {
  trimStartMs: 0,
  trimEndMs: 0,
  cuts: [], // [{start, end}] ms ranges removed from the middle of the clip
  zoomDepth: 1.8,
  background: { type: 'gradient', value: 'purple', image: null },
  insetPadFrac: 0.06,
  browserFrame: false,
  clickEffects: { enabled: true, color: '#667eea', intensity: 0.6 },
  webcamPip: { enabled: true, corner: 'br', sizeFrac: 0.22, background: { mode: 'none', blurPx: 14, image: null } },
};

const els = {};

function formatTime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function updateTimeLabel(tMs) {
  els.timeLabel.textContent = `${formatTime(tMs)} / ${formatTime(durationMs)}`;
}

/**
 * Returns the [start, end] ms ranges of the clip that should actually play,
 * i.e. [trimStartMs, trimEndMs] with every range in `cuts` removed.
 */
function computeKeptSegments(trimStartMs, trimEndMs, cuts) {
  const sortedCuts = [...cuts].sort((a, b) => a.start - b.start);
  const segments = [];
  let cursor = trimStartMs;
  for (const cut of sortedCuts) {
    const cs = Math.max(cut.start, trimStartMs);
    const ce = Math.min(cut.end, trimEndMs);
    if (ce <= cursor || cs >= trimEndMs) continue;
    if (cs > cursor) segments.push([cursor, cs]);
    cursor = Math.max(cursor, ce);
  }
  if (cursor < trimEndMs) segments.push([cursor, trimEndMs]);
  return segments;
}

function seekTo(videoEl, timeSec) {
  return new Promise((resolve) => {
    if (Math.abs(videoEl.currentTime - timeSec) < 0.01) return resolve();
    const handler = () => {
      videoEl.removeEventListener('seeked', handler);
      resolve();
    };
    videoEl.addEventListener('seeked', handler);
    videoEl.currentTime = timeSec;
  });
}

function waitForMetadata(videoEl) {
  return new Promise((resolve) => {
    if (videoEl.readyState >= 1) return resolve();
    videoEl.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
}

/**
 * Plays through a list of [start, end] ms segments in order, seeking straight
 * past any gap between them (the cut-out ranges) instead of playing over it.
 * onFrame(tMs, elapsedKeptMs) — tMs is the raw source-video time (what
 * zoom/click-effect data is anchored to), elapsedKeptMs is how far into the
 * edited (cuts removed) timeline playback has gotten, for progress display.
 */
function drivePlayback({ screenVideoEl: sv, camVideoEl: cv, segments, onFrame, onDone }) {
  let stopped = false;
  let frameHandle = null;
  let segIndex = 0;

  if (!segments.length) {
    onDone();
    return { stop: () => {} };
  }

  // requestAnimationFrame is tied to paint and browsers fully suspend it while the
  // document is hidden (backgrounded/minimized tab) — during export that leaves the
  // MediaRecorder repeating the last painted canvas frame for however long the tab
  // was out of focus, i.e. a frozen export even though playback (which nobody is
  // recording) looks fine. requestVideoFrameCallback is tied to the video decoder
  // instead of paint, so it keeps firing in a hidden tab and export stays live.
  const useVideoFrameCallback = typeof sv.requestVideoFrameCallback === 'function';
  function scheduleFrame() {
    frameHandle = useVideoFrameCallback ? sv.requestVideoFrameCallback(frame) : requestAnimationFrame(frame);
  }
  function cancelScheduledFrame() {
    if (frameHandle == null) return;
    if (useVideoFrameCallback) sv.cancelVideoFrameCallback(frameHandle);
    else cancelAnimationFrame(frameHandle);
  }

  const segOffsets = [];
  let acc = 0;
  for (const [a, b] of segments) {
    segOffsets.push(acc);
    acc += b - a;
  }

  function finish() {
    if (stopped) return;
    stopped = true;
    cancelScheduledFrame();
    sv.removeEventListener('ended', onSourceEnded);
    sv.pause();
    if (cv) cv.pause();
    onDone();
  }

  // requestVideoFrameCallback only fires for a newly-presented frame, so once the
  // source video reaches the end of its own duration (the common case: the last
  // kept segment ends where the recording does) no further frame arrives to notice
  // the boundary and finish the export — it hangs forever at ~100%. The 'ended'
  // event fires reliably regardless, so use it to force that same check.
  function onSourceEnded() {
    frame();
  }
  sv.addEventListener('ended', onSourceEnded);

  function advanceToNextSegment() {
    segIndex += 1;
    if (segIndex >= segments.length) {
      finish();
      return;
    }
    const nextStart = segments[segIndex][0] / 1000;
    Promise.all([seekTo(sv, nextStart), cv ? seekTo(cv, nextStart) : Promise.resolve()]).then(() => {
      if (!stopped) scheduleFrame();
    });
  }

  function frame() {
    if (stopped) return;
    const tMs = sv.currentTime * 1000;
    const [, segEnd] = segments[segIndex];
    if (tMs >= segEnd || sv.ended) {
      advanceToNextSegment();
      return;
    }
    const elapsedKeptMs = segOffsets[segIndex] + (tMs - segments[segIndex][0]);
    onFrame(tMs, elapsedKeptMs);
    scheduleFrame();
  }

  const firstStart = segments[0][0] / 1000;
  Promise.all([seekTo(sv, firstStart), cv ? seekTo(cv, firstStart) : Promise.resolve()])
    .then(() => Promise.all([sv.play(), cv ? cv.play() : Promise.resolve()]))
    .then(() => {
      if (!stopped) scheduleFrame();
    });

  return { stop: finish };
}

function buildRenderState(tMs) {
  return {
    screenVideoEl,
    camVideoEl: settings.webcamPip.enabled && camVideoEl ? camVideoEl : null,
    t: tMs,
    segments: zoomSegments,
    cursorEvents: clickEvents,
    background: settings.background,
    insetPadFrac: settings.insetPadFrac,
    browserFrame: settings.browserFrame,
    clickEffects: settings.clickEffects,
    webcamPip: settings.webcamPip,
  };
}

function drawFrame(tMs) {
  renderComposite(previewCtx, els.previewCanvas, buildRenderState(tMs));
}

async function renderAtTime(tMs) {
  previewTimeMs = tMs;
  await Promise.all([seekTo(screenVideoEl, tMs / 1000), camVideoEl ? seekTo(camVideoEl, tMs / 1000) : Promise.resolve()]);
  drawFrame(tMs);
  updateTimeLabel(tMs);
}

function recomputeZoomSegments() {
  zoomSegments = computeZoomSegments(recording.cursorEvents || [], settings.zoomDepth);
  // Click-effect rendering only cares about down/click events, but cursorEvents is
  // dominated by ~30Hz mousemove samples — pre-filtering once here instead of
  // rescanning the whole (much larger) raw array on every rendered frame is what
  // keeps preview/export playback smooth on longer recordings.
  clickEvents = (recording.cursorEvents || []).filter(
    (e) => (e.kind === 'down' || e.kind === 'click') && e.nx !== undefined
  );
}

function setupCanvasSize() {
  const maxW = 960;
  const vw = screenVideoEl.videoWidth || 1920;
  const vh = screenVideoEl.videoHeight || 1080;
  const scale = Math.min(1, maxW / vw);
  els.previewCanvas.width = Math.round(vw * scale);
  els.previewCanvas.height = Math.round(vh * scale);
  previewCtx = els.previewCanvas.getContext('2d');
}

function setupWebcamVisibility() {
  if (!camVideoEl) {
    els.webcamFieldset.hidden = true;
    settings.webcamPip.enabled = false;
  }
}

const THUMBNAIL_COUNT = 12;

async function generateThumbnails() {
  els.filmstrip.innerHTML = '';
  if (!durationMs || !isFinite(durationMs)) return;

  const thumbW = 160;
  const thumbH = Math.max(1, Math.round(thumbW * (screenVideoEl.videoHeight / screenVideoEl.videoWidth || 0.5625)));
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = thumbW;
  thumbCanvas.height = thumbH;
  const tctx = thumbCanvas.getContext('2d');
  const resumeTime = screenVideoEl.currentTime;

  for (let i = 0; i < THUMBNAIL_COUNT; i++) {
    const t = (durationMs * (i + 0.5)) / THUMBNAIL_COUNT;
    await seekTo(screenVideoEl, t / 1000);
    tctx.drawImage(screenVideoEl, 0, 0, thumbW, thumbH);
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = thumbCanvas.toDataURL('image/jpeg', 0.6);
    els.filmstrip.appendChild(img);
  }

  await seekTo(screenVideoEl, resumeTime);
}

function msFromClientX(clientX) {
  const rect = els.timeline.getBoundingClientRect();
  const px = Math.min(rect.width, Math.max(0, clientX - rect.left));
  return (px / rect.width) * durationMs;
}

function updateTimelineUI() {
  const toPct = (ms) => `${durationMs > 0 ? (ms / durationMs) * 100 : 0}%`;
  els.handleStart.style.left = toPct(settings.trimStartMs);
  els.handleEnd.style.left = toPct(settings.trimEndMs);
  els.trimDimLeft.style.width = toPct(settings.trimStartMs);
  els.trimDimRight.style.left = toPct(settings.trimEndMs);
  els.trimDimRight.style.width = `calc(100% - ${toPct(settings.trimEndMs)})`;
  els.playhead.style.left = toPct(previewTimeMs);

  const durationInt = Math.round(durationMs);
  els.timeline.setAttribute('aria-valuemax', String(durationInt));
  els.timeline.setAttribute('aria-valuenow', String(Math.round(previewTimeMs)));
  els.handleStart.setAttribute('aria-valuemax', String(durationInt));
  els.handleStart.setAttribute('aria-valuenow', String(Math.round(settings.trimStartMs)));
  els.handleEnd.setAttribute('aria-valuemax', String(durationInt));
  els.handleEnd.setAttribute('aria-valuenow', String(Math.round(settings.trimEndMs)));
}

function toTimelinePct(ms) {
  return `${durationMs > 0 ? (ms / durationMs) * 100 : 0}%`;
}

function renderCutRegions() {
  els.cutRegions.innerHTML = '';
  settings.cuts.forEach((cut, i) => {
    const div = document.createElement('div');
    div.className = 'cut-region';
    div.style.left = toTimelinePct(cut.start);
    div.style.width = `calc(${toTimelinePct(cut.end)} - ${toTimelinePct(cut.start)})`;

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'cut-restore';
    restoreBtn.title = 'Restore this section';
    restoreBtn.setAttribute('aria-label', 'Restore this cut section');
    restoreBtn.textContent = '↺';
    restoreBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    restoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      settings.cuts.splice(i, 1);
      renderCutRegions();
      renderAtTime(previewTimeMs);
    });

    div.appendChild(restoreBtn);
    els.cutRegions.appendChild(div);
  });
}

function updatePendingCutMarker() {
  if (pendingCutStart === null) {
    els.pendingCutMarker.hidden = true;
    return;
  }
  els.pendingCutMarker.hidden = false;
  els.pendingCutMarker.style.left = toTimelinePct(pendingCutStart);
}

function onMarkCutClick() {
  if (pendingCutStart === null) {
    pendingCutStart = previewTimeMs;
    els.markCutBtn.textContent = '✂ Cut to here';
    els.cancelCutBtn.hidden = false;
    updatePendingCutMarker();
    return;
  }

  const start = Math.min(pendingCutStart, previewTimeMs);
  const end = Math.max(pendingCutStart, previewTimeMs);
  if (end - start >= 100) {
    settings.cuts.push({ start, end });
  }
  pendingCutStart = null;
  els.markCutBtn.textContent = '✂ Mark cut here';
  els.cancelCutBtn.hidden = true;
  updatePendingCutMarker();
  renderCutRegions();
  renderAtTime(previewTimeMs);
}

function onCancelCutClick() {
  pendingCutStart = null;
  els.markCutBtn.textContent = '✂ Mark cut here';
  els.cancelCutBtn.hidden = true;
  updatePendingCutMarker();
}

let timelineDragMode = null; // 'scrub' | 'trimStart' | 'trimEnd'

const KEY_STEP_MS = 200;
const KEY_STEP_MS_BIG = 2000;

function setupTimeline() {
  updateTimelineUI();

  els.timeline.addEventListener('pointerdown', (e) => {
    if (e.target === els.handleStart) timelineDragMode = 'trimStart';
    else if (e.target === els.handleEnd) timelineDragMode = 'trimEnd';
    else timelineDragMode = 'scrub';
    stopPreviewIfPlaying();
    els.timeline.setPointerCapture(e.pointerId);
    onTimelinePointerMove(e);
  });

  els.timeline.addEventListener('pointermove', onTimelinePointerMove);

  els.timeline.addEventListener('keydown', (e) => {
    if (e.target !== els.timeline) return;
    const step = e.shiftKey ? KEY_STEP_MS_BIG : KEY_STEP_MS;
    if (e.key === 'ArrowLeft') {
      stopPreviewIfPlaying();
      renderAtTime(Math.max(0, previewTimeMs - step));
      updateTimelineUI();
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      stopPreviewIfPlaying();
      renderAtTime(Math.min(durationMs, previewTimeMs + step));
      updateTimelineUI();
      e.preventDefault();
    } else if (e.key === 'Home') {
      stopPreviewIfPlaying();
      renderAtTime(0);
      updateTimelineUI();
      e.preventDefault();
    } else if (e.key === 'End') {
      stopPreviewIfPlaying();
      renderAtTime(durationMs);
      updateTimelineUI();
      e.preventDefault();
    }
  });

  els.handleStart.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? KEY_STEP_MS_BIG : KEY_STEP_MS;
    if (e.key === 'ArrowLeft') {
      settings.trimStartMs = Math.max(0, settings.trimStartMs - step);
    } else if (e.key === 'ArrowRight') {
      settings.trimStartMs = Math.min(settings.trimEndMs - 100, settings.trimStartMs + step);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    stopPreviewIfPlaying();
    renderAtTime(settings.trimStartMs);
    updateTimelineUI();
  });

  els.handleEnd.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? KEY_STEP_MS_BIG : KEY_STEP_MS;
    if (e.key === 'ArrowLeft') {
      settings.trimEndMs = Math.max(settings.trimStartMs + 100, settings.trimEndMs - step);
    } else if (e.key === 'ArrowRight') {
      settings.trimEndMs = Math.min(durationMs, settings.trimEndMs + step);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    stopPreviewIfPlaying();
    renderAtTime(settings.trimEndMs);
    updateTimelineUI();
  });

  const endDrag = (e) => {
    timelineDragMode = null;
    try {
      els.timeline.releasePointerCapture(e.pointerId);
    } catch (err) {
      // pointer capture may already be released
    }
  };
  els.timeline.addEventListener('pointerup', endDrag);
  els.timeline.addEventListener('pointercancel', endDrag);
}

function onTimelinePointerMove(e) {
  if (!timelineDragMode) return;
  const ms = msFromClientX(e.clientX);

  if (timelineDragMode === 'trimStart') {
    settings.trimStartMs = Math.max(0, Math.min(ms, settings.trimEndMs - 100));
    renderAtTime(settings.trimStartMs);
  } else if (timelineDragMode === 'trimEnd') {
    settings.trimEndMs = Math.min(durationMs, Math.max(ms, settings.trimStartMs + 100));
    renderAtTime(settings.trimEndMs);
  } else {
    renderAtTime(Math.min(durationMs, Math.max(0, ms)));
  }
  updateTimelineUI();
}

function populateSwatches() {
  els.bgSwatches.innerHTML = '';
  for (const key of Object.keys(OM_GRADIENT_PRESETS)) {
    const [c1, c2] = OM_GRADIENT_PRESETS[key];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch' + (key === settings.background.value ? ' selected' : '');
    btn.title = key;
    btn.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
    btn.addEventListener('click', () => {
      settings.background = { type: 'gradient', value: key, image: null };
      els.bgSwatches.querySelectorAll('.swatch').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      renderAtTime(previewTimeMs);
    });
    els.bgSwatches.appendChild(btn);
  }
}

async function togglePlayback() {
  if (previewPlayback) {
    previewPlayback.stop();
    previewPlayback = null;
    els.playPauseBtn.textContent = '▶ Play';
    return;
  }
  getAudioSources();
  els.playPauseBtn.textContent = '❙❙ Pause';
  previewPlayback = drivePlayback({
    screenVideoEl,
    camVideoEl: settings.webcamPip.enabled ? camVideoEl : null,
    segments: computeKeptSegments(settings.trimStartMs, settings.trimEndMs, settings.cuts),
    onFrame: (tMs) => {
      previewTimeMs = tMs;
      drawFrame(tMs);
      updateTimelineUI();
      updateTimeLabel(tMs);
    },
    onDone: () => {
      previewPlayback = null;
      els.playPauseBtn.textContent = '▶ Play';
    },
  });
}

function stopPreviewIfPlaying() {
  if (previewPlayback) {
    previewPlayback.stop();
    previewPlayback = null;
    els.playPauseBtn.textContent = '▶ Play';
  }
}

function getAudioSources() {
  if (!cachedAudioCtx) {
    cachedAudioCtx = new AudioContext();
    // A muted <video> silences the samples before they reach the Web Audio graph too,
    // not just the speakers — unmute so both live preview and the exported audio tap
    // actually get signal. Connecting to audioCtx.destination is what makes Play/scrub
    // in the editor audible; the export path additionally taps the same source nodes
    // into a MediaStreamAudioDestinationNode to capture them into the output file.
    screenVideoEl.muted = false;
    if (camVideoEl) camVideoEl.muted = false;
    try {
      screenAudioSource = cachedAudioCtx.createMediaElementSource(screenVideoEl);
      screenAudioSource.connect(cachedAudioCtx.destination);
    } catch (err) {
      screenAudioSource = null;
    }
    if (camVideoEl) {
      try {
        camAudioSource = cachedAudioCtx.createMediaElementSource(camVideoEl);
        camAudioSource.connect(cachedAudioCtx.destination);
      } catch (err) {
        camAudioSource = null;
      }
    }
  }
  return { audioCtx: cachedAudioCtx, screenAudioSource, camAudioSource };
}

async function runExport() {
  stopPreviewIfPlaying();
  els.exportBtn.disabled = true;
  els.exportStatus.textContent = 'Preparing export…';

  const resHeight = Number(els.outputResolution.value);
  const fps = Number(els.outputFps.value);
  const bitrateMbps = Number(els.bitrateRange.value);

  const vw = screenVideoEl.videoWidth || 1920;
  const vh = screenVideoEl.videoHeight || 1080;
  const exportCanvas = document.createElement('canvas');
  exportCanvas.height = resHeight;
  exportCanvas.width = Math.round(resHeight * (vw / vh));
  const exportCtx = exportCanvas.getContext('2d');

  const { audioCtx, screenAudioSource: sSrc, camAudioSource: cSrc } = getAudioSources();
  const dest = audioCtx.createMediaStreamDestination();
  // Fan out the same source nodes to this export's capture destination — they stay
  // connected to audioCtx.destination too, so export remains audible like preview.
  // Drop the previous export's capture destination first so repeated exports don't
  // pile up dangling connections.
  if (lastExportAudioDest) {
    try {
      sSrc?.disconnect(lastExportAudioDest);
    } catch (err) {
      // already disconnected
    }
    try {
      cSrc?.disconnect(lastExportAudioDest);
    } catch (err) {
      // already disconnected
    }
  }
  lastExportAudioDest = dest;

  let connectedAny = false;
  if (sSrc) {
    sSrc.connect(dest);
    connectedAny = true;
  }
  if (cSrc) {
    cSrc.connect(dest);
    connectedAny = true;
  }

  const canvasStream = exportCanvas.captureStream(fps);
  const tracks = [...canvasStream.getVideoTracks()];
  if (connectedAny) tracks.push(...dest.stream.getAudioTracks());
  const exportStream = new MediaStream(tracks);

  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) =>
    MediaRecorder.isTypeSupported(t)
  );
  const exportRecorder = new MediaRecorder(exportStream, {
    mimeType,
    videoBitsPerSecond: bitrateMbps * 1_000_000,
  });
  const exportChunks = [];
  exportRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) exportChunks.push(e.data);
  };
  const exportDone = new Promise((resolve) => {
    exportRecorder.onstop = resolve;
  });

  exportRecorder.start();
  const exportStartedAtMs = performance.now();

  const exportSegments = computeKeptSegments(settings.trimStartMs, settings.trimEndMs, settings.cuts);
  const totalKeptMs = exportSegments.reduce((sum, [a, b]) => sum + (b - a), 0);

  drivePlayback({
    screenVideoEl,
    camVideoEl: settings.webcamPip.enabled ? camVideoEl : null,
    segments: exportSegments,
    onFrame: (tMs, elapsedKeptMs) => {
      renderComposite(exportCtx, exportCanvas, buildRenderState(tMs));
      const pct = totalKeptMs > 0 ? Math.min(100, Math.round((elapsedKeptMs / totalKeptMs) * 100)) : 100;
      // Export plays the clip back in real time to capture audio, so elapsed-so-far
      // is the best predictor of what's left — extrapolate remaining wall time from
      // the same pace rather than assuming a fixed (and often wrong) 1x rate.
      const elapsedRealMs = performance.now() - exportStartedAtMs;
      let etaSuffix = '';
      if (elapsedKeptMs > 500 && totalKeptMs > elapsedKeptMs) {
        const remainingMs = (elapsedRealMs / elapsedKeptMs) * (totalKeptMs - elapsedKeptMs);
        etaSuffix = ` (${formatTime(remainingMs)} left)`;
      }
      els.exportStatus.textContent = `Exporting… ${pct}%${etaSuffix}`;
    },
    onDone: () => {
      if (exportRecorder.state !== 'inactive') exportRecorder.stop();
    },
  });

  await exportDone;

  const blob = new Blob(exportChunks, { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  els.resultVideo.src = url;
  els.downloadLink.href = url;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  els.downloadLink.download = `open-motion-${stamp}.webm`;

  els.exportBtn.disabled = false;
  els.exportStatus.textContent = '';
  els.editorRoot.hidden = true;
  els.resultOverlay.hidden = false;
}

async function onWebcamBgModeChange() {
  const mode = els.webcamBgMode.value;
  settings.webcamPip.background.mode = mode;
  els.webcamBlurRow.hidden = mode !== 'blur';
  els.webcamBgUploadRow.hidden = mode !== 'image';

  if (mode === 'none') {
    els.webcamBgStatus.hidden = true;
    renderAtTime(previewTimeMs);
    return;
  }

  if (!window.omSegmenter) {
    els.webcamBgStatus.hidden = false;
    els.webcamBgStatus.textContent = "Background removal isn't available in this build.";
    return;
  }

  if (!window.omSegmenter.isSegmenterReady()) {
    els.webcamBgStatus.hidden = false;
    els.webcamBgStatus.textContent = 'Loading background removal model (first time only)…';
    try {
      await window.omSegmenter.initSegmenter();
      els.webcamBgStatus.hidden = true;
    } catch (err) {
      els.webcamBgStatus.textContent = 'Could not load the background removal model — showing your real background.';
      console.warn(err);
    }
  } else {
    els.webcamBgStatus.hidden = true;
  }

  renderAtTime(previewTimeMs);
}

function bindControls() {
  els.playPauseBtn.addEventListener('click', togglePlayback);
  els.markCutBtn.addEventListener('click', onMarkCutClick);
  els.cancelCutBtn.addEventListener('click', onCancelCutClick);

  els.zoomDepthRange.addEventListener('input', () => {
    settings.zoomDepth = Number(els.zoomDepthRange.value);
    els.zoomDepthValue.textContent = `${settings.zoomDepth.toFixed(1)}x`;
    recomputeZoomSegments();
    renderAtTime(previewTimeMs);
  });

  els.bgUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      settings.background = { type: 'image', image: img, value: null };
      els.bgSwatches.querySelectorAll('.swatch').forEach((b) => b.classList.remove('selected'));
      renderAtTime(previewTimeMs);
    };
    img.src = URL.createObjectURL(file);
  });

  els.paddingRange.addEventListener('input', () => {
    const pct = Number(els.paddingRange.value);
    settings.insetPadFrac = pct / 100;
    els.paddingValue.textContent = `${pct}%`;
    renderAtTime(previewTimeMs);
  });

  els.browserFrameToggle.addEventListener('change', () => {
    settings.browserFrame = els.browserFrameToggle.checked;
    renderAtTime(previewTimeMs);
  });

  els.clickEffectsToggle.addEventListener('change', () => {
    settings.clickEffects.enabled = els.clickEffectsToggle.checked;
    renderAtTime(previewTimeMs);
  });

  els.clickColor.addEventListener('input', () => {
    settings.clickEffects.color = els.clickColor.value;
    renderAtTime(previewTimeMs);
  });

  els.intensityRange.addEventListener('input', () => {
    const pct = Number(els.intensityRange.value);
    settings.clickEffects.intensity = pct / 100;
    els.intensityValue.textContent = `${pct}%`;
    renderAtTime(previewTimeMs);
  });

  els.webcamToggle.addEventListener('change', () => {
    settings.webcamPip.enabled = els.webcamToggle.checked;
    renderAtTime(previewTimeMs);
  });

  els.webcamCorner.addEventListener('change', () => {
    settings.webcamPip.corner = els.webcamCorner.value;
    renderAtTime(previewTimeMs);
  });

  els.webcamSizeRange.addEventListener('input', () => {
    const pct = Number(els.webcamSizeRange.value);
    settings.webcamPip.sizeFrac = pct / 100;
    els.webcamSizeValue.textContent = `${pct}%`;
    renderAtTime(previewTimeMs);
  });

  els.webcamBgMode.addEventListener('change', () => onWebcamBgModeChange());

  els.webcamBlurRange.addEventListener('input', () => {
    const px = Number(els.webcamBlurRange.value);
    settings.webcamPip.background.blurPx = px;
    els.webcamBlurValue.textContent = `${px}px`;
    renderAtTime(previewTimeMs);
  });

  els.webcamBgUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      settings.webcamPip.background.image = img;
      renderAtTime(previewTimeMs);
    };
    img.src = URL.createObjectURL(file);
  });

  els.bitrateRange.addEventListener('input', () => {
    els.bitrateValue.textContent = `${els.bitrateRange.value} Mbps`;
  });

  els.exportBtn.addEventListener('click', runExport);

  els.backToEditBtn.addEventListener('click', () => {
    els.resultOverlay.hidden = true;
    els.editorRoot.hidden = false;
  });
}

function showError() {
  els.loadingState.hidden = true;
  els.errorState.hidden = false;
}

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return showError();

  recording = await getRecording(id);
  if (!recording) return showError();

  screenVideoEl = document.createElement('video');
  screenVideoEl.src = URL.createObjectURL(recording.screenBlob);
  screenVideoEl.muted = true;
  screenVideoEl.playsInline = true;
  els.mediaSinks.appendChild(screenVideoEl);

  if (recording.camBlob) {
    camVideoEl = document.createElement('video');
    camVideoEl.src = URL.createObjectURL(recording.camBlob);
    camVideoEl.muted = true;
    camVideoEl.playsInline = true;
    els.mediaSinks.appendChild(camVideoEl);
  }

  await Promise.all([waitForMetadata(screenVideoEl), camVideoEl ? waitForMetadata(camVideoEl) : Promise.resolve()]);

  const durations = [screenVideoEl.duration * 1000];
  if (camVideoEl) durations.push(camVideoEl.duration * 1000);
  durationMs = Math.min(...durations.filter((d) => isFinite(d) && d > 0));
  if (!isFinite(durationMs) || durationMs <= 0) durationMs = recording.meta?.durationMs || 0;

  settings.trimStartMs = 0;
  settings.trimEndMs = durationMs;

  setupCanvasSize();
  recomputeZoomSegments();
  setupWebcamVisibility();
  setupTimeline();
  populateSwatches();
  bindControls();

  els.loadingState.querySelector('.sub').textContent = 'Generating filmstrip…';
  await generateThumbnails();
  renderCutRegions();
  updateTimelineUI();

  if (!recording.meta?.trackingAvailable) {
    els.zoomWarning.hidden = false;
    if (recording.meta?.displaySurface && recording.meta.displaySurface !== 'browser') {
      const label = recording.meta.displaySurface === 'monitor' ? 'the entire screen' : 'a window';
      els.zoomWarning.textContent = `This recording shared ${label}, not "This Tab", so no cursor data was captured — auto zoom & click effects are unavailable for it. Everything else still works.`;
    }
  }

  els.loadingState.hidden = true;
  els.editorRoot.hidden = false;

  await renderAtTime(0);
}

window.addEventListener('DOMContentLoaded', () => {
  els.loadingState = document.getElementById('loadingState');
  els.errorState = document.getElementById('errorState');
  els.editorRoot = document.getElementById('editorRoot');
  els.resultOverlay = document.getElementById('resultOverlay');
  els.mediaSinks = document.getElementById('mediaSinks');

  els.previewCanvas = document.getElementById('previewCanvas');
  els.playPauseBtn = document.getElementById('playPauseBtn');
  els.timeLabel = document.getElementById('timeLabel');
  els.markCutBtn = document.getElementById('markCutBtn');
  els.cancelCutBtn = document.getElementById('cancelCutBtn');
  els.timeline = document.getElementById('timeline');
  els.filmstrip = document.getElementById('filmstrip');
  els.trimDimLeft = document.getElementById('trimDimLeft');
  els.trimDimRight = document.getElementById('trimDimRight');
  els.cutRegions = document.getElementById('cutRegions');
  els.pendingCutMarker = document.getElementById('pendingCutMarker');
  els.handleStart = document.getElementById('handleStart');
  els.handleEnd = document.getElementById('handleEnd');
  els.playhead = document.getElementById('playhead');
  els.zoomWarning = document.getElementById('zoomWarning');

  els.zoomDepthRange = document.getElementById('zoomDepthRange');
  els.zoomDepthValue = document.getElementById('zoomDepthValue');

  els.bgSwatches = document.getElementById('bgSwatches');
  els.bgUpload = document.getElementById('bgUpload');
  els.paddingRange = document.getElementById('paddingRange');
  els.paddingValue = document.getElementById('paddingValue');

  els.browserFrameToggle = document.getElementById('browserFrameToggle');

  els.clickEffectsToggle = document.getElementById('clickEffectsToggle');
  els.clickColor = document.getElementById('clickColor');
  els.intensityRange = document.getElementById('intensityRange');
  els.intensityValue = document.getElementById('intensityValue');

  els.webcamFieldset = document.getElementById('webcamFieldset');
  els.webcamToggle = document.getElementById('webcamToggle');
  els.webcamCorner = document.getElementById('webcamCorner');
  els.webcamSizeRange = document.getElementById('webcamSizeRange');
  els.webcamSizeValue = document.getElementById('webcamSizeValue');
  els.webcamBgMode = document.getElementById('webcamBgMode');
  els.webcamBlurRow = document.getElementById('webcamBlurRow');
  els.webcamBlurRange = document.getElementById('webcamBlurRange');
  els.webcamBlurValue = document.getElementById('webcamBlurValue');
  els.webcamBgUploadRow = document.getElementById('webcamBgUploadRow');
  els.webcamBgUpload = document.getElementById('webcamBgUpload');
  els.webcamBgStatus = document.getElementById('webcamBgStatus');

  els.outputResolution = document.getElementById('outputResolution');
  els.outputFps = document.getElementById('outputFps');
  els.bitrateRange = document.getElementById('bitrateRange');
  els.bitrateValue = document.getElementById('bitrateValue');

  els.exportBtn = document.getElementById('exportBtn');
  els.exportStatus = document.getElementById('exportStatus');

  els.resultVideo = document.getElementById('resultVideo');
  els.downloadLink = document.getElementById('downloadLink');
  els.backToEditBtn = document.getElementById('backToEditBtn');

  init();
});
