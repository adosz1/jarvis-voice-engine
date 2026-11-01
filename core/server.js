import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { GeminiLiveSession, PRIMARY_MODEL, FALLBACK_MODEL } from './gemini-live.js';
import { setupTwilioBridge, triggerTwilioOutboundCallback } from './twilio-bridge.js';
import { jobManager } from './job-manager.js';
import { loadProjects, executeToolCall } from '../tools/tool-registry.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');

const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Track connected UI / voice stream clients and active Gemini Live sessions
const activeClients = new Set();
const activeGeminiSessions = new Set();

function broadcastToClients(payload) {
  const data = JSON.stringify(payload);
  for (const client of activeClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// Mount Phase 2 Twilio Voice Webhook (/twilio/voice) & Media Stream WebSocket (/twilio/media)
const { twilioWss } = setupTwilioBridge({
  app,
  activeGeminiSessions,
  broadcastToClients
});

server.on('upgrade', (request, socket, head) => {
  try {
    const pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;

    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (pathname === '/twilio/media') {
      twilioWss.handleUpgrade(request, socket, head, (ws) => {
        twilioWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  } catch {
    socket.destroy();
  }
});

// Forward JobManager lifecycle events to all connected UI clients
jobManager.on('job_created', (job) => {
  broadcastToClients({
    type: 'job_event',
    event: 'created',
    job,
    jobs: jobManager.getAllJobs()
  });
});

jobManager.on('job_updated', (job) => {
  broadcastToClients({
    type: 'job_event',
    event: 'updated',
    job,
    jobs: jobManager.getAllJobs()
  });
});

jobManager.on('job_finished', (job) => {
  broadcastToClients({
    type: 'callback_log',
    level: job.status === 'completed' ? 'success' : 'error',
    message: `[Callback] Background job ${job.job_id} (${job.project_name}) ${job.status}: ${job.result_summary}`,
    job,
    timestamp: new Date().toISOString()
  });
});

// Health & status endpoints for Render / Cloudflare & Control Panel
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Jarvis Voice Engine', timestamp: new Date().toISOString() });
});

app.get('/api/status', (req, res) => {
  const hasApiKey = Boolean(
    process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here'
  );
  res.json({
    status: 'online',
    engine: 'Jarvis Voice Engine (Phase 3 - 24/7 Cloud + Cloudflare Auto-Deploy)',
    primary_model: PRIMARY_MODEL,
    fallback_model: FALLBACK_MODEL,
    twilio_voice_webhook: '/twilio/voice',
    twilio_media_stream: '/twilio/media',
    dry_run: String(process.env.DRY_RUN).toLowerCase() === 'true',
    api_key_configured: hasApiKey,
    projects: loadProjects(),
    jobs: jobManager.getAllJobs()
  });
});

app.get('/api/projects', (req, res) => {
  res.json({ projects: loadProjects() });
});

app.get('/api/jobs', (req, res) => {
  res.json({ jobs: jobManager.getAllJobs() });
});

// Direct manual tool test endpoint so user can also test background jobs & callbacks from UI
app.post('/api/tools/dispatch', async (req, res) => {
  try {
    const { tool_name = 'dispatch_coding_task', args = {} } = req.body || {};
    const result = await executeToolCall(tool_name, args, {
      activeProject: args.project_name || 'CoeliSafe',
      onJobCompletedCallback: (completedJob) => {
        if (activeGeminiSessions.size > 0) {
          for (const liveSession of activeGeminiSessions) {
            liveSession.notifyBackgroundJobCompletion(completedJob);
          }
        } else {
          triggerTwilioOutboundCallback(completedJob, broadcastToClients);
        }
      }
    });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// WebSocket handler for Browser Mic Testbench (and modular hook for future Twilio Media Streams)
wss.on('connection', (ws) => {
  activeClients.add(ws);
  let geminiSession = null;
  let currentProject = 'CoeliSafe';

  const sendJson = (obj) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  };

  // Send initial state snapshot on connection
  sendJson({
    type: 'init',
    projects: loadProjects(),
    jobs: jobManager.getAllJobs(),
    dry_run: String(process.env.DRY_RUN).toLowerCase() === 'true',
    primary_model: PRIMARY_MODEL,
    fallback_model: FALLBACK_MODEL,
    api_key_configured: Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here'
    )
  });

  ws.on('message', async (rawData, isBinary) => {
    try {
      // Binary frame support: raw 16kHz 16-bit mono PCM audio buffer from microphone
      if (isBinary) {
        if (geminiSession && geminiSession.isConnected) {
          const base64Pcm = Buffer.from(rawData).toString('base64');
          geminiSession.sendRealtimeAudio(base64Pcm);
        }
        return;
      }

      const msg = JSON.parse(rawData.toString());

      switch (msg.type) {
        case 'start_call': {
          if (geminiSession) {
            activeGeminiSessions.delete(geminiSession);
            geminiSession.close();
            geminiSession = null;
          }

          currentProject = msg.activeProject || currentProject;

          geminiSession = new GeminiLiveSession({
            activeProject: currentProject,
            onAudioChunk: (base64Pcm, mimeType) => {
              sendJson({
                type: 'audio_out',
                data: base64Pcm,
                mimeType
              });
            },
            onInterrupted: () => {
              sendJson({
                type: 'interrupted',
                timestamp: new Date().toISOString()
              });
            },
            onTranscript: ({ role, text }) => {
              sendJson({
                type: 'transcript',
                role,
                text,
                timestamp: new Date().toISOString()
              });
            },
            onStatus: ({ status, model, message }) => {
              sendJson({
                type: 'call_status',
                status,
                model,
                message,
                timestamp: new Date().toISOString()
              });
            },
            onToolEvent: (event) => {
              sendJson({
                type: 'tool_event',
                event
              });
            }
          });

          try {
            const connectedModel = await geminiSession.connect();
            activeGeminiSessions.add(geminiSession);
            sendJson({
              type: 'callback_log',
              level: 'info',
              message: `[Voice Session] Connected to Gemini Live (${connectedModel}) for project "${currentProject}".`,
              timestamp: new Date().toISOString()
            });
          } catch (err) {
            sendJson({
              type: 'call_status',
              status: 'error',
              message: err.message
            });
            sendJson({
              type: 'callback_log',
              level: 'error',
              message: `[Voice Session Error] ${err.message}`,
              timestamp: new Date().toISOString()
            });
          }
          break;
        }

        case 'audio_in': {
          // Base64 16kHz PCM audio chunk
          if (geminiSession && geminiSession.isConnected && msg.data) {
            geminiSession.sendRealtimeAudio(msg.data);
          }
          break;
        }

        case 'text_in': {
          // Optional text message injection into live voice session
          if (geminiSession && geminiSession.isConnected && msg.text) {
            geminiSession.sendTextPrompt(msg.text, true);
          }
          break;
        }

        case 'select_project': {
          currentProject = msg.project_name || 'CoeliSafe';
          if (geminiSession) {
            geminiSession.setActiveProject(currentProject);
          }
          sendJson({
            type: 'callback_log',
            level: 'info',
            message: `[Context] Switched active project to "${currentProject}".`,
            timestamp: new Date().toISOString()
          });
          break;
        }

        case 'end_call': {
          if (geminiSession) {
            activeGeminiSessions.delete(geminiSession);
            geminiSession.close();
            geminiSession = null;
          }
          sendJson({
            type: 'call_status',
            status: 'disconnected',
            message: 'Call ended.'
          });
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('[Server WS] Message handling error:', err.message);
    }
  });

  ws.on('close', () => {
    activeClients.delete(ws);
    if (geminiSession) {
      activeGeminiSessions.delete(geminiSession);
      geminiSession.close();
      geminiSession = null;
    }
  });
});

server.listen(PORT, async () => {
  const externalUrl = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '').replace(/\/$/, '');
  console.log(`============================================================`);
  console.log(`  JARVIS VOICE ENGINE — PHASE 3 (24/7 CLOUD + CLOUDFLARE)`);
  console.log(`  Local Control Panel : ${externalUrl || `http://localhost:${PORT}`}`);
  console.log(`  UI WebSocket        : ${externalUrl ? externalUrl.replace(/^http/, 'ws') : `ws://localhost:${PORT}`}/ws`);
  console.log(`  Twilio Voice Hook   : ${externalUrl || `http://localhost:${PORT}`}/twilio/voice`);
  console.log(`  Twilio Media WS     : ${externalUrl ? externalUrl.replace(/^http/, 'ws') : `ws://localhost:${PORT}`}/twilio/media`);
  console.log(`  Primary Live Model  : ${PRIMARY_MODEL}`);
  console.log(`  J.A.R.V.I.S. Voice  : ${process.env.JARVIS_VOICE || 'Charon'} (British RP)`);
  console.log(`  Dry Run Mode        : ${String(process.env.DRY_RUN).toLowerCase() === 'true'}`);
  console.log(`============================================================`);

  if (externalUrl) {
    // 1. Keep Render Free Tier warm with a 10-minute external self-ping
    setInterval(() => {
      fetch(`${externalUrl}/health`).catch(() => {});
    }, 10 * 60 * 1000);

    // 2. Automatically point Twilio phone number webhook to this 24/7 Cloud URL
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const phoneNumber = process.env.TWILIO_PHONE_NUMBER;
    if (accountSid && authToken && phoneNumber) {
      try {
        const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
        const listUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`;
        const listRes = await fetch(listUrl, { headers: { Authorization: `Basic ${basicAuth}` } });
        if (listRes.ok) {
          const listData = await listRes.json();
          const numObj = (listData.incoming_phone_numbers || [])[0];
          if (numObj) {
            const voiceUrl = `${externalUrl}/twilio/voice`;
            const smsUrl = `${externalUrl}/twilio/sms`;
            const form = new URLSearchParams({
              VoiceUrl: voiceUrl,
              VoiceMethod: 'POST',
              SmsUrl: smsUrl,
              SmsMethod: 'POST'
            });
            const updateRes = await fetch(
              `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${numObj.sid}.json`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Basic ${basicAuth}`,
                  'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: form.toString()
              }
            );
            if (updateRes.ok) {
              console.log(`[Twilio Auto-Config] Linked ${phoneNumber} -> Voice: ${voiceUrl} | SMS: ${smsUrl}`);
            }
          }
        }
      } catch (err) {
        console.warn(`[Twilio Auto-Config] Warning: ${err.message}`);
      }
    }
  }
});
