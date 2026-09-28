const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const openRecorderBtn = document.getElementById('openRecorderBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const timerEl = document.getElementById('timer');
const camToggle = document.getElementById('camToggle');
const micToggle = document.getElementById('micToggle');
const qualitySelect = document.getElementById('quality');

let tickHandle = null;

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function renderState(state) {
  const status = state?.status || 'idle';

  statusDot.classList.remove('recording', 'paused');
  if (status === 'recording') statusDot.classList.add('recording');
  if (status === 'paused') statusDot.classList.add('paused');

  statusText.textContent =
    status === 'recording' ? 'Recording' :
    status === 'paused' ? 'Paused' :
    status === 'stopped' ? 'Finished — check recorder tab' :
    'Idle';

  startBtn.disabled = status === 'recording' || status === 'paused';
  pauseBtn.disabled = status === 'idle' || status === 'stopped';
  pauseBtn.textContent = status === 'paused' ? '▶ Resume' : '❙❙ Pause';
  stopBtn.disabled = status === 'idle' || status === 'stopped';

  clearInterval(tickHandle);
  if (status === 'recording' || status === 'paused') {
    const tick = () => {
      const pausedMs = state.totalPausedMs || 0;
      const extraPause = status === 'paused' ? Date.now() - state.pausedAt : 0;
      timerEl.textContent = formatElapsed(Date.now() - state.startedAt - pausedMs - extraPause);
    };
    tick();
    tickHandle = setInterval(tick, 500);
  } else {
    timerEl.textContent = '00:00';
  }
}

async function loadState() {
  const { recordingState } = await chrome.storage.local.get('recordingState');
  renderState(recordingState);
  return recordingState;
}

async function focusOrCreateRecorderTab() {
  const { recordingState } = await chrome.storage.local.get('recordingState');
  const tabId = recordingState?.tabId;
  if (tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return tab.id;
    } catch {
      // tab no longer exists, fall through to creating a new one
    }
  }
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('record.html') });
  return tab.id;
}

async function getActiveTabId() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab?.id ?? null;
}

startBtn.addEventListener('click', async () => {
  // Actual cursor-tracker injection now happens from background.js once
  // recording really starts (see record.js) — it has persistent host_permissions
  // and can retry, unlike a one-shot injection tied to this click's activeTab grant.
  const targetTabId = await getActiveTabId();
  await chrome.storage.local.set({
    recordingOptions: {
      includeCamera: camToggle.checked,
      includeMic: micToggle.checked,
      quality: qualitySelect.value,
      targetTabId,
    },
  });
  await focusOrCreateRecorderTab();
});

openRecorderBtn.addEventListener('click', () => {
  focusOrCreateRecorderTab();
});

pauseBtn.addEventListener('click', async () => {
  const { recordingState } = await chrome.storage.local.get('recordingState');
  if (!recordingState?.tabId) return;
  const type = recordingState.status === 'paused' ? 'resume' : 'pause';
  chrome.tabs.sendMessage(recordingState.tabId, { type });
});

stopBtn.addEventListener('click', async () => {
  const { recordingState } = await chrome.storage.local.get('recordingState');
  if (!recordingState?.tabId) return;
  chrome.tabs.sendMessage(recordingState.tabId, { type: 'stop' });
  await chrome.tabs.update(recordingState.tabId, { active: true });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.recordingState) {
    renderState(changes.recordingState.newValue);
  }
});

loadState();
