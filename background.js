/**
 * CursorFly Screen Recorder
 * Copyright (c) 2026 Anu S Pillai
 * GitHub: https://github.com/anugotta
 *
 * Licensed under the MIT License.
 */

// Background Service Worker
let isRecording = false;
let isPaused = false;
let cursorData = [];
let recordingStartTime = 0;
let recordingTabId = null;
let storedVideoData = null;
let videoStoredInIndexedDB = false;
let recordedVideoWidth = 0;
let recordedVideoHeight = 0;
let videoDataReady = false;
let cursorDataReady = false;
let cameraOverlayEnabled = false;
let cameraFrameData = null; // Store latest camera frame from record.html
let previousRecordingTabId = null; // Track previous tab to remove overlay when switching

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

// Update extension icon to show recording state
async function updateRecordingIcon(recording, paused = false) {
  try {
    if (recording) {
      if (paused) {
        // Show paused state
        await chrome.action.setBadgeText({ text: '⏸' });
        await chrome.action.setBadgeBackgroundColor({ color: '#ffa500' }); // Orange
        await chrome.action.setTitle({ title: 'Cursorfly - Recording paused. Click to stop recording.' });
      } else {
        // Show active recording
        await chrome.action.setBadgeText({ text: '●' });
        await chrome.action.setBadgeBackgroundColor({ color: '#dc3545' }); // Red
        await chrome.action.setTitle({ title: 'Cursorfly - Recording in progress. Click to stop recording.' });
      }
    } else {
      // Clear badge and reset title
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: 'Cursorfly - Screen Recorder with Auto Pan Zoom' });
    }
  } catch (error) {
    console.warn('[Background] Could not update icon:', error);
  }
}

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  
  // Handle camera frame updates from record.html
  if (message.action === 'updateCameraFrame') {
    // Store the latest camera frame from record.html
    cameraFrameData = message.frameData;
    // Broadcast to recording tab only if recording is active and tab ID is set
    if (isRecording && cameraOverlayEnabled && recordingTabId && cameraFrameData) {
      chrome.tabs.sendMessage(recordingTabId, {
        action: 'updateCameraFrame',
        frameData: cameraFrameData
      }).then(() => {
      }).catch((error) => {
        // Only log errors if recording is still active (avoid spam when recording stops)
        if (isRecording && cameraOverlayEnabled) {
        }
      });
    }
    sendResponse({ success: true });
    return true;
  }
  
  // Handle requests for camera frame
  if (message.action === 'getCameraFrame') {
    sendResponse({ frameData: cameraFrameData });
    return true;
  }
  
  // New flow: Record page handles the stream, just need to track state
  if (message.action === 'startRecordingWithMediaStream') {
    console.log('[Background] startRecordingWithMediaStream called');
    console.log('[Background] tabId:', message.tabId);
    
    // Update state
    isRecording = true;
    isPaused = false;
    cursorData = [];
    recordingStartTime = Date.now();
    videoDataReady = false;
    cursorDataReady = false;
    storedVideoData = null;
    videoStoredInIndexedDB = false;
    cameraOverlayEnabled = message.cameraOverlayEnabled || false;
    previousRecordingTabId = recordingTabId; // Store previous tab before updating
    recordingTabId = message.tabId;
    
    
    chrome.storage.local.set({ isRecording: true, isPaused: false, cameraOverlayEnabled: cameraOverlayEnabled });
    
    // Update icon to show recording state
    updateRecordingIcon(true, false);
    
    // Inject camera overlay into the recording tab only if camera is enabled
    // Note: Camera/microphone permissions are handled by getUserMedia() in the injected script
    // We don't need to check extension permissions - the browser handles it per-tab
    if (cameraOverlayEnabled) {
      // Remove overlay from previous tab if it exists
      if (previousRecordingTabId && previousRecordingTabId !== recordingTabId) {
        removeCameraOverlayFromTab(previousRecordingTabId);
      }
      
      
      // Inject immediately (no delay)
      injectCameraOverlayToRecordingTab(recordingTabId);
      
      // Send the latest frame immediately and repeatedly until confirmed (in case frames were sent before recordingTabId was set)
      if (cameraFrameData) {
        let attempts = 0;
        const maxAttempts = 10;
        const sendLatestFrame = () => {
          if (attempts < maxAttempts && isRecording && cameraOverlayEnabled && recordingTabId) {
            chrome.tabs.sendMessage(recordingTabId, {
              action: 'updateCameraFrame',
              frameData: cameraFrameData
            }).then(() => {
              // Success - frame sent
            }).catch(() => {
              // Tab might not be ready yet, retry
              attempts++;
              setTimeout(sendLatestFrame, 200);
            });
          }
        };
        // Start sending after a short delay to ensure overlay is injected
        setTimeout(sendLatestFrame, 300);
      }
    } else {
    }
    
    sendResponse({ success: true });
    return true;
  }
  
  // Update recording start time to sync with MediaRecorder start
  if (message.action === 'syncRecordingStartTime') {
    console.log('[Background] Syncing recording start time');
    // Clear any cursor data collected before MediaRecorder started
    // This ensures cursor timestamps align with video timestamps
    const oldCursorData = cursorData.length;
    cursorData = [];
    recordingStartTime = Date.now();
    console.log('[Background] Recording start time synced, cleared', oldCursorData, 'early cursor data points');
    sendResponse({ success: true, newStartTime: recordingStartTime });
    return true;
  }
  
  // Legacy: Start recording with desktopCapture
  if (message.action === 'startRecording') {
    startRecording(message.tabId, message.settings)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'stopRecording') {
    stopRecording()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'pauseRecording') {
    pauseRecording()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'resumeRecording') {
    resumeRecording()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'cursorMove') {
    if (!isRecording) {
      console.log('[Background] Ignoring cursor move - not recording');
      sendResponse({ success: false, error: 'Not recording' });
      return true;
    }
    
    if (isPaused) {
      sendResponse({ success: false, error: 'Recording paused' });
      return true;
    }
    
    // Store cursor position data with normalized coordinates
    const data = {
      x: message.x,
      y: message.y,
      normalizedX: message.normalizedX,
      normalizedY: message.normalizedY,
      viewportWidth: message.viewportWidth,
      viewportHeight: message.viewportHeight,
      timestamp: Date.now() - recordingStartTime,
      type: message.type,
      key: message.key,
      elementInfo: message.elementInfo
    };
    
    cursorData.push(data);
    
    if (message.type === 'click' || message.type === 'doubleclick') {
      console.log('[Background] 🖱️ Click #' + cursorData.filter(d => d.type === 'click').length + ' stored:', 
                  'x:', data.x, 'y:', data.y,
                  'normalized:', data.normalizedX?.toFixed(3), data.normalizedY?.toFixed(3),
                  'timestamp:', data.timestamp);
    }
    
    sendResponse({ success: true, cursorDataLength: cursorData.length });
    return true;
  }
  
  if (message.action === 'recordingStopped') {
    console.log('[Background] Recording stopped, cursor data length:', cursorData.length);
    
    isRecording = false;
    isPaused = false;
    const tabToCleanup = recordingTabId; // Store before clearing
    const previousTabToCleanup = previousRecordingTabId; // Store previous tab too
    recordingTabId = null;
    previousRecordingTabId = null;
    
    chrome.storage.local.set({ isRecording: false, isPaused: false, cameraOverlayEnabled: false });
    
    // Remove camera overlay from all tabs and specifically from recording tab
    // Use Promise.all to ensure both complete
    Promise.all([
      removeCameraOverlayFromAllTabs(),
      tabToCleanup ? removeCameraOverlayFromTab(tabToCleanup) : Promise.resolve(),
      previousTabToCleanup ? removeCameraOverlayFromTab(previousTabToCleanup) : Promise.resolve()
    ]).then(() => {
    }).catch((error) => {
      console.warn('[Background] Error during overlay cleanup:', error);
    });
    
    // Update icon to clear recording state
    updateRecordingIcon(false);
    
    saveCursorData();
    cursorDataReady = true;
    
    console.log('[Background] ✅ Recording stopped. Video ready:', videoDataReady, 'Cursor ready:', cursorDataReady);
    
    sendResponse({ success: true });
    return true; // Keep channel open for async operations
  }
  
  if (message.action === 'storeVideoBlob') {
    console.log('[Background] Storing video blob, size:', message.size);
    console.log('[Background] Video dimensions:', message.width, 'x', message.height);
    
    if (message.useIndexedDB && message.videoId) {
      // Large video stored in IndexedDB - store reference
      storedVideoData = message.videoId; // Store ID as reference
      videoStoredInIndexedDB = true;
      console.log('[Background] Video stored in IndexedDB with ID:', message.videoId);
    } else {
      // Small video - store data directly
      storedVideoData = message.videoData;
      videoStoredInIndexedDB = false;
    }
    
    recordedVideoWidth = message.width || 1280;
    recordedVideoHeight = message.height || 720;
    cameraOverlayEnabled = message.cameraOverlayEnabled || false;
    videoDataReady = true;
    console.log('[Background] ✅ Video data stored!');
    console.log('[Background] Camera overlay enabled:', cameraOverlayEnabled);
    sendResponse({ success: true });
    return true;
  }
  
  if (message.action === 'getRecordingData') {
    const clicks = cursorData.filter(d => d.type === 'click' || d.type === 'doubleclick');
    console.log('[Background] getRecordingData called');
    console.log('[Background] - Video ready:', videoDataReady);
    console.log('[Background] - Cursor data points:', cursorData.length);
    console.log('[Background] - Click events:', clicks.length);
    
    
    if (clicks.length > 0) {
      console.log('[Background] - First click:', clicks[0]);
      console.log('[Background] - Last click:', clicks[clicks.length - 1]);
    }
    
    sendResponse({
      success: true,
      cursorData: cursorData,
      videoData: storedVideoData,
      videoWidth: recordedVideoWidth,
      videoHeight: recordedVideoHeight,
      videoDataReady: videoDataReady,
      cursorDataReady: cursorDataReady,
      cameraOverlayEnabled: cameraOverlayEnabled,
      videoStoredInIndexedDB: videoStoredInIndexedDB // Flag to indicate IndexedDB storage
    });
    
    return true;
  }
  
  if (message.action === 'getRecordingStatus') {
    sendResponse({
      isRecording: isRecording,
      isPaused: isPaused
    });
    return true;
  }
  
  // Handle navigation notification from content script
  if (message.action === 'pageNavigated' && isRecording && sender.tab?.id === recordingTabId) {
    console.log('[Background] Page navigation detected from content script');
    // The tab.onUpdated listener will handle re-injection, but we can also do it here
    reinjectContentScript(sender.tab.id).catch(() => {});
    sendResponse({ success: true });
    return true;
  }
  
  // Handle ping from content script
  if (message.action === 'ping') {
    sendResponse({ success: true });
    return true;
  }
});

