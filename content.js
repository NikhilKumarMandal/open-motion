(() => {
  if (window.__openMotionTrackerActive) return;
  window.__openMotionTrackerActive = true;

  const MOVE_INTERVAL_MS = 33; // ~30Hz
  let lastMoveSent = 0;

  function send(kind, x, y) {
    const event = { kind, t: Date.now() };
    if (x !== undefined) {
      event.nx = x / window.innerWidth;
      event.ny = y / window.innerHeight;
    }
    try {
      chrome.runtime.sendMessage({ type: 'om-cursor-event', event });
    } catch (err) {
      // extension context can be gone if this tab outlives the recording session
    }
  }

  function onMouseMove(e) {
    const now = Date.now();
    if (now - lastMoveSent < MOVE_INTERVAL_MS) return;
    lastMoveSent = now;
    send('move', e.clientX, e.clientY);
  }

  function onMouseDown(e) {
    send('down', e.clientX, e.clientY);
  }

  function onClick(e) {
    send('click', e.clientX, e.clientY);
  }

  function onKeyDown() {
    send('key');
  }

  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKeyDown, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'om-stop-tracking') {
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.__openMotionTrackerActive = false;
    }
  });
})();
