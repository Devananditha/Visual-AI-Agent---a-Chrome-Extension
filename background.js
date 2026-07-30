/**
 * Background service worker for Visual AI Agent.
 * Manages offscreen document lifecycle and heartbeat coordination.
 */

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const AUTH_URL = 'http://localhost:3000/api/auth';
const WEBSOCKET_BASE_URL = 'ws://localhost:3000/vision-stream';
const AUTH_USERNAME = 'visual-ai-agent';
const AUTH_PASSWORD = 'extension-secret';
const MAX_PAYLOAD_CHARS = 400000;

let isCapturing = false;
let jwtToken = null;

/**
 * WebSocket wrapper with exponential backoff and jitter reconnection.
 */
class ReconnectingWebSocket {
  constructor() {
    this.maxAttempts = 10;
    this.currentAttempt = 0;
    this.baseDelay = 500;
    this.url = null;
    this.socket = null;
    this.reconnectTimer = null;
    this.shouldReconnect = false;
    this.pendingMessages = [];
  }

  connect(url) {
    this.url = url;
    this.shouldReconnect = true;
    this.currentAttempt = 0;
    this.openConnection();
  }

  openConnection() {
    if (!this.url) {
      return;
    }

    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }

    try {
      const ws = new WebSocket(this.url);
      this.socket = ws;

      ws.onopen = () => {
        console.log('[Background] WebSocket connected.');
        this.currentAttempt = 0;
        this.flushPendingMessages();
      };

      ws.onerror = (error) => {
        console.error('[Background] WebSocket error:', error);
        this.reconnect();
      };

      ws.onclose = () => {
        this.socket = null;

        if (this.shouldReconnect) {
          this.reconnect();
        }
      };
    } catch (error) {
      console.error('[Background] WebSocket connection failed:', error);
      this.reconnect();
    }
  }

  reconnect() {
    if (!this.shouldReconnect || !this.url) {
      return;
    }

    if (this.currentAttempt >= this.maxAttempts) {
      console.error('[Background] WebSocket max reconnect attempts reached.');
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    const delay = Math.min(this.baseDelay * Math.pow(2, this.currentAttempt), 30000)
      + Math.random() * 1000;

    console.log(
      `[Background] WebSocket reconnect scheduled in ${Math.round(delay)}ms`,
      `(attempt ${this.currentAttempt + 1}/${this.maxAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.currentAttempt += 1;
      this.openConnection();
    }, delay);
  }

  send(data) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(data);
      return;
    }

    this.pendingMessages.push(data);

    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      this.reconnect();
    }
  }

  flushPendingMessages() {
    while (
      this.pendingMessages.length > 0
      && this.socket
      && this.socket.readyState === WebSocket.OPEN
    ) {
      this.socket.send(this.pendingMessages.shift());
    }
  }

  disconnect() {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }

    this.pendingMessages = [];
    this.currentAttempt = 0;
    this.url = null;
  }
}

const visionStream = new ReconnectingWebSocket();

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
 * Connects the authenticated vision stream WebSocket.
 */
function connectVisionStream(token) {
  const websocketUrl = `${WEBSOCKET_BASE_URL}?token=${token}`;
  visionStream.connect(websocketUrl);
}

/**
 * Sends a captured frame payload to the backend over WebSocket.
 */
function sendFrameToServer(frame, timestamp) {
  const payload = JSON.stringify({
    timestamp,
    frame,
  });

  if (payload.length > MAX_PAYLOAD_CHARS) {
    console.error('[Background] Frame payload exceeds safe size limit, skipping send.');
    return;
  }

  visionStream.send(payload);
}

/**
 * Starts tab capture by creating the offscreen document and forwarding the stream ID.
 */
async function startTabCapture() {
  const token = await fetchAuthToken();
  connectVisionStream(token);

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
  });
}

/**
 * Stops tab capture and closes the offscreen document to release the media stream.
 */
async function stopTabCapture() {
  visionStream.disconnect();
  jwtToken = null;

  if (!(await hasOffscreenDocument())) {
    return;
  }

  await chrome.offscreen.closeDocument();
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

  if (message.type === 'FRAME_DATA' && message.frame && message.timestamp) {
    sendFrameToServer(message.frame, message.timestamp);
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
