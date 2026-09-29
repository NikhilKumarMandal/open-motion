/**
 * CursorFly Screen Recorder
 * Copyright (c) 2026 Anu S Pillai
 * GitHub: https://github.com/anugotta
 *
 * Licensed under the MIT License.
 */

// Recorder Script - Injected into the tab to handle MediaRecorder
// This runs in the tab context where the streamId is valid

// Prevent double injection
if (window.__SCREEN_RECORDER_INJECTED__) {
  console.log('[Recorder] Already injected, skipping');
  // Still need to listen for messages in case of re-injection
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startRecordingInTab' || 
        message.action === 'stopRecordingInTab' ||
        message.action === 'pauseRecordingInTab' ||
        message.action === 'resumeRecordingInTab') {
      console.log('[Recorder] Duplicate injection - message already handled');
      sendResponse({ success: false, error: 'Already injected' });
    }
  });
} else {
  window.__SCREEN_RECORDER_INJECTED__ = true;
  console.log('[Recorder] Script loaded');

let mediaRecorder = null;
let recordedChunks = [];
let recordingStream = null;
let recordingIndicator = null;

// Create visual recording indicator
function showRecordingIndicator() {
  if (recordingIndicator) return;
  
  recordingIndicator = document.createElement('div');
  recordingIndicator.id = 'screen-recorder-indicator';
  recordingIndicator.innerHTML = `
    <div style="
      position: fixed;
      top: 10px;
      right: 10px;
      background: rgba(220, 53, 69, 0.95);
      color: white;
      padding: 12px 20px;
      border-radius: 25px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 600;
      z-index: 999999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      display: flex;
      align-items: center;
      gap: 8px;
      animation: pulse 2s infinite;
    ">
      <span style="
        width: 10px;
        height: 10px;
        background: white;
        border-radius: 50%;
        display: inline-block;
        animation: blink 1s infinite;
      "></span>
      Recording...
    </div>
    <style>
      @keyframes blink {
        0%, 50% { opacity: 1; }
        51%, 100% { opacity: 0.3; }
      }
    </style>
  `;
  document.body.appendChild(recordingIndicator);
  console.log('[Recorder] Visual indicator added');
}

function hideRecordingIndicator() {
  if (recordingIndicator) {
    recordingIndicator.remove();
    recordingIndicator = null;
    console.log('[Recorder] Visual indicator removed');
  }
}

// Listen for messages to start recording
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Recorder] Received message:', message.action);
  
  if (message.action === 'startRecordingInTab') {
    startRecording(message.streamId, message.settings)
      .then(() => {
        console.log('[Recorder] Recording started successfully');
        sendResponse({ success: true });
      })
      .catch(error => {
        console.error('[Recorder] Failed to start recording:', error);
        sendResponse({ success: false, error: error.message || error.toString() });
      });
    return true;
  }
  
  if (message.action === 'stopRecordingInTab') {
    stopRecording()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'pauseRecordingInTab') {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.pause();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false });
    }
    return true;
  }
  
  if (message.action === 'resumeRecordingInTab') {
    if (mediaRecorder && mediaRecorder.state === 'paused') {
      mediaRecorder.resume();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false });
    }
    return true;
  }
});

