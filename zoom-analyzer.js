/**
 * CursorFly Screen Recorder
 * Copyright (c) 2026 Anu S Pillai
 * GitHub: https://github.com/anugotta
 *
 * Licensed under the MIT License.
 */

// Zoom Analyzer - Cinematic click-anticipating zoom for demo recordings
// Zooms in before first click, stays zoomed and PANS between clicks,
// only zooms out if 5+ seconds gap before next click

class ZoomAnalyzer {
  constructor() {
    // Zoom settings
    this.ZOOM_LEVEL = 1.05;          // Zoom level (1.05x) - very subtle
    
    // Timing
    this.ANTICIPATE_TIME = 2000;     // Start zooming 2 seconds BEFORE click
    this.HOLD_AFTER_CLICK = 0;      // Zoom out immediately after click (no wait)
    this.TRANSITION_IN = 1000;       // Smooth zoom in duration (ms)
    this.TRANSITION_OUT = 1000;      // Smooth zoom out duration (ms)
    this.PAN_DURATION = 800;         // Time to pan between clicks (ms)
    
    // Gap threshold - only zoom out if next click is 5+ seconds away
    this.ZOOM_OUT_GAP = 5000;        // 5 seconds
  }

  /**
   * Analyze cursor data - creates smart zoom segments
   * Stays zoomed and pans between clicks if they're close together
   * Only zooms out when there's a 5+ second gap
   */
  analyzeClicks(cursorData, videoWidth = 1920, videoHeight = 1080) {
    console.log('[ZoomAnalyzer] Analyzing', cursorData.length, 'cursor events');
    console.log('[ZoomAnalyzer] Video dimensions:', videoWidth, 'x', videoHeight);
    
    // Get ALL clicks
    const clicks = cursorData.filter(d => 
      d.type === 'click' || d.type === 'doubleclick' || d.type === 'mousedown'
    );
    
    console.log('[ZoomAnalyzer] Found', clicks.length, 'click events');
    
    if (clicks.length === 0) {
      console.log('[ZoomAnalyzer] No clicks found');
      return [];
    }

    // Sort clicks by timestamp
    clicks.sort((a, b) => a.timestamp - b.timestamp);

    // Group clicks into segments based on 5-second gap rule
    const segments = [];
    let currentSegment = null;
    
    for (let i = 0; i < clicks.length; i++) {
      const click = clicks[i];
      const nextClick = clicks[i + 1];
      const clickTime = click.timestamp;
      
      // Get normalized position
      let normalizedX, normalizedY;
      
      if (click.normalizedX !== undefined && !isNaN(click.normalizedX)) {
        normalizedX = click.normalizedX;
        normalizedY = click.normalizedY;
      } else if (click.viewportWidth && click.viewportWidth > 0) {
        normalizedX = click.x / click.viewportWidth;
        normalizedY = click.y / click.viewportHeight;
      } else {
        normalizedX = click.x / videoWidth;
        normalizedY = click.y / videoHeight;
      }
      
      // Clamp to valid range - expanded to allow panning to edges
      // Allow panning closer to edges (0.03-0.97) for better coverage
      normalizedX = Math.max(0.03, Math.min(0.97, normalizedX));
      normalizedY = Math.max(0.03, Math.min(0.97, normalizedY));
      
      const position = {
        x: normalizedX * videoWidth,
        y: normalizedY * videoHeight,
        normalizedX,
        normalizedY,
        timestamp: clickTime
      };
      
      // Check gap to next click
      const gapToNext = nextClick ? (nextClick.timestamp - clickTime) : Infinity;
      const shouldZoomOut = gapToNext >= this.ZOOM_OUT_GAP;
      
      if (!currentSegment) {
        // First segment only: no pre-click anticipation — avoids the video opening already zoomed
        // when the first click happens soon after recording starts. Later segments keep anticipation.
        const isFirstSegment = segments.length === 0;
        const anticipateMs = isFirstSegment ? 0 : this.ANTICIPATE_TIME;
        currentSegment = {
          startTime: Math.max(0, clickTime - anticipateMs),
          positions: [position],
          zoomLevel: this.ZOOM_LEVEL,
          clickCount: 1
        };
        console.log('[ZoomAnalyzer] Starting segment at click', i + 1,
                    isFirstSegment ? '(no lead-in zoom — starts at first click)' : '',
                    '- segment from', (currentSegment.startTime / 1000).toFixed(2) + 's');
      } else {
        // Add click to current segment
        currentSegment.positions.push(position);
        currentSegment.clickCount++;
      }
      
      // Decide whether to end this segment
      if (shouldZoomOut) {
        // End segment - zoom out immediately after click, with transition duration
        currentSegment.endTime = clickTime + this.HOLD_AFTER_CLICK + this.TRANSITION_OUT;
        segments.push(currentSegment);
        console.log('[ZoomAnalyzer] Ending segment after click', i + 1,
                    '- zoom out starts immediately, completes at', (currentSegment.endTime / 1000).toFixed(2) + 's',
                    '(' + currentSegment.clickCount + ' clicks in segment)',
                    nextClick ? '(5s+ gap to next)' : '(last click)');
        currentSegment = null;
      } else {
        console.log('[ZoomAnalyzer] Click', i + 1, '- staying zoomed, will pan to next',
                    '(gap: ' + (gapToNext / 1000).toFixed(2) + 's)');
      }
    }
    
    // Handle any remaining segment
    if (currentSegment) {
      const lastClick = currentSegment.positions[currentSegment.positions.length - 1];
      currentSegment.endTime = lastClick.timestamp + this.HOLD_AFTER_CLICK + this.TRANSITION_OUT;
      segments.push(currentSegment);
    }
    
    console.log('[ZoomAnalyzer] ✅ Created', segments.length, 'zoom segments from', clicks.length, 'clicks');
    
    return segments;
  }

