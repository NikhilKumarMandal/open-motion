/**
 * Open-Motions Screen Recorder
 * Copyright (c) 2026 Anu S Pillai
 * GitHub: https://github.com/anugotta
 *
 * Licensed under the MIT License.
 */

// Editor Page Controller
// Production mode: set to false to disable debug logging
// Use window object to share across multiple scripts
if (typeof window !== 'undefined' && typeof window.DEBUG_MODE === 'undefined') {
  window.DEBUG_MODE = false;
}

// Debug logging utility
function debugLog(...args) {
  if (typeof window !== 'undefined' && window.DEBUG_MODE) {
    console.log(...args);
  }
}

// ========== CONSTANTS ==========

const zoomDepths = {
  shallow: 1.1,
  moderate: 1.3,
  deep: 1.5,
  maximum: 2.0
};

// Two-stop 135deg gradients only: the export pipeline reads the first two hex stops.
const backgrounds = {
  'grad-1': 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'grad-2': 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'grad-3': 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'grad-4': 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'grad-5': 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'grad-6': 'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
  'grad-7': 'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)',
  'grad-8': 'linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)',
  'grad-9': 'linear-gradient(135deg, #0f2027 0%, #2c5364 100%)',
  'grad-10': 'linear-gradient(135deg, #232526 0%, #414345 100%)',
  'grad-11': 'linear-gradient(135deg, #1e3c72 0%, #2a5298 100%)',
  'grad-12': 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)',
  'hidden': 'transparent'
};

const clickColors = {
  white: '#ffffff',
  green: '#10b981',
  blue: '#3b82f6',
  purple: '#8b5cf6',
  pink: '#ec4899',
  orange: '#f97316',
  red: '#ef4444',
  yellow: '#facc15'
};

const clickIntensity = {
  weak: { size: 0.7, alpha: 0.7 },
  moderate: { size: 1.0, alpha: 1.0 },
  strong: { size: 1.4, alpha: 1.2 }
};

const exportResolutions = {
  '4k': { width: 3840, height: 2160 },
  '1440p': { width: 2560, height: 1440 },
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
  '480p': { width: 854, height: 480 }
};

const exportBitrates = {
  high: 150000000,  // 150 Mbps base for 1080p
  medium: 75000000,
  low: 40000000
};

const FRAME_PADDING = 24;         // Background padding around the video (px)
const MIN_TRIM_SECONDS = 0.5;     // Shortest clip the trim handles allow
const NEW_ZOOM_DURATION_MS = 3000;
const UNDO_LIMIT = 50;

// ========== STATE ==========

let cursorData = [];
let clickEvents = [];             // Pre-filtered clicks, so the render loop doesn't scan cursorData
let zoomSegments = [];
let videoWidth = 1920;
let videoHeight = 1080;
let videoDuration = 0;            // Seconds; resolved once so WebM "Infinity" durations don't leak
let videoUrl = null;
let videoLoaded = false;
let cameraOverlayEnabled = false;
let selectedZoomIndex = -1;
let trimHandles = { start: 0, end: 1 };
let undoStack = [];
let redoStack = [];
let drag = null;                  // { type, startX, startValue, snapshot }
let isExportProcessing = false;

let animationFrameId = null;
let redrawUntil = 0;
let lastRenderedTime = -1;
let lastWindowTransform = '';
let filmstripToken = 0;
let toastTimer = null;

const settings = {
  background: 'grad-1',           // 'grad-N' | 'image' | 'hidden'
  backgroundImage: null,          // Uploaded image data URL (kept when switching tabs)
  aspectRatio: 'native',
  applyZoom: true,
  zoomDepth: 'moderate',
  clickStyle: 'orb',              // 'orb' | 'none'
  clickColor: 'white',            // Preset key, or 'custom'
  customClickColor: '#ffffff',    // Effective hex colour
  clickForce: 'moderate',
  showBrowserFrame: true,         // false = auto-crop browser UI from the top
  showTaskbar: true,              // false = auto-crop the OS taskbar / Dock from the bottom
  showShadow: true
};

let lastGradient = settings.background;
let analyzer = null;
let processor = null;
let ctx = null;
const els = {};

// ========== HELPERS ==========

const $ = (id) => document.getElementById(id);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const iconSvg = (name) => `<svg class="icon"><use href="#i-${name}"/></svg>`;

function waitForEvent(target, eventName, timeoutMs) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      target.removeEventListener(eventName, done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    target.addEventListener(eventName, done, { once: true });
  });
}

function normalizeHex(value) {
  let color = String(value || '').trim();
  if (!color.startsWith('#')) color = '#' + color;
  if (!/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color)) return null;
  if (color.length === 4) {
    color = '#' + color[1] + color[1] + color[2] + color[2] + color[3] + color[3];
  }
  return color.toLowerCase();
}

function hexToRgba(hex, alpha) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return `rgba(16, 185, 129, ${alpha})`;
  return `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`;
}

