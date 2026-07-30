const express = require('express');
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const ACTIVITY_LOG_PATH = path.join(DATA_DIR, 'activity-log.ndjson');

const app = express();

let writeQueue = Promise.resolve();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.get('/api/activity', async (_request, response) => {
  try {
    try {
      await fs.access(ACTIVITY_LOG_PATH);
    } catch {
      response.json([]);
      return;
    }

    const fileContent = await fs.readFile(ACTIVITY_LOG_PATH, 'utf8');
    const activity = fileContent
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    response.json(activity);
  } catch (error) {
    console.error('[Server] Failed to read activity log:', error);
    response.status(500).json({ error: 'Failed to read activity log.' });
  }
});

/**
 * Ensures the data directory and activity log file exist.
 */
async function ensureActivityLogFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(ACTIVITY_LOG_PATH);
  } catch {
    await fs.writeFile(ACTIVITY_LOG_PATH, '', 'utf8');
  }
}

/**
 * Appends a frame record to the local NDJSON activity log.
 * Uses line-delimited JSON to avoid re-parsing large files on every write.
 * @param {{ timestamp: string, frame: string }} record
 */
async function appendActivityRecord(record) {
  await ensureActivityLogFile();

  const entry = JSON.stringify({
    timestamp: record.timestamp,
    frameLength: record.frame.length,
    frame: record.frame,
  });

  writeQueue = writeQueue.then(() => fs.appendFile(ACTIVITY_LOG_PATH, `${entry}\n`, 'utf8'));
  await writeQueue;
}

const server = http.createServer(app);

const visionStreamServer = new WebSocketServer({
  server,
  path: '/vision-stream',
  maxPayload: 16 * 1024 * 1024,
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
  console.log(`[Server] Activity log path: ${ACTIVITY_LOG_PATH}`);
});
