/**
 * CursorFly Screen Recorder
 * Copyright (c) 2026 Anu S Pillai
 * GitHub: https://github.com/anugotta
 *
 * Licensed under the MIT License.
 */

// Record Page Controller - Cursorfly-style flow
// Screen picker appears on this page, then recording starts on original tab

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

debugLog('[Record] Page loaded');

// Get tab ID from URL
const urlParams = new URLSearchParams(window.location.search);
const tabId = parseInt(urlParams.get('tabId'));

debugLog('[Record] Target tab ID:', tabId);

// State
let mediaStream = null;
/** Video-only stream for picture-in-picture overlay (separate permission from mic) */
let cameraVideoStream = null;
/** Audio-only stream for voice mixed into recording (separate permission from camera) */
let micStream = null;
let isRecording = false;
let startTime = 0;
let timerInterval = null;

// DOM Elements
const selectScreenBtn = document.getElementById('selectScreenBtn');
const enableCameraBtn = document.getElementById('enableCameraBtn');
const enableMicBtn = document.getElementById('enableMicBtn');
const cameraStatus = document.getElementById('cameraStatus');
const cameraStatusText = document.getElementById('cameraStatusText');

function hasCameraOverlay() {
  return !!(cameraVideoStream && cameraVideoStream.getVideoTracks().length > 0);
}

function hasMicForRecording() {
  return !!(micStream && micStream.getAudioTracks().length > 0);
}

function updateOptionalMediaStatus() {
  const cam = hasCameraOverlay();
  const mic = hasMicForRecording();
  if (!cam && !mic) {
    cameraStatus.style.display = 'none';
    return;
  }
  cameraStatus.style.display = 'inline-flex';
  if (cam && mic) {
    cameraStatusText.textContent = 'Camera overlay and microphone enabled';
  } else if (cam) {
    cameraStatusText.textContent = 'Camera overlay enabled (no microphone)';
  } else {
    cameraStatusText.textContent = 'Microphone enabled (no camera overlay)';
  }
}
const startRecordingBtn = document.getElementById('startRecordingBtn');
const stopRecordingBtn = document.getElementById('stopRecordingBtn');
const screenStatus = document.getElementById('screenStatus');
const screenStatusText = document.getElementById('screenStatusText');
const recordingOverlay = document.getElementById('recordingOverlay');
const cameraOverlay = document.getElementById('cameraOverlay');
const cameraOverlayVideo = document.getElementById('cameraOverlayVideo');
const timer = document.getElementById('timer');
const unsupportedModal = document.getElementById('unsupportedModal');
const unsupportedModalMessage = document.getElementById('unsupportedModalMessage');
const unsupportedModalOk = document.getElementById('unsupportedModalOk');

// Utility function to detect unsupported websites
function isUnsupportedWebsite(url) {
  if (!url) return false;
  
  // Chrome internal pages
  if (url.startsWith('chrome://')) return true;
  if (url.startsWith('chrome-extension://')) return true;
  if (url.startsWith('edge://')) return true;
  if (url.startsWith('about:')) return true;
  
  // Chrome Web Store
  if (url.includes('chrome.google.com/webstore')) return true;
  
  // Edge Web Store
  if (url.includes('microsoftedge.microsoft.com/addons')) return true;
  
  // Settings pages
  if (url.includes('chrome://settings')) return true;
  if (url.includes('edge://settings')) return true;
  
  return false;
}

// Get website name for display
function getWebsiteName(url) {
  if (!url) return 'this page';
  
  if (url.startsWith('chrome://')) {
    const page = url.replace('chrome://', '').split('/')[0];
    return `Chrome ${page} page`;
  }
  if (url.startsWith('chrome-extension://')) {
    return 'Chrome Extension page';
  }
  if (url.startsWith('edge://')) {
    const page = url.replace('edge://', '').split('/')[0];
    return `Edge ${page} page`;
  }
  if (url.includes('chrome.google.com/webstore')) {
    return 'Chrome Web Store';
  }
  if (url.includes('microsoftedge.microsoft.com/addons')) {
    return 'Edge Add-ons Store';
  }
  if (url.includes('settings')) {
    return 'Settings page';
  }
  
  return 'this page';
}

// Show unsupported website modal
function showUnsupportedModal(url) {
  const websiteName = getWebsiteName(url);
  unsupportedModalMessage.textContent = 
    `Cursorfly - Screen Recorder with Auto Pan Zoom is not allowed to record your mouse interactions on ${websiteName} and Settings pages.`;
  unsupportedModal.classList.add('active');
}

// Hide unsupported website modal
function hideUnsupportedModal() {
  unsupportedModal.classList.remove('active');
}

// Check if target tab is unsupported (without showing modal)
async function checkUnsupportedWebsite() {
  try {
    if (!tabId || isNaN(tabId)) {
      return false;
    }
    
    const tab = await chrome.tabs.get(tabId);
    debugLog('[Record] Checking target tab URL:', tab.url);
    
    if (isUnsupportedWebsite(tab.url)) {
      console.warn('[Record] ⚠️ Unsupported website detected:', tab.url);
      return true;
    }
    return false;
  } catch (error) {
    console.warn('[Record] Could not check tab URL:', error);
    return false;
  }
}

// Modal OK button handler
unsupportedModalOk.addEventListener('click', () => {
  hideUnsupportedModal();
});

// Close modal when clicking outside
unsupportedModal.addEventListener('click', (e) => {
  if (e.target === unsupportedModal) {
    hideUnsupportedModal();
  }
});