async function startRecording(streamId, settings) {
  try {
    console.log('[Recorder] Starting recording with streamId:', streamId);
    console.log('[Recorder] Settings:', settings);
    
    // Quality presets - optimized for crisp, high-quality recordings
    // Higher bitrates ensure artifact-free, crisp videos
    const qualityPresets = {
      '4k': { width: 3840, height: 2160, bitrate: 50000000 }, // 50 Mbps for 4K
      '1440p': { width: 2560, height: 1440, bitrate: 30000000 }, // 30 Mbps for 1440p
      '1080p': { width: 1920, height: 1080, bitrate: 25000000 }, // 25 Mbps for 1080p (increased from 8Mbps)
      '720p': { width: 1280, height: 720, bitrate: 15000000 } // 15 Mbps for 720p
    };
    
    // Get quality setting (default to 1080p)
    const quality = settings.quality || '1080p';
    const preset = qualityPresets[quality] || qualityPresets['1080p'];
    // Default to 60fps for smoother videos, fallback to 30fps if not supported
    const frameRate = parseInt(settings.fps) || 60;
    
    console.log(`[Recorder] Quality: ${quality} - Resolution: ${preset.width}x${preset.height} @ ${frameRate}fps`);
    
    // Constraints for getUserMedia with desktopCapture streamId
    // Use high resolution capture
    const constraints = {
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: streamId,
          minWidth: preset.width,
          maxWidth: preset.width,
          minHeight: preset.height,
          maxHeight: preset.height,
          maxFrameRate: frameRate
        }
      },
      audio: false
    };
    
    console.log('[Recorder] Calling getUserMedia...');
    
    // Get the screen stream - THIS WORKS in tab context!
    try {
      recordingStream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log('[Recorder] Got video stream with', recordingStream.getVideoTracks().length, 'video track(s)');
    } catch (error) {
      console.error('[Recorder] getUserMedia failed:', error.name, error.message);
      throw new Error(`Failed to capture screen: ${error.message}`);
    }
    
    // Add microphone if requested
    if (settings.recordMicrophone) {
      try {
        console.log('[Recorder] Getting microphone...');
        // High-quality audio constraints for better microphone recording
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: { ideal: 48000, min: 44100 }, // High-quality sample rate (48kHz ideal, 44.1kHz minimum)
            channelCount: { ideal: 2, min: 1 } // Stereo if available, mono as fallback
          },
          video: false
        });
        const micTrack = micStream.getAudioTracks()[0];
        if (micTrack) {
          recordingStream.addTrack(micTrack);
          const settings = micTrack.getSettings();
          console.log('[Recorder] Added microphone track with quality settings:', {
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
            echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseSuppression,
            autoGainControl: settings.autoGainControl
          });
        }
      } catch (error) {
        console.warn('[Recorder] Could not capture microphone:', error);
      }
    }
    
    // Detect supported codecs with cross-platform fallbacks
    // VP9 is preferred for quality, VP8 for compatibility, WebM as fallback
    // Order matters - try best quality first, then fallback to compatible options
    const codecs = [
      'video/webm;codecs=vp9', // Best quality, widely supported
      'video/webm;codecs=vp8', // Good quality, excellent compatibility
      'video/webm', // Basic WebM fallback
      'video/mp4;codecs=avc1.42E01E', // H.264 for maximum compatibility (Windows/Linux)
      'video/mp4' // Basic MP4 fallback
    ];
    
    let selectedCodec = codecs[codecs.length - 1]; // Default to last fallback
    for (const codec of codecs) {
      if (MediaRecorder.isTypeSupported(codec)) {
        selectedCodec = codec;
        console.log('[Recorder] Using codec:', codec);
        break;
      }
    }
    
    // Setup MediaRecorder with high bitrate for quality
    const options = {
      mimeType: selectedCodec,
      videoBitsPerSecond: preset.bitrate
    };
    
    console.log('[Recorder] Creating MediaRecorder...');
    mediaRecorder = new MediaRecorder(recordingStream, options);
    recordedChunks = [];
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
        console.log('[Recorder] Data chunk:', event.data.size, 'bytes (total chunks:', recordedChunks.length + ')');
      }
    };
    
    mediaRecorder.onstart = () => {
      console.log('[Recorder] MediaRecorder started!');
      showRecordingIndicator();
    };
    
    mediaRecorder.onerror = (event) => {
      console.error('[Recorder] MediaRecorder error:', event.error);
    };
    
    mediaRecorder.onstop = async () => {
      console.log('[Recorder] MediaRecorder stopped. Total chunks:', recordedChunks.length);
      hideRecordingIndicator();
      
      const blob = new Blob(recordedChunks, { type: selectedCodec });
      console.log('[Recorder] Created blob:', blob.size, 'bytes');
      
      await saveRecording(blob);
      
      // Clean up
      if (recordingStream) {
        recordingStream.getTracks().forEach(track => {
          track.stop();
          console.log('[Recorder] Stopped track:', track.kind);
        });
      }
      
      // Note: saveRecording() above will send the 'recordingStopped' notification after storing video
    };
    
    // Start recording!
    mediaRecorder.start(100); // Collect data every 100ms
    console.log('[Recorder] MediaRecorder.start() called');
    
  } catch (error) {
    console.error('[Recorder] Error in startRecording:', error);
    console.error('[Recorder] Error stack:', error.stack);
    throw error;
  }
}

