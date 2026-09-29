/**
 * CursorFly Screen Recorder
 * Copyright (c) 2026 Anu S Pillai
 * GitHub: https://github.com/anugotta
 *
 * Licensed under the MIT License.
 */

// Popup UI Controller
let isRecording = false;
let isPaused = false;
let timerInterval = null;
let startTime = 0;
let elapsedTime = 0;

// DOM Elements
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const pauseBtn = document.getElementById('pauseBtn');
const statusText = document.getElementById('statusText');
const statusDot = document.querySelector('.status-dot');
const timerDisplay = document.getElementById('timer');
const trackCursor = document.getElementById('trackCursor');
const recordAudio = document.getElementById('recordAudio');
const recordMicrophone = document.getElementById('recordMicrophone');
const quality = document.getElementById('quality');
const fps = document.getElementById('fps');

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Load saved settings
  const settings = await chrome.storage.local.get(['trackCursor', 'recordAudio', 'recordMicrophone', 'quality', 'fps']);
  
  if (settings.trackCursor !== undefined) trackCursor.checked = settings.trackCursor;
  if (settings.recordAudio !== undefined) recordAudio.checked = settings.recordAudio;
  if (settings.recordMicrophone !== undefined) recordMicrophone.checked = settings.recordMicrophone;
  if (settings.quality) quality.value = settings.quality;
  if (settings.fps) fps.value = settings.fps;
  
  // Check if already recording
  const status = await chrome.storage.local.get(['isRecording', 'isPaused']);
  if (status.isRecording) {
    showRecordingUI();
    if (status.isPaused) {
      showPausedState();
    }
  }
});

// Save settings when changed
trackCursor.addEventListener('change', saveSettings);
recordAudio.addEventListener('change', saveSettings);
recordMicrophone.addEventListener('change', saveSettings);
quality.addEventListener('change', saveSettings);
fps.addEventListener('change', saveSettings);

async function saveSettings() {
  await chrome.storage.local.set({
    trackCursor: trackCursor.checked,
    recordAudio: recordAudio.checked,
    recordMicrophone: recordMicrophone.checked,
    quality: quality.value,
    fps: fps.value
  });
}

// Start Recording
startBtn.addEventListener('click', async () => {
  try {
    startBtn.disabled = true;
    statusText.textContent = 'Requesting screen access...';
    
    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // Send message to background script to start recording
    const response = await chrome.runtime.sendMessage({
      action: 'startRecording',
      tabId: tab.id,
      settings: {
        trackCursor: trackCursor.checked,
        recordAudio: recordAudio.checked,
        recordMicrophone: recordMicrophone.checked,
        quality: quality.value,
        fps: fps.value
      }
    });
    
    if (response.success) {
      showRecordingUI();
      startTimer();
      statusText.textContent = 'Recording...';
    } else {
      statusText.textContent = 'Failed to start recording';
      startBtn.disabled = false;
      alert('Error: ' + (response.error || 'Failed to start recording'));
    }
  } catch (error) {
    console.error('Error starting recording:', error);
    statusText.textContent = 'Error starting recording';
    startBtn.disabled = false;
    alert('Error: ' + error.message);
  }
});

// Stop Recording
stopBtn.addEventListener('click', async () => {
  try {
    stopBtn.disabled = true;
    statusText.textContent = 'Stopping and processing...';
    
    const response = await chrome.runtime.sendMessage({ action: 'stopRecording' });
    
    if (response.success) {
      showStoppedUI();
      stopTimer();
      statusText.textContent = 'Recording saved!';
      
      // Show success message
      setTimeout(() => {
        statusText.textContent = 'Ready to record';
      }, 3000);
    } else {
      statusText.textContent = 'Error stopping recording';
      stopBtn.disabled = false;
    }
  } catch (error) {
    console.error('Error stopping recording:', error);
    statusText.textContent = 'Error stopping recording';
    stopBtn.disabled = false;
  }
});

// Pause/Resume Recording
pauseBtn.addEventListener('click', async () => {
  try {
    if (isPaused) {
      // Resume
      await chrome.runtime.sendMessage({ action: 'resumeRecording' });
      pauseBtn.innerHTML = '<span class="btn-icon">⏸</span>Pause';
      statusText.textContent = 'Recording...';
      statusDot.classList.remove('paused');
      statusDot.classList.add('recording');
      isPaused = false;
      startTimer();
    } else {
      // Pause
      await chrome.runtime.sendMessage({ action: 'pauseRecording' });
      pauseBtn.innerHTML = '<span class="btn-icon">▶</span>Resume';
      statusText.textContent = 'Paused';
      showPausedState();
    }
  } catch (error) {
    console.error('Error pausing/resuming:', error);
  }
});

function showRecordingUI() {
  isRecording = true;
  startBtn.style.display = 'none';
  stopBtn.style.display = 'flex';
  pauseBtn.style.display = 'flex';
  statusDot.classList.add('recording');
  
  // Disable options during recording
  document.querySelectorAll('.options input, .options select').forEach(el => {
    el.disabled = true;
  });
}

function showStoppedUI() {
  isRecording = false;
  isPaused = false;
  startBtn.style.display = 'flex';
  stopBtn.style.display = 'none';
  pauseBtn.style.display = 'none';
  startBtn.disabled = false;
  statusDot.classList.remove('recording', 'paused');
  
  // Re-enable options
  document.querySelectorAll('.options input, .options select').forEach(el => {
    el.disabled = false;
  });
}

function showPausedState() {
  isPaused = true;
  statusDot.classList.remove('recording');
  statusDot.classList.add('paused');
  stopTimer();
}

function startTimer() {
  startTime = Date.now() - elapsedTime;
  timerInterval = setInterval(updateTimer, 100);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (!isRecording) {
    elapsedTime = 0;
    timerDisplay.textContent = '00:00';
  }
}

function updateTimer() {
  elapsedTime = Date.now() - startTime;
  const seconds = Math.floor(elapsedTime / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  timerDisplay.textContent = `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

// Processor and Settings buttons
document.getElementById('processorBtn').addEventListener('click', () => {
  // Open video processor in new tab
  chrome.tabs.create({
    url: chrome.runtime.getURL('processor.html')
  });
});

document.getElementById('settingsBtn').addEventListener('click', () => {
  // Open settings page (to be implemented)
  alert('Settings page coming soon!');
});

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'recordingStopped') {
    showStoppedUI();
    stopTimer();
    statusText.textContent = 'Ready to record';
  }
});