// Validate tab ID
if (!tabId || isNaN(tabId)) {
  console.error('[Record] Invalid tab ID!');
  selectScreenBtn.disabled = true;
  selectScreenBtn.textContent = '⚠️ Invalid target';
} else {
  // Check for unsupported website on page load (just log, don't show modal)
  checkUnsupportedWebsite().then(isUnsupported => {
    if (isUnsupported) {
      console.warn('[Record] Target tab is unsupported - modal will show when Start Recording is clicked');
    }
  });
}

// Event Listeners
selectScreenBtn.addEventListener('click', selectScreen);
enableCameraBtn.addEventListener('click', enableCameraVideo);
enableMicBtn.addEventListener('click', enableMicrophone);
startRecordingBtn.addEventListener('click', startRecording);
stopRecordingBtn.addEventListener('click', stopRecording);

// Step 1: Select Screen - Uses getDisplayMedia to show picker on THIS page
// Following the approach from: https://www.recall.ai/blog/how-to-build-a-chrome-recording-extension
async function selectScreen() {
  try {
    debugLog('[Record] Selecting screen...');
    selectScreenBtn.disabled = true;
    selectScreenBtn.innerHTML = '<span class="btn-icon">⏳</span> Selecting...';

    // Use getDisplayMedia - this shows the picker dialog on THIS page
    // According to the article, we need to enable audio to capture system/tab audio
    // The user must check "Share tab audio" or "Share system audio" in the picker
    const displayMediaOptions = {
      video: {
        displaySurface: 'monitor',
        width: { ideal: 1920, max: 3840 },
        height: { ideal: 1080, max: 2160 },
        frameRate: { ideal: 30, max: 60 }
      },
      audio: true, // Enable audio capture - user must select audio in picker
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude'
    };
    
    // Try to include systemAudio if supported (newer API)
    // Note: This may not work on all platforms/browsers
    if ('systemAudio' in navigator.mediaDevices.getDisplayMedia) {
      displayMediaOptions.systemAudio = 'include';
      console.log('[Record] systemAudio: include is supported');
    } else {
      console.log('[Record] systemAudio option not available, using standard audio capture');
    }
    
    mediaStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);

    console.log('[Record] Screen selected!');
    console.log('[Record] Video tracks:', mediaStream.getVideoTracks().length);
    console.log('[Record] Audio tracks:', mediaStream.getAudioTracks().length);

    // Get video track settings
    const videoTrack = mediaStream.getVideoTracks()[0];
    const settings = videoTrack.getSettings();
    console.log('[Record] Video settings:', settings);

    // Log audio track information if present
    // Following the article's approach: verify audio tracks are captured
    const audioTracks = mediaStream.getAudioTracks();
    if (audioTracks.length > 0) {
      audioTracks.forEach((track, index) => {
        const audioSettings = track.getSettings();
        console.log(`[Record] Audio track ${index + 1} settings:`, audioSettings);
        console.log(`[Record] Audio track ${index + 1} label:`, track.label);
        console.log(`[Record] Audio track ${index + 1} enabled:`, track.enabled);
        console.log(`[Record] Audio track ${index + 1} kind:`, track.kind);
      });
      console.log('[Record] ✅ System/tab audio will be recorded');
    }

    // Update UI
    selectScreenBtn.innerHTML = '<span class="btn-icon">✅</span> Screen selected';
    selectScreenBtn.classList.remove('btn-primary');
    selectScreenBtn.classList.add('btn-outline');
    selectScreenBtn.disabled = true;
    
    screenStatus.style.display = 'inline-flex';
    const hasAudio = mediaStream.getAudioTracks().length > 0;
    screenStatusText.textContent = hasAudio 
      ? 'Screen and audio selected - Ready to record'
      : 'Screen selected (no audio) - Ready to record';

    // Enable start recording button
    startRecordingBtn.disabled = false;
    startRecordingBtn.classList.remove('btn-outline');
    startRecordingBtn.classList.add('btn-primary');

    // Handle stream ending (user clicked stop sharing)
    mediaStream.getVideoTracks()[0].onended = () => {
      console.log('[Record] Stream ended by user');
      resetUI();
    };

  } catch (error) {
    // Screen selection error - silently handled
    
    // Reset button
    selectScreenBtn.disabled = false;
    selectScreenBtn.innerHTML = '<span class="btn-icon">🖥️</span> Select screen';
    
    if (error.name !== 'NotAllowedError') {
      alert('Failed to select screen: ' + error.message);
    }
  }
}

// Enable camera only (picture-in-picture overlay) — separate permission prompt
async function enableCameraVideo() {
  try {
    debugLog('[Record] Requesting camera (video only)...');
    enableCameraBtn.disabled = true;
    enableCameraBtn.innerHTML = '<span class="btn-icon">⏳</span> Requesting...';

    if (cameraVideoStream) {
      cameraVideoStream.getTracks().forEach((t) => t.stop());
      cameraVideoStream = null;
    }

    cameraVideoStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640, max: 1280 },
        height: { ideal: 480, max: 720 },
        facingMode: 'user'
      },
      audio: false
    });

    console.log('[Record] Camera (overlay) enabled, video tracks:', cameraVideoStream.getVideoTracks().length);

    enableCameraBtn.innerHTML = '<span class="btn-icon">✅</span> Camera enabled';
    enableCameraBtn.classList.remove('btn-outline');
    enableCameraBtn.classList.add('btn-primary');
    enableCameraBtn.disabled = true;

    cameraVideoStream.getVideoTracks()[0].onended = () => {
      console.log('[Record] Camera video ended by user');
      if (cameraVideoStream) {
        cameraVideoStream.getTracks().forEach((t) => t.stop());
        cameraVideoStream = null;
      }
      enableCameraBtn.disabled = false;
      enableCameraBtn.innerHTML = '<span class="btn-icon">📹</span> Enable camera (overlay)';
      enableCameraBtn.classList.add('btn-outline');
      enableCameraBtn.classList.remove('btn-primary');
      updateOptionalMediaStatus();
    };

    updateOptionalMediaStatus();
  } catch (error) {
    console.error('[Record] Camera error:', error);
    enableCameraBtn.disabled = false;
    enableCameraBtn.innerHTML = '<span class="btn-icon">📹</span> Enable camera (overlay)';
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      alert('Camera permission denied. Allow camera access to use the overlay.');
    } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      alert('No camera found. Connect a camera to use the overlay.');
    } else {
      alert('Failed to enable camera: ' + error.message);
    }
  }
}

