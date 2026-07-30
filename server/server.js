const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const jwt = require('jsonwebtoken');
const path = require('path');
const readline = require('readline');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.JWT_SECRET || 'visual-ai-agent-dev-secret-key';
const AUTH_USERNAME = 'visual-ai-agent';
const AUTH_PASSWORD = 'extension-secret';
const DATA_DIR = path.join(__dirname, 'data');
const ACTIVITY_LOG_PATH = path.join(DATA_DIR, 'activity-log.ndjson');
const ACTIVITY_LOG_TMP_PATH = path.join(DATA_DIR, 'activity-log.tmp.ndjson');
const LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const app = express();

let writeQueue = Promise.resolve();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.post('/api/auth', (request, response) => {
  console.log('[Server] Token requested');
  const { username, password } = request.body;

  if (username !== AUTH_USERNAME || password !== AUTH_PASSWORD) {
    response.status(401).json({ error: 'Invalid credentials.' });
    return;
  }

  const token = jwt.sign(
    { sub: username },
    SECRET_KEY,
    { expiresIn: '24h' },
  );

  response.json({ token });
});

app.get('/api/activity', async (_request, response) => {
  try {
    try {
      await fsp.access(ACTIVITY_LOG_PATH);
    } catch {
      response.json([]);
      return;
    }

    const fileContent = await fsp.readFile(ACTIVITY_LOG_PATH, 'utf8');
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
  await fsp.mkdir(DATA_DIR, { recursive: true });

  try {
    await fsp.access(ACTIVITY_LOG_PATH);
  } catch {
    await fsp.writeFile(ACTIVITY_LOG_PATH, '', 'utf8');
  }
}

/**
 * Streams the NDJSON activity log and removes records older than 30 days.
 */
async function purgeOldLogs() {
  await writeQueue;

  try {
    if (!fs.existsSync(ACTIVITY_LOG_PATH)) {
      return;
    }

    const cutoff = Date.now() - LOG_TTL_MS;
    const readStream = fs.createReadStream(ACTIVITY_LOG_PATH, { encoding: 'utf8' });
    const writeStream = fs.createWriteStream(ACTIVITY_LOG_TMP_PATH, { encoding: 'utf8' });
    const lineReader = readline.createInterface({
      input: readStream,
      crlfDelay: Infinity,
    });

    let keptRecords = 0;
    let removedRecords = 0;

    for await (const line of lineReader) {
      if (!line.trim()) {
        continue;
      }

      try {
        const record = JSON.parse(line);
        const recordTime = new Date(record.timestamp).getTime();

        if (Number.isNaN(recordTime)) {
          continue;
        }

        if (recordTime > cutoff) {
          writeStream.write(`${line}\n`);
          keptRecords += 1;
        } else {
          removedRecords += 1;
        }
      } catch {
        // Skip malformed lines during purge.
      }
    }

    await new Promise((resolve, reject) => {
      writeStream.on('error', reject);
      writeStream.end(resolve);
    });

    fs.renameSync(ACTIVITY_LOG_TMP_PATH, ACTIVITY_LOG_PATH);
    console.log(
      `[Server] TTL purge complete. Removed ${removedRecords} records, kept ${keptRecords}.`,
    );
  } catch (error) {
    console.error('[Server] Failed to purge old logs:', error);

    if (fs.existsSync(ACTIVITY_LOG_TMP_PATH)) {
      fs.unlinkSync(ACTIVITY_LOG_TMP_PATH);
    }
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

  writeQueue = writeQueue.then(() => fsp.appendFile(ACTIVITY_LOG_PATH, `${entry}\n`, 'utf8'));
  await writeQueue;
}

const server = http.createServer(app);

const visionStreamServer = new WebSocketServer({
  server,
  path: '/vision-stream',
  maxPayload: 16 * 1024 * 1024,
  verifyClient: (info, done) => {
    try {
      const requestUrl = new URL(info.req.url, `http://${info.req.headers.host}`);
      const token = requestUrl.searchParams.get('token');

      if (!token) {
        console.warn('[Server] WebSocket rejected: missing token');
        if (info.req.socket) {
          info.req.socket.destroy();
        }
        done(false, 401, 'Unauthorized');
        return;
      }

      jwt.verify(token, SECRET_KEY);
      done(true);
    } catch (error) {
      console.warn('[Server] WebSocket rejected: invalid token');
      if (info.req.socket) {
        info.req.socket.destroy();
      }
      done(false, 401, 'Unauthorized');
    }
  },
});

visionStreamServer.on('connection', (socket, request) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const token = requestUrl.searchParams.get('token');

    if (!token) {
      socket.destroy();
      return;
    }

    jwt.verify(token, SECRET_KEY);
  } catch {
    socket.destroy();
    return;
  }

  console.log('[Server] WebSocket client connected on /vision-stream?token=***');

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

  purgeOldLogs().catch((error) => {
    console.error('[Server] Startup TTL purge failed:', error);
  });

  setInterval(() => {
    purgeOldLogs().catch((error) => {
      console.error('[Server] Scheduled TTL purge failed:', error);
    });
  }, PURGE_INTERVAL_MS);

  console.log(`[Server] HTTP server listening on http://localhost:${PORT}`);
  console.log(`[Server] WebSocket endpoint available at ws://localhost:${PORT}/vision-stream`);
  console.log(`[Server] Activity log path: ${ACTIVITY_LOG_PATH}`);
});