// mm:ss.cc — floors to centiseconds so 59.996 never renders as "00:60.00"
function formatPrecise(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const cs = Math.floor(s * 100 + 1e-6);
  const m = Math.floor(cs / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

function formatClock(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function formatLength(s) {
  return s < 60 ? `${s.toFixed(1)}s` : formatClock(s);
}

// Height of the tab strip + address bar that "hide browser UI" crops away
function getBrowserUIHeight() {
  return Math.min(105, Math.floor(videoHeight * 0.08) + 5);
}

const platformName = (() => {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  if (/mac/i.test(p)) return 'mac';
  if (/win/i.test(p)) return 'windows';
  return 'other';
})();

// Height of the Windows taskbar / macOS Dock in video pixels, for "hide taskbar".
// Measured from this display (screen minus usable area), scaled to the recording;
// falls back to a typical size when the taskbar/Dock auto-hides.
function getTaskbarHeight() {
  const screenH = window.screen.height || videoHeight;
  const measured = screenH - window.screen.availHeight - (window.screen.availTop || 0);
  const fallback = platformName === 'mac' ? 70 : 48;
  const cssPx = measured > 0 && measured < screenH * 0.2 ? measured : fallback;
  return Math.min(Math.round(cssPx * (videoHeight / screenH)), Math.floor(videoHeight * 0.2));
}

function getBottomCrop() {
  return settings.showTaskbar ? 0 : getTaskbarHeight();
}

function getSourceRect() {
  const top = settings.showBrowserFrame ? 0 : getBrowserUIHeight();
  const bottom = getBottomCrop();
  return { x: 0, y: top, width: videoWidth, height: Math.max(1, videoHeight - top - bottom) };
}

function getActiveBackgroundImage() {
  return settings.background === 'image' ? settings.backgroundImage : null;
}

// Keep redrawing briefly: right after load/seek the decoded frame may land a few frames late
function requestRedraw() {
  redrawUntil = performance.now() + 300;
}

// ========== INIT ==========

document.addEventListener('DOMContentLoaded', () => {
  debugLog('[Editor] DOM loaded');

  [
    'loadingOverlay', 'loadingText', 'emptyState', 'previewArea', 'videoFrame', 'videoBackground',
    'videoWindow', 'video', 'previewCanvas', 'playBtn', 'currentTime', 'totalTime', 'trimRangeText',
    'timeline', 'timelineTrack', 'timeMarkers', 'filmstrip', 'zoomSegmentsLayer', 'trimmedLeft',
    'trimmedRight', 'trimWindow', 'trimStartHandle', 'trimEndHandle', 'playhead', 'zoomCountText',
    'deleteZoomBtn', 'exportBtn', 'recordingMeta', 'metaResolution', 'metaDuration', 'metaClicks',
    'metaClicksChip', 'bgGrid', 'bgImagePanel', 'bgImageDrop', 'bgImageDropText', 'customColorPicker',
    'hexColorInput', 'toast'
  ].forEach((id) => { els[id] = $(id); });

  analyzer = new ZoomAnalyzer();
  processor = new VideoProcessor();

  buildSwatches();
  setupEventListeners();
  setupTimelineInteractions();
  setupExportModal();
  syncSettingsUI();

  init();
});

async function init() {
  try {
    const response = await fetchRecordingData();

    if (!response || !response.videoData) {
      showEmptyState();
      return;
    }

    setCursorData(response.cursorData || []);
    videoWidth = response.videoWidth || 1920;
    videoHeight = response.videoHeight || 1080;
    cameraOverlayEnabled = response.cameraOverlayEnabled || false;

    let blob;
    if (response.videoStoredInIndexedDB && typeof response.videoData === 'string' && !response.videoData.startsWith('data:')) {
      debugLog('[Editor] Video stored in IndexedDB, retrieving with ID:', response.videoData);
      try {
        blob = await retrieveVideoFromIndexedDB(response.videoData);
      } catch (error) {
        throw new Error('Failed to retrieve video from IndexedDB: ' + error.message);
      }
    } else {
      blob = dataUrlToBlob(response.videoData);
    }

    if (!blob || blob.size === 0) {
      throw new Error('Video blob is empty - recording may have failed');
    }
    debugLog('[Editor] Video blob size:', blob.size, 'bytes');

    await assertWebM(blob);

    const url = URL.createObjectURL(blob);
    try {
      setVideoUrl(url);
      await loadVideo(url);
    } catch (loadError) {
      throw new Error('Failed to load video: ' + (loadError.message || String(loadError)));
    }
  } catch (error) {
    console.error('[Editor] Init error:', error);
    showToast(describeLoadError(error), 'error');
    showEmptyState();
  }
}

// The background worker may still be saving the recording, so retry for a few seconds
async function fetchRecordingData() {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
    return null;
  }
  debugLog('[Editor] Fetching recording data...');
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getRecordingData' });
      if (response && response.success && response.videoData) {
        debugLog('[Editor] Got recording data');
        return response;
      }
    } catch (e) {
      debugLog('[Editor] getRecordingData failed, retrying:', e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

function retrieveVideoFromIndexedDB(videoId) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('OpenMotionsVideoStorage', 1);

    request.onerror = () => reject(new Error('Failed to open IndexedDB'));
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('videos')) {
        db.createObjectStore('videos', { keyPath: 'id' });
      }
    };
    request.onsuccess = (event) => {
      const db = event.target.result;
      const getRequest = db.transaction(['videos'], 'readonly').objectStore('videos').get(videoId);
      getRequest.onsuccess = (e) => {
        const result = e.target.result;
        if (result && result.blob) {
          resolve(result.blob);
        } else {
          reject(new Error('Video not found in IndexedDB'));
        }
      };
      getRequest.onerror = () => reject(new Error('Failed to retrieve video from IndexedDB'));
    };
  });
}

// Decode base64 directly rather than fetch(dataUrl), which can include the prefix in the blob
function dataUrlToBlob(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new Error('Invalid video data format');
  }
  const base64Index = dataUrl.indexOf(';base64,');
  if (base64Index === -1) {
    throw new Error('Invalid data URL format: missing ;base64, separator');
  }
  const mimeMatch = dataUrl.match(/^data:([^;]+)/);
  const binary = atob(dataUrl.substring(base64Index + 8));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeMatch ? mimeMatch[1] : 'video/webm' });
}

async function assertWebM(blob) {
  const view = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (view[0] !== 0x1A || view[1] !== 0x45 || view[2] !== 0xDF || view[3] !== 0xA3) {
    const magic = Array.from(view).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    throw new Error('Video blob is corrupted - invalid WebM format. Magic bytes: ' + magic);
  }
}

function describeLoadError(error) {
  const message = (error && error.message) || String(error);
  if (message.includes('fetch')) {
    return 'Could not load the recording. It may be empty or corrupted — please try recording again.';
  }
  if (message.includes('No video data') || message.includes('No recording data')) {
    return 'No recording data found. Make sure you finished a recording before opening the editor.';
  }
  if (message.includes('empty')) {
    return 'The recording appears to be empty. Please try recording again.';
  }
  return 'Error loading recording: ' + message;
}

function setCursorData(data) {
  cursorData = Array.isArray(data) ? data : [];
  clickEvents = cursorData.filter((d) => d.type === 'click' || d.type === 'doubleclick');
  debugLog('[Editor] Cursor data points:', cursorData.length, 'clicks:', clickEvents.length);
}

function setVideoUrl(url) {
  if (videoUrl && videoUrl !== url && videoUrl.startsWith('blob:')) {
    URL.revokeObjectURL(videoUrl);
  }
  videoUrl = url;
}

// ========== VIDEO LOADING ==========

function loadVideo(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const video = els.video;

    const cleanup = () => {
      clearTimeout(timeout);
      video.onerror = null;
      video.onloadeddata = null;
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const timeout = setTimeout(() => {
      fail(new Error('Video load timeout - the video file may be corrupted or invalid. Please try recording again.'));
    }, 30000);

    video.onerror = () => {
      const err = video.error;
      fail(new Error(err ? `Video load error: ${err.code} - ${err.message}` : 'Video failed to load (unknown error)'));
    };
    video.onloadeddata = async () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        await onVideoReady();
        resolve();
      } catch (err) {
        reject(err);
      }
    };

    video.muted = false; // Allow audio playback in the editor
    video.src = url;
    video.load();
  });
}

