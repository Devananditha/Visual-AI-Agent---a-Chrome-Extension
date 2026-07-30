/**
 * Offscreen document logic for continuous tab video capture.
 */

const TARGET_FRAME_WIDTH = 1024;
const JPEG_QUALITY = 0.5;
const MAX_PAYLOAD_CHARS = 400000;
const WEBSOCKET_BASE_URL = 'ws://localhost:3000/vision-stream';

const videoElement = document.getElementById('capture-stream');
const frameCanvas = document.getElementById('frame-canvas');
const frameContext = frameCanvas.getContext('2d');

let visionSocket = null;
let jwtToken = null;

/**
 * Returns true when the video element has a drawable frame.
 */
function videoHasFrameData() {
  return (
    videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    videoElement.videoWidth > 0 &&
    videoElement.videoHeight > 0
  );
}

/**
 * Draws the current video frame onto the canvas, downscaled to 1024px width.
 * @returns {string|null} Base64 JPEG data URL, or null if no frame is available.
 */
function extractFrame() {
  if (!videoHasFrameData()) {
    return null;
  }

  const scale = TARGET_FRAME_WIDTH / videoElement.videoWidth;
  const targetHeight = Math.round(videoElement.videoHeight * scale);

  frameCanvas.width = TARGET_FRAME_WIDTH;
  frameCanvas.height = targetHeight;

  frameContext.drawImage(
    videoElement,
    0,
    0,
    TARGET_FRAME_WIDTH,
    targetHeight,
  );

  return frameCanvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

/**
 * Opens an authenticated WebSocket connection after JWT is available.
 */
function connectVisionStream() {
  if (!jwtToken) {
    console.error('[Offscreen] Cannot connect WebSocket without JWT token.');
    return;
  }

  if (visionSocket) {
    visionSocket.close();
    visionSocket = null;
  }

  try {
    const ws = new WebSocket(`${WEBSOCKET_BASE_URL}?token=${jwtToken}`);
    visionSocket = ws;

    ws.addEventListener('open', () => {
      console.log('[Offscreen] WebSocket connected with JWT.');
    });

    ws.addEventListener('error', (error) => {
      console.error('[Offscreen] WebSocket connection error:', error);
    });

    ws.addEventListener('close', () => {
      visionSocket = null;
    });
  } catch (error) {
    console.error('[Offscreen] Failed to open WebSocket connection:', error);
    visionSocket = null;
  }
}

/**
 * Sends a captured frame and timestamp to the backend over WebSocket.
 * @param {string} base64Frame
 */
function sendFrameToServer(base64Frame) {
  if (!jwtToken) {
    console.error('[Offscreen] Cannot send frame without JWT token.');
    return;
  }

  const commaIndex = base64Frame.indexOf(',');
  const frameData = commaIndex >= 0 ? base64Frame.slice(commaIndex + 1) : base64Frame;

  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    frame: frameData,
  });

  if (payload.length > MAX_PAYLOAD_CHARS) {
    console.error('[Offscreen] Frame payload exceeds safe size limit, skipping send.');
    return;
  }

  try {
    if (!visionSocket || visionSocket.readyState === WebSocket.CLOSED) {
      connectVisionStream();
    }

    if (!visionSocket) {
      return;
    }

    if (visionSocket.readyState === WebSocket.OPEN) {
      visionSocket.send(payload);
      return;
    }

    visionSocket.addEventListener('open', () => {
      visionSocket.send(payload);
    }, { once: true });
  } catch (error) {
    console.error('[Offscreen] Failed to send frame to server:', error);
  }
}

/**
 * Binds a tab capture stream to the hidden video element.
 * @param {string} streamId - Media stream ID from chrome.tabCapture.getMediaStreamId
 * @param {string} token - JWT used to authenticate the WebSocket connection
 */
async function startCaptureStream(streamId, token) {
  jwtToken = token;

  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  videoElement.srcObject = mediaStream;
  await videoElement.play();
  connectVisionStream();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'START_STREAM' && message.streamId && message.token) {
    startCaptureStream(message.streamId, message.token).catch((error) => {
      console.error('[Offscreen] Failed to start capture stream:', error);
    });
    return;
  }

  if (message.type === 'OFFSCREEN_SNAPSHOT') {
    const base64Frame = extractFrame();

    if (base64Frame) {
      sendFrameToServer(base64Frame);
    }
  }
});

setInterval(() => {
  chrome.runtime.sendMessage({ type: 'keepAlive' }).catch((error) => {
    console.error('[Offscreen] Failed to send heartbeat:', error);
  });
}, 20000);
