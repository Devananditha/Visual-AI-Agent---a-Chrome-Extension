/**
 * Offscreen document logic for continuous tab video capture.
 */

const TARGET_FRAME_WIDTH = 1024;
const JPEG_QUALITY = 0.6;
const WEBSOCKET_URL = 'ws://localhost:3000/vision-stream';

const videoElement = document.getElementById('capture-stream');
const frameCanvas = document.getElementById('frame-canvas');
const frameContext = frameCanvas.getContext('2d');

let visionSocket = null;

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
 * Opens a WebSocket connection to the backend vision stream endpoint.
 */
function connectVisionStream() {
  if (visionSocket && (
    visionSocket.readyState === WebSocket.OPEN ||
    visionSocket.readyState === WebSocket.CONNECTING
  )) {
    return;
  }

  try {
    visionSocket = new WebSocket(WEBSOCKET_URL);

    visionSocket.addEventListener('error', (error) => {
      console.error('[Offscreen] WebSocket connection error:', error);
    });

    visionSocket.addEventListener('close', () => {
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
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    frame: base64Frame,
  });

  try {
    connectVisionStream();

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
 */
async function startCaptureStream(streamId) {
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
  if (message.type === 'START_STREAM' && message.streamId) {
    startCaptureStream(message.streamId).catch((error) => {
      console.error('[Offscreen] Failed to start capture stream:', error);
    });
    return;
  }

  if (message.type === 'TAKE_SNAPSHOT') {
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