// Legacy: Start recording using desktopCapture
async function startRecording(tabId, settings) {
  try {
    console.log('[Background] startRecording called with tabId:', tabId);
    
    if (isRecording) {
      throw new Error('Recording already in progress');
    }
    
    const tab = await chrome.tabs.get(tabId);
    console.log('[Background] Got tab:', tab.id, tab.url);
    
    if (isUnsupportedWebsite(tab.url)) {
      throw new Error('Cannot record from Chrome system pages.');
    }
    
    console.log('[Background] Showing screen picker...');
    const streamId = await new Promise((resolve, reject) => {
      chrome.desktopCapture.chooseDesktopMedia(
        ['screen', 'window', 'tab'],
        tab,
        (streamId) => {
          if (!streamId) {
            reject(new Error('User cancelled screen capture'));
            return;
          }
          resolve(streamId);
        }
      );
    });
    
    if (!streamId) {
      throw new Error('No stream ID received');
    }
    
    console.log('[Background] Got streamId:', streamId);
    
    recordingTabId = tabId;
    
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['recorder.js']
      });
      console.log('[Background] Recorder script injected');
    } catch (error) {
      console.error('[Background] Failed to inject recorder script:', error);
      throw new Error('Failed to start recording: ' + error.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'startRecordingInTab',
      streamId: streamId,
      settings: settings
    });
    
    if (!response || !response.success) {
      throw new Error(response?.error || 'Failed to start recording in tab');
    }
    
    isRecording = true;
    isPaused = false;
    cursorData = [];
    recordingStartTime = Date.now();
    videoDataReady = false;
    cursorDataReady = false;
    storedVideoData = null;
    videoStoredInIndexedDB = false;
    
    await chrome.storage.local.set({ isRecording: true, isPaused: false });
    
    // Update icon to show recording state
    updateRecordingIcon(true, false);
    
    if (settings.trackCursor) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['content.js']
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        await chrome.tabs.sendMessage(tabId, { action: 'startTracking' });
        console.log('[Background] Cursor tracking enabled');
      } catch (error) {
        console.warn('[Background] Could not enable cursor tracking:', error);
      }
    }
    
    return { success: true };
  } catch (error) {
    console.error('[Background] Error starting recording:', error);
    return { success: false, error: error.message };
  }
}

