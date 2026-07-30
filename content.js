/**
 * Content script injected into web pages.
 * Captures DOM-level user activity events and triggers snapshots.
 */

function triggerCapture() {
  chrome.runtime.sendMessage({ type: 'TAKE_SNAPSHOT' });
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
