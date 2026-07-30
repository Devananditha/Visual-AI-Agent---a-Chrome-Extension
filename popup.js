/**
 * Popup UI logic for Visual AI Agent.
 */

document.addEventListener('DOMContentLoaded', () => {
  const startButton = document.getElementById('start-tracking');
  const stopButton = document.getElementById('stop-tracking');

  startButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'START_TRACKING' });
  });

  stopButton.addEventListener('click', () => {
    // Tracking stop logic will be implemented in a later phase.
  });
});