async function stopRecording() {
  try {
    console.log('[Background] Stopping recording...');
    
    if (!isRecording) {
      return { success: false, error: 'No active recording' };
    }
    
    if (recordingTabId) {
      try {
        const tab = await chrome.tabs.get(recordingTabId).catch(() => null);
        
        if (tab) {
          await chrome.tabs.sendMessage(recordingTabId, {
            action: 'stopRecordingInTab'
          });
          console.log('[Background] Stop message sent');
        } else {
          await handleRecordingStoppedLocally();
        }
      } catch (error) {
        console.warn('[Background] Could not communicate with tab:', error.message);
        await handleRecordingStoppedLocally();
      }
    } else {
      await handleRecordingStoppedLocally();
    }
    
    return { success: true };
  } catch (error) {
    console.error('[Background] Error stopping recording:', error);
    await handleRecordingStoppedLocally();
    return { success: true };
  }
}

async function handleRecordingStoppedLocally() {
  console.log('[Background] Handling recording stop locally');
  
  if (cursorData.length > 0) {
    await saveCursorData();
  }
  
  isRecording = false;
  isPaused = false;
  const tabToCleanup = recordingTabId; // Store before clearing
  const previousTabToCleanup = previousRecordingTabId; // Store previous tab too
  recordingTabId = null;
  previousRecordingTabId = null;
  
  await chrome.storage.local.set({ isRecording: false, isPaused: false, cameraOverlayEnabled: false });
  
  // Remove camera overlay from all tabs and specifically from recording tab
  await Promise.all([
    removeCameraOverlayFromAllTabs(),
    tabToCleanup ? removeCameraOverlayFromTab(tabToCleanup) : Promise.resolve(),
    previousTabToCleanup ? removeCameraOverlayFromTab(previousTabToCleanup) : Promise.resolve()
  ]).catch((error) => {
    console.warn('[Background] Error during overlay cleanup:', error);
  });
  
  
  // Update icon to clear recording state
  updateRecordingIcon(false);
}