// MediaRecorder WebM files often report Infinity until you seek to the end
async function resolveDuration() {
  const video = els.video;
  if (isFinite(video.duration) && video.duration > 0) return video.duration;

  debugLog('[Editor] Finding real duration...');
  video.currentTime = Number.MAX_SAFE_INTEGER;
  await waitForEvent(video, 'seeked', 2000);
  const duration = isFinite(video.duration) && video.duration > 0 ? video.duration : (video.currentTime || 30);

  video.currentTime = 0;
  await waitForEvent(video, 'seeked', 500);
  return duration;
}

async function onVideoReady() {
  const video = els.video;
  videoWidth = video.videoWidth || videoWidth;
  videoHeight = video.videoHeight || videoHeight;
  videoDuration = await resolveDuration();
  // A never-seeked video can hand drawImage() an empty frame; a seek makes the first frame available
  video.currentTime = 0;
  await waitForEvent(video, 'seeked', 500);
  debugLog('[Editor] Video loaded:', videoWidth, 'x', videoHeight, 'duration:', videoDuration);

  videoLoaded = true;
  trimHandles = { start: 0, end: 1 };
  undoStack = [];
  redoStack = [];
  selectedZoomIndex = -1;

  ctx = els.previewCanvas.getContext('2d', { alpha: false });

  els.loadingOverlay.classList.add('hidden');
  els.emptyState.classList.add('hidden');
  els.videoFrame.classList.remove('hidden');
  els.exportBtn.disabled = false;
  document.body.classList.remove('no-video');

  updateBackground();
  renderTimeMarkers();
  analyzeZoom();
  updateTrimUI();
  updateTimeline();
  updateRecordingMeta();
  requestRedraw();
  startRenderLoop();
  buildFilmstrip();
}

function showEmptyState() {
  videoLoaded = false;
  filmstripToken++;
  els.filmstrip.innerHTML = '';
  els.zoomSegmentsLayer.innerHTML = '';
  els.timeMarkers.innerHTML = '';
  document.body.classList.add('no-video');
  els.loadingOverlay.classList.add('hidden');
  els.emptyState.classList.remove('hidden');
  els.videoFrame.classList.add('hidden');
  els.recordingMeta.classList.add('hidden');
  els.exportBtn.disabled = true;
}

function startNewRecording() {
  window.location.href = chrome.runtime.getURL('record.html');
}

function loadVideoFromFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'video/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;

    els.video.pause();
    videoLoaded = false;
    filmstripToken++;
    setCursorData([]);
    zoomSegments = [];

    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    els.loadingText.textContent = 'Opening video…';
    els.loadingOverlay.classList.remove('hidden');

    try {
      await loadVideo(url);
    } catch (err) {
      console.error('[Editor] Error loading file:', err);
      showToast('Could not open that file: ' + err.message, 'error');
      showEmptyState();
    }
  };
  input.click();
}

function updateRecordingMeta() {
  els.metaResolution.textContent = `${videoWidth}×${videoHeight}`;
  els.metaDuration.textContent = formatLength(videoDuration);
  els.metaClicks.textContent = clickEvents.length + (clickEvents.length === 1 ? ' click' : ' clicks');
  els.metaClicksChip.classList.toggle('hidden', cursorData.length === 0);
  els.recordingMeta.classList.remove('hidden');
}

// ========== SETTINGS UI ==========

function buildSwatches() {
  els.bgGrid.innerHTML = Object.keys(backgrounds)
    .filter((key) => key.startsWith('grad-'))
    .map((key) => `<button class="bg-option" data-value="${key}" style="background:${backgrounds[key]}" aria-label="Gradient ${key.slice(5)}"></button>`)
    .join('');

  $('colorGroup').innerHTML = Object.entries(clickColors)
    .map(([name, hex]) => `<button class="color-option" data-value="${name}" style="background:${hex}" title="${name}" aria-label="${name}"></button>`)
    .join('');
}

// Wire a group of [data-value] buttons as a single-choice control
function bindChoiceGroup(groupId, onSelect) {
  $(groupId).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-value]');
    if (!btn) return;
    setChoice(groupId, btn.dataset.value);
    onSelect(btn.dataset.value);
  });
}

function setChoice(groupId, value) {
  $(groupId).querySelectorAll('[data-value]').forEach((btn) => {
    const selected = btn.dataset.value === value;
    btn.classList.toggle('selected', selected);
    btn.setAttribute('aria-pressed', String(selected));
  });
}

function syncSettingsUI() {
  setChoice('aspectGroup', settings.aspectRatio);
  setChoice('zoomDepthGroup', settings.zoomDepth);
  setChoice('clickForceGroup', settings.clickForce);
  setChoice('colorGroup', settings.clickColor);
  setChoice('bgGrid', lastGradient);
  $('showBrowserFrame').checked = settings.showBrowserFrame;
  $('showTaskbar').checked = settings.showTaskbar;
  $('showShadow').checked = settings.showShadow;
  $('applyZoom').checked = settings.applyZoom;
  $('clickEnabled').checked = settings.clickStyle !== 'none';
  els.customColorPicker.value = settings.customClickColor;
  els.hexColorInput.value = settings.customClickColor;
  showBackgroundPanel(settings.background === 'hidden' ? 'hidden' : settings.background === 'image' ? 'image' : 'gradient');
  applyShadow();
}

function showBackgroundPanel(type) {
  setChoice('bgTypeGroup', type);
  els.bgGrid.classList.toggle('hidden', type !== 'gradient');
  els.bgImagePanel.classList.toggle('hidden', type !== 'image');
}

function setClickColor(hex, presetName = 'custom') {
  settings.customClickColor = hex;
  settings.clickColor = presetName;
  els.customColorPicker.value = hex;
  els.hexColorInput.value = hex;
  setChoice('colorGroup', presetName);
  requestRedraw();
}

function applyShadow() {
  els.videoWindow.style.boxShadow = settings.showShadow ? '0 20px 40px rgba(0, 0, 0, 0.4)' : 'none';
}

