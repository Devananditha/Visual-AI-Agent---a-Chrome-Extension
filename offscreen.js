/**
 * Offscreen document logic for continuous tab video capture.
 */

const TARGET_FRAME_WIDTH = 1024;
const JPEG_QUALITY = 0.5;

const videoElement = document.getElementById('capture-stream');
const frameCanvas = document.getElementById('frame-canvas');
const frameContext = frameCanvas.getContext('2d');

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
 * Sends extracted frame data to the background service worker for WebSocket delivery.
 * @param {string} base64Frame
 */
function sendFrameToBackground(base64Frame) {
  const commaIndex = base64Frame.indexOf(',');
  const frameData = commaIndex >= 0 ? base64Frame.slice(commaIndex + 1) : base64Frame;

  chrome.runtime.sendMessage({
    type: 'FRAME_DATA',
    timestamp: new Date().toISOString(),
    frame: frameData,
  }).catch((error) => {
    console.error('[Offscreen] Failed to send frame to background:', error);
  });
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
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'START_STREAM' && message.streamId) {
    startCaptureStream(message.streamId).catch((error) => {
      console.error('[Offscreen] Failed to start capture stream:', error);
    });
    return;
  }

  if (message.type === 'OFFSCREEN_SNAPSHOT') {
    const base64Frame = extractFrame();

    if (base64Frame) {
      sendFrameToBackground(base64Frame);
    }
  }
});

setInterval(() => {
  chrome.runtime.sendMessage({ type: 'keepAlive' }).catch((error) => {
    console.error('[Offscreen] Failed to send heartbeat:', error);
  });
}, 20000);