async function pauseRecording() {
  if (isRecording && !isPaused && recordingTabId) {
    try {
      await chrome.tabs.sendMessage(recordingTabId, { action: 'pauseRecordingInTab' });
      isPaused = true;
      await chrome.storage.local.set({ isPaused: true });
      // Update icon to show paused state
      updateRecordingIcon(true, true);
    } catch (error) {
      isPaused = true;
      await chrome.storage.local.set({ isPaused: true });
      // Update icon to show paused state
      updateRecordingIcon(true, true);
    }
  }
}

async function resumeRecording() {
  if (isRecording && isPaused && recordingTabId) {
    try {
      await chrome.tabs.sendMessage(recordingTabId, { action: 'resumeRecordingInTab' });
      isPaused = false;
      await chrome.storage.local.set({ isPaused: false });
      // Update icon to show active recording state
      updateRecordingIcon(true, false);
    } catch (error) {
      isPaused = false;
      await chrome.storage.local.set({ isPaused: false });
      // Update icon to show active recording state
      updateRecordingIcon(true, false);
    }
  }
}

async function saveCursorData() {
  console.log('[Background] Cursor data ready for editor, length:', cursorData.length);
}

// Inject camera overlay into the recording tab only
async function injectCameraOverlayToRecordingTab(tabId) {
  try {
    
    if (!tabId) {
      console.log('[Background] Invalid tab ID:', tabId);
      return;
    }
    
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      console.log('[Background] Recording tab not found:', tabId);
      return;
    }
    
    
    // Skip chrome:// and extension pages
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://'))) {
      console.log('[Background] Cannot inject camera overlay into restricted page:', tab.url);
      return;
    }
    
    // Retry injection with minimal delays to ensure page is ready
    let injected = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Minimal wait - only on retries
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        // Check if tab is still valid
        const currentTab = await chrome.tabs.get(tabId).catch(() => null);
        if (!currentTab) {
          console.log('[Background] Tab no longer exists:', tabId);
          return;
        }
        
        
        // Inject content script to show camera overlay
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: injectCameraOverlayScript,
          args: []
        });
        
        console.log('[Background] Camera overlay injected into recording tab:', tabId, '(attempt', attempt + 1 + ')');
        injected = true;
        
        
        break;
      } catch (error) {
        console.warn('[Background] Camera overlay injection attempt', attempt + 1, 'failed:', error.message);
        if (attempt === 2) {
        }
      }
    }
    
    if (injected) {
      // Listen for tab updates (navigation) to re-inject overlay (only add once)
      if (!chrome.tabs.onUpdated.hasListener(handleRecordingTabUpdateForCameraOverlay)) {
        chrome.tabs.onUpdated.addListener(handleRecordingTabUpdateForCameraOverlay);
      }
    }
  } catch (error) {
    console.error('[Background] Error injecting camera overlay:', error);
  }
}