  /**
   * Get zoom state for a specific timestamp
   * @param {number} timestamp - Current timestamp in milliseconds
   * @param {Array} zoomSegments - Array of zoom segments
   * @param {number} videoWidth - Video width (optional, defaults to 1920)
   * @param {number} videoHeight - Video height (optional, defaults to 1080)
   */
  getZoomAtTime(timestamp, zoomSegments, videoWidth = 1920, videoHeight = 1080) {
    if (!zoomSegments || zoomSegments.length === 0) {
      return { active: false, level: 1.0, x: 0, y: 0 };
    }
    
    for (const segment of zoomSegments) {
      if (timestamp >= segment.startTime && timestamp <= segment.endTime) {
        const positions = segment.positions || [];
        const zoomLevel = segment.zoomLevel || this.ZOOM_LEVEL;
        
        // Handle segments with no positions (manually added)
        if (positions.length === 0) {
          // Simple zoom in/out based on segment timing
          const segmentDuration = segment.endTime - segment.startTime;
          const elapsed = timestamp - segment.startTime;
          const progress = elapsed / segmentDuration;
          
          let currentZoom = zoomLevel;
          const transitionPct = 0.15;
          
          if (progress < transitionPct) {
            const inProgress = progress / transitionPct;
            currentZoom = 1.0 + (zoomLevel - 1.0) * this.easeOutCubic(inProgress);
          } else if (progress > (1 - transitionPct)) {
            const outProgress = (progress - (1 - transitionPct)) / transitionPct;
            currentZoom = zoomLevel - (zoomLevel - 1.0) * this.easeInCubic(outProgress);
          }
          
          return {
            active: currentZoom > 1.01,
            level: Math.max(1.0, currentZoom),
            x: segment.centerX || 960,
            y: segment.centerY || 540
          };
        }
        
        const firstClickTime = positions[0].timestamp;
        const lastClickTime = positions[positions.length - 1].timestamp;
        const firstClickPosition = positions[0];
        
        // Calculate zoom level based on phase
        let currentZoomLevel = zoomLevel;
        const timeBeforeFirstClick = firstClickTime - timestamp;
        const timeAfterLastClick = timestamp - lastClickTime;
        
        // PHASE 1: Zooming IN (before first click) - pan to center on click position
        if (timeBeforeFirstClick > 0) {
          if (timeBeforeFirstClick <= this.TRANSITION_IN) {
            const progress = 1 - (timeBeforeFirstClick / this.TRANSITION_IN);
            currentZoomLevel = 1.0 + (zoomLevel - 1.0) * this.easeOutCubic(progress);
          } else {
            currentZoomLevel = 1.0;
          }
        }
        // PHASE 2: Zooming OUT (starts immediately after click)
        else if (timeAfterLastClick >= this.HOLD_AFTER_CLICK) {
          // Zoom out starts immediately after click (HOLD_AFTER_CLICK = 0)
          const outProgress = Math.min(1, timeAfterLastClick / this.TRANSITION_OUT);
          currentZoomLevel = zoomLevel - (zoomLevel - 1.0) * this.easeInCubic(outProgress);
        }
        // PHASE 3: Holding/Panning (between clicks or holding after click)
        else {
          currentZoomLevel = zoomLevel;
        }
        
        // Get current position with smooth centering during zoom-in
        let position;
        if (timeBeforeFirstClick > 0 && timeBeforeFirstClick <= this.TRANSITION_IN) {
          // During zoom-in phase: smoothly pan from center to clicked position
          const zoomInProgress = 1 - (timeBeforeFirstClick / this.TRANSITION_IN);
          const easedProgress = this.easeOutCubic(zoomInProgress);
          
          // Start from center of screen (or current view center)
          // We'll use the video center as starting point
          const videoCenterX = videoWidth / 2;
          const videoCenterY = videoHeight / 2;
          
          // Smoothly interpolate from center to clicked position
          position = {
            x: videoCenterX + (firstClickPosition.x - videoCenterX) * easedProgress,
            y: videoCenterY + (firstClickPosition.y - videoCenterY) * easedProgress
          };
        } else {
          // Normal panning between clicks (after zoom-in is complete)
          position = this.getPositionAtTime(timestamp, positions);
        }
        
        return {
          active: currentZoomLevel > 1.01,
          level: Math.max(1.0, currentZoomLevel),
          x: position.x,
          y: position.y
        };
      }
    }
    
    // Not in any segment
    return {
      active: false,
      level: 1.0,
      x: 0,
      y: 0
    };
  }