// Enable microphone only — separate permission prompt, mixed into recording with screen audio
async function enableMicrophone() {
  try {
    debugLog('[Record] Requesting microphone (audio only)...');
    enableMicBtn.disabled = true;
    enableMicBtn.innerHTML = '<span class="btn-icon">⏳</span> Requesting...';

    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: { ideal: 48000, min: 44100 },
        channelCount: { ideal: 2, min: 1 }
      },
      video: false
    });

    console.log('[Record] Microphone enabled, audio tracks:', micStream.getAudioTracks().length);
    micStream.getAudioTracks().forEach((track, i) => {
      const settings = track.getSettings();
      console.log(`[Record] Microphone ${i + 1}:`, {
        sampleRate: settings.sampleRate,
        channelCount: settings.channelCount
      });
      track.onended = () => {
        console.log('[Record] Microphone track ended by user');
        if (micStream) {
          micStream.getTracks().forEach((t) => t.stop());
          micStream = null;
        }
        enableMicBtn.disabled = false;
        enableMicBtn.innerHTML = '<span class="btn-icon">🎤</span> Enable microphone';
        enableMicBtn.classList.add('btn-outline');
        enableMicBtn.classList.remove('btn-primary');
        updateOptionalMediaStatus();
      };
    });

    enableMicBtn.innerHTML = '<span class="btn-icon">✅</span> Microphone enabled';
    enableMicBtn.classList.remove('btn-outline');
    enableMicBtn.classList.add('btn-primary');
    enableMicBtn.disabled = true;

    updateOptionalMediaStatus();
  } catch (error) {
    console.error('[Record] Microphone error:', error);
    enableMicBtn.disabled = false;
    enableMicBtn.innerHTML = '<span class="btn-icon">🎤</span> Enable microphone';
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      alert('Microphone permission denied. Allow microphone access to record your voice.');
    } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      alert('No microphone found. Connect a microphone to record voice.');
    } else {
      alert('Failed to enable microphone: ' + error.message);
    }
  }
}

