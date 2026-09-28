// Click clustering: consecutive clicks closer together than this stay in the same "run"
// (one continuous zoomed-in hold that pans between click points) instead of zooming out and back in.
const ZOOM_HOLD_GAP_MS = 2500;

// Ease-in ends exactly AT the click (anticipatory, not reactive) — easeOutCubic (fast start, settles).
const ZOOM_EASE_IN_MS = 450;
// Ease-out starts after a short pause following the run's last click — easeInCubic (slow start, accelerates away).
const ZOOM_POST_HOLD_MS = 600;
const ZOOM_EASE_OUT_MS = 500;

// While zoomed and multiple clicks land in the same run, the focus point pans from one
// click to the next over this window of the gap between them (not an instant jump).
const ZOOM_PAN_START_FRAC = 0.15;
const ZOOM_PAN_END_FRAC = 0.75;

// Keep the zoomed frame from centering exactly on a screen edge/corner.
const ZOOM_FOCUS_MIN = 0.06;
const ZOOM_FOCUS_MAX = 0.94;

function easeOutCubic(x) {
  return 1 - Math.pow(1 - x, 3);
}

function easeInCubic(x) {
  return x * x * x;
}

function easeInOutCubic(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp01(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function groupIntoRuns(clickEvents) {
  const runs = [];
  for (const e of clickEvents) {
    const current = runs[runs.length - 1];
    if (current && e.t - current[current.length - 1].t <= ZOOM_HOLD_GAP_MS) {
      current.push(e);
    } else {
      runs.push([e]);
    }
  }
  return runs;
}

/**
 * cursorEvents: [{kind: 'move'|'down'|'click'|'key', nx, ny, t}], t = ms since recording start
 * zoomDepth: target zoom scale, e.g. 1 (off) .. 3 (3x)
 * returns runs: [{ scale, clicks: [{t, nx, ny}, ...] }]
 */
function computeZoomSegments(cursorEvents, zoomDepth) {
  if (!zoomDepth || zoomDepth <= 1) return [];

  const clickEvents = cursorEvents
    .filter((e) => (e.kind === 'down' || e.kind === 'click') && e.nx !== undefined)
    .map((e) => ({ t: e.t, nx: clamp01(e.nx, ZOOM_FOCUS_MIN, ZOOM_FOCUS_MAX), ny: clamp01(e.ny, ZOOM_FOCUS_MIN, ZOOM_FOCUS_MAX) }));
  if (!clickEvents.length) return [];

  return groupIntoRuns(clickEvents).map((clicks) => ({ scale: zoomDepth, clicks }));
}

/**
 * Returns {scale, focusX, focusY} for a given playback time (ms since recording start).
 */
function getTransformAtTime(runs, t) {
  const rest = { scale: 1, focusX: 0.5, focusY: 0.5 };

  for (const run of runs) {
    const clicks = run.clicks;
    const first = clicks[0];
    const last = clicks[clicks.length - 1];
    const easeInStart = first.t - ZOOM_EASE_IN_MS;
    const holdEnd = last.t + ZOOM_POST_HOLD_MS;
    const easeOutEnd = holdEnd + ZOOM_EASE_OUT_MS;

    if (t < easeInStart || t >= easeOutEnd) continue;

    if (t < first.t) {
      const p = (t - easeInStart) / ZOOM_EASE_IN_MS;
      const eased = easeOutCubic(p);
      return {
        scale: lerp(1, run.scale, eased),
        focusX: lerp(0.5, first.nx, eased),
        focusY: lerp(0.5, first.ny, eased),
      };
    }

    if (t <= last.t) {
      for (let i = 0; i < clicks.length - 1; i++) {
        if (t > clicks[i + 1].t) continue;
        const a = clicks[i];
        const b = clicks[i + 1];
        const gap = b.t - a.t;
        const panStart = a.t + gap * ZOOM_PAN_START_FRAC;
        const panSpan = Math.max(1, gap * (ZOOM_PAN_END_FRAC - ZOOM_PAN_START_FRAC));
        const p = clamp01((t - panStart) / panSpan, 0, 1);
        const eased = easeInOutCubic(p);
        return {
          scale: run.scale,
          focusX: lerp(a.nx, b.nx, eased),
          focusY: lerp(a.ny, b.ny, eased),
        };
      }
      return { scale: run.scale, focusX: last.nx, focusY: last.ny };
    }

    if (t < holdEnd) {
      return { scale: run.scale, focusX: last.nx, focusY: last.ny };
    }

    const p = (t - holdEnd) / ZOOM_EASE_OUT_MS;
    const eased = easeInCubic(p);
    return {
      scale: lerp(run.scale, 1, eased),
      focusX: lerp(last.nx, 0.5, eased),
      focusY: lerp(last.ny, 0.5, eased),
    };
  }

  return rest;
}