// Handle recording tab updates (navigation) for camera overlay
async function handleRecordingTabUpdateForCameraOverlay(tabId, changeInfo, tab) {
  
  if (!isRecording || !cameraOverlayEnabled || tabId !== recordingTabId) {
    return;
  }
  if (changeInfo.status !== 'complete') return;
  
  // Skip chrome:// and extension pages
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://'))) {
    return;
  }
  
  try {
    // Check if overlay already exists
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => !!document.getElementById('cursorfly-camera-overlay')
    });
    
    if (!results[0]?.result) {
      // Inject immediately (no delay)
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: injectCameraOverlayScript,
        args: []
      });
      console.log('[Background] Camera overlay re-injected after navigation in recording tab:', tabId);
      
      // Send latest frame immediately after re-injection
      if (cameraFrameData) {
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, {
            action: 'updateCameraFrame',
            frameData: cameraFrameData
          }).catch(() => {
            // Tab might not be ready yet, that's okay - periodic requests will handle it
          });
        }, 300);
      }
    }
  } catch (error) {
    console.log('[Background] Could not re-inject camera overlay after navigation:', error.message);
  }
}

// Function to inject camera overlay (runs in page context)
function injectCameraOverlayScript() {
  try {
    
    // Check if overlay already exists
    if (document.getElementById('cursorfly-camera-overlay')) {
      console.log('[CameraOverlay] Overlay already exists');
      return;
    }
    
    // Wait for body to be ready
    if (!document.body) {
      console.warn('[CameraOverlay] Document body not ready, waiting...');
      setTimeout(injectCameraOverlayScript, 100);
      return;
    }
    
    // Create overlay container
    const overlay = document.createElement('div');
    overlay.id = 'cursorfly-camera-overlay';
    overlay.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 160px;
      height: 160px;
      border-radius: 50%;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      border: 3px solid rgba(255, 255, 255, 0.4);
      z-index: 2147483647;
      background: #000;
      pointer-events: none;
      transition: opacity 0.2s ease-in-out;
      opacity: 1;
    `;
    
    // Use an img element instead of video - we'll update it with frames from record.html
    const img = document.createElement('img');
    img.id = 'cursorfly-camera-image';
    img.style.cssText = `
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform: scaleX(-1);
      image-rendering: -webkit-optimize-contrast;
      image-rendering: crisp-edges;
    `;
    
    // Handle image load errors
    img.onerror = () => {
      console.warn('[CameraOverlay] Image load error, will retry on next frame');
    };
    
    overlay.appendChild(img);
    document.body.appendChild(overlay);
    
    // Track last frame to avoid unnecessary updates and ensure fresh frames
    let lastFrameData = null;
    
    
    console.log('[CameraOverlay] Overlay created and appended to body');
    
    // Listen for camera frame updates from background script
    // Store listener reference for cleanup (prevent duplicate listeners)
    if (window.__cameraOverlayMessageListener) {
      chrome.runtime.onMessage.removeListener(window.__cameraOverlayMessageListener);
    }
    
    
    const messageListener = (message, sender, sendResponse) => {
      
      if (message.action === 'updateCameraFrame' && message.frameData) {
        // Only update if frame data has changed (avoid unnecessary updates)
        if (lastFrameData !== message.frameData) {
          lastFrameData = message.frameData;
          
          // Force image reload by clearing src first, then setting new src
          // This ensures the browser always loads the new frame
          img.src = '';
          
          // Use requestAnimationFrame to ensure DOM update happens before setting new src
          requestAnimationFrame(() => {
            img.src = message.frameData;
          });
          
          console.log('[CameraOverlay] Frame updated');
        }
      }
      return true;
    };
    
    window.__cameraOverlayMessageListener = messageListener;
    chrome.runtime.onMessage.addListener(messageListener);
    
    // Request initial frame from background script and set up periodic frame requests
    const requestFrame = () => {
      chrome.runtime.sendMessage({ action: 'getCameraFrame' }, (response) => {
        // Check for errors
        if (chrome.runtime.lastError) {
          // Silently fail - frames will come via message listener
          return;
        }
        
        if (response && response.frameData) {
          // Always update if we have frame data (periodic requests ensure fresh frames)
          // Don't check lastFrameData here - let the message listener handle deduplication
          // This ensures frames are always fresh even if message listener fails
          img.src = '';
          requestAnimationFrame(() => {
            img.src = response.frameData;
            lastFrameData = response.frameData; // Update tracking
            console.log('[CameraOverlay] Frame updated from periodic request');
          });
        }
      });
    };
    
    // Request initial frame immediately
    requestFrame();
    
    // Also set up periodic requests as fallback (every 100ms) in case message listener fails
    // This ensures frames are always updated even if message listener has issues
    const frameRequestInterval = setInterval(() => {
      const overlay = document.getElementById('cursorfly-camera-overlay');
      if (overlay) {
        requestFrame();
      } else {
        clearInterval(frameRequestInterval);
        window.__cameraOverlayFrameRequestInterval = null;
      }
    }, 100); // Increased frequency for smoother updates
    
    // Store interval for cleanup
    window.__cameraOverlayFrameRequestInterval = frameRequestInterval;
  } catch (error) {
    console.error('[CameraOverlay] Error in injection script:', error);
  }
}


// Remove camera overlay from a specific tab
async function removeCameraOverlayFromTab(tabId) {
  if (!tabId) return;
  
  try {
    
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        // Remove message listener to prevent memory leaks
        if (window.__cameraOverlayMessageListener) {
          try {
            chrome.runtime.onMessage.removeListener(window.__cameraOverlayMessageListener);
          } catch (e) {
            // Ignore errors
          }
          window.__cameraOverlayMessageListener = null;
        }
        
        // Clear frame request interval
        if (window.__cameraOverlayFrameRequestInterval) {
          clearInterval(window.__cameraOverlayFrameRequestInterval);
          window.__cameraOverlayFrameRequestInterval = null;
        }
        
        // Remove overlay immediately (no fade-out delay to ensure cleanup)
        const overlay = document.getElementById('cursorfly-camera-overlay');
        if (overlay) {
          const img = document.getElementById('cursorfly-camera-image');
          if (img) {
            img.src = '';
            img.onerror = null; // Remove error handler
          }
          overlay.remove();
          console.log('[CameraOverlay] Overlay removed from tab');
        }
        
        // Also clear any stored frame data
        if (window.__lastFrameData) {
          window.__lastFrameData = null;
        }
      }
    });
  } catch (error) {
    // Tab may not be scriptable or may have been closed
    console.log('[Background] Could not remove camera overlay from tab', tabId, ':', error.message);
  }
}

// Remove camera overlay from all tabs
async function removeCameraOverlayFromAllTabs() {
  try {
    
    const tabs = await chrome.tabs.query({});
    console.log('[Background] Removing camera overlay from', tabs.length, 'tabs');
    
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Remove message listener
            if (window.__cameraOverlayMessageListener) {
              try {
                chrome.runtime.onMessage.removeListener(window.__cameraOverlayMessageListener);
              } catch (e) {
                // Ignore errors
              }
              window.__cameraOverlayMessageListener = null;
            }
            
            // Clear frame request interval
            if (window.__cameraOverlayFrameRequestInterval) {
              clearInterval(window.__cameraOverlayFrameRequestInterval);
              window.__cameraOverlayFrameRequestInterval = null;
            }
            
            // Remove overlay immediately
            const overlay = document.getElementById('cursorfly-camera-overlay');
            if (overlay) {
              const img = document.getElementById('cursorfly-camera-image');
              if (img) {
                img.src = '';
                img.onerror = null;
              }
              overlay.remove();
              console.log('[CameraOverlay] Overlay removed from tab', tab.id);
            }
            
            // Clear stored frame data
            if (window.__lastFrameData) {
              window.__lastFrameData = null;
            }
          }
        });
      } catch (error) {
        // Some tabs may not be scriptable
        console.log('[Background] Could not remove camera overlay from tab', tab.id, ':', error.message);
      }
    }
    
    // Remove listener
    if (chrome.tabs.onUpdated.hasListener(handleRecordingTabUpdateForCameraOverlay)) {
      chrome.tabs.onUpdated.removeListener(handleRecordingTabUpdateForCameraOverlay);
    }
    
    // Reset state
    previousRecordingTabId = null;
  } catch (error) {
    console.error('[Background] Error removing camera overlay:', error);
  }
}

// Handle extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  console.log('[Background] Extension icon clicked');
  console.log('[Background] Current tab:', tab.id, tab.url);
  
  // If currently recording, stop
  if (isRecording) {
    console.log('[Background] Recording in progress, stopping...');
    
    // Notify the record page first (before stopping, so it can handle cleanup)
    const recordPageUrl = chrome.runtime.getURL('record.html');
    try {
      const allTabs = await chrome.tabs.query({});
      const recordTabs = allTabs.filter(t => t.url && t.url.startsWith(recordPageUrl));
      
      for (const recordTab of recordTabs) {
        try {
          await chrome.tabs.sendMessage(recordTab.id, { action: 'recordingStopped' });
          console.log('[Background] Notified record page tab:', recordTab.id);
        } catch (e) {
          console.log('[Background] Could not notify record tab:', e.message);
        }
      }
    } catch (e) {
      console.log('[Background] Could not find record tabs:', e.message);
    }
    
    // Stop recording
    await stopRecording();
    return;
  }
  
  // Check if we can access the current tab
  let targetTabId = tab.id;
  
  if (tab.url && isUnsupportedWebsite(tab.url)) {
    console.warn('[Background] Current tab is restricted:', tab.url);
    
    // Create a new regular tab
    const newTab = await chrome.tabs.create({ url: 'https://www.google.com', active: true });
    targetTabId = newTab.id;
    
    // Wait for it to load
    await new Promise(resolve => {
      const listener = (tabId, info) => {
        if (tabId === newTab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 5000);
    });
    
    console.log('[Background] New tab ready:', targetTabId);
  }
  
  // Open recording page
  const recordUrl = chrome.runtime.getURL(`record.html?tabId=${targetTabId}`);
  await chrome.tabs.create({ url: recordUrl, pinned: true });
});

// Function to re-inject content script into a tab
async function reinjectContentScript(tabId) {
  if (!isRecording || !tabId) {
    return;
  }
  
  try {
    const tab = await chrome.tabs.get(tabId);
    
    // Skip if it's an unsupported website
    if (isUnsupportedWebsite(tab.url)) {
      console.log('[Background] Skipping re-injection for unsupported website:', tab.url);
      return;
    }
    
    // Check if content script is already injected (by checking if we can send a message)
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      // If ping succeeds, script is already there, just start tracking
      console.log('[Background] Content script already present, starting tracking');
      await chrome.tabs.sendMessage(tabId, { action: 'startTracking' });
      return;
    } catch (e) {
      // Script not present, need to inject
      console.log('[Background] Content script not present, injecting...');
    }
    
    // Inject content script
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    });
    
    // Wait for script to load
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Start tracking
    await chrome.tabs.sendMessage(tabId, { action: 'startTracking' });
    console.log('[Background] ✅ Content script re-injected and tracking started on tab:', tabId);
  } catch (error) {
    console.warn('[Background] Failed to re-inject content script:', error.message);
  }
}

// Listen for tab updates (navigation, page loads)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only handle if we're recording and this is the recording tab
  if (!isRecording || tabId !== recordingTabId) {
    return;
  }
  
  // When a page finishes loading (status === 'complete'), re-inject content script and camera overlay
  if (changeInfo.status === 'complete' && tab.url) {
    console.log('[Background] Tab navigation detected, re-injecting content script:', tab.url);
    await reinjectContentScript(tabId);
    
    // Re-inject camera overlay if enabled (immediately, no delay)
    if (cameraOverlayEnabled) {
      handleRecordingTabUpdateForCameraOverlay(tabId, changeInfo, tab);
    }
  }
});

// Listen for tab activation (tab switches)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Only handle if we're recording
  if (!isRecording) {
    return;
  }
  
  const activeTabId = activeInfo.tabId;
  
  
  // If the active tab is the recording tab, ensure content script is injected
  if (activeTabId === recordingTabId) {
    console.log('[Background] Recording tab activated, ensuring content script is present');
    await reinjectContentScript(activeTabId);
    
      // Re-inject camera overlay if enabled (immediately, no delay)
      if (cameraOverlayEnabled) {
        injectCameraOverlayToRecordingTab(activeTabId);
        
        // Send latest frame immediately after injection
        if (cameraFrameData) {
          setTimeout(() => {
            chrome.tabs.sendMessage(activeTabId, {
              action: 'updateCameraFrame',
              frameData: cameraFrameData
            }).catch(() => {
              // Tab might not be ready yet, that's okay - periodic requests will handle it
            });
          }, 300);
        }
      }
  } else {
    // User switched to a different tab during recording
    // Remove overlay from previous recording tab FIRST (for smooth transition)
    if (recordingTabId && recordingTabId !== activeTabId) {
      await removeCameraOverlayFromTab(recordingTabId);
    }
    
    // Update recordingTabId to continue tracking in the new tab
    console.log('[Background] Tab switched during recording, updating tracking to new tab:', activeTabId);
    previousRecordingTabId = recordingTabId;
    recordingTabId = activeTabId;
    await reinjectContentScript(activeTabId);
    
      // Re-inject camera overlay if enabled (immediately, no delay)
      if (cameraOverlayEnabled) {
        injectCameraOverlayToRecordingTab(activeTabId);
        
        // Send latest frame immediately after injection
        if (cameraFrameData) {
          setTimeout(() => {
            chrome.tabs.sendMessage(activeTabId, {
              action: 'updateCameraFrame',
              frameData: cameraFrameData
            }).catch(() => {
              // Tab might not be ready yet, that's okay - periodic requests will handle it
            });
          }, 300);
        }
      }
  }
});

// Initialize icon state on startup (in case extension was reloaded during recording)
(async () => {
  try {
    const result = await chrome.storage.local.get(['isRecording', 'isPaused']);
    if (result.isRecording) {
      isRecording = true;
      isPaused = result.isPaused || false;
      await updateRecordingIcon(true, isPaused);
    } else {
      await updateRecordingIcon(false);
    }
  } catch (error) {
    console.warn('[Background] Could not initialize icon state:', error);
    // Silently fail - icon will update when recording starts
  }
})();