/** Stop optional camera/mic tracks and reset buttons (e.g. after recording or full reset) */
function resetOptionalMediaUI() {
  if (cameraVideoStream) {
    cameraVideoStream.getTracks().forEach((t) => t.stop());
    cameraVideoStream = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  enableCameraBtn.disabled = false;
  enableCameraBtn.innerHTML = '<span class="btn-icon">📹</span> Enable camera (overlay)';
  enableCameraBtn.classList.add('btn-outline');
  enableCameraBtn.classList.remove('btn-primary');
  enableMicBtn.disabled = false;
  enableMicBtn.innerHTML = '<span class="btn-icon">🎤</span> Enable microphone';
  enableMicBtn.classList.add('btn-outline');
  enableMicBtn.classList.remove('btn-primary');
  cameraStatus.style.display = 'none';
}

// Reset UI when stream ends
function resetUI() {
  selectScreenBtn.disabled = false;
  selectScreenBtn.innerHTML = '<span class="btn-icon">🖥️</span> Select screen';
  selectScreenBtn.classList.add('btn-primary');
  selectScreenBtn.classList.remove('btn-outline');
  
  startRecordingBtn.disabled = true;
  startRecordingBtn.classList.add('btn-outline');
  startRecordingBtn.classList.remove('btn-primary');
  
  screenStatus.style.display = 'none';
  mediaStream = null;
  
  resetOptionalMediaUI();
}

// Step 3: Start Recording
async function startRecording() {
  if (!mediaStream) {
    alert('Please select a screen first');
    return;
  }
  
  // Clean up any previous recording resources
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    console.log('[Record] Cleaning up previous MediaRecorder before starting new recording');
    try {
      mediaRecorder.stop();
    } catch (e) {
      console.warn('[Record] Error stopping previous MediaRecorder:', e);
    }
    mediaRecorder = null;
  }
  recordedChunks = [];
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  // Check for unsupported website BEFORE starting recording
  try {
    const tab = await chrome.tabs.get(tabId);
    console.log('[Record] Checking target tab before recording:', tab.url);
    
    if (isUnsupportedWebsite(tab.url)) {
      console.warn('[Record] ⚠️ Unsupported website detected, showing modal');
      showUnsupportedModal(tab.url);
      // Don't proceed with recording
      return;
    }
  } catch (error) {
    console.warn('[Record] Could not check tab before recording:', error);
    // If we can't check, we should still try to proceed
    // but show modal if injection fails later
  }

  try {
    console.log('[Record] Starting recording...');
    startRecordingBtn.disabled = true;
    startRecordingBtn.innerHTML = '<span class="btn-icon">⏳</span> Starting...';

    // FIRST: Check target tab one more time before starting
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isUnsupportedWebsite(tab.url)) {
        console.log('[Record] Unsupported website detected, showing modal');
        showUnsupportedModal(tab.url);
        startRecordingBtn.disabled = false;
        startRecordingBtn.innerHTML = '<span class="btn-icon">🎬</span> Start recording';
        return;
      }
    } catch (error) {
      console.log('[Record] Could not check tab, proceeding anyway');
    }

    // SECOND: Tell background we're starting (sets isRecording = true)
    // If camera is enabled, set up a canvas to capture frames and send to background
    if (hasCameraOverlay()) {
      // Create a canvas to capture camera frames (store references for cleanup)
      window.cameraFrameCanvas = document.createElement('canvas');
      window.cameraFrameCtx = window.cameraFrameCanvas.getContext('2d');
      window.cameraFrameVideo = document.createElement('video');
      window.cameraFrameVideo.srcObject = cameraVideoStream;
      window.cameraFrameVideo.autoplay = true;
      window.cameraFrameVideo.muted = true;
      await window.cameraFrameVideo.play();
      
      window.cameraFrameCanvas.width = 640;
      window.cameraFrameCanvas.height = 480;
      
      // Wait for video to be ready before starting frame capture
      const startFrameCapture = () => {
        // Capture frames and send to background script
        const captureFrame = () => {
          // Ensure all required elements exist before accessing
          if (!window.cameraFrameVideo || !window.cameraFrameCtx || !window.cameraFrameCanvas) {
            return; // Skip if elements not ready
          }
          
          if (window.cameraFrameVideo.readyState >= 2) {
            window.cameraFrameCtx.drawImage(window.cameraFrameVideo, 0, 0, window.cameraFrameCanvas.width, window.cameraFrameCanvas.height);
            // Use higher quality JPEG for better overlay appearance
            const dataUrl = window.cameraFrameCanvas.toDataURL('image/jpeg', 0.92);
            chrome.runtime.sendMessage({
              action: 'updateCameraFrame',
              frameData: dataUrl
            }).then(() => {
            }).catch((error) => {
            });
          }
        };
        
        // Capture at ~20 FPS for smooth overlay (every ~50ms) - better frame rate for smoother appearance
        window.cameraFrameSender = setInterval(captureFrame, 50);
        // Wait a bit before capturing first frame to ensure video is ready
        setTimeout(() => {
          captureFrame(); // Initial frame
        }, 100);
      };
      
      // Start frame capture after video is ready
      if (window.cameraFrameVideo.readyState >= 2) {
        startFrameCapture();
      } else {
        // Wait for video to be ready
        window.cameraFrameVideo.addEventListener('loadeddata', startFrameCapture, { once: true });
      }
    }
    
    
    const response = await chrome.runtime.sendMessage({
      action: 'startRecordingWithMediaStream',
      tabId: tabId,
      cameraOverlayEnabled: hasCameraOverlay(), // Pass camera overlay flag
      settings: {
        trackCursor: true,
        recordMicrophone: false,
        quality: '1080p',
        fps: '30'
      }
    });
    

    if (!response.success) {
      throw new Error(response.error || 'Failed to start recording');
    }
    
    console.log('[Record] Background acknowledged, isRecording is now true');

    // THIRD: Inject content script for cursor tracking (AFTER isRecording is set)
    const trackingResult = await injectCursorTracking();
    
    // If unsupported website detected, stop everything gracefully
    if (trackingResult && trackingResult.unsupported) {
      // Stop the recording we just started
      try {
        await chrome.runtime.sendMessage({ action: 'recordingStopped' });
      } catch (e) {
        // Ignore errors
      }
      
      // Stop media recorder if it was started
      try {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
        if (mediaStream) {
          mediaStream.getTracks().forEach(track => track.stop());
        }
      } catch (e) {
        // Ignore errors
      }
      
      // Reset UI
      startRecordingBtn.disabled = false;
      startRecordingBtn.innerHTML = '<span class="btn-icon">🎬</span> Start recording';
      
      // Show modal
      showUnsupportedModal(trackingResult.url);
      
      return; // Don't proceed
    }

    // FOURTH: Switch to original tab FIRST (before starting recording)
    console.log('[Record] Switching to original tab:', tabId);
    try {
      await chrome.tabs.update(tabId, { active: true });
      // Wait for tab to be fully active and visible
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Give background script time to inject camera overlay
      if (hasCameraOverlay()) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (e) {
      console.warn('[Record] Could not switch to original tab:', e);
    }

    // FIFTH: Sync recording start time right before MediaRecorder starts
    // This ensures cursor timestamps align perfectly with video timestamps
    console.log('[Record] Syncing recording start time with MediaRecorder start');
    try {
      await chrome.runtime.sendMessage({ action: 'syncRecordingStartTime' });
    } catch (e) {
      console.warn('[Record] Could not sync recording start time:', e);
    }

    // SIXTH: Start local recording AFTER tab switch and time sync
    await startLocalRecording();
    
      isRecording = true;
      startTime = Date.now();
    
    // Start timer
      timerInterval = setInterval(updateTimer, 100);

    // Show recording overlay (will be visible when user comes back to this tab)
    recordingOverlay.classList.add('active');
    
    // NOTE: Camera overlay should NOT appear on record.html page
    // It should only appear on the tab being recorded (injected by background script)
    // Do NOT show camera overlay here - it's handled by background script injection

  } catch (error) {
    console.log('[Record] Start recording error:', error);
    
    startRecordingBtn.disabled = false;
    startRecordingBtn.innerHTML = '<span class="btn-icon">🎬</span> Start recording';
    
    // Only show alert for unexpected errors (not unsupported website)
    if (!error.message || (!error.message.includes('unsupported website') && !error.message.includes('Cannot record'))) {
      alert('Failed to start recording: ' + (error.message || 'Unknown error'));
    }
  }
}

