import { FilesetResolver, ImageSegmenter } from './vendor/mediapipe/vision_bundle.mjs';

let segmenterInstance = null;
let initPromise = null;
let maskCanvas = null;
let maskCtx = null;
let maskImageData = null;
let personLayerCanvas = null;
let personLayerCtx = null;

async function initSegmenter() {
  if (segmenterInstance) return segmenterInstance;
  if (!initPromise) {
    initPromise = (async () => {
      const wasmFileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('vendor/mediapipe/wasm'));
      segmenterInstance = await ImageSegmenter.createFromOptions(wasmFileset, {
        baseOptions: {
          modelAssetPath: chrome.runtime.getURL('vendor/mediapipe/selfie_segmenter.tflite'),
          delegate: 'CPU',
        },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      return segmenterInstance;
    })();
  }
  return initPromise;
}

function isSegmenterReady() {
  return !!segmenterInstance;
}

function maskToCanvas(mask) {
  const w = mask.width;
  const h = mask.height;
  const data = mask.getAsFloat32Array();

  if (!maskCanvas || maskCanvas.width !== w || maskCanvas.height !== h) {
    maskCanvas = document.createElement('canvas');
    maskCanvas.width = w;
    maskCanvas.height = h;
    maskCtx = maskCanvas.getContext('2d');
    maskImageData = maskCtx.createImageData(w, h);
  }

  const px = maskImageData.data;
  for (let i = 0; i < data.length; i++) {
    px[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(data[i] * 255)));
  }
  maskCtx.putImageData(maskImageData, 0, 0);
  return maskCanvas;
}

/**
 * Returns a canvas of size targetW x targetH containing only the person
 * (background made transparent via the segmentation mask), or null if the
 * segmenter isn't ready yet / segmentation failed for this frame — callers
 * should fall back to drawing the plain webcam video in that case.
 */
function getPersonLayerCanvas(videoEl, targetW, targetH) {
  if (!segmenterInstance || !videoEl.videoWidth) return null;

  let result;
  try {
    // A monotonically increasing wall-clock timestamp is required by the video
    // running mode, and is safe to use here since it doesn't need to match the
    // video's own currentTime — we only need per-frame segmentation, not
    // temporal smoothing tied to playback position (which can seek backwards).
    result = segmenterInstance.segmentForVideo(videoEl, performance.now());
  } catch (err) {
    console.warn('Segmentation failed for this frame', err);
    return null;
  }

  const mask = result.confidenceMasks && result.confidenceMasks[0];
  if (!mask) {
    result.close();
    return null;
  }

  const maskCanvasSrc = maskToCanvas(mask);
  result.close();

  if (!personLayerCanvas || personLayerCanvas.width !== targetW || personLayerCanvas.height !== targetH) {
    personLayerCanvas = document.createElement('canvas');
    personLayerCanvas.width = targetW;
    personLayerCanvas.height = targetH;
    personLayerCtx = personLayerCanvas.getContext('2d');
  }

  personLayerCtx.globalCompositeOperation = 'source-over';
  personLayerCtx.clearRect(0, 0, targetW, targetH);
  personLayerCtx.drawImage(videoEl, 0, 0, targetW, targetH);
  personLayerCtx.globalCompositeOperation = 'destination-in';
  personLayerCtx.drawImage(maskCanvasSrc, 0, 0, targetW, targetH);
  personLayerCtx.globalCompositeOperation = 'source-over';

  return personLayerCanvas;
}

// Exposed as a global so the non-module editor.js (shared plain-script scope
// with video-processor.js, zoom-analyzer.js, db.js) can call into it.
window.omSegmenter = { initSegmenter, isSegmenterReady, getPersonLayerCanvas };
