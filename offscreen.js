/**
 * CursorFly Screen Recorder
 * Copyright (c) 2026 Anu S Pillai
 * GitHub: https://github.com/anugotta
 *
 * Licensed under the MIT License.
 */

// Offscreen document for handling MediaRecorder
// This is needed because service workers don't have access to getUserMedia/MediaRecorder

let mediaRecorder = null;
let recordedChunks = [];
let recordingStream = null;

console.log('Offscreen document loaded');

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Offscreen received message:', message.action);
  
  if (message.action === 'startRecording') {
    startRecording(message.streamId, message.audioStreamId, message.settings)
      .then(() => {
        console.log('Recording started successfully');
        sendResponse({ success: true });
      })
      .catch(error => {
        console.error('Failed to start recording:', error);
        sendResponse({ success: false, error: error.message || error.toString() });
      });
    return true; // Keep channel open
  }
  
  if (message.action === 'stopRecording') {
    stopRecording()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'pauseRecording') {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.pause();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Not recording' });
    }
  }
  
  if (message.action === 'resumeRecording') {
    if (mediaRecorder && mediaRecorder.state === 'paused') {
      mediaRecorder.resume();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Not paused' });
    }
  }
});

async function startRecording(streamId, audioStreamId, settings) {
  try {
    console.log('Starting recording with streamId:', streamId);
    console.log('Settings:', settings);
    
    // Get video constraints
    const height = parseInt(settings.quality);
    const width = Math.floor(height * 16 / 9);
    const frameRate = parseInt(settings.fps);
    
    console.log(`Resolution: ${width}x${height} @ ${frameRate}fps`);
    
    // Modern constraints format
    const constraints = {
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: streamId,
          maxWidth: width,
          maxHeight: height,
          maxFrameRate: frameRate
        }
      },
      audio: false
    };
    
    console.log('Getting user media...');
    
    // Get the screen stream
    try {
      recordingStream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log('Got video stream:', recordingStream.getVideoTracks().length, 'video tracks');
    } catch (error) {
      console.error('getUserMedia error:', error.name, error.message);
      throw new Error(`Failed to capture screen: ${error.message}`);
    }
    
    // Add audio track if provided from background (microphone)
    if (settings.recordMicrophone) {
      try {
        console.log('Getting microphone...');
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
          console.log('Added microphone track with quality settings:', {
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
            echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseSuppression,
            autoGainControl: settings.autoGainControl
          });
        }
      } catch (error) {
        console.warn('Could not capture microphone:', error);
      }
    }
    
    // Check which codecs are supported
    const supportedMimeTypes = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4'
    ];
    
    let selectedMimeType = supportedMimeTypes[0];
    for (const mimeType of supportedMimeTypes) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        selectedMimeType = mimeType;
        console.log('Using mime type:', mimeType);
        break;
      }
    }
    
    // Setup MediaRecorder
    const options = {
      mimeType: selectedMimeType,
      videoBitsPerSecond: getVideoBitrate(height)
    };
    
    console.log('Creating MediaRecorder with options:', options);
    
    try {
      mediaRecorder = new MediaRecorder(recordingStream, options);
    } catch (error) {
      console.error('MediaRecorder creation failed:', error);
      throw new Error(`MediaRecorder error: ${error.message}`);
    }
    
    recordedChunks = [];
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
        console.log('Data chunk received:', event.data.size, 'bytes');
      }
    };
    
    mediaRecorder.onstart = () => {
      console.log('MediaRecorder started');
    };
    
    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event.error);
    };
    
    mediaRecorder.onstop = async () => {
      console.log('MediaRecorder stopped, chunks:', recordedChunks.length);
      const blob = new Blob(recordedChunks, { type: selectedMimeType });
      console.log('Created blob:', blob.size, 'bytes');
      await saveRecording(blob);
      
      // Clean up
      if (recordingStream) {
        recordingStream.getTracks().forEach(track => {
          track.stop();
          console.log('Stopped track:', track.kind);
        });
      }
      
      // Notify background script
      chrome.runtime.sendMessage({ action: 'recordingStopped' });
    };
    
    mediaRecorder.start(100);
    console.log('MediaRecorder.start() called');
    
  } catch (error) {
    console.error('Error in offscreen recording:', error);
    console.error('Error stack:', error.stack);
    throw error;
  }
}

async function stopRecording() {
  console.log('Stopping recording, current state:', mediaRecorder?.state);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

async function saveRecording(blob) {
  try {
    console.log('Saving recording, blob size:', blob.size);
    
    // Create download URL
    const url = URL.createObjectURL(blob);
    
    // Generate filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `cursorfly-${timestamp}.webm`;
    
    console.log('Requesting download:', filename);
    
    // Send to background script to trigger download
    chrome.runtime.sendMessage({
      action: 'downloadRecording',
      url: url,
      filename: filename
    });
  } catch (error) {
    console.error('Error saving recording:', error);
  }
}

function getVideoBitrate(height) {
  const bitrate = {
    1080: 8000000, // 8 Mbps
    720: 5000000,  // 5 Mbps
    480: 2500000   // 2.5 Mbps
  }[height] || 5000000;
  
  console.log('Video bitrate:', bitrate);
  return bitrate;
}

// Log when document is ready
console.log('Offscreen document ready');
