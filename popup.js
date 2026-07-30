/**
 * Popup UI logic for Visual AI Agent.
 */

document.addEventListener('DOMContentLoaded', () => {
  const startButton = document.getElementById('start-tracking');
  const stopButton = document.getElementById('stop-tracking');

  startButton.addEventListener('click', () => {
    startButton.disabled = true;
    stopButton.disabled = false;
    chrome.runtime.sendMessage({ type: 'START_TRACKING' });
  });

  stopButton.addEventListener('click', () => {
    startButton.disabled = false;
    stopButton.disabled = true;
    chrome.runtime.sendMessage({ type: 'STOP_TRACKING' });
  });
});