function setupEventListeners() {
  const video = els.video;

  // Top bar + empty state
  $('newRecordingBtn').addEventListener('click', startNewRecording);
  $('newRecordingBtnTop').addEventListener('click', startNewRecording);
  $('loadVideoBtn').addEventListener('click', loadVideoFromFile);
  $('loadVideoBtnTop').addEventListener('click', loadVideoFromFile);
  els.exportBtn.addEventListener('click', openExportModal);

  // Transport
  els.playBtn.addEventListener('click', togglePlay);
  $('jumpStartBtn').addEventListener('click', () => seekTo(trimHandles.start * videoDuration));
  $('resetTimelineBtn').addEventListener('click', resetTrim);
  $('addZoomBtn').addEventListener('click', addZoomAtCurrentTime);
  els.deleteZoomBtn.addEventListener('click', deleteSelectedZoom);

  // Aspect ratio
  bindChoiceGroup('aspectGroup', (value) => {
    settings.aspectRatio = value;
    updateFrameSize();
  });

  // Background
  bindChoiceGroup('bgTypeGroup', (type) => {
    showBackgroundPanel(type);
    if (type === 'gradient') {
      settings.background = lastGradient;
    } else if (type === 'hidden') {
      settings.background = 'hidden';
    } else if (settings.backgroundImage) {
      settings.background = 'image';
    } else {
      uploadBackground();
    }
    updateBackground();
  });

  bindChoiceGroup('bgGrid', (key) => {
    lastGradient = key;
    settings.background = key;
    updateBackground();
  });

  els.bgImageDrop.addEventListener('click', uploadBackground);

  // Frame
  $('showBrowserFrame').addEventListener('change', (e) => {
    settings.showBrowserFrame = e.target.checked;
    updateFrameSize();
  });

  $('showTaskbar').addEventListener('change', (e) => {
    settings.showTaskbar = e.target.checked;
    updateFrameSize();
  });

  $('showShadow').addEventListener('change', (e) => {
    settings.showShadow = e.target.checked;
    applyShadow();
  });

  // Zoom
  $('applyZoom').addEventListener('change', (e) => {
    settings.applyZoom = e.target.checked;
    // Zooms are only generated while enabled, so generate them the first time it's switched on
    if (settings.applyZoom && zoomSegments.length === 0) {
      analyzeZoom();
    } else {
      renderZoomSegments();
    }
    requestRedraw();
  });

  bindChoiceGroup('zoomDepthGroup', (value) => {
    settings.zoomDepth = value;
    analyzeZoom();
    requestRedraw();
  });

  // Click highlight
  $('clickEnabled').addEventListener('change', (e) => {
    settings.clickStyle = e.target.checked ? 'orb' : 'none';
    requestRedraw();
  });

  bindChoiceGroup('colorGroup', (name) => setClickColor(clickColors[name], name));

  els.customColorPicker.addEventListener('input', (e) => setClickColor(normalizeHex(e.target.value)));

  els.hexColorInput.addEventListener('input', (e) => {
    const hex = normalizeHex(e.target.value);
    if (hex) {
      settings.customClickColor = hex;
      settings.clickColor = 'custom';
      els.customColorPicker.value = hex;
      setChoice('colorGroup', 'custom');
      requestRedraw();
    }
  });

  els.hexColorInput.addEventListener('blur', (e) => {
    e.target.value = normalizeHex(e.target.value) || settings.customClickColor;
  });

  bindChoiceGroup('clickForceGroup', (value) => {
    settings.clickForce = value;
    requestRedraw();
  });

  // Video state
  video.addEventListener('play', updatePlayButton);
  video.addEventListener('pause', updatePlayButton);
  video.addEventListener('seeked', requestRedraw);
  video.addEventListener('canplay', requestRedraw);

  // Keep the preview sized to its container (window resize, sidebar, timeline)
  new ResizeObserver(() => {
    updateFrameSize();
    renderTimeMarkers();
  }).observe(els.previewArea);

  document.addEventListener('keydown', handleKeydown);

  window.addEventListener('beforeunload', () => {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
  });
}

function handleKeydown(e) {
  if (e.target instanceof Element && e.target.matches('input, textarea, select')) return;

  const exportOpen = !$('exportModal').classList.contains('hidden');
  if (exportOpen) {
    if (e.code === 'Escape') closeExportModal();
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.code === 'KeyZ') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (mod && e.code === 'KeyY') {
    e.preventDefault();
    redo();
    return;
  }
  if (!videoLoaded || mod || e.altKey) return;

  const video = els.video;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      // A focused button would also "click" on keyup and toggle twice
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
      togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      seekTo(video.currentTime - (e.shiftKey ? 5 : 1));
      break;
    case 'ArrowRight':
      e.preventDefault();
      seekTo(video.currentTime + (e.shiftKey ? 5 : 1));
      break;
    case 'Home':
      e.preventDefault();
      seekTo(trimHandles.start * videoDuration);
      break;
    case 'End':
      e.preventDefault();
      seekTo(trimHandles.end * videoDuration);
      break;
    case 'Delete':
    case 'Backspace':
      if (selectedZoomIndex >= 0) {
        e.preventDefault();
        deleteSelectedZoom();
      }
      break;
    case 'Escape':
      selectZoom(-1);
      break;
  }
}

// ========== BACKGROUND + FRAME ==========

function uploadBackground() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      settings.backgroundImage = ev.target.result;
      settings.background = 'image';
      showBackgroundPanel('image');
      updateBackground();
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

function updateBackground() {
  const image = getActiveBackgroundImage();
  const bgEl = els.videoBackground;

  if (image) {
    bgEl.style.background = `url(${image}) center/cover`;
    bgEl.style.display = 'block';
  } else if (settings.background === 'hidden') {
    bgEl.style.display = 'none';
  } else {
    bgEl.style.background = backgrounds[settings.background] || backgrounds['grad-1'];
    bgEl.style.display = 'block';
  }

  const drop = els.bgImageDrop;
  drop.classList.toggle('has-image', Boolean(settings.backgroundImage));
  drop.style.backgroundImage = settings.backgroundImage ? `url(${settings.backgroundImage})` : '';
  els.bgImageDropText.textContent = settings.backgroundImage ? 'Replace image' : 'Choose an image';

  // Padding depends on whether there's a background
  updateFrameSize();
}

