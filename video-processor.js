/**
 * CursorFly Screen Recorder
 * Copyright (c) 2026 Anu S Pillai
 * GitHub: https://github.com/anugotta
 *
 * Licensed under the MIT License.
 */

// Video Processor - Stable Reverted Version (MediaRecorder)
// This version uses standard MediaRecorder for maximum compatibility

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

class VideoProcessor {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.video = null;
    this.outputStream = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.analyzer = null;
    this.webcamVideo = null;
    this.webcamStream = null;
    
    // WebCodecs (disabled for stability)
    this.videoEncoder = null;
    this.useWebCodecs = false;
    this.encodedChunks = [];
    this.frameCount = 0;
    this.targetFps = 30;
    
    // Frame rate control for smooth playback
    this.minFps = 60; // Minimum target FPS for 1080p
    this.frameTiming = {
      lastFrameTime: 0,
      frameInterval: 1000 / 60, // ~16.67ms for 60fps
      actualFps: 0,
      frameCount: 0,
      lastFpsUpdate: 0
    };
    this.previousFrame = null; // For frame interpolation
    
    this.settings = {
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      backgroundImage: null,
      padding: 32,
      borderRadius: 12,
      trimStart: 0,
      trimEnd: 1,
      clickStyle: 'pressure',
      clickColor: '#10b981',
      clickSize: 40,
      showWebcam: false,
      webcamPosition: 'bottom-right',
      webcamSize: 'medium',
      webcamShape: 'circular',
      webcamFlip: false,
      showCursor: true,
      cursorSize: 20,
      sharpening: true,
      antiAlias: true,
      showBrowserFrame: true, // true = show browser UI, false = hide browser UI (auto-crop)
      showShadow: true // true = show shadow effect, false = hide shadow
    };
    