  /**
   * Get smoothly interpolated position - pans between click locations
   */
  getPositionAtTime(timestamp, positions) {
    if (!positions || positions.length === 0) {
      return { x: 0, y: 0 };
    }
    
    if (positions.length === 1) {
      return { x: positions[0].x, y: positions[0].y };
    }
    
    // Before first click - stay at first position
    if (timestamp <= positions[0].timestamp) {
      return { x: positions[0].x, y: positions[0].y };
    }
    
    // After last click - stay at last position
    if (timestamp >= positions[positions.length - 1].timestamp) {
      const last = positions[positions.length - 1];
      return { x: last.x, y: last.y };
    }
    
    // Between clicks - smooth pan
    for (let i = 0; i < positions.length - 1; i++) {
      const current = positions[i];
      const next = positions[i + 1];
      
      if (timestamp >= current.timestamp && timestamp <= next.timestamp) {
        const totalTime = next.timestamp - current.timestamp;
        const elapsed = timestamp - current.timestamp;
        
        // Start panning earlier and complete faster for quicker panning
        const panStart = totalTime * 0.15;  // Start pan at 15% of gap
        const panEnd = totalTime * 0.75;     // Complete pan at 75% of gap
        
        if (elapsed < panStart) {
          // Still at current position
          return { x: current.x, y: current.y };
        } else if (elapsed > panEnd) {
          // Already at next position
          return { x: next.x, y: next.y };
        } else {
          // Panning
          const panProgress = (elapsed - panStart) / (panEnd - panStart);
          const eased = this.easeInOutCubic(panProgress);
          
          return {
            x: current.x + (next.x - current.x) * eased,
            y: current.y + (next.y - current.y) * eased
          };
        }
      }
    }
    
    // Fallback
    return { x: positions[0].x, y: positions[0].y };
  }

  // Easing functions
  easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }
  
  easeInCubic(t) {
    return t * t * t;
  }
  
  easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  generateSummary(zoomSegments) {
    const totalZoomTime = zoomSegments.reduce((sum, seg) => 
      sum + (seg.endTime - seg.startTime), 0
    );
    
    const totalClicks = zoomSegments.reduce((sum, seg) => 
      sum + (seg.clickCount || 1), 0
    );

    return {
      totalSegments: zoomSegments.length,
      totalZoomTime,
      totalClicks
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ZoomAnalyzer;
}