// Inject content script into target tab for cursor tracking
async function injectCursorTracking() {
  try {
    // Check if target tab is accessible
    const tab = await chrome.tabs.get(tabId);
    console.log('[Record] Target tab URL:', tab.url);
    
    // Check if it's a restricted URL
    if (isUnsupportedWebsite(tab.url)) {
      console.log('[Record] Unsupported website detected');
      // Return a special indicator instead of throwing
      return { unsupported: true, url: tab.url };
    }
    
    // Inject content script
    console.log('[Record] Injecting content script into tab:', tabId);
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    });
    console.log('[Record] ✅ Content script injected');
    
    // Wait for script to load
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Start tracking
    console.log('[Record] Sending startTracking message...');
    const trackingResponse = await chrome.tabs.sendMessage(tabId, { action: 'startTracking' });
    console.log('[Record] ✅ Cursor tracking started, response:', trackingResponse);
    
  } catch (error) {
    console.log('[Record] Could not inject content script:', error.message);
    
    // If it's a "cannot be scripted" error, it's likely an unsupported website
    if (error.message && (error.message.includes('cannot be scripted') || error.message.includes('extensions gallery'))) {
      // This is likely an unsupported website
      try {
        const tab = await chrome.tabs.get(tabId);
        return { unsupported: true, url: tab.url };
      } catch (e) {
        return { unsupported: true, url: null };
      }
    }
    
    // For other errors, just continue without cursor tracking
    console.log('[Record] Continuing without cursor tracking');
    return { unsupported: false };
  }
}

// Local recording using the mediaStream we already have
let mediaRecorder = null;
let recordedChunks = [];

