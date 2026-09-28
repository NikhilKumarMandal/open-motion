let screenStream = null;
let camStream = null;
let micOnlyStream = null;
let screenRecorder = null;
let camRecorder = null;
let screenChunks = [];
let camChunks = [];
let myTabId = null;
let targetTabId = null;
let recordingStartWallClock = null;
let stopWallClock = null;
let cursorEventsRaw = [];
let trackingEndedAt = null;
let screenAudioMixCtx = null;
let cursorEventCount = 0;
let captureInfo = null; // { displaySurface, hasTabAudio }
let trackingReady = false;
let trackingEnabledForThisRecording = false;

let state = {
  status: 'idle', // idle | recording | paused | stopped
  startedAt: null,
  totalPausedMs: 0,
  pausedAt: null,
  tabId: null,
};

const els = {};

function qualityToHeight(q) {
  return { '720': 720, '1080': 1080, '1440': 1440, '2160': 2160 }[q] || 1080;
}

function showScreen(name) {
  els.setupScreen.hidden = name !== 'setup';
  els.liveScreen.hidden = name !== 'live';
  els.processingScreen.hidden = name !== 'processing';
}

async function persistState() {
  await chrome.storage.local.set({ recordingState: { ...state, tabId: myTabId } });
}

function makeRecorder(stream) {
  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) =>
    MediaRecorder.isTypeSupported(t)
  );
  return new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined);
}

// Captures a specific tab directly by id — no share picker, so there's no way
// to accidentally pick the wrong tab (e.g. the recorder tab itself instead of
// the one being demoed), which is what a manual getDisplayMedia picker risks.
function getTabStream(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        reject(new Error(chrome.runtime.lastError?.message || 'Could not get a tab capture stream id.'));
        return;
      }
      navigator.mediaDevices
        .getUserMedia({
          video: {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: streamId,
              maxFrameRate: 30,
            },
          },
          audio: {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: streamId,
            },
          },
        })
        .then(resolve, reject);
    });
  });
}

async function startRecordingTabDirect() {
  if (!targetTabId) {
    await startRecordingWithPicker();
    return;
  }

  els.startBtn.disabled = true;
  els.startWindowBtn.disabled = true;

  try {
    screenStream = await getTabStream(targetTabId);
  } catch (err) {
    console.warn('Direct tab capture failed, falling back to the share picker.', err);
    els.captureInfo.hidden = false;
    els.captureInfo.textContent = 'Direct tab capture failed — opening the standard share picker instead.';
    await startRecordingWithPicker();
    return;
  }

  captureInfo = { displaySurface: 'browser', hasTabAudio: screenStream.getAudioTracks().length > 0 };
  trackingEnabledForThisRecording = true;
  await continueStartRecording();
}

async function startRecordingWithPicker() {
  els.startBtn.disabled = true;
  els.startWindowBtn.disabled = true;

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30, height: { ideal: qualityToHeight(els.quality.value) } },
      audio: true,
    });
  } catch (err) {
    els.startBtn.disabled = !!targetTabId;
    els.startWindowBtn.disabled = false;
    return;
  }

  const capSettings = screenStream.getVideoTracks()[0].getSettings();
  captureInfo = {
    displaySurface: capSettings.displaySurface || 'unknown',
    hasTabAudio: screenStream.getAudioTracks().length > 0,
  };
  // This path never promises zoom/click effects, regardless of what ends up
  // being picked — that guarantee only holds for the direct tab-capture path.
  trackingEnabledForThisRecording = false;
  await continueStartRecording();
}

