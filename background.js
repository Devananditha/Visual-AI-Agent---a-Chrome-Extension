/**
 * Background service worker for Visual AI Agent.
 * Manages offscreen document lifecycle and heartbeat coordination.
 */

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const AUTH_URL = 'http://localhost:3000/api/auth';
const AUTH_USERNAME = 'visual-ai-agent';
const AUTH_PASSWORD = 'extension-secret';

let isCapturing = false;
let jwtToken = null;

/**
 * Fetches a JWT from the backend auth endpoint and stores it in memory.
 */
async function fetchAuthToken() {
  try {
    const response = await fetch(AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: AUTH_USERNAME,
        password: AUTH_PASSWORD,
      }),
    });

    if (!response.ok) {
      throw new Error(`Auth request failed with status ${response.status}`);
    }

    const data = await response.json();

    if (!data.token) {
      throw new Error('Auth response did not include a token.');
    }

    jwtToken = data.token;
    console.log('[Background] JWT fetched successfully.');
    return jwtToken;
  } catch (error) {
    console.error('[Background] Failed to fetch JWT:', error);
    throw error;
  }
}

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
 * Sends a message to the offscreen document with short retries while it initializes.
 */
async function sendToOffscreen(message) {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await chrome.runtime.sendMessage(message);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError;
}

/**
 * Starts tab capture by creating the offscreen document and forwarding the stream ID.
 */
async function startTabCapture() {
  const token = await fetchAuthToken();

  if (!(await hasOffscreenDocument())) {
    await createOffscreenDocument();
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('No active tab found for capture.');
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });

  await sendToOffscreen({
    type: 'START_STREAM',
    streamId,
    token,
  });
}

/**
 * Stops tab capture and closes the offscreen document to release the media stream.
 */
async function stopTabCapture() {
  if (!(await hasOffscreenDocument())) {
    return;
  }

  await chrome.offscreen.closeDocument();
  jwtToken = null;
}

/**
 * Forwards snapshot requests to the offscreen document when it is available.
 */
async function routeSnapshotToOffscreen() {
  try {
    if (!(await hasOffscreenDocument())) {
      return;
    }

    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_SNAPSHOT' });
  } catch {
    // Offscreen document is not ready to receive messages yet.
  }
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
    return;
  }

  if (message.type === 'STOP_TRACKING') {
    stopTabCapture().catch((error) => {
      console.error('[Background] Failed to stop tab capture:', error);
    });
    return;
  }

  if (message.type === 'TAKE_SNAPSHOT') {
    if (isCapturing) {
      return;
    }

    isCapturing = true;
    routeSnapshotToOffscreen();

    setTimeout(() => {
      isCapturing = false;
    }, 1000);
  }
});