async function startLocalRecording() {
  const qualityPresets = {
    '4k': { width: 3840, height: 2160, bitrate: 20000000 },
    '1440p': { width: 2560, height: 1440, bitrate: 12000000 },
    '1080p': { width: 1920, height: 1080, bitrate: 8000000 },
    '720p': { width: 1280, height: 720, bitrate: 5000000 }
  };
  
  const preset = qualityPresets['1080p'];
  
  // Codec detection - VP9 preferred for quality, VP8/WebM fallback for compatibility
  const codecs = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  
  let selectedCodec = codecs[0];
  for (const codec of codecs) {
    if (MediaRecorder.isTypeSupported(codec)) {
      selectedCodec = codec;
      console.log('[Record] Using codec:', codec);
      break;
    }
  }
  
  // Setup MediaRecorder
  // Check if we have audio tracks to include in recording
  let audioTracks = mediaStream.getAudioTracks();
  const videoTracks = mediaStream.getVideoTracks();
  
  // Add microphone-only audio (separate from camera permission) when enabled
  if (hasMicForRecording()) {
    const micAudioTracks = micStream.getAudioTracks();
    if (micAudioTracks.length > 0) {
      console.log('[Record] Adding microphone audio track(s) to recording stream');
      const combinedStream = new MediaStream();
      videoTracks.forEach((track) => combinedStream.addTrack(track));
      audioTracks.forEach((track) => combinedStream.addTrack(track));
      micAudioTracks.forEach((track) => {
        combinedStream.addTrack(track);
        console.log('[Record] Added mic track:', track.label, track.id);
      });
      mediaStream = combinedStream;
      audioTracks = mediaStream.getAudioTracks();
      console.log('[Record] Combined stream has', audioTracks.length, 'audio track(s)');
    }
  }
  
  const hasAudioTracks = audioTracks.length > 0;
  
  console.log('[Record] MediaRecorder setup:');
  console.log('[Record] - Video tracks:', videoTracks.length);
  console.log('[Record] - Audio tracks:', audioTracks.length);
  
  if (hasAudioTracks) {
    audioTracks.forEach((track, i) => {
      console.log(`[Record] - Audio track ${i + 1}:`, {
        label: track.label,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState,
        settings: track.getSettings()
      });
    });
  }
  
  // Always try to use audio-capable codecs first
  // This ensures audio is recorded if tracks are present
  const audioCodecs = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  
  const videoOnlyCodecs = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  
  const codecsToTry = hasAudioTracks ? audioCodecs : videoOnlyCodecs;
  
  let selectedMimeType = selectedCodec;
  for (const codec of codecsToTry) {
    if (MediaRecorder.isTypeSupported(codec)) {
      selectedMimeType = codec;
      console.log('[Record] Selected codec:', codec, hasAudioTracks ? '(with audio support)' : '(video only)');
      break;
    }
  }
  
  const options = {
    mimeType: selectedMimeType,
    videoBitsPerSecond: preset.bitrate
  };
  
  // Add audio bitrate if we have audio tracks
  // Use high-quality audio bitrate: 192 kbps for excellent quality (Opus supports up to 510 kbps)
  // 192 kbps provides near-transparent quality for voice and music
  if (hasAudioTracks) {
    options.audioBitsPerSecond = 192000; // 192 kbps for high-quality audio (increased from 128 kbps)
    console.log('[Record] Audio bitrate set to 192 kbps (high quality)');
    
    // Log audio track settings for quality verification
    audioTracks.forEach((track, i) => {
      const settings = track.getSettings();
      console.log(`[Record] Audio track ${i + 1} quality settings:`, {
        sampleRate: settings.sampleRate,
        channelCount: settings.channelCount,
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl
      });
    });
  }
  
  console.log('[Record] Final MediaRecorder options:', options);
  console.log('[Record] Stream will be recorded with:', {
    videoTracks: videoTracks.length,
    audioTracks: audioTracks.length,
    mimeType: options.mimeType
  });
  
  // Verify the stream has the tracks we expect
  if (hasAudioTracks) {
    const allAudioEnabled = audioTracks.every(track => track.enabled && track.readyState === 'live');
    if (!allAudioEnabled) {
      console.warn('[Record] ⚠️ Some audio tracks are not enabled or not live!');
      audioTracks.forEach((track, i) => {
        if (!track.enabled || track.readyState !== 'live') {
          console.warn(`[Record] Audio track ${i + 1} issue:`, {
            enabled: track.enabled,
            readyState: track.readyState
          });
        }
      });
    }
  }
  
  mediaRecorder = new MediaRecorder(mediaStream, options);
  recordedChunks = [];
  
  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
      console.log('[Record] Data chunk:', event.data.size, 'bytes', `(total: ${recordedChunks.length} chunks)`);
    }
  };
  
  mediaRecorder.onerror = (event) => {
    console.error('[Record] MediaRecorder error:', event.error);
    console.error('[Record] Error details:', {
      error: event.error,
      state: mediaRecorder.state
    });
  };
  
  // Store references for use in callbacks
  const finalAudioTracks = audioTracks;
  const finalHasAudioTracks = hasAudioTracks;
  
  mediaRecorder.onstop = async () => {
    console.log('[Record] MediaRecorder stopped. Total chunks:', recordedChunks.length);
    console.log('[Record] MediaRecorder state:', mediaRecorder.state);
    
    // Wait a bit for any final data chunks
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Verify we have data
    const totalSize = recordedChunks.reduce((sum, chunk) => sum + chunk.size, 0);
    console.log('[Record] Total recorded data:', totalSize, 'bytes', `(${(totalSize / 1024 / 1024).toFixed(2)} MB)`);
    console.log('[Record] Chunk details:', recordedChunks.map((c, i) => `Chunk ${i + 1}: ${c.size} bytes`));
    
    if (totalSize === 0 || recordedChunks.length === 0) {
      console.error('[Record] ⚠️ ERROR: No data recorded!');
      console.error('[Record] MediaRecorder may not have captured any data. Possible causes:');
      console.error('[Record] - Recording was too short');
      console.error('[Record] - MediaRecorder failed silently');
      console.error('[Record] - No video/audio tracks were active');
      
      // Check track status
      if (mediaStream) {
        const videoTracks = mediaStream.getVideoTracks();
        const audioTracks = mediaStream.getAudioTracks();
        console.error('[Record] Stream status at stop:', {
          videoTracks: videoTracks.length,
          audioTracks: audioTracks.length,
          videoTrackStates: videoTracks.map(t => ({ enabled: t.enabled, readyState: t.readyState })),
          audioTrackStates: audioTracks.map(t => ({ enabled: t.enabled, readyState: t.readyState }))
        });
      }
      
      alert('Recording failed: No data was captured. This may happen if:\n- The recording was too short\n- The screen share was stopped\n- There was an error during recording\n\nPlease try recording again.');
      return;
    }
    
    const blob = new Blob(recordedChunks, { type: selectedMimeType });
    console.log('[Record] Created blob:', blob.size, 'bytes', `(${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
    console.log('[Record] Blob type:', blob.type);
    
    // Verify blob is valid
    if (blob.size === 0) {
      console.error('[Record] ⚠️ ERROR: Blob is empty even though chunks exist!');
      alert('Recording failed: Created blob is empty. Please try again.');
      return;
    }
    
    // Validate blob has WebM magic bytes (for WebM files)
    if (selectedMimeType.includes('webm')) {
      const firstBytes = await blob.slice(0, 4).arrayBuffer();
      const view = new Uint8Array(firstBytes);
      const magicBytes = Array.from(view).map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log('[Record] Blob first 4 bytes (hex):', magicBytes);
      
      // WebM files should start with 0x1A 0x45 0xDF 0xA3 (EBML header)
      if (view[0] === 0x1A && view[1] === 0x45 && view[2] === 0xDF && view[3] === 0xA3) {
        console.log('[Record] ✅ Blob has valid WebM magic bytes');
      } else {
        console.warn('[Record] ⚠️ Blob does not have valid WebM magic bytes! This may indicate corruption.');
      }
    }
    
    // Log final audio track status
    if (finalHasAudioTracks) {
      console.log('[Record] Final audio track status:');
      finalAudioTracks.forEach((track, i) => {
        const trackInfo = {
          label: track.label,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState
        };
        console.log(`[Record] - Audio track ${i + 1}:`, trackInfo);
      });
    }
    
    await saveRecording(blob);
  };
  
  // Start recording
  try {
    mediaRecorder.start(100); // Collect data every 100ms
    console.log('[Record] MediaRecorder.start() called');
    
    // Verify it actually started
    if (mediaRecorder.state === 'recording') {
      console.log('[Record] ✅ MediaRecorder is recording!');
    } else {
      console.warn('[Record] ⚠️ MediaRecorder state after start:', mediaRecorder.state);
    }
    
    // Monitor for errors during recording
    setTimeout(() => {
      if (mediaRecorder.state === 'recording') {
        console.log('[Record] MediaRecorder still recording after 1 second');
        if (recordedChunks.length === 0) {
          console.warn('[Record] ⚠️ No data chunks received yet - this may be normal for very short recordings');
        }
      } else {
        console.error('[Record] ⚠️ MediaRecorder stopped unexpectedly! State:', mediaRecorder.state);
      }
    }, 1000);
    
  } catch (error) {
    console.error('[Record] Failed to start MediaRecorder:', error);
    throw new Error('Failed to start recording: ' + error.message);
  }
}

// Store video in IndexedDB for large files
async function storeVideoInIndexedDB(videoId, blob) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('CursorflyVideoStorage', 1);
    
    request.onerror = () => reject(new Error('Failed to open IndexedDB'));
    request.onsuccess = (event) => {
      const db = event.target.result;
      const transaction = db.transaction(['videos'], 'readwrite');
      const store = transaction.objectStore('videos');
      const putRequest = store.put({ id: videoId, blob: blob, timestamp: Date.now() });
      
      putRequest.onsuccess = () => resolve();
      putRequest.onerror = () => reject(new Error('Failed to store video in IndexedDB'));
    };
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('videos')) {
        db.createObjectStore('videos', { keyPath: 'id' });
      }
    };
  });
}

async function saveRecording(blob) {
  try {
    console.log('[Record] Saving recording...');
    console.log('[Record] Blob to save:', blob.size, 'bytes', `(${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
    
    // Validate blob
    if (!blob || blob.size === 0) {
      throw new Error('Cannot save empty blob');
    }
    
    // Get video dimensions
    let videoWidth = 1920;
    let videoHeight = 1080;
    
    if (mediaStream) {
      const videoTrack = mediaStream.getVideoTracks()[0];
      if (videoTrack) {
        const settings = videoTrack.getSettings();
        videoWidth = settings.width || 1920;
        videoHeight = settings.height || 1080;
      }
    }
    
    console.log('[Record] Video dimensions:', videoWidth, 'x', videoHeight);
    
    // Check if video is too large for message passing
    // Base64 encoding increases size by ~33%, so we need to account for that
    // Chrome's message limit is 64MB, so we use 40MB blob size threshold
    // 40MB blob * 1.33 = ~53MB base64, which is safely under 64MB limit
    const MAX_MESSAGE_SIZE = 40 * 1024 * 1024; // 40MB (will be ~53MB when base64 encoded)
    const useIndexedDB = blob.size > MAX_MESSAGE_SIZE;
    
    if (useIndexedDB) {
      console.log('[Record] Video is large (' + (blob.size / 1024 / 1024).toFixed(2) + ' MB), using IndexedDB for storage...');
      
      // Store video in IndexedDB and send reference
      const videoId = 'video_' + Date.now();
      await storeVideoInIndexedDB(videoId, blob);
      
      console.log('[Record] Video stored in IndexedDB with ID:', videoId);
      
      // Send reference to background
      const storeResponse = await chrome.runtime.sendMessage({
        action: 'storeVideoBlob',
        videoId: videoId, // Reference instead of data
        useIndexedDB: true,
        size: blob.size,
        width: videoWidth,
        height: videoHeight,
        cameraOverlayEnabled: hasCameraOverlay()
      });
      
      if (!storeResponse || !storeResponse.success) {
        throw new Error('Failed to store video reference in background: ' + (storeResponse?.error || 'Unknown error'));
      }
    } else {
      // Small video - use existing base64 method
      console.log('[Record] Converting blob to base64...');
      const reader = new FileReader();
      const blobData = await new Promise((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result;
          console.log('[Record] Base64 conversion complete, data URL length:', result.length);
          resolve(result);
        };
        reader.onerror = (error) => {
          console.error('[Record] FileReader error:', error);
          reject(new Error('Failed to convert blob to base64: ' + error));
        };
        reader.readAsDataURL(blob);
      });
      
      // Validate data URL
      if (!blobData || !blobData.startsWith('data:')) {
        throw new Error('Invalid data URL generated');
      }
      
      // Check if base64 data is too large (64MB limit for Chrome messages)
      const MAX_MESSAGE_SIZE_BYTES = 64 * 1024 * 1024; // 64MB in bytes
      if (blobData.length > MAX_MESSAGE_SIZE_BYTES) {
        console.log('[Record] Base64 data too large (' + (blobData.length / 1024 / 1024).toFixed(2) + ' MB), switching to IndexedDB...');
        
        // Fallback to IndexedDB
        const videoId = 'video_' + Date.now();
        await storeVideoInIndexedDB(videoId, blob);
        
        console.log('[Record] Video stored in IndexedDB with ID:', videoId);
        
        // Send reference to background
        const storeResponse = await chrome.runtime.sendMessage({
          action: 'storeVideoBlob',
          videoId: videoId,
          useIndexedDB: true,
          size: blob.size,
          width: videoWidth,
          height: videoHeight,
          cameraOverlayEnabled: hasCameraOverlay()
        });
        
        if (!storeResponse || !storeResponse.success) {
          throw new Error('Failed to store video reference in background: ' + (storeResponse?.error || 'Unknown error'));
        }
      } else {
        console.log('[Record] Sending video to background...');
        
        // Store in background
        const storeResponse = await chrome.runtime.sendMessage({
          action: 'storeVideoBlob',
          videoData: blobData,
          useIndexedDB: false,
          size: blob.size,
          width: videoWidth,
          height: videoHeight,
          cameraOverlayEnabled: hasCameraOverlay()
        });
        
        if (!storeResponse || !storeResponse.success) {
          throw new Error('Failed to store video in background: ' + (storeResponse?.error || 'Unknown error'));
        }
      }
    }
    
    console.log('[Record] ✅ Video stored successfully!');
    
    // Notify background that recording is complete
    await chrome.runtime.sendMessage({ action: 'recordingStopped' });
    
  } catch (error) {
    console.error('[Record] Error saving recording:', error);
    console.error('[Record] Error stack:', error.stack);
    alert('Failed to save recording: ' + (error.message || 'Unknown error') + '\n\nPlease try recording again.');
    throw error;
  }
}

// Stop Recording
async function stopRecording() {
  try {
    console.log('[Record] Stopping recording...');
    stopRecordingBtn.disabled = true;
    stopRecordingBtn.innerHTML = '<span class="btn-icon">⏳</span> Stopping...';

    clearInterval(timerInterval);
    isRecording = false;
    
    // Stop cursor tracking on target tab
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab) {
        await chrome.tabs.sendMessage(tabId, { action: 'stopTracking' });
        console.log('[Record] Cursor tracking stopped');
      }
    } catch (e) {
      // Ignore - tab might be closed or restricted
      console.log('[Record] Could not stop tracking (tab may be restricted)');
    }

    // Stop the MediaRecorder and wait for it to finish
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      console.log('[Record] Stopping MediaRecorder, current state:', mediaRecorder.state);
      
      // Wait for MediaRecorder to stop and process
      const recorderStopped = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.warn('[Record] MediaRecorder stop timeout after 10 seconds');
          resolve(false);
        }, 10000);
        
        const originalOnStop = mediaRecorder.onstop;
        mediaRecorder.onstop = async () => {
          clearTimeout(timeout);
          console.log('[Record] MediaRecorder onstop fired');
          if (originalOnStop) {
            await originalOnStop();
          }
          resolve(true);
        };
      });
      
      mediaRecorder.stop();
      
      // Wait for MediaRecorder to finish processing
      const stopped = await recorderStopped;
      if (!stopped) {
        console.warn('[Record] MediaRecorder may not have stopped properly');
      }
      
      // Give it a moment to finalize
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Now stop all tracks (after MediaRecorder has finished)
    if (mediaStream) {
      console.log('[Record] Stopping media stream tracks...');
      mediaStream.getTracks().forEach(track => {
        track.stop();
        console.log('[Record] Stopped track:', track.kind, track.label);
      });
      mediaStream = null;
    }
    
    // Hide camera overlay
    if (cameraOverlay) {
      cameraOverlay.classList.remove('active');
      if (cameraOverlayVideo) {
        cameraOverlayVideo.srcObject = null;
      }
    }
    
    // Stop camera frame sender if it was active
    if (window.cameraFrameSender) {
      clearInterval(window.cameraFrameSender);
      window.cameraFrameSender = null;
    }
    
    // Clean up camera frame capture resources
    if (window.cameraFrameVideo) {
      window.cameraFrameVideo.pause();
      window.cameraFrameVideo.srcObject = null;
      window.cameraFrameVideo = null;
    }
    if (window.cameraFrameCanvas) {
      // Clear canvas
      if (window.cameraFrameCtx) {
        window.cameraFrameCtx.clearRect(0, 0, window.cameraFrameCanvas.width, window.cameraFrameCanvas.height);
      }
      window.cameraFrameCanvas = null;
      window.cameraFrameCtx = null;
    }
    
    // Stop optional camera / microphone streams
    if (cameraVideoStream || micStream) {
      console.log('[Record] Stopping optional camera/mic tracks...');
      resetOptionalMediaUI();
    }
    
    // Clean up MediaRecorder and chunks
    if (mediaRecorder) {
      mediaRecorder = null;
    }
    recordedChunks = [];

    // Wait for video to be ready
    console.log('[Record] Waiting for video data to be stored...');
    
    let dataReady = false;
    let attempts = 0;
    const maxAttempts = 50; // Increased timeout
    
    while (!dataReady && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 500));
      
      try {
        const checkResponse = await chrome.runtime.sendMessage({
          action: 'getRecordingData'
        });
        
        if (checkResponse && checkResponse.videoDataReady && checkResponse.videoData) {
          dataReady = true;
          debugLog('[Record] ✅ Video data ready!');
          debugLog('[Record] Video data size:', checkResponse.videoData.length, 'chars');
          // Cursor data points tracked
          openEditor();
          break;
        } else {
          console.log(`[Record] Waiting for video data... (attempt ${attempts + 1}/${maxAttempts})`);
          if (checkResponse) {
            console.log('[Record] Response status:', {
              videoDataReady: checkResponse.videoDataReady,
              hasVideoData: !!checkResponse.videoData,
              videoDataLength: checkResponse.videoData?.length || 0
            });
          }
        }
      } catch (e) {
        console.warn('[Record] Error checking data:', e);
      }
      
      attempts++;
    }
    
    if (!dataReady) {
      console.error('[Record] ⚠️ Timeout waiting for video data');
      const finalCheck = await chrome.runtime.sendMessage({ action: 'getRecordingData' });
      if (finalCheck && finalCheck.videoData) {
        console.log('[Record] Video data found on final check, opening editor');
        openEditor();
      } else {
        throw new Error('Recording did not complete. The video data was not saved. Please try recording again.');
      }
    }
    
  } catch (error) {
    console.error('[Record] Stop recording error:', error);
    alert('Error: ' + error.message);
    
    stopRecordingBtn.disabled = false;
    stopRecordingBtn.innerHTML = '<span class="btn-icon">⏹️</span> Stop Recording';
  }
}

// Open Editor
function openEditor() {
  console.log('[Record] Opening editor...');
  const editorUrl = chrome.runtime.getURL('editor.html');
  chrome.tabs.create({ url: editorUrl }, (tab) => {
    console.log('[Record] Editor opened in tab:', tab.id);
    // Close this recording page
    setTimeout(() => window.close(), 500);
  });
}

// Update Timer
function updateTimer() {
  const elapsed = Date.now() - startTime;
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  timer.textContent = `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

// Listen for recording stopped message (from extension icon click)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'recordingStopped') {
    console.log('[Record] Recording stopped notification received');
    if (isRecording) {
      stopRecording();
    }
  }
});

// Handle page visibility - show overlay when coming back to this tab during recording
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isRecording) {
    recordingOverlay.classList.add('active');
  }
});

// Handle page unload
window.addEventListener('beforeunload', () => {
  if (isRecording) {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
    }
  }
});