async function continueStartRecording() {
  const includeCamera = els.camToggle.checked;
  const includeMic = els.micToggle.checked;

  if (includeCamera) {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240 },
        audio: includeMic,
      });
    } catch (err) {
      camStream = null;
      console.warn('Webcam unavailable, recording screen only.', err);
    }
  } else if (includeMic) {
    try {
      micOnlyStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      micOnlyStream = null;
      console.warn('Microphone unavailable.', err);
    }
  }

  els.previewVideo.srcObject = screenStream;
  await els.previewVideo.play();

  if (camStream) {
    els.camPreviewOverlay.srcObject = camStream;
    els.camPreviewOverlay.hidden = false;
    await els.camPreviewOverlay.play();
  }

  // Inject the cursor tracker before recording actually starts, so tracking is
  // live from t=0. Only attempted for the direct tab-capture path, where
  // targetTabId is guaranteed to be the exact tab being recorded.
  trackingReady = false;
  if (trackingEnabledForThisRecording && targetTabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: targetTabId }, files: ['content.js'] });
      await new Promise((resolve) => setTimeout(resolve, 250));
      trackingReady = true;
    } catch (err) {
      console.warn('Could not inject cursor tracker into the shared tab.', err);
    }
    chrome.runtime.sendMessage({ type: 'om-watch-tab', tabId: targetTabId, recordTabId: myTabId }).catch(() => {});
  }

  // MediaRecorder only reliably encodes one audio track per stream, so when both
  // tab audio and mic audio need to end up in the same (camera-less) recording,
  // mix them down to a single track instead of bundling two tracks together.
  let screenRecordStream = screenStream;
  if (micOnlyStream) {
    screenAudioMixCtx = new AudioContext();
    const dest = screenAudioMixCtx.createMediaStreamDestination();
    if (screenStream.getAudioTracks().length) {
      screenAudioMixCtx.createMediaStreamSource(new MediaStream(screenStream.getAudioTracks())).connect(dest);
    }
    screenAudioMixCtx.createMediaStreamSource(micOnlyStream).connect(dest);
    screenRecordStream = new MediaStream([...screenStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  }

  screenRecorder = makeRecorder(screenRecordStream);
  screenChunks = [];
  screenRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) screenChunks.push(e.data);
  };

  if (camStream) {
    camRecorder = makeRecorder(camStream);
    camChunks = [];
    camRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) camChunks.push(e.data);
    };
  }

  recordingStartWallClock = Date.now();
  screenRecorder.start();
  if (camRecorder) camRecorder.start();

  screenStream.getVideoTracks()[0].addEventListener('ended', () => {
    if (state.status === 'recording' || state.status === 'paused') stopRecording();
  });

  state = { status: 'recording', startedAt: recordingStartWallClock, totalPausedMs: 0, pausedAt: null, tabId: myTabId };
  await persistState();
  showScreen('live');

  const sourceLabel =
    captureInfo.displaySurface === 'browser'
      ? 'this tab'
      : captureInfo.displaySurface === 'monitor'
      ? 'your entire screen'
      : captureInfo.displaySurface === 'window'
      ? 'a window'
      : 'an unknown source';
  const infoLines = [`Recording ${sourceLabel}.`];
  if (!trackingEnabledForThisRecording) {
    infoLines.push("Zoom & click effects aren't available for window/screen recordings.");
  }
  if (captureInfo.hasTabAudio) {
    infoLines.push('Tab audio: captured.');
  } else if (includeMic) {
    infoLines.push('No system audio for this share mode — recording microphone only.');
  } else {
    infoLines.push('⚠ No audio will be recorded — no tab audio available and microphone is off.');
  }
  els.captureInfo.hidden = false;
  els.captureInfo.textContent = infoLines.join('  ');

  if (trackingEnabledForThisRecording) {
    els.trackCount.hidden = false;
    if (trackingReady) {
      cursorEventCount = 0;
      els.trackCount.textContent = 'Waiting for cursor data from the tab you share…';
    } else {
      els.trackCount.textContent =
        "⚠ Could not enable cursor tracking on that tab — zoom & click effects won't be available for this recording.";
    }
  } else {
    els.trackCount.hidden = true;
  }
}

function pauseRecording() {
  if (state.status !== 'recording' || !screenRecorder) return;
  screenRecorder.pause();
  if (camRecorder) camRecorder.pause();
  state = { ...state, status: 'paused', pausedAt: Date.now() };
  persistState();
  els.pauseLiveBtn.textContent = '▶ Resume';
}

function resumeRecording() {
  if (state.status !== 'paused' || !screenRecorder) return;
  screenRecorder.resume();
  if (camRecorder) camRecorder.resume();
  state = {
    ...state,
    status: 'recording',
    totalPausedMs: state.totalPausedMs + (Date.now() - state.pausedAt),
    pausedAt: null,
  };
  persistState();
  els.pauseLiveBtn.textContent = '❙❙ Pause';
}

function stopRecording() {
  if (!screenRecorder || state.status === 'idle' || state.status === 'stopped') return;
  stopWallClock = Date.now();

  const screenDone = new Promise((resolve) => {
    screenRecorder.onstop = resolve;
  });
  const camDone = camRecorder ? new Promise((resolve) => { camRecorder.onstop = resolve; }) : Promise.resolve();

  if (screenRecorder.state !== 'inactive') screenRecorder.stop();
  if (camRecorder && camRecorder.state !== 'inactive') camRecorder.stop();

  for (const t of screenStream?.getTracks() || []) t.stop();
  for (const t of camStream?.getTracks() || []) t.stop();
  for (const t of micOnlyStream?.getTracks() || []) t.stop();
  if (screenAudioMixCtx) screenAudioMixCtx.close();

  if (targetTabId) {
    chrome.tabs.sendMessage(targetTabId, { type: 'om-stop-tracking' }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'om-unwatch-tab', tabId: targetTabId }).catch(() => {});
  }

  showScreen('processing');
  Promise.all([screenDone, camDone]).then(finishAndSave);
}