function updateFrameSize() {
  if (!videoLoaded) return;

  const container = els.previewArea;
  const maxW = container.clientWidth - 48;
  const maxH = container.clientHeight - 48;
  if (maxW <= 0 || maxH <= 0) return;

  let targetRatio = videoWidth / videoHeight;
  if (settings.aspectRatio !== 'native') {
    const [w, h] = settings.aspectRatio.split(':').map(Number);
    targetRatio = w / h;
  }

  // Outer frame (the background)
  let frameW, frameH;
  if (targetRatio >= 1) {
    frameW = Math.min(maxW, maxH * targetRatio);
    frameH = frameW / targetRatio;
  } else {
    frameH = Math.min(maxH, maxW / targetRatio);
    frameW = frameH * targetRatio;
  }
  els.videoFrame.style.width = frameW + 'px';
  els.videoFrame.style.height = frameH + 'px';

  // Inner video window keeps the (possibly cropped) source aspect
  const source = getSourceRect();
  const sourceAspect = source.width / source.height;
  const padding = settings.background === 'hidden' ? 0 : FRAME_PADDING;
  const availableW = frameW - padding * 2;
  const availableH = frameH - padding * 2;

  let windowW, windowH;
  if (sourceAspect > availableW / availableH) {
    windowW = availableW;
    windowH = availableW / sourceAspect;
  } else {
    windowH = availableH;
    windowW = availableH * sourceAspect;
  }
  els.videoWindow.style.width = windowW + 'px';
  els.videoWindow.style.height = windowH + 'px';

  // Resizing a canvas clears it and resets context state, so only do it when needed
  const canvas = els.previewCanvas;
  if (canvas.width !== source.width || canvas.height !== source.height) {
    canvas.width = source.width;
    canvas.height = source.height;
  }
  requestRedraw();
}

// ========== RENDER LOOP ==========

function startRenderLoop() {
  if (animationFrameId) return;

  const render = () => {
    animationFrameId = requestAnimationFrame(render);
    if (!videoLoaded || !ctx) return;

    const video = els.video;
    const t = video.currentTime;

    // Stop at the trim end (timeupdate only fires ~4x/second, too coarse for this)
    if (!video.paused && t >= trimHandles.end * videoDuration) {
      video.pause();
      video.currentTime = trimHandles.start * videoDuration;
    }

    // Nothing changed while paused: skip the full-resolution redraw
    if (video.paused && t === lastRenderedTime && performance.now() > redrawUntil) return;
    lastRenderedTime = t;

    drawFrame();
    applyZoomTransform(t * 1000);
    updateTimeline();
  };

  render();
}

function drawFrame() {
  const canvas = els.previewCanvas;
  const source = getSourceRect();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(els.video, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height);

  if (settings.clickStyle !== 'none') {
    drawClickEffects();
  }
}

// The video window is centred with translate(-50%, -50%); zoom/pan is layered on top
function applyZoomTransform(timestampMs) {
  let transform = 'translate(-50%, -50%)';

  if (settings.applyZoom && zoomSegments.length > 0 && analyzer) {
    const zoomState = analyzer.getZoomAtTime(timestampMs, zoomSegments, videoWidth, videoHeight);
    if (zoomState.active && zoomState.level > 1.01) {
      const scale = zoomState.level;
      // Pan multiplier matches the exported video
      const panMultiplier = 2.0;
      const panX = (0.5 - zoomState.x / videoWidth) * (scale - 1) * 100 * panMultiplier;
      const panY = (0.5 - zoomState.y / videoHeight) * (scale - 1) * 100 * panMultiplier;
      transform = `translate(-50%, -50%) scale(${scale}) translate(${panX}%, ${panY}%)`;
    }
  }

  if (transform !== lastWindowTransform) {
    els.videoWindow.style.transform = transform;
    lastWindowTransform = transform;
  }
}

function drawClickEffects() {
  if (clickEvents.length === 0) return;

  const canvas = els.previewCanvas;
  const timestamp = els.video.currentTime * 1000;
  const previewBeforeMs = 120; // Show orb 120ms before click
  const durationAfterMs = 250; // ...and 250ms after
  const totalWindow = previewBeforeMs + durationAfterMs;
  // Page viewport in video pixels: below the browser UI, above the taskbar when one is cropped
  const source = getSourceRect();
  const viewportTop = getBrowserUIHeight();
  const viewportHeight = videoHeight - viewportTop - getBottomCrop();

  for (const click of clickEvents) {
    const timeFromClick = timestamp - click.timestamp;
    if (timeFromClick < -previewBeforeMs || timeFromClick >= durationAfterMs) continue;

    // Normalised coordinates are relative to the page viewport (below the browser UI)
    let normX, normY;
    if (click.normalizedX !== undefined) {
      normX = click.normalizedX;
      normY = click.normalizedY;
    } else if (click.viewportWidth) {
      normX = click.x / click.viewportWidth;
      normY = click.y / click.viewportHeight;
    } else {
      normX = click.x / videoWidth;
      normY = click.y / videoHeight;
    }

    const x = normX * canvas.width;
    const y = ((viewportTop + normY * viewportHeight - source.y) / source.height) * canvas.height;

    drawOrbClick(x, y, (timeFromClick + previewBeforeMs) / totalWindow);
  }
}