async function stopRecording() {
  console.log('[Recorder] Stopping recording, state:', mediaRecorder?.state);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    console.warn('[Recorder] MediaRecorder not active, cleaning up anyway');
    hideRecordingIndicator();
  }
}

async function saveRecording(blob) {
  try {
    console.log('[Recorder] Saving recording, blob size:', blob.size, 'bytes (', (blob.size / 1024 / 1024).toFixed(2), 'MB)');
    
    // Get video dimensions from stream FIRST (before stream might close)
    let videoWidth = 1280;
    let videoHeight = 720;
    
    try {
      const videoTrack = recordingStream.getVideoTracks()[0];
      if (videoTrack) {
        const trackSettings = videoTrack.getSettings();
        videoWidth = trackSettings.width || 1280;
        videoHeight = trackSettings.height || 720;
      }
    } catch (e) {
      console.warn('[Recorder] Could not get track settings:', e);
    }
    
    console.log('[Recorder] Video dimensions:', videoWidth, 'x', videoHeight);
    
    // Convert blob to base64 for storage
    console.log('[Recorder] Converting blob to base64...');
    const startTime = Date.now();
    
    const reader = new FileReader();
    const blobData = await new Promise((resolve, reject) => {
      reader.onload = () => {
        console.log('[Recorder] Base64 conversion complete, took', Date.now() - startTime, 'ms');
        resolve(reader.result);
      };
      reader.onerror = (e) => {
        console.error('[Recorder] FileReader error:', e);
        reject(e);
      };
      reader.readAsDataURL(blob);
    });
    
    console.log('[Recorder] Base64 data length:', blobData.length, 'chars');
    console.log('[Recorder] Sending video data to background...');
    
    // Store in background
    try {
      await chrome.runtime.sendMessage({
        action: 'storeVideoBlob',
        videoData: blobData,
        size: blob.size,
        width: videoWidth,
        height: videoHeight
      });
      console.log('[Recorder] ✅ Video stored in background successfully!');
    } catch (sendError) {
      console.error('[Recorder] Failed to send video to background:', sendError);
      // If message is too large, try to save locally as fallback
      if (sendError.message && sendError.message.includes('message length')) {
        console.log('[Recorder] Video too large for messaging, saving locally...');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cursorfly-${Date.now()}.webm`;
        a.click();
        URL.revokeObjectURL(url);
        throw new Error('Video too large - saved directly to downloads');
      }
      throw sendError;
    }
    
    // Now notify background that recording is complete
    console.log('[Recorder] Notifying background that recording is complete...');
    await chrome.runtime.sendMessage({
      action: 'recordingStopped'
    });
    
    console.log('[Recorder] ✅ All done! Video and notification sent.');
    
  } catch (error) {
    console.error('[Recorder] Error saving recording:', error);
    
    // Still notify background even if save failed
    try {
      await chrome.runtime.sendMessage({
        action: 'recordingStopped'
      });
    } catch (e) {
      console.error('[Recorder] Failed to notify background:', e);
    }
  }
}

function getVideoBitrate(height) {
  const bitrates = {
    1080: 8000000,
    720: 5000000,
    480: 2500000
  };
  return bitrates[height] || 5000000;
}

console.log('[Recorder] Script ready');

} // End of injection guard