    this.backgroundImageElement = null; // Preloaded background image
    this.activeClicks = [];
    debugLog('[VideoProcessor] Initialized (Stable Mode)');
  }

  async processVideo(videoBlob, zoomSegments, onProgress = null, settings = null, cursorData = []) {
    debugLog('[VideoProcessor] Starting processing...');
    
    if (settings) {
      this.settings = { ...this.settings, ...settings };
      if (!this.settings.showBrowserFrame) {
        debugLog('[VideoProcessor] Browser UI will be auto-cropped from top');
      }
      
      // Preload background image if provided
      if (this.settings.backgroundImage && this.settings.backgroundImage.startsWith('data:image/')) {
        await this.preloadBackgroundImage(this.settings.backgroundImage);
      } else {
        this.backgroundImageElement = null;
      }
    }
    
    this.analyzer = new ZoomAnalyzer();
    this.cursorData = cursorData || [];

    return new Promise(async (resolve, reject) => {
      try {
        // Create video element with maximum quality settings
        this.video = document.createElement('video');
        this.video.src = URL.createObjectURL(videoBlob);
        // Keep unmuted - Web Audio API needs unmuted video to capture audio
        // We prevent playback by not connecting to audioContext.destination
        this.video.muted = false;
        this.video.preload = 'auto';
        // Ensure video loads at full resolution
        this.video.playsInline = true;
        this.video.setAttribute('playsinline', 'true');
        
        await new Promise((res, rej) => {
          this.video.onloadedmetadata = res;
          this.video.onerror = rej;
          setTimeout(() => rej(new Error('Video load timeout')), 10000);
        });

        const videoWidth = this.video.videoWidth;
        const videoHeight = this.video.videoHeight;
        let fullDuration = this.video.duration;
        
        debugLog('[VideoProcessor] Video loaded:', videoWidth, 'x', videoHeight);
        
        // Handle WebM Infinity duration - more robust detection
        if (!isFinite(fullDuration) || fullDuration <= 0 || fullDuration === Infinity) {
          debugLog('[VideoProcessor] Invalid duration detected:', fullDuration, '- finding real duration...');
          this.video.currentTime = Number.MAX_SAFE_INTEGER;
          await new Promise(res => {
            let resolved = false;
            const resolveOnce = (value) => {
              if (!resolved) {
                resolved = true;
                fullDuration = value;
                res();
              }
            };
            this.video.onseeked = () => {
              const detectedDuration = this.video.duration;
              if (isFinite(detectedDuration) && detectedDuration > 0) {
                resolveOnce(detectedDuration);
              }
            };
            setTimeout(() => {
              const detectedDuration = this.video.currentTime || this.video.duration;
              if (isFinite(detectedDuration) && detectedDuration > 0) {
                resolveOnce(detectedDuration);
              } else {
                resolveOnce(30); // Fallback
              }
            }, 2000);
          });
          this.video.currentTime = 0;
          await new Promise(res => {
            this.video.onseeked = res;
            setTimeout(res, 500);
          });
        }
        
        debugLog('[VideoProcessor] Detected video duration:', fullDuration, 'seconds');
        
        const trimStart = isFinite(this.settings.trimStart) ? this.settings.trimStart : 0;
        const trimEnd = isFinite(this.settings.trimEnd) ? this.settings.trimEnd : 1;
        const startTime = Math.max(0, fullDuration * trimStart);
        const endTime = Math.min(fullDuration, fullDuration * trimEnd);
        const duration = endTime - startTime;
        
        debugLog('[VideoProcessor] Trim settings - start:', trimStart, 'end:', trimEnd);
        debugLog('[VideoProcessor] Processing range:', startTime.toFixed(2), 'to', endTime.toFixed(2), 
                    'duration:', duration.toFixed(2), 'seconds');

        const padding = this.settings.padding;
        let outputVideoWidth = this.settings.outputWidth || videoWidth;
        let outputVideoHeight = this.settings.outputHeight || videoHeight;

        // Even dimensions: H.264 / VP9 encoders are happiest with even width & height (fewer glitches)
        const snapEven = (n) => {
          const v = Math.max(2, Math.round(Number(n) || 0));
          return v - (v % 2);
        };
        outputVideoWidth = snapEven(outputVideoWidth);
        outputVideoHeight = snapEven(outputVideoHeight);
        
        const outputWidth = snapEven(outputVideoWidth + (padding * 2));
        const outputHeight = snapEven(outputVideoHeight + (padding * 2));
        
        this.outputVideoWidth = outputVideoWidth;
        this.outputVideoHeight = outputVideoHeight;
        this.sourceVideoWidth = videoWidth;
        this.sourceVideoHeight = videoHeight;
        
        this.canvas = document.createElement('canvas');
        // Ensure canvas is at exact output resolution for 100% quality
        this.canvas.width = outputWidth;
        this.canvas.height = outputHeight;
        debugLog('[VideoProcessor] Canvas created at:', this.canvas.width, 'x', this.canvas.height);
        
        // Get 2D context with maximum quality settings
        this.ctx = this.canvas.getContext('2d', { 
          alpha: false, 
          desynchronized: false, // Disable desynchronized for better quality
          willReadFrequently: false // Optimize for write operations
        });
        
        // Maximum quality rendering settings for 100% quality export
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
        
        // Ensure pixel-perfect rendering
        this.ctx.textBaseline = 'top';
        this.ctx.textAlign = 'left';

        // Setup webcam/camera overlay if enabled (but don't set up audio yet - will do after audio context)
        if (this.settings.showWebcam) {
          await this.setupWebcamVideo();
        }

        // 1440p/4K: cap export frame rate — 60fps + huge canvas often drops frames and desyncs MediaRecorder
        const contentPixels = outputVideoWidth * outputVideoHeight;
        const isHeavyResExport =
          contentPixels >= 2560 * 1440 ||
          outputVideoWidth >= 3200 ||
          outputVideoHeight >= 1800;
        const userFps = this.settings.fps ?? 60;
        const userMaxFps = this.settings.maxFps ?? 60;
        let targetFps;
        let captureFps;
        if (isHeavyResExport) {
          targetFps = Math.max(24, Math.min(30, userFps, userMaxFps, 30));
          captureFps = targetFps;
          debugLog('[VideoProcessor] High-res export — using', targetFps, 'fps for stable encoding (1440p/4K)');
        } else {
          targetFps = Math.max(this.minFps, Math.min(userFps, userMaxFps));
          captureFps = Math.max(targetFps, this.minFps);
        }
        this.targetFps = targetFps;
        this.frameTiming.frameInterval = 1000 / targetFps;
        
        // Maximum Quality Bitrate Settings - Optimized for 100% quality
        let bitrate = this.settings.bitrate;
        if (!bitrate) {
          const pixels = outputWidth * outputHeight;
          const quality = this.settings.quality || 'high';
          const qualityMultipliers = { 'low': 1.0, 'medium': 2.0, 'high': 4.0 };
          const qualityMult = qualityMultipliers[quality] || 4.0;
          const pixelRatio = pixels / (1920 * 1080);
          const baseBitrate = 75000000; // Increased base to 75 Mbps for ultra-high quality
          bitrate = Math.round(baseBitrate * pixelRatio * qualityMult);
          
          // For 1080p, ensure minimum 150 Mbps for artifact-free quality
          if (pixels >= 1920 * 1080 * 0.9 && pixels < 2560 * 1440) { // 1080p range
            bitrate = Math.max(bitrate, 150000000); // 150 Mbps minimum for 1080p
            debugLog('[VideoProcessor] 1080p detected - using ultra-high bitrate:', (bitrate / 1000000).toFixed(1), 'Mbps');
          }

          // 1440p / 2K class canvas — tier between 1080p and full 4K
          if (pixels >= 2560 * 1440 * 0.88 && pixels < 3840 * 2160 * 0.88) {
            bitrate = Math.max(bitrate, 170000000);
            debugLog('[VideoProcessor] 1440p/2K output - boosted bitrate:', (bitrate / 1000000).toFixed(1), 'Mbps');
          }
          
          // For 4K, use very high bitrate for maximum quality
          // Note: Browsers typically support up to ~250 Mbps, but we'll request higher
          // and let the browser cap it if needed
          if (pixels >= 3840 * 2160 * 0.9) { // 4K or close to it
            // For 4K, use 200 Mbps (browser-safe maximum) for true 100% quality
            // This is the practical maximum most browsers support
            bitrate = Math.max(bitrate, 200000000); // 200 Mbps for 4K (browser-safe max)
            debugLog('[VideoProcessor] 4K detected - using maximum bitrate:', (bitrate / 1000000).toFixed(1), 'Mbps');
          }
          
          // Ensure minimum quality - for smaller resolutions, maintain reasonable bitrate
          // For portrait/vertical videos, ensure minimum 20 Mbps for quality
          const minBitrateForQuality = Math.max(20000000, Math.round(outputWidth * outputHeight * 0.01)); // At least 20 Mbps or 0.01 bpp
          bitrate = Math.max(minBitrateForQuality, bitrate);
        } else {
          // If bitrate is explicitly provided, use it as-is for maximum quality
          // Browsers will handle the actual encoding, and most modern browsers
          // can handle very high bitrates (up to 250+ Mbps)
          // Ensure minimum quality threshold - don't let it drop too low
          const minBitrateForQuality = Math.max(20000000, Math.round(outputWidth * outputHeight * 0.01)); // At least 20 Mbps or 0.01 bpp
          bitrate = Math.max(minBitrateForQuality, bitrate);
          debugLog('[VideoProcessor] Using provided bitrate:', (bitrate / 1000000).toFixed(1), 'Mbps');
        }
        

        debugLog('[VideoProcessor] Target FPS:', targetFps, 'Bitrate:', (bitrate/1000000).toFixed(1), 'Mbps');
        
        // Force MediaRecorder for stability
        this.useWebCodecs = false;
        
        this.outputStream = this.canvas.captureStream(captureFps);
        
        // FIX: Extract audio from source video and add to output stream
        // Canvas captureStream only captures video, so we need to add audio separately
        // Use Web Audio API to capture audio from the video element
        let audioContext = null;
        let audioSource = null;
        let audioDestination = null;
        
        try {
          // Check if video has audio (by checking if it can play audio)
          // Create audio context with cross-platform compatibility
          // Support both standard AudioContext and webkitAudioContext (Safari/older browsers)
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (!AudioContextClass) {
            throw new Error('AudioContext not supported');
          }
          audioContext = new AudioContextClass({
            // Use optimal sample rate for quality (default is usually 44.1kHz or 48kHz)
            sampleRate: 48000 // 48kHz for high-quality audio
          });
          audioSource = audioContext.createMediaElementSource(this.video);
          audioDestination = audioContext.createMediaStreamDestination();
          
          // Connect video audio to destination stream for capture
          audioSource.connect(audioDestination);
          // DO NOT connect to audioContext.destination - we don't want audio playing through speakers
          // Audio will be captured via audioDestination but won't be audible during export
          
          // Keep video unmuted - Web Audio API needs unmuted video to capture audio
          // We prevent playback by NOT connecting to audioContext.destination
          this.video.muted = false;
          debugLog('[VideoProcessor] Video unmuted for audio capture (but not connected to speakers)');
          
          // Resume audio context if suspended (required for audio capture)
          if (audioContext.state === 'suspended') {
            await audioContext.resume();
            debugLog('[VideoProcessor] Audio context resumed');
          }
          
          const audioTracks = audioDestination.stream.getAudioTracks();
          debugLog('[VideoProcessor] Audio tracks from Web Audio API:', audioTracks.length);
          
          // Add audio tracks to output stream
          audioTracks.forEach(track => {
            if (track.readyState === 'live') {
              this.outputStream.addTrack(track);
              debugLog('[VideoProcessor] Added audio track to output stream:', track.label);
            }
          });
          
          // Store references for cleanup
          this.audioContext = audioContext;
          this.audioSource = audioSource;
          this.audioDestination = audioDestination;
          
          // Now set up camera audio mixing if camera overlay is enabled
          if (this.settings.showWebcam && this.webcamStream && this.webcamStream.getAudioTracks().length > 0) {
            await this.setupCameraAudio();
          }
        } catch (error) {
          console.warn('[VideoProcessor] ⚠️ Cannot extract audio via Web Audio API:', error);
          // Even if screen audio fails, try to set up camera audio if enabled
          if (this.settings.showWebcam && this.webcamStream && this.webcamStream.getAudioTracks().length > 0) {
            try {
              // Create audio context just for camera
              const AudioContextClass = window.AudioContext || window.webkitAudioContext;
              if (AudioContextClass) {
                this.audioContext = new AudioContextClass({ sampleRate: 48000 });
                this.audioDestination = this.audioContext.createMediaStreamDestination();
                await this.setupCameraAudio();
              }
            } catch (cameraAudioError) {
              console.warn('[VideoProcessor] Could not set up camera-only audio:', cameraAudioError);
            }
          }
        }
        
        const format = this.settings.format || 'webm';
        let mimeType;
        
        // Check if we have audio tracks to include
        const hasAudio = this.outputStream.getAudioTracks().length > 0;
        debugLog('[VideoProcessor] Output stream has audio:', hasAudio);
        
        if (format === 'mp4') {
            const mp4Codecs = hasAudio 
              ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E', 'video/mp4']
              : ['video/mp4;codecs=avc1.42E01E', 'video/mp4'];
            for (const codec of mp4Codecs) {
              if (MediaRecorder.isTypeSupported(codec)) { mimeType = codec; break; }
            }
        }
        
        if (!mimeType) {
            // Prefer VP9 for best quality, especially for 4K
            // Include opus audio codec if we have audio tracks
            const webmCodecs = hasAudio
              ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
              : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
            for (const codec of webmCodecs) {
              if (MediaRecorder.isTypeSupported(codec)) { 
                mimeType = codec; 
                debugLog('[VideoProcessor] Selected codec:', codec, hasAudio ? '(with audio)' : '(video only)');
                break; 
              }
            }
        }
        
        debugLog('[VideoProcessor] Using MIME:', mimeType);
        debugLog('[VideoProcessor] Canvas resolution:', outputWidth, 'x', outputHeight);
        debugLog('[VideoProcessor] Output video resolution:', outputVideoWidth, 'x', outputVideoHeight);
        
        // MediaRecorder options - use highest quality settings
        // Optimized for cross-platform compatibility (Chrome on Mac/Windows/Linux)
        const recorderOptions = {
          mimeType: mimeType,
          videoBitsPerSecond: bitrate
        };
        
        // Add audio bitrate if we have audio tracks
        // Use high-quality audio bitrate: 192 kbps for excellent quality (Opus supports up to 510 kbps)
        // 192 kbps provides near-transparent quality for voice and music
        if (this.outputStream.getAudioTracks().length > 0) {
          recorderOptions.audioBitsPerSecond = 192000; // 192 kbps for high-quality audio (increased from 128 kbps)
          debugLog('[VideoProcessor] Audio bitrate set to 192 kbps (high quality)');
          
          // Log audio track settings for quality verification
          const audioTracks = this.outputStream.getAudioTracks();
          audioTracks.forEach((track, i) => {
            const settings = track.getSettings();
            debugLog(`[VideoProcessor] Audio track ${i + 1} quality settings:`, {
              sampleRate: settings.sampleRate,
              channelCount: settings.channelCount,
              echoCancellation: settings.echoCancellation,
              noiseSuppression: settings.noiseSuppression,
              autoGainControl: settings.autoGainControl
            });
          });
        }
        
        // For VP9, try to use quality mode if supported (better than bitrate alone)
        // Note: Not all browsers support this, but it's worth trying
        if (mimeType.includes('vp9')) {
          // VP9 supports quality-based encoding in some browsers
          try {
            // Try maximum quality parameter first
            const qualityMimeTypes = [
              mimeType + ';quality=1.0',
              mimeType + ';quality=0.95',
              mimeType
            ];
            
            for (const qualityMimeType of qualityMimeTypes) {
              if (MediaRecorder.isTypeSupported(qualityMimeType)) {
                recorderOptions.mimeType = qualityMimeType;
                debugLog('[VideoProcessor] Using VP9 with quality parameter:', qualityMimeType);
                break;
              }
            }
          } catch (e) {
            // Fallback to bitrate-based
            debugLog('[VideoProcessor] Using bitrate-based encoding');
          }
        }
        
        // For H.264/MP4, ensure we're using the best profile
        if (mimeType.includes('mp4') || mimeType.includes('avc1')) {
          // Try to use high profile for better quality
          const highProfileCodecs = [
            'video/mp4;codecs=avc1.640032', // High Profile Level 5.0 — better for 4K when supported
            'video/mp4;codecs=avc1.640028', // High Profile Level 4.0
            'video/mp4;codecs=avc1.64001F', // High Profile Level 3.1
            'video/mp4;codecs=avc1.42E01E', // Baseline Profile (fallback)
            'video/mp4'
          ];
          
          for (const codec of highProfileCodecs) {
            if (MediaRecorder.isTypeSupported(codec)) {
              recorderOptions.mimeType = codec;
              debugLog('[VideoProcessor] Using H.264 codec:', codec);
              break;
            }
          }
        }
        
        // Cap bitrate to browser-safe maximum before creating MediaRecorder
        // Different codecs have different limits:
        // - VP9/WebM: Can handle up to ~250 Mbps
        // - H.264/MP4: Often limited to ~100-150 Mbps in browsers
        let MAX_SAFE_BITRATE = 250000000; // 250 Mbps default for VP9/WebM
        
        // For H.264/MP4, use lower bitrate cap (browsers often struggle with high H.264 bitrates)
        if (recorderOptions.mimeType && (recorderOptions.mimeType.includes('mp4') || recorderOptions.mimeType.includes('avc1'))) {
          // Slightly higher cap for 2K/4K MP4 — still within what Chrome typically accepts
          MAX_SAFE_BITRATE = isHeavyResExport ? 180000000 : 150000000;
        }
        
        if (bitrate > MAX_SAFE_BITRATE) {
          // Silently cap bitrate to browser-safe maximum
          bitrate = MAX_SAFE_BITRATE;
          recorderOptions.videoBitsPerSecond = bitrate;
        }
        
        this.mediaRecorder = new MediaRecorder(this.outputStream, recorderOptions);
        
        // Log the actual settings being used
        debugLog('[VideoProcessor] MediaRecorder created with:', {
          mimeType: recorderOptions.mimeType,
          bitrate: (bitrate / 1000000).toFixed(1) + ' Mbps',
          canvasSize: outputWidth + 'x' + outputHeight,
          videoSize: outputVideoWidth + 'x' + outputVideoHeight,
          fps: captureFps
        });
        
        this.chunks = [];
        let totalDataSize = 0;
        let emptyChunkCount = 0;
        let lastChunkTime = Date.now();
        
        this.mediaRecorder.ondataavailable = (e) => {
          const now = Date.now();
          const timeSinceLastChunk = now - lastChunkTime;
          lastChunkTime = now;
          
          if (e.data && e.data.size > 0) {
            this.chunks.push(e.data);
            totalDataSize += e.data.size;
            emptyChunkCount = 0; // Reset empty chunk counter on successful chunk
            
            if (this.chunks.length % 10 === 0) {
              debugLog('[VideoProcessor] Chunks:', this.chunks.length, 'Total data:', (totalDataSize / 1024 / 1024).toFixed(2), 'MB');
            }
          } else {
            // Empty chunks can occur normally (MediaRecorder fires periodically)
            // But frequent empty chunks indicate a problem
            emptyChunkCount++;
            if (emptyChunkCount <= 3) {
              // First few empty chunks are normal, just log at debug level
              debugLog('[VideoProcessor] Received empty data chunk (normal during startup)');
            } else if (emptyChunkCount === 4) {
              // After 3 empty chunks, warn - might indicate an issue
              console.warn('[VideoProcessor] Multiple empty data chunks received - this may indicate encoding issues');
            }
          }
        };
        
        this.mediaRecorder.onerror = (event) => {
          console.error('[VideoProcessor] MediaRecorder error:', event.error);
        };
        
        this.mediaRecorder.onstart = () => {
          debugLog('[VideoProcessor] MediaRecorder started successfully');
        };
        
        this.mediaRecorder.onstop = () => {
          debugLog('[VideoProcessor] MediaRecorder stopped, total chunks:', this.chunks.length);
        };

        // Seek to start and ensure video is ready
        this.video.currentTime = startTime;
        await new Promise((res) => {
          const timeout = setTimeout(res, 5000);
          this.video.onseeked = () => {
            clearTimeout(timeout);
            res();
          };
          // Also wait for canplay to ensure video is ready
          this.video.oncanplay = () => {
            clearTimeout(timeout);
            res();
          };
        });
        
        // Video is unmuted for audio capture, but audio won't play through speakers
        // because we don't connect audioSource to audioContext.destination
        debugLog('[VideoProcessor] Video ready for processing (audio capture enabled, speakers disabled)');
        
        debugLog('[VideoProcessor] Starting at:', startTime, 'Ending at:', endTime, 'Duration:', duration);

        // Start video playback to ensure audio is flowing through Web Audio API
        // The video must be playing for audio to be captured
        if (this.video.paused) {
          debugLog('[VideoProcessor] Starting video playback for audio capture');
          await this.video.play().catch(e => console.warn('[VideoProcessor] Play error:', e));
        }
        
        // Longer timeslice at 1440p/4K — encoder needs more time per frame
        const recorderTimeslice = isHeavyResExport ? 350 : 200;
        this.mediaRecorder.start(recorderTimeslice);
        debugLog('[VideoProcessor] MediaRecorder started with', (bitrate / 1000000).toFixed(1), 'Mbps bitrate,', recorderOptions.mimeType, 'codec');

        // Process frames
        await this.processFrames(zoomSegments, videoWidth, videoHeight, startTime, endTime, targetFps, onProgress);

        // Stop video
        this.video.pause();
        
        // Ensure we get all data before stopping
        if (this.mediaRecorder.state === 'recording') {
            debugLog('[VideoProcessor] Requesting final data and stopping MediaRecorder...');
            this.mediaRecorder.requestData();
            // Wait a moment for data to be available
            await new Promise(res => setTimeout(res, isHeavyResExport ? 400 : 200));
            this.mediaRecorder.stop();
        }
        
        // High-res exports need longer for the encoder to flush final samples
        debugLog('[VideoProcessor] Waiting for final chunks...');
        await new Promise(res => setTimeout(res, isHeavyResExport ? 2200 : 1000));
        
        debugLog('[VideoProcessor] Total chunks collected:', this.chunks.length);
        
        const blob = new Blob(this.chunks, { type: this.mediaRecorder.mimeType || 'video/webm' });
        const blobSizeMB = blob.size / 1024 / 1024;
        const blobSizeKB = blob.size / 1024;
        debugLog('[VideoProcessor] Final blob:', blobSizeMB.toFixed(2), 'MB');
        
        
        URL.revokeObjectURL(this.video.src);
        this.cleanupWebcam();
        this.cleanupAudio();
        
        // Clean up video element
        if (this.video) {
          this.video.pause();
          this.video.src = '';
          this.video.srcObject = null;
          this.video = null;
        }
        
        // Clean up MediaRecorder
        if (this.mediaRecorder) {
          this.mediaRecorder = null;
        }
        
        // Clean up canvas
        if (this.canvas) {
          const ctx = this.canvas.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
          }
          this.canvas = null;
          this.ctx = null;
        }
        
        // Clean up output stream
        if (this.outputStream) {
          this.outputStream.getTracks().forEach(track => track.stop());
          this.outputStream = null;
        }
        
        resolve(blob);

      } catch (error) {
        console.error('[VideoProcessor] Error:', error);
        this.cleanupWebcam();
        this.cleanupAudio();
        
        // Clean up on error
        if (this.video) {
          this.video.pause();
          this.video.src = '';
          this.video.srcObject = null;
        }
        if (this.mediaRecorder) {
          this.mediaRecorder = null;
        }
        if (this.outputStream) {
          this.outputStream.getTracks().forEach(track => track.stop());
          this.outputStream = null;
        }
        
        reject(error);
      }
    });
  }

  async processFrames(zoomSegments, videoWidth, videoHeight, startTime, endTime, fps, onProgress) {
    const duration = endTime - startTime;
    const padding = this.settings.padding;
    const radius = this.settings.borderRadius;
    
    const outWidth = this.outputVideoWidth || videoWidth;
    const outHeight = this.outputVideoHeight || videoHeight;
    const srcWidth = this.sourceVideoWidth || videoWidth;
    const srcHeight = this.sourceVideoHeight || videoHeight;

    return new Promise((resolve) => {
      let isProcessing = true;
      let lastProgress = 0;
      let frameIndex = 0;
      
      // Frame rate control variables - strict 60fps output
      const targetFrameInterval = this.frameTiming.frameInterval; // ms per frame (~16.67ms for 60fps)
      let lastFrameTimestamp = performance.now();
      let lastVideoTime = startTime;
      let frameTimeoutId = null;
      // Initialize to current time since first frame is drawn immediately
      // It will be incremented by targetFrameInterval after first frame, scheduling second frame correctly
      let nextFrameTime = performance.now();
      let frameStartTime = performance.now(); // Track when frame drawing started
      
      // Store previous frame for interpolation/filler frames
      let previousFrameData = null;
      let previousVideoTime = startTime;
      let lastDrawnVideoTime = startTime;
      
      
      const drawFrame = async () => {
        if (!isProcessing) return;
        
        const frameStart = performance.now();
        const elapsed = frameStart - lastFrameTimestamp;
        
        // Check if we've reached the end time - don't stop on video.ended, only on reaching endTime
        // This ensures we process the full trimmed duration even if video naturally ends
        const currentTime = this.video.currentTime;
        const hasReachedEnd = currentTime >= endTime;
        
        // If video ended but we haven't reached endTime, seek forward to continue
        if (this.video.ended && !hasReachedEnd) {
          debugLog('[VideoProcessor] Video ended early at', currentTime, 'but need to reach', endTime, '- seeking forward');
          // Try to seek slightly past current time to continue playback
          this.video.currentTime = Math.min(currentTime + 0.1, endTime);
          await new Promise(res => {
            const timeout = setTimeout(res, 100);
            this.video.onseeked = () => {
              clearTimeout(timeout);
              res();
            };
          });
          // Resume playback if paused
          if (this.video.paused) {
            await this.video.play().catch(e => console.warn('[VideoProcessor] Play error:', e));
          }
        }
        
        if (hasReachedEnd) {
          debugLog('[VideoProcessor] Reached end time:', endTime, 'at currentTime:', currentTime);
          isProcessing = false;
          if (frameTimeoutId) clearTimeout(frameTimeoutId);
          if (onProgress) onProgress(100);
          resolve();
          return;
        }
        
        const currentVideoTime = this.video.currentTime;
        const timestamp = currentVideoTime * 1000;
        const videoTimeDelta = currentVideoTime - lastDrawnVideoTime;
        const zoomState = this.analyzer.getZoomAtTime(timestamp, zoomSegments, srcWidth, srcHeight);

        // Draw background
        this.drawBackground();

        // Calculate zoom
        let zoomScale = 1;
        let offsetX = 0;
        let offsetY = 0;

        if (zoomState.active && zoomState.level > 1) {
          zoomScale = zoomState.level;
          const normX = zoomState.x / srcWidth;
          const normY = zoomState.y / srcHeight;
          // Moderate panning range multiplier (2.0x) for balanced panning to edges
          const panMultiplier = 2.0;
          offsetX = (0.5 - normX) * outWidth * (zoomScale - 1) * panMultiplier;
          offsetY = (0.5 - normY) * outHeight * (zoomScale - 1) * panMultiplier;
        }

        // Determine if we should use a new video frame or filler frame
        // Always output at 60fps - use new video frame if available, otherwise duplicate previous
        const minFrameInterval = targetFrameInterval / 1000; // Convert to seconds (~0.01667s for 60fps)
        // Use 110% threshold - be more aggressive about generating filler frames
        // Since video often advances at ~0.017-0.020s (50-59fps), we need more filler frames to reach 60fps
        const isNewVideoFrame = videoTimeDelta >= minFrameInterval * 1.1;
        
        if (isNewVideoFrame || !previousFrameData) {
          // Calculate crop values if browser UI should be hidden
          let sourceX = 0;
          let sourceY = 0;
          let sourceWidth = srcWidth;
          let sourceHeight = srcHeight;
          let effectiveAspectRatio = srcWidth / srcHeight;
          
          if (!this.settings.showBrowserFrame) {
            // Auto-crop browser UI from top (address bar + tabs)
            // Standard browser UI height: ~100px (tabs ~40px + address bar ~60px)
            // Use percentage-based calculation for different screen sizes
            // Add extra 5px to ensure no black line remains
            const browserUIHeight = Math.min(105, Math.floor(srcHeight * 0.08) + 5); // ~8% of height + 5px or max 105px
            
            // Crop only from top, keep full width
            sourceX = 0;
            sourceY = browserUIHeight;
            sourceWidth = srcWidth;
            sourceHeight = srcHeight - browserUIHeight;
            
            // Ensure valid dimensions
            sourceWidth = Math.max(1, sourceWidth);
            sourceHeight = Math.max(1, sourceHeight);
            effectiveAspectRatio = sourceWidth / sourceHeight;
            
            debugLog('[VideoProcessor] Auto-cropping browser UI (top only):', { 
              browserUIHeight, 
              sourceX,
              sourceY, 
              sourceWidth,
              sourceHeight, 
              originalWidth: srcWidth,
              originalHeight: srcHeight,
              effectiveAspectRatio: effectiveAspectRatio.toFixed(3)
            });
          }
          
          // Draw new video frame with transformations
          // Calculate aspect ratio-preserving dimensions using effective (cropped) aspect ratio
          // Use content area dimensions (without padding) for accurate aspect ratio calculation
          const contentAreaWidth = this.outputVideoWidth;
          const contentAreaHeight = this.outputVideoHeight;
          const contentAspectRatio = contentAreaWidth / contentAreaHeight;
          
          // Calculate base dimensions that fit within content area while maintaining source aspect ratio
          // Always center the content regardless of aspect ratio
          let baseDrawWidth, baseDrawHeight;
          if (effectiveAspectRatio > contentAspectRatio) {
            // Source is wider - fit to content width, will have letterboxing on top/bottom
            baseDrawWidth = contentAreaWidth;
            baseDrawHeight = baseDrawWidth / effectiveAspectRatio;
          } else {
            // Source is taller - fit to content height, will have letterboxing on left/right
            baseDrawHeight = contentAreaHeight;
            baseDrawWidth = baseDrawHeight * effectiveAspectRatio;
          }
          
          // Apply zoom scale
          const drawWidth = baseDrawWidth * zoomScale;
          const drawHeight = baseDrawHeight * zoomScale;
          
          // Always center the content for all aspect ratios
          // Calculate position to center the base size within the content area (excluding padding)
          const baseX = padding + (contentAreaWidth - baseDrawWidth) / 2;
          const baseY = padding + (contentAreaHeight - baseDrawHeight) / 2;
          const drawX = baseX + offsetX;
          const drawY = baseY + offsetY;
          // Pixel-aligned destination — consistent shadow, clip, and video at high resolutions
          const dx = Math.round(drawX);
          const dy = Math.round(drawY);
          const dw = Math.max(1, Math.round(drawWidth));
          const dh = Math.max(1, Math.round(drawHeight));
          
          // Draw shadow first (behind content) if enabled - shadow moves with content
          // Only draw shadow when there's padding (background visible)
          if (this.settings.showShadow !== false && padding > 0) {
            this.ctx.save();
            // Match the editor preview shadow: 0 20px 40px rgba(0, 0, 0, 0.4)
            this.ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
            this.ctx.shadowBlur = 40;
            this.ctx.shadowOffsetY = 20;
            this.ctx.shadowOffsetX = 0;
            // Draw a solid shape to cast the shadow - the video will draw over this
            // Using a solid color ensures the shadow renders at full strength
            this.ctx.fillStyle = '#000000';
            this.ctx.beginPath();
            this.roundRect(this.ctx, dx, dy, dw, dh, radius);
            this.ctx.fill();
            this.ctx.restore();
          }
          
          // Draw video with clipping to rounded rectangle that moves with content
          this.ctx.save();
          this.ctx.beginPath();
          this.roundRect(this.ctx, dx, dy, dw, dh, radius);
          this.ctx.clip();
          
          if (this.settings.sharpening) {
            this.ctx.filter = 'contrast(1.02) saturate(1.05)';
          }
          
          // Draw current video frame (new frame from video) at full resolution
          // Always use high-quality smoothing for best quality
          const wasSmoothingEnabled = this.ctx.imageSmoothingEnabled;
          const wasSmoothingQuality = this.ctx.imageSmoothingQuality;
          this.ctx.imageSmoothingEnabled = true;
          this.ctx.imageSmoothingQuality = 'high';
          
          this.ctx.drawImage(
            this.video,
            sourceX, sourceY, sourceWidth, sourceHeight,
            dx, dy, dw, dh
          );
          
          // Restore smoothing setting
          this.ctx.imageSmoothingEnabled = wasSmoothingEnabled;
          this.ctx.imageSmoothingQuality = wasSmoothingQuality;
          
          this.ctx.filter = 'none';
          
          this.drawClickEffects(timestamp, dx, dy, dw, dh, srcWidth, srcHeight);
          
          this.ctx.restore();
          
          this.drawVideoFrame(dx, dy, dw, dh, radius);
          
          if (isNewVideoFrame) {
            lastDrawnVideoTime = this.video.currentTime;
            previousVideoTime = this.video.currentTime;
          } else {
            // First frame
            lastDrawnVideoTime = this.video.currentTime;
            previousVideoTime = this.video.currentTime;
          }
        } else {
          // Use filler frame - draw complete previous frame (includes all effects, border, and webcam)
          // Draw directly to canvas without transformations since previousFrameData is a complete snapshot
          this.ctx.drawImage(
            previousFrameData,
            0, 0, previousFrameData.width, previousFrameData.height,
            0, 0, this.canvas.width, this.canvas.height
          );
          // Skip drawing webcam since it's already included in previousFrameData
        }
        
        // Draw webcam only for new video frames (filler frames already include webcam)
        if ((isNewVideoFrame || !previousFrameData) && this.settings.showWebcam && this.webcamVideo) {
          this.drawWebcam(padding, outWidth, outHeight);
        }
        
        // Capture complete frame (after all drawing: video, clicks, border, webcam) for future filler frames
        if (!previousFrameData) {
          previousFrameData = document.createElement('canvas');
          previousFrameData.width = this.canvas.width;
          previousFrameData.height = this.canvas.height;
        }
        const prevCtx = previousFrameData.getContext('2d');
        prevCtx.drawImage(this.canvas, 0, 0);
        
        // Update frame timing stats
        this.frameTiming.frameCount++;
        const fpsUpdateInterval = 1000; // Update FPS calculation every second
        const currentTimeForFps = performance.now();
        if (currentTimeForFps - this.frameTiming.lastFpsUpdate >= fpsUpdateInterval) {
          this.frameTiming.actualFps = (this.frameTiming.frameCount * 1000) / (currentTimeForFps - this.frameTiming.lastFpsUpdate);
          this.frameTiming.frameCount = 0;
          this.frameTiming.lastFpsUpdate = currentTimeForFps;
        }
        
        // Progress
        const progress = ((this.video.currentTime - startTime) / duration) * 100;
        if (onProgress && progress - lastProgress > 1) {
          onProgress(Math.min(99, progress));
          lastProgress = progress;
        }
        
        // Debug logging for duration tracking
        if (frameIndex % 300 === 0) { // Log every 300 frames (~10 seconds at 30fps)
          debugLog('[VideoProcessor] Frame', frameIndex, '- currentTime:', this.video.currentTime.toFixed(2), 
                      '/ endTime:', endTime.toFixed(2), '- progress:', progress.toFixed(1) + '%');
        }
        
        frameIndex++;
        const frameEndTime = performance.now();
        const frameExecutionTime = frameEndTime - frameStart;
        lastFrameTimestamp = frameEndTime;
        
        // Schedule next frame with precise timing
        // Calculate when the next frame should start (based on target interval)
        nextFrameTime = nextFrameTime + targetFrameInterval;
        const currentPerformanceTime = performance.now();
        const timeUntilNextFrame = nextFrameTime - currentPerformanceTime;
        
        // Cap execution time to prevent spikes from breaking timing (max 2x target interval)
        const cappedExecutionTime = Math.min(frameExecutionTime, targetFrameInterval * 2);
        
        // Adjust delay to account for execution time, but maintain strict timing
        const adjustedDelay = Math.max(0, timeUntilNextFrame);
        
        // Use setTimeout with precise timing
        // If we're behind schedule (negative delay), schedule immediately to catch up
        if (adjustedDelay <= 0) {
          // We're behind - schedule immediately to catch up
          frameTimeoutId = setTimeout(() => {
            drawFrame();
          }, 0);
          // Reset nextFrameTime to current time to prevent drift
          nextFrameTime = currentPerformanceTime + targetFrameInterval;
        } else {
          frameTimeoutId = setTimeout(() => {
            drawFrame();
          }, adjustedDelay);
        }
      };
      
      // Don't stop on video.ended - only stop when we reach endTime
      // This ensures we process the full trimmed duration
      this.video.onended = () => {
        const currentTime = this.video.currentTime;
        debugLog('[VideoProcessor] Video ended event at:', currentTime, 'target endTime:', endTime);
        // Only stop if we've actually reached or passed endTime
        if (currentTime >= endTime && isProcessing) {
          debugLog('[VideoProcessor] Stopping - reached endTime');
          isProcessing = false;
          if (frameTimeoutId) clearTimeout(frameTimeoutId);
          if (onProgress) onProgress(100);
          resolve();
        } else if (isProcessing) {
          // Video ended early - try to continue by seeking
          debugLog('[VideoProcessor] Video ended early, attempting to continue...');
          this.video.currentTime = Math.min(currentTime + 0.1, endTime);
          this.video.play().catch(e => console.warn('[VideoProcessor] Play error after seek:', e));
        }
      };
      
      // Let video play normally, but control output frame rate
      this.video.playbackRate = 1.0;
      
      // Ensure video doesn't pause during processing
      this.video.addEventListener('pause', () => {
        if (isProcessing && this.video.currentTime < endTime) {
          debugLog('[VideoProcessor] Video paused during processing, resuming...');
          this.video.play().catch(e => console.warn('[VideoProcessor] Resume error:', e));
        }
      });
      
      // Initialize frame timing
      this.frameTiming.lastFrameTime = performance.now();
      this.frameTiming.lastFpsUpdate = performance.now();
      this.frameTiming.frameCount = 0;
      
      // Start video playback
      this.video.play().then(() => {
        debugLog('[VideoProcessor] Video playback started, processing frames from', startTime, 'to', endTime);
        // Start frame loop with precise timing
        drawFrame();
      }).catch(err => {
        console.error('[VideoProcessor] Play error:', err);
        resolve();
      });
    });
  }

  // Helper methods
  async preloadBackgroundImage(imageDataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.backgroundImageElement = img;
        resolve();
      };
      img.onerror = reject;
      img.src = imageDataUrl;
    });
  }

  drawBackground() {
    // Handle image background (from upload) - use preloaded image
    if (this.backgroundImageElement) {
      this.ctx.drawImage(this.backgroundImageElement, 0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    
    const bg = this.settings.background;
    
    // Handle gradient backgrounds - parse CSS gradient string
    if (bg && typeof bg === 'string' && bg.includes('gradient')) {
      // Parse linear-gradient CSS string
      const gradMatch = bg.match(/linear-gradient\(([^)]+)\)/);
      if (gradMatch) {
        const grad = this.ctx.createLinearGradient(0, 0, this.canvas.width, this.canvas.height);
        // Extract color stops from gradient string
        const colorStops = gradMatch[1].match(/#[0-9a-fA-F]{6}/g);
        if (colorStops && colorStops.length >= 2) {
          grad.addColorStop(0, colorStops[0]);
          grad.addColorStop(1, colorStops[1]);
          this.ctx.fillStyle = grad;
        } else {
          // Fallback to default gradient
          grad.addColorStop(0, '#667eea');
          grad.addColorStop(1, '#764ba2');
          this.ctx.fillStyle = grad;
        }
      } else {
        // Fallback to default gradient if parsing fails
        const grad = this.ctx.createLinearGradient(0, 0, this.canvas.width, this.canvas.height);
        grad.addColorStop(0, '#667eea');
        grad.addColorStop(1, '#764ba2');
        this.ctx.fillStyle = grad;
      }
    } else if (bg === 'transparent' || bg === 'hidden' || bg === null) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    } else {
      // Solid color background
      this.ctx.fillStyle = bg || '#1a1a2e';
    }
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  roundRect(ctx, x, y, width, height, radius) {
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  hexToRgba(hex, alpha) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return `rgba(16, 185, 129, ${alpha})`;
    return `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`;
  }
  
  easeOutElastic(t) {
    const c4 = (2 * Math.PI) / 3;
    return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  }

  drawClickEffects(timestamp, videoX, videoY, drawWidth, drawHeight, srcWidth, srcHeight) {
    if (this.settings.clickStyle === 'none' || !this.cursorData) return;
    const videoWidth = srcWidth || drawWidth;
    const videoHeight = srcHeight || drawHeight;
    const previewBeforeMs = 120; // Show orb 120ms before click
    const durationAfterMs = 250; // Show orb for 250ms after click
    const totalWindow = previewBeforeMs + durationAfterMs;
    const clicks = this.cursorData.filter(d => (d.type === 'click' || d.type === 'doubleclick') && timestamp >= d.timestamp - previewBeforeMs && timestamp < d.timestamp + durationAfterMs);
    
    // Calculate browser UI height if cropped
    let browserUIHeight = 0;
    let croppedHeight = videoHeight;
    if (!this.settings.showBrowserFrame) {
      browserUIHeight = Math.min(105, Math.floor(videoHeight * 0.08) + 5);
      croppedHeight = videoHeight - browserUIHeight;
    }
    
    clicks.forEach(click => {
      // Calculate progress: 0 = before click, 1 = after click
      const timeFromClick = timestamp - click.timestamp;
      const progress = (timeFromClick + previewBeforeMs) / totalWindow; // Normalize to 0-1
      
      // Calculate normalized coordinates (0-1) relative to viewport/content area
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
      
      // Normalized coordinates are relative to the viewport (content area excluding browser UI)
      // Map to output coordinates using actual draw dimensions
      // videoX, videoY is where the video is drawn, drawWidth, drawHeight is the video size on canvas
      let x = videoX + (normX * drawWidth);
      let y;
      
      if (browserUIHeight > 0) {
        // Browser UI is cropped - drawHeight represents content area only
        // normalizedY is relative to content area, use directly
        y = videoY + (normY * drawHeight);
      } else {
        // Browser UI is shown - need to offset by browser UI height
        const browserUIHeightActual = Math.min(105, Math.floor(videoHeight * 0.08) + 5);
        const contentAreaHeight = videoHeight - browserUIHeightActual;
        // normalizedY is 0-1 relative to content area, map to drawHeight proportionally
        const browserUIHeightScaled = (browserUIHeightActual / videoHeight) * drawHeight;
        const contentAreaHeightScaled = (contentAreaHeight / videoHeight) * drawHeight;
        y = videoY + browserUIHeightScaled + (normY * contentAreaHeightScaled);
      }
      
      // Draw orb animation (always orb when enabled)
      if (this.settings.clickStyle !== 'none') {
        this.drawOrbClick(x, y, progress);
      }
    });
  }

  drawOrbClick(x, y, progress) {
    // Intensity multipliers based on clickForce setting
    const intensityMultipliers = {
      weak: { size: 0.7, alpha: 0.7 },
      moderate: { size: 1.0, alpha: 1.0 },
      strong: { size: 1.4, alpha: 1.2 }
    };
    const intensity = intensityMultipliers[this.settings.clickForce] || intensityMultipliers.moderate;
    
    // Strong, bigger orb that appears before click and fades naturally
    const baseSize = 35 * intensity.size; // Base size adjusted by intensity
    // Grow more gradually: start smaller, peak around click time, then fade
    const growthPhase = Math.min(progress, 0.35); // Growth phase (first 35% of animation)
    const fadePhase = Math.max(0, progress - 0.35); // Fade phase (remaining 65%)
    const size = baseSize * (0.5 + growthPhase * 1.2 + fadePhase * 0.3); // Grows bigger then shrinks
    
    // Alpha: visibility adjusted by intensity - peaks at click, then fades out naturally
    let alpha;
    if (progress < 0.35) {
      // Before/during click: increase visibility quickly
      alpha = (0.7 + (progress / 0.35) * 0.25) * intensity.alpha; // Adjusted by intensity
    } else {
      // After click: fade out smoothly
      alpha = (0.95 * (1 - (fadePhase / 0.65))) * intensity.alpha; // Adjusted by intensity
    }
    alpha = Math.max(0, Math.min(1, alpha));
    
    // Get selected color
    const selectedColor = this.settings.clickColor || '#10b981';
    
    // Draw very light shadow/outline for subtle visibility
    this.ctx.beginPath();
    this.ctx.arc(x, y, size + 3, 0, Math.PI * 2);
    this.ctx.strokeStyle = `rgba(0, 0, 0, ${alpha * 0.08})`;
    this.ctx.lineWidth = 4;
    this.ctx.stroke();
    
    // Create gradient for orb effect - strong and vibrant
    const gradient = this.ctx.createRadialGradient(x, y, 0, x, y, size);
    gradient.addColorStop(0, this.hexToRgba(selectedColor, alpha * 1.0));
    gradient.addColorStop(0.2, this.hexToRgba(selectedColor, alpha * 0.9));
    gradient.addColorStop(0.4, this.hexToRgba(selectedColor, alpha * 0.7));
    gradient.addColorStop(0.7, this.hexToRgba(selectedColor, alpha * 0.4));
    gradient.addColorStop(1, this.hexToRgba(selectedColor, 0));
    
    this.ctx.beginPath();
    this.ctx.arc(x, y, size, 0, Math.PI * 2);
    this.ctx.fillStyle = gradient;
    this.ctx.fill();
    
    // Outer ring - strong border for visibility
    this.ctx.beginPath();
    this.ctx.arc(x, y, size, 0, Math.PI * 2);
    this.ctx.strokeStyle = this.hexToRgba(selectedColor, alpha * 0.95);
    this.ctx.lineWidth = 3;
    this.ctx.stroke();
    
    // Inner bright center for stronger effect
    this.ctx.beginPath();
    this.ctx.arc(x, y, size * 0.3, 0, Math.PI * 2);
    this.ctx.fillStyle = this.hexToRgba(selectedColor, alpha * 0.8);
    this.ctx.fill();
  }

  drawVideoFrame(x, y, width, height, radius) {
    // Draw transparent border at zoomed content position (matches shadow and video)
    this.ctx.save();
    this.ctx.shadowColor = 'transparent';
    this.ctx.shadowBlur = 0;
    this.ctx.shadowOffsetY = 0;
    this.ctx.shadowOffsetX = 0;
    this.ctx.strokeStyle = 'transparent';
    this.ctx.lineWidth = 0;
    this.ctx.beginPath();
    this.roundRect(this.ctx, x, y, width, height, radius);
    this.ctx.stroke();
    this.ctx.restore();
  }

  drawWebcam(padding, videoWidth, videoHeight) {
    if (!this.webcamVideo || !this.webcamVideo.videoWidth) return;
    const sizeRatio = 0.2; // 20% of video width
    const webcamWidth = videoWidth * sizeRatio;
    const webcamHeight = (this.webcamVideo.videoHeight / this.webcamVideo.videoWidth) * webcamWidth;
    const margin = 20;
    // Position in bottom-right corner
    const x = padding + videoWidth - webcamWidth - margin;
    const y = padding + videoHeight - webcamHeight - margin;
    
    this.ctx.save();
    // Add shadow for depth
    this.ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    this.ctx.shadowBlur = 20;
    this.ctx.shadowOffsetX = 0;
    this.ctx.shadowOffsetY = 4;
    
    // Always use circular shape for camera overlay (rounded)
    const radius = Math.min(webcamWidth, webcamHeight) / 2;
    this.ctx.beginPath();
    this.ctx.arc(x + webcamWidth / 2, y + webcamHeight / 2, radius, 0, Math.PI * 2);
    this.ctx.clip();
    
    // Draw camera video
    this.ctx.drawImage(this.webcamVideo, x, y, webcamWidth, webcamHeight);
    
    // Draw border for better visibility
    this.ctx.restore();
    this.ctx.save();
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    this.ctx.lineWidth = 3;
    this.ctx.beginPath();
    this.ctx.arc(x + webcamWidth / 2, y + webcamHeight / 2, radius, 0, Math.PI * 2);
    this.ctx.stroke();
    this.ctx.restore();
  }

  // Setup webcam video only (audio will be set up separately after audio context is created)
  async setupWebcamVideo() {
    try {
      // Request camera with audio for camera overlay (for content creators)
      const constraints = {
        video: { 
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
          facingMode: 'user' 
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      };
      
      this.webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.webcamVideo = document.createElement('video');
      this.webcamVideo.srcObject = this.webcamStream;
      this.webcamVideo.muted = true; // Mute playback, but audio will be captured
      await this.webcamVideo.play();
      debugLog('[VideoProcessor] Camera video set up, audio tracks:', this.webcamStream.getAudioTracks().length);
    } catch (e) { 
      console.warn('[VideoProcessor] Could not set up camera:', e);
      this.settings.showWebcam = false; 
    }
  }
  
  // Setup camera audio mixing with screen audio
  async setupCameraAudio() {
    if (!this.webcamStream || !this.audioContext) {
      return;
    }
    
    const audioTracks = this.webcamStream.getAudioTracks();
    if (audioTracks.length === 0) {
      debugLog('[VideoProcessor] Camera has no audio tracks');
      return;
    }
    
    try {
      debugLog('[VideoProcessor] Setting up camera audio mixing');
      
      // Create source for camera audio
      const cameraAudioSource = this.audioContext.createMediaStreamSource(this.webcamStream);
      
      // If we have screen audio, mix them together
      if (this.audioSource && this.audioDestination) {
        // Create gain nodes to control volume of each source
        const cameraGain = this.audioContext.createGain();
        const screenGain = this.audioContext.createGain();
        cameraGain.gain.value = 1.0; // Camera audio level
        screenGain.gain.value = 1.0; // Screen audio level
        
        // Disconnect existing audio source from destination
        this.audioSource.disconnect();
        this.audioSource.connect(screenGain);
        
        // Connect camera audio through gain
        cameraAudioSource.connect(cameraGain);
        
        // Create a merger to properly mix both sources into mono (both channels get mixed audio)
        // This ensures both camera and screen audio are heard in both left and right channels
        const merger = this.audioContext.createChannelMerger(2);
        
        // Create a gain node to combine both sources before sending to merger
        const mixerGain = this.audioContext.createGain();
        mixerGain.gain.value = 1.0;
        
        // Connect both sources to the mixer
        cameraGain.connect(mixerGain);
        screenGain.connect(mixerGain);
        
        // Connect mixer to both channels of merger (mono mix to stereo output)
        mixerGain.connect(merger, 0, 0); // Left channel
        mixerGain.connect(merger, 0, 1); // Right channel
        
        // Disconnect old connection and connect merger to destination
        // First, remove old audio tracks from output stream
        const oldAudioTracks = this.outputStream.getAudioTracks();
        oldAudioTracks.forEach(track => {
          this.outputStream.removeTrack(track);
        });
        
        // Connect merger to destination
        merger.connect(this.audioDestination);
        
        // Store mixer reference for cleanup
        this.audioMixer = mixerGain;
        
        // Store references for cleanup
        this.cameraAudioSource = cameraAudioSource;
        this.audioMerger = merger;
        this.cameraGain = cameraGain;
        this.screenGain = screenGain;
        
        debugLog('[VideoProcessor] Camera audio mixed with screen audio (mono mix to stereo)');
      } else {
        // No screen audio, just use camera audio
        if (!this.audioDestination) {
          this.audioDestination = this.audioContext.createMediaStreamDestination();
        }
        cameraAudioSource.connect(this.audioDestination);
        this.cameraAudioSource = cameraAudioSource;
        debugLog('[VideoProcessor] Using camera audio only (no screen audio)');
      }
      
      // Add/update audio tracks in output stream
      const oldAudioTracks = this.outputStream.getAudioTracks();
      oldAudioTracks.forEach(track => {
        this.outputStream.removeTrack(track);
      });
      
      const newAudioTracks = this.audioDestination.stream.getAudioTracks();
      newAudioTracks.forEach(track => {
        if (track.readyState === 'live') {
          this.outputStream.addTrack(track);
          debugLog('[VideoProcessor] Added audio track to output stream');
        }
      });
      
      // Resume audio context if suspended
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
        debugLog('[VideoProcessor] Audio context resumed for camera audio');
      }
    } catch (audioError) {
      console.warn('[VideoProcessor] Could not set up camera audio mixing:', audioError);
      // Continue without camera audio mixing
    }
  }

  cleanupAudio() {
    if (this.audioSource) {
      try {
        this.audioSource.disconnect();
        this.audioSource = null;
      } catch (e) {
        console.warn('[VideoProcessor] Error disconnecting audio source:', e);
      }
    }
    if (this.cameraAudioSource) {
      try {
        this.cameraAudioSource.disconnect();
        this.cameraAudioSource = null;
      } catch (e) {
        console.warn('[VideoProcessor] Error disconnecting camera audio source:', e);
      }
    }
    if (this.audioMixer) {
      try {
        this.audioMixer.disconnect();
        this.audioMixer = null;
      } catch (e) {
        console.warn('[VideoProcessor] Error disconnecting audio mixer:', e);
      }
    }
    if (this.cameraGain) {
      try {
        this.cameraGain.disconnect();
        this.cameraGain = null;
      } catch (e) {
        console.warn('[VideoProcessor] Error disconnecting camera gain:', e);
      }
    }
    if (this.screenGain) {
      try {
        this.screenGain.disconnect();
        this.screenGain = null;
      } catch (e) {
        console.warn('[VideoProcessor] Error disconnecting screen gain:', e);
      }
    }
    if (this.audioMerger) {
      try {
        this.audioMerger.disconnect();
        this.audioMerger = null;
      } catch (e) {
        console.warn('[VideoProcessor] Error disconnecting audio merger:', e);
      }
    }
    if (this.audioDestination) {
      try {
        this.audioDestination.disconnect();
        this.audioDestination = null;
      } catch (e) {
        console.warn('[VideoProcessor] Error disconnecting audio destination:', e);
      }
    }
    if (this.audioContext) {
      try {
        this.audioContext.close();
        this.audioContext = null;
      } catch (e) {
        console.warn('[VideoProcessor] Error closing audio context:', e);
      }
    }
  }

  cleanupWebcam() {
    if (this.webcamStream) { 
      this.webcamStream.getTracks().forEach(t => t.stop()); 
      this.webcamStream = null; 
    }
    if (this.webcamVideo) { 
      this.webcamVideo.srcObject = null; 
      this.webcamVideo = null; 
    }
    // Clean up camera audio source if it exists
    if (this.cameraAudioSource) {
      try {
        this.cameraAudioSource.disconnect();
        this.cameraAudioSource = null;
      } catch (e) {
        console.warn('[VideoProcessor] Error disconnecting camera audio source:', e);
      }
    }
    if (this.audioMerger) {
      try {
        this.audioMerger.disconnect();
        this.audioMerger = null;
      } catch (e) {
        console.warn('[VideoProcessor] Error disconnecting audio merger:', e);
      }
    }
  }

  cancel() {
    if (this.video) this.video.pause();
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
    this.cleanupWebcam();
    this.cleanupAudio();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = VideoProcessor;
}