async function finishAndSave() {
  const screenBlob = new Blob(screenChunks, { type: 'video/webm' });
  const camBlob = camChunks.length ? new Blob(camChunks, { type: 'video/webm' }) : null;

  const cutoff = trackingEndedAt || stopWallClock;
  const cursorEvents = cursorEventsRaw
    .filter((e) => e.t >= recordingStartWallClock && e.t <= cutoff)
    .map((e) => ({ ...e, t: e.t - recordingStartWallClock }));

  const durationMs = stopWallClock - recordingStartWallClock - (state.totalPausedMs || 0);
  const recordingId = generateRecordingId();

  await putRecording({
    id: recordingId,
    screenBlob,
    camBlob,
    cursorEvents,
    meta: {
      durationMs,
      hasCamera: !!camBlob,
      quality: els.quality.value,
      createdAt: Date.now(),
      trackingAvailable: cursorEvents.length > 0,
      displaySurface: captureInfo?.displaySurface || 'unknown',
      hasTabAudio: !!captureInfo?.hasTabAudio,
    },
  });

  state = { status: 'stopped', startedAt: state.startedAt, totalPausedMs: state.totalPausedMs, pausedAt: null, tabId: myTabId };
  await persistState();

  window.location.href = chrome.runtime.getURL(`editor.html?id=${recordingId}`);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'pause') pauseRecording();
  if (msg.type === 'resume') resumeRecording();
  if (msg.type === 'stop') stopRecording();
  if (msg.type === 'om-cursor-event') {
    cursorEventsRaw.push(msg.event);
    cursorEventCount += 1;
    if (els.trackCount && !els.trackCount.hidden) {
      els.trackCount.textContent = `✓ Tracking cursor (${cursorEventCount} events) — zoom & click effects will work`;
    }
  }
  if (msg.type === 'om-tracking-ended') {
    trackingEndedAt = Date.now();
    if (els.trackCount) {
      els.trackCount.textContent = `Tracked tab closed/navigated — zoom data stops at ${Math.round(
        (trackingEndedAt - recordingStartWallClock) / 1000
      )}s`;
    }
  }
});

function tickTimer() {
  if (state.status !== 'recording' && state.status !== 'paused') return;
  const extraPause = state.status === 'paused' ? Date.now() - state.pausedAt : 0;
  const elapsed = Date.now() - state.startedAt - state.totalPausedMs - extraPause;
  const totalSec = Math.max(0, Math.floor(elapsed / 1000));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  els.liveTimer.textContent = `${mm}:${ss}`;
}

async function init() {
  const tab = await chrome.tabs.getCurrent();
  myTabId = tab?.id ?? null;

  const { recordingOptions } = await chrome.storage.local.get('recordingOptions');
  els.camToggle.checked = recordingOptions?.includeCamera ?? true;
  els.micToggle.checked = recordingOptions?.includeMic ?? true;
  els.quality.value = recordingOptions?.quality ?? '1080';
  targetTabId = recordingOptions?.targetTabId ?? null;

  if (targetTabId) {
    try {
      const targetTab = await chrome.tabs.get(targetTabId);
      els.targetTabInfo.hidden = false;
      els.targetTabInfo.textContent = `"Start Recording This Tab" will record: "${targetTab.title}" — captured directly, no share picker needed, so zoom & click effects always line up.`;
    } catch (err) {
      targetTabId = null;
    }
  }

  if (!targetTabId) {
    els.startBtn.hidden = true;
  }

  showScreen('setup');
}

window.addEventListener('DOMContentLoaded', () => {
  els.setupScreen = document.getElementById('setupScreen');
  els.liveScreen = document.getElementById('liveScreen');
  els.processingScreen = document.getElementById('processingScreen');
  els.camToggle = document.getElementById('camToggle');
  els.micToggle = document.getElementById('micToggle');
  els.quality = document.getElementById('quality');
  els.startBtn = document.getElementById('startBtn');
  els.startWindowBtn = document.getElementById('startWindowBtn');
  els.previewVideo = document.getElementById('previewVideo');
  els.camPreviewOverlay = document.getElementById('camPreviewOverlay');
  els.pauseLiveBtn = document.getElementById('pauseLiveBtn');
  els.stopLiveBtn = document.getElementById('stopLiveBtn');
  els.liveTimer = document.getElementById('liveTimer');
  els.targetTabInfo = document.getElementById('targetTabInfo');
  els.trackCount = document.getElementById('trackCount');
  els.captureInfo = document.getElementById('captureInfo');

  els.startBtn.addEventListener('click', startRecordingTabDirect);
  els.startWindowBtn.addEventListener('click', startRecordingWithPicker);
  els.pauseLiveBtn.addEventListener('click', () => {
    if (state.status === 'paused') resumeRecording();
    else pauseRecording();
  });
  els.stopLiveBtn.addEventListener('click', stopRecording);

  setInterval(tickTimer, 500);

  init();
});

window.addEventListener('beforeunload', () => {
  chrome.storage.local.set({ recordingState: { status: 'idle', tabId: null } });
});
