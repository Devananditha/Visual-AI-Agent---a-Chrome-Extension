/**
 * Background service worker for Visual AI Agent.
 * Manages offscreen document lifecycle and heartbeat coordination.
 */

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

/**
 * Returns true if the offscreen document is already open.
 */
async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });

  return contexts.length > 0;
}

/**
 * Creates the offscreen document used for continuous tab capture.
 * Reason USER_MEDIA is required for getUserMedia-based stream handling.
 */
async function createOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Capture browser tab video stream for visual AI activity monitoring.',
  });
}

/**
 * Starts tab capture by creating the offscreen document and forwarding the stream ID.
 */
async function startTabCapture() {
  await createOffscreenDocument();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('No active tab found for capture.');
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });

  await chrome.runtime.sendMessage({
    type: 'START_STREAM',
    streamId,
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'keepAlive') {
    console.log(
      '[Background] Heartbeat received from offscreen document at',
      new Date().toISOString(),
    );
    return;
  }

  if (message.type === 'START_TRACKING') {
    startTabCapture().catch((error) => {
      console.error('[Background] Failed to start tab capture:', error);
    });
  }
});
