/**
 * Content script injected into web pages.
 * Captures DOM-level user activity events and triggers snapshots.
 */

const CAPTURE_DEBOUNCE_MS = 500;

let debounceTimer = null;

/**
 * Debounces snapshot requests so rapid events produce a single capture.
 */
function triggerCapture() {
  clearTimeout(debounceTimer);

  debounceTimer = setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'TAKE_SNAPSHOT' });
  }, CAPTURE_DEBOUNCE_MS);
}

function initializeActivityObservers() {
  const mutationObserver = new MutationObserver(() => {
    triggerCapture();
  });

  mutationObserver.observe(document.body, {
    childList: true,
    attributes: true,
    subtree: true,
  });

  document.addEventListener('click', triggerCapture, true);
  window.addEventListener('scroll', triggerCapture, { capture: true, passive: true });
}

if (document.body) {
  initializeActivityObservers();
} else {
  document.addEventListener('DOMContentLoaded', initializeActivityObservers);
}
