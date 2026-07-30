const express = require('express');
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const ACTIVITY_LOG_PATH = path.join(DATA_DIR, 'activity-log.json');

const app = express();

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

/**
 * Ensures the data directory and activity log file exist.
 */
async function ensureActivityLogFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(ACTIVITY_LOG_PATH);
  } catch {
    await fs.writeFile(ACTIVITY_LOG_PATH, '[]', 'utf8');
  }
}

/**
 * Appends a frame record to the local JSON activity log.
 * @param {{ timestamp: string, frame: string }} record
 */
async function appendActivityRecord(record) {
  await ensureActivityLogFile();

  const existingContent = await fs.readFile(ACTIVITY_LOG_PATH, 'utf8');
  const activityLog = JSON.parse(existingContent);

  activityLog.push({
    timestamp: record.timestamp,
    frameLength: record.frame.length,
    frame: record.frame,
  });

  await fs.writeFile(ACTIVITY_LOG_PATH, JSON.stringify(activityLog, null, 2), 'utf8');
}

const server = http.createServer(app);

const visionStreamServer = new WebSocketServer({
  server,
  path: '/vision-stream',
});

visionStreamServer.on('connection', (socket) => {
  console.log('[Server] WebSocket client connected on /vision-stream');

  socket.on('message', async (rawMessage) => {
    try {
      const payload = JSON.parse(rawMessage.toString());

      if (!payload.timestamp || !payload.frame) {
        socket.send(JSON.stringify({
          status: 'error',
          message: 'Payload must include timestamp and frame fields.',
        }));
        return;
      }

      await appendActivityRecord({
        timestamp: payload.timestamp,
        frame: payload.frame,
      });

      console.log(
        '[Server] Saved frame at',
        payload.timestamp,
        `(length: ${payload.frame.length})`,
      );

      socket.send(JSON.stringify({ status: 'ok' }));
    } catch (error) {
      console.error('[Server] Failed to process frame payload:', error);
      socket.send(JSON.stringify({
        status: 'error',
        message: 'Failed to process frame payload.',
      }));
    }
  });

  socket.on('close', () => {
    console.log('[Server] WebSocket client disconnected');
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[Server] Port ${PORT} is already in use. Stop the existing process or set PORT to another value.`);
    process.exit(1);
  }

  console.error('[Server] Failed to start server:', error);
  process.exit(1);
});

server.listen(PORT, async () => {
  await ensureActivityLogFile();
  console.log(`[Server] HTTP server listening on http://localhost:${PORT}`);
  console.log(`[Server] WebSocket endpoint available at ws://localhost:${PORT}/vision-stream`);
});
