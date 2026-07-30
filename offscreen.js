/**
 * Offscreen document logic for continuous tab video capture.
 */

const videoElement = document.getElementById('capture-stream');
const frameCanvas = document.getElementById('frame-canvas');

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
  if (message.type !== 'START_STREAM' || !message.streamId) {
    return;
  }

  startCaptureStream(message.streamId).catch((error) => {
    console.error('[Offscreen] Failed to start capture stream:', error);
  });
});

setInterval(() => {
  chrome.runtime.sendMessage({ type: 'keepAlive' }).catch((error) => {
    console.error('[Offscreen] Failed to send heartbeat:', error);
  });
}, 20000);