function drawOrbClick(x, y, progress) {
  const intensity = clickIntensity[settings.clickForce] || clickIntensity.moderate;

  // Grows until ~the click, then fades and settles
  const baseSize = 35 * intensity.size;
  const growthPhase = Math.min(progress, 0.35);
  const fadePhase = Math.max(0, progress - 0.35);
  const size = baseSize * (0.5 + growthPhase * 1.2 + fadePhase * 0.3);

  let alpha = progress < 0.35
    ? (0.7 + (progress / 0.35) * 0.25) * intensity.alpha
    : (0.95 * (1 - fadePhase / 0.65)) * intensity.alpha;
  alpha = clamp(alpha, 0, 1);

  const color = settings.customClickColor || clickColors.white;

  // Faint outline for visibility on light content
  ctx.beginPath();
  ctx.arc(x, y, size + 3, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(0, 0, 0, ${alpha * 0.08})`;
  ctx.lineWidth = 4;
  ctx.stroke();

  const gradient = ctx.createRadialGradient(x, y, 0, x, y, size);
  gradient.addColorStop(0, hexToRgba(color, alpha));
  gradient.addColorStop(0.2, hexToRgba(color, alpha * 0.9));
  gradient.addColorStop(0.4, hexToRgba(color, alpha * 0.7));
  gradient.addColorStop(0.7, hexToRgba(color, alpha * 0.4));
  gradient.addColorStop(1, hexToRgba(color, 0));

  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.strokeStyle = hexToRgba(color, alpha * 0.95);
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, size * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = hexToRgba(color, alpha * 0.8);
  ctx.fill();
}

// ========== PLAYBACK ==========

function seekTo(seconds) {
  if (!videoLoaded) return;
  els.video.currentTime = clamp(seconds, 0, videoDuration);
  requestRedraw();
}

function togglePlay() {
  if (!videoLoaded) return;
  const video = els.video;

  if (!video.paused) {
    video.pause();
    return;
  }

  const trimStart = trimHandles.start * videoDuration;
  const trimEnd = trimHandles.end * videoDuration;
  if (video.currentTime < trimStart || video.currentTime >= trimEnd - 0.01) {
    video.currentTime = trimStart;
  }
  video.play().catch((err) => debugLog('[Editor] play() rejected:', err));
}

function updatePlayButton() {
  const playing = !els.video.paused;
  els.playBtn.innerHTML = iconSvg(playing ? 'pause' : 'play');
  els.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  requestRedraw();
}

// ========== TIMELINE ==========

function updateTimeline() {
  if (!videoLoaded || !videoDuration) return;
  const t = els.video.currentTime;
  els.playhead.style.left = clamp((t / videoDuration) * 100, 0, 100) + '%';
  els.currentTime.textContent = formatPrecise(t);
  els.totalTime.textContent = formatPrecise(videoDuration);
}

function renderTimeMarkers() {
  const ruler = els.timeMarkers;
  if (!videoLoaded || !videoDuration) {
    ruler.innerHTML = '';
    return;
  }

  // Pick the smallest "nice" step that keeps labels ~80px apart
  const width = ruler.clientWidth || 600;
  const maxLabels = Math.max(2, Math.floor(width / 80));
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  const step = steps.find((s) => videoDuration / s <= maxLabels) || steps[steps.length - 1];

  let html = '';
  for (let t = 0; t <= videoDuration - step * 0.35; t += step) {
    const label = step < 1 ? t.toFixed(1) + 's' : formatClock(t);
    html += `<div class="ruler-tick" style="left:${(t / videoDuration) * 100}%"><span>${label}</span></div>`;
  }
  ruler.innerHTML = html;
}

function updateTrimUI() {
  if (!videoLoaded || !videoDuration) return;

  const startPct = trimHandles.start * 100;
  const endPct = (1 - trimHandles.end) * 100;
  els.trimmedLeft.style.width = startPct + '%';
  els.trimmedRight.style.width = endPct + '%';
  els.trimWindow.style.left = startPct + '%';
  els.trimWindow.style.right = endPct + '%';

  const isTrimmed = trimHandles.start > 0 || trimHandles.end < 1;
  const start = trimHandles.start * videoDuration;
  const end = trimHandles.end * videoDuration;
  els.trimRangeText.textContent = isTrimmed
    ? `${formatPrecise(start)} – ${formatPrecise(end)} · ${formatLength(end - start)}`
    : `Full clip · ${formatLength(videoDuration)}`;
}

// Seek thumbnails with a separate <video> so the preview isn't disturbed
async function buildFilmstrip() {
  const token = ++filmstripToken;
  const strip = els.filmstrip;
  strip.innerHTML = '';
  if (!videoUrl || !videoDuration) return;

  const trackRect = els.timelineTrack.getBoundingClientRect();
  const aspect = videoWidth / videoHeight;
  const count = clamp(Math.round(trackRect.width / (trackRect.height * aspect)) || 10, 6, 24);

  const cells = [];
  for (let i = 0; i < count; i++) {
    const cell = document.createElement('div');
    cell.className = 'film-cell';
    strip.appendChild(cell);
    cells.push(cell);
  }

  const probe = document.createElement('video');
  probe.muted = true;
  probe.preload = 'auto';
  probe.src = videoUrl;

  try {
    await waitForEvent(probe, 'loadeddata', 5000);
    if (token !== filmstripToken || probe.readyState < 2) return;

    const canvas = document.createElement('canvas');
    canvas.height = Math.round(trackRect.height * 2);
    canvas.width = Math.round(canvas.height * aspect);
    const thumbCtx = canvas.getContext('2d');

    for (let i = 0; i < count; i++) {
      if (token !== filmstripToken) return;
      probe.currentTime = Math.min(videoDuration - 0.05, ((i + 0.5) / count) * videoDuration);
      await waitForEvent(probe, 'seeked', 3000);
      if (token !== filmstripToken) return;
      if (probe.readyState < 2) continue;

      thumbCtx.drawImage(probe, 0, 0, canvas.width, canvas.height);
      cells[i].style.backgroundImage = `url(${canvas.toDataURL('image/jpeg', 0.7)})`;
      cells[i].classList.add('loaded');
    }
  } catch (err) {
    debugLog('[Editor] Filmstrip generation failed:', err);
  } finally {
    probe.removeAttribute('src');
    probe.load();
  }
}

function fractionFromClientX(clientX) {
  const rect = els.timelineTrack.getBoundingClientRect();
  return rect.width ? (clientX - rect.left) / rect.width : 0;
}

function setupTimelineInteractions() {
  els.timeline.addEventListener('pointerdown', (e) => {
    if (!videoLoaded || e.button !== 0) return;

    const marker = e.target.closest('.zoom-marker');
    if (marker) {
      selectZoom(Number(marker.dataset.index));
      return;
    }

    e.preventDefault();
    if (e.target === els.trimStartHandle) {
      beginDrag(e, 'trim-start');
    } else if (e.target === els.trimEndHandle) {
      beginDrag(e, 'trim-end');
    } else {
      selectZoom(-1, false);
      beginDrag(e, 'playhead');
      scrubTo(e.clientX);
    }
  });

  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.type === 'playhead') {
      scrubTo(e.clientX);
      return;
    }

    const delta = fractionFromClientX(e.clientX) - fractionFromClientX(drag.startX);
    const minGap = Math.min(MIN_TRIM_SECONDS, videoDuration / 2) / videoDuration;
    if (drag.type === 'trim-start') {
      trimHandles.start = clamp(drag.startValue + delta, 0, trimHandles.end - minGap);
      seekTo(trimHandles.start * videoDuration);
    } else {
      trimHandles.end = clamp(drag.startValue + delta, trimHandles.start + minGap, 1);
      seekTo(trimHandles.end * videoDuration);
    }
    updateTrimUI();
  });

  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
}

// Seeks are limited to the trimmed range so the playhead always matches what exports
function scrubTo(clientX) {
  const fraction = clamp(fractionFromClientX(clientX), trimHandles.start, trimHandles.end);
  seekTo(fraction * videoDuration);
}

function beginDrag(e, type) {
  drag = {
    type,
    startX: e.clientX,
    startValue: type === 'trim-start' ? trimHandles.start : trimHandles.end,
    snapshot: snapshotState()
  };
  if (type !== 'playhead') {
    els.video.pause();
    (type === 'trim-start' ? els.trimStartHandle : els.trimEndHandle).classList.add('active');
  }
  document.body.style.cursor = type === 'playhead' ? '' : 'ew-resize';
}

function endDrag() {
  if (!drag) return;
  const { type, snapshot } = drag;
  drag = null;

  els.trimStartHandle.classList.remove('active');
  els.trimEndHandle.classList.remove('active');
  document.body.style.cursor = '';

  if (type !== 'playhead' &&
      (snapshot.trimHandles.start !== trimHandles.start || snapshot.trimHandles.end !== trimHandles.end)) {
    pushUndo(snapshot);
  }
}

function resetTrim() {
  if (!videoLoaded || (trimHandles.start === 0 && trimHandles.end === 1)) return;
  pushUndo(snapshotState());
  trimHandles = { start: 0, end: 1 };
  updateTrimUI();
}

// ========== UNDO / REDO ==========

function snapshotState() {
  return {
    zoomSegments: structuredClone(zoomSegments),
    trimHandles: { ...trimHandles }
  };
}

function pushUndo(snapshot) {
  undoStack.push(snapshot);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
}

function restoreState(state) {
  zoomSegments = state.zoomSegments;
  trimHandles = state.trimHandles;
  selectedZoomIndex = -1;
  updateZoomUI();
  updateTrimUI();
  requestRedraw();
}

function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(snapshotState());
  restoreState(undoStack.pop());
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(snapshotState());
  restoreState(redoStack.pop());
}

// ========== ZOOM SEGMENTS ==========

function analyzeZoom() {
  if (!analyzer || !settings.applyZoom) {
    zoomSegments = [];
  } else {
    analyzer.ZOOM_LEVEL = zoomDepths[settings.zoomDepth];
    zoomSegments = analyzer.analyzeClicks(cursorData, videoWidth, videoHeight);
    debugLog('[Editor] Found', zoomSegments.length, 'zoom segments');
  }
  selectedZoomIndex = -1;
  updateZoomUI();
}

function updateZoomUI() {
  const count = zoomSegments.length;
  els.zoomCountText.textContent = count + (count === 1 ? ' zoom' : ' zooms');
  renderZoomSegments();
}

function renderZoomSegments() {
  const layer = els.zoomSegmentsLayer;
  layer.classList.toggle('is-disabled', !settings.applyZoom);
  els.deleteZoomBtn.disabled = selectedZoomIndex < 0;

  if (!videoDuration) {
    layer.innerHTML = '';
    return;
  }

  const totalMs = videoDuration * 1000;
  layer.innerHTML = zoomSegments.map((seg, i) => {
    const level = seg.zoomLevel || zoomDepths[settings.zoomDepth];
    const left = (seg.startTime / totalMs) * 100;
    const width = ((seg.endTime - seg.startTime) / totalMs) * 100;
    const title = `Zoom ${level.toFixed(1)}× · ${formatClock(seg.startTime / 1000)}–${formatClock(seg.endTime / 1000)}`;
    return `<button class="zoom-marker${i === selectedZoomIndex ? ' selected' : ''}" data-index="${i}" ` +
      `style="left:${left}%;width:${width}%" title="${title}">${iconSvg('zoom')}<span>${level.toFixed(1)}×</span></button>`;
  }).join('');
}

function selectZoom(index, seek = true) {
  selectedZoomIndex = index >= 0 && index < zoomSegments.length ? index : -1;
  renderZoomSegments();
  if (seek && selectedZoomIndex >= 0) {
    seekTo(zoomSegments[selectedZoomIndex].startTime / 1000);
  }
}

function addZoomAtCurrentTime() {
  if (!videoLoaded) return;
  pushUndo(snapshotState());

  const totalMs = videoDuration * 1000;
  const startTime = Math.min(els.video.currentTime * 1000, Math.max(0, totalMs - NEW_ZOOM_DURATION_MS));
  const centerX = videoWidth / 2;
  const centerY = videoHeight / 2;

  // Shape matches ZoomAnalyzer output; the click lands 1s in, after the zoom-in
  const segment = {
    startTime,
    endTime: Math.min(totalMs, startTime + NEW_ZOOM_DURATION_MS),
    positions: [{
      x: centerX,
      y: centerY,
      normalizedX: 0.5,
      normalizedY: 0.5,
      timestamp: startTime + 1000
    }],
    zoomLevel: zoomDepths[settings.zoomDepth] || 1.3,
    clickCount: 1,
    centerX,
    centerY
  };

  zoomSegments.push(segment);
  zoomSegments.sort((a, b) => a.startTime - b.startTime);

  if (!settings.applyZoom) {
    settings.applyZoom = true;
    $('applyZoom').checked = true;
  }
  selectedZoomIndex = zoomSegments.indexOf(segment);
  updateZoomUI();
  requestRedraw();
}

function deleteSelectedZoom() {
  if (selectedZoomIndex < 0 || selectedZoomIndex >= zoomSegments.length) return;
  pushUndo(snapshotState());
  zoomSegments.splice(selectedZoomIndex, 1);
  selectedZoomIndex = -1;
  updateZoomUI();
  requestRedraw();
}

// ========== TOAST ==========

function showToast(message, type = 'error') {
  const toast = els.toast;
  toast.className = 'toast ' + type;
  toast.innerHTML = iconSvg(type === 'success' ? 'check' : 'alert') + '<span></span>';
  toast.querySelector('span').textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), type === 'error' ? 8000 : 4000);
}

// ========== EXPORT ==========

const EXPORT_BUTTON_HTML = iconSvg('download') + 'Export';

function openExportModal() {
  if (!videoLoaded) return;
  els.video.pause();
  $('exportModal').classList.remove('hidden');
  $('confirmExport').focus();
}

function closeExportModal() {
  if (isExportProcessing) return;
  $('exportModal').classList.add('hidden');
  $('exportProgress').classList.add('hidden');
  $('exportInfo').classList.remove('hidden');
}

function setupExportModal() {
  $('confirmExport').innerHTML = EXPORT_BUTTON_HTML;
  $('closeExportModal').addEventListener('click', closeExportModal);
  $('cancelExport').addEventListener('click', closeExportModal);
  document.querySelector('#exportModal .modal-backdrop').addEventListener('click', closeExportModal);
  $('confirmExport').addEventListener('click', doExport);
}

function setExportBusy(busy) {
  isExportProcessing = busy;
  ['closeExportModal', 'cancelExport', 'confirmExport', 'exportResolution', 'exportFormat', 'exportQuality']
    .forEach((id) => { $(id).disabled = busy; });
  $('exportProgress').classList.toggle('hidden', !busy);
  $('exportInfo').classList.toggle('hidden', busy);
}

function setExportProgress(percent, status) {
  const pct = clamp(Math.round(percent), 0, 100);
  $('exportProgressFill').style.width = pct + '%';
  $('exportPercent').textContent = pct + '%';
  if (status) $('exportStatus').textContent = status;
}

// Fit the chosen resolution to the selected aspect ratio, keeping the larger pixel count
function computeExportDimensions(resolution) {
  const base = resolution === 'original'
    ? { width: videoWidth, height: videoHeight }
    : (exportResolutions[resolution] || exportResolutions['1080p']);
  let { width, height } = base;

  if (settings.aspectRatio !== 'native') {
    const [aw, ah] = settings.aspectRatio.split(':').map(Number);
    const target = aw / ah;
    if (Math.abs(target - base.width / base.height) > 0.01) {
      const byHeight = { width: Math.round(base.height * target), height: base.height };
      const byWidth = { width: base.width, height: Math.round(base.width / target) };
      ({ width, height } = byHeight.width * byHeight.height >= byWidth.width * byWidth.height ? byHeight : byWidth);
    }
  }

  // Even dimensions — fewer encoder artifacts (H.264 / VP9) at 1440p and 4K
  const snapEven = (n) => {
    const v = Math.max(2, Math.round(Number(n) || 0));
    return v - (v % 2);
  };
  return { width: snapEven(width), height: snapEven(height) };
}

function computeExportBitrate(resolution, quality, format, width, height) {
  let multiplier = (width * height) / (1920 * 1080);
  if (resolution === '4k') multiplier = Math.max(multiplier, 5.0);
  // Portrait / small outputs still get at least half the base bitrate
  multiplier = Math.max(multiplier, 0.5);

  const bitrate = Math.round((exportBitrates[quality] || exportBitrates.high) * multiplier);
  // Browser-safe caps: H.264 encoders are more limited than VP9
  const maxSafe = format === 'mp4' ? 150000000 : 250000000;
  return Math.min(bitrate, maxSafe);
}

async function doExport() {
  const confirmBtn = $('confirmExport');
  const resolution = $('exportResolution').value || '1080p';
  const format = $('exportFormat').value || 'mp4';
  const quality = $('exportQuality').value || 'high';

  if (!processor || typeof processor.processVideo !== 'function') {
    showToast('Video processor not initialized. Please refresh the page.', 'error');
    return;
  }

  // The processor decodes its own copy; keep the preview idle so it doesn't compete
  els.video.pause();
  setExportBusy(true);
  confirmBtn.innerHTML = '<span class="spinner"></span>Exporting…';
  setExportProgress(0, 'Preparing…');

  try {
    const blob = await fetch(els.video.src).then((r) => r.blob());
    const { width, height } = computeExportDimensions(resolution);
    const bitrate = computeExportBitrate(resolution, quality, format, width, height);
    const highRes = resolution === '4k' || resolution === '1440p';
    const image = getActiveBackgroundImage();

    const exportSettings = {
      background: image || backgrounds[settings.background] || backgrounds['grad-1'],
      backgroundImage: image,
      padding: settings.background === 'hidden' ? 0 : FRAME_PADDING,
      borderRadius: 8,
      trimStart: isFinite(trimHandles.start) ? trimHandles.start : 0,
      trimEnd: isFinite(trimHandles.end) ? trimHandles.end : 1,
      clickStyle: settings.clickStyle,
      clickColor: settings.customClickColor || clickColors.white,
      clickForce: settings.clickForce || 'moderate',
      showWebcam: false, // Camera overlay is already in the recorded video
      webcamPosition: 'bottom-right',
      webcamSize: 'medium',
      webcamShape: 'circular',
      webcamFlip: false,
      showBrowserFrame: settings.showBrowserFrame,
      taskbarCrop: getBottomCrop(),
      showShadow: settings.showShadow,
      outputWidth: width,
      outputHeight: height,
      bitrate,
      format,
      quality,
      // 1440p/4K are capped at 30 FPS for stable encoding
      fps: highRes ? 30 : 60,
      maxFps: highRes ? 30 : 60,
      sharpening: true,
      antiAlias: true,
      useWebCodecs: false
    };

    debugLog('[Editor] Export settings:', {
      resolution, format, quality, width, height,
      bitrate: (bitrate / 1000000).toFixed(1) + ' Mbps',
      trim: [exportSettings.trimStart, exportSettings.trimEnd]
    });

    setExportProgress(0, 'Rendering…');
    const processed = await processor.processVideo(
      blob,
      settings.applyZoom ? zoomSegments : [],
      (progress) => setExportProgress(progress, 'Rendering…'),
      exportSettings,
      cursorData
    );
    debugLog('[Editor] Output size:', (processed.size / 1024 / 1024).toFixed(2), 'MB');

    setExportProgress(100, 'Saving…');
    // The browser may fall back to WebM when MP4 recording isn't supported
    const extension = format === 'mp4' && processed.type.includes('mp4') ? 'mp4' : 'webm';
    const url = URL.createObjectURL(processed);
    const a = document.createElement('a');
    a.href = url;
    a.download = `open-motions-${Date.now()}.${extension}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    setExportProgress(100, 'Export complete');
    confirmBtn.innerHTML = iconSvg('check') + 'Done';
    setTimeout(() => {
      setExportBusy(false);
      confirmBtn.innerHTML = EXPORT_BUTTON_HTML;
      closeExportModal();
      showToast(`Saved as .${extension}`, 'success');
    }, 1200);
  } catch (e) {
    console.error('[Editor] Export error:', e);
    setExportBusy(false);
    confirmBtn.innerHTML = EXPORT_BUTTON_HTML;

    let message = 'Export failed: ' + e.message;
    if (e.message.includes('VideoEncoder')) {
      message += '\nTip: Try WebM format instead of MP4.';
    } else if (e.message.includes('duration')) {
      message += '\nTip: The video file may be corrupted. Try recording again.';
    }
    showToast(message, 'error');
  }
}
