import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { GeminiLiveSession } from './gemini-live.js';
import { jobManager } from './job-manager.js';

let lastCallerNumber = '';
let lastPublicHost = '';

/**
 * Precomputed ITU-T G.711 mu-law (8-bit) -> 16-bit signed linear PCM lookup table
 */
const MULAW_TO_PCM16_TABLE = new Int16Array(256);
(function initMulawDecodeTable() {
  for (let i = 0; i < 256; i++) {
    const mu = ~i & 0xff;
    const sign = mu & 0x80;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    MULAW_TO_PCM16_TABLE[i] = sign ? -sample : sample;
  }
})();

/**
 * Encode a single 16-bit signed PCM sample (-32768..32767) into an 8-bit ITU-T G.711 mu-law byte
 * @param {number} pcmSample
 * @returns {number}
 */
export function encodePcm16SampleToMulaw(pcmSample) {
  const BIAS = 0x84;
  const CLIP = 32635;

  let sign = 0;
  let sample = pcmSample;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > CLIP) {
    sample = CLIP;
  }
  sample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    // Find segment exponent
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulawByte;
}

/**
 * Transcode 8kHz 8-bit G.711 mu-law buffer from Twilio into 16kHz 16-bit signed little-endian mono PCM Buffer
 * @param {Buffer|Uint8Array} mulawBuffer
 * @returns {Buffer} 16kHz PCM16LE buffer (4 bytes per input mu-law byte)
 */
export function mulaw8kToPcm16k(mulawBuffer) {
  const inputLen = mulawBuffer.length;
  if (inputLen === 0) return Buffer.alloc(0);

  // 1:2 upsampling (8000 Hz -> 16000 Hz), 2 bytes per 16-bit sample => 4x byte length
  const pcm16kBuffer = Buffer.allocUnsafe(inputLen * 4);

  for (let i = 0; i < inputLen; i++) {
    const currentSample = MULAW_TO_PCM16_TABLE[mulawBuffer[i]];
    const nextSample =
      i + 1 < inputLen ? MULAW_TO_PCM16_TABLE[mulawBuffer[i + 1]] : currentSample;
    const interpolatedSample = (currentSample + nextSample) >> 1;

    const byteOffset = i * 4;
    pcm16kBuffer.writeInt16LE(currentSample, byteOffset);
    pcm16kBuffer.writeInt16LE(interpolatedSample, byteOffset + 2);
  }

  return pcm16kBuffer;
}

/**
 * Transcode 16kHz 16-bit signed little-endian mono PCM Buffer into 8kHz 8-bit G.711 mu-law Buffer for Twilio
 * @param {Buffer|Uint8Array} pcm16kBuffer
 * @returns {Buffer} 8kHz mu-law buffer
 */
export function pcm16kToMulaw8k(pcm16kBuffer) {
  const buf = Buffer.isBuffer(pcm16kBuffer) ? pcm16kBuffer : Buffer.from(pcm16kBuffer);
  const totalSamples16k = Math.floor(buf.length / 2);
  const outputSamples8k = Math.floor(totalSamples16k / 2);
  if (outputSamples8k === 0) return Buffer.alloc(0);

  const mulawBuffer = Buffer.allocUnsafe(outputSamples8k);

  for (let i = 0; i < outputSamples8k; i++) {
    const offset = i * 4;
    const s0 = buf.readInt16LE(offset);
    const s1 = buf.readInt16LE(offset + 2);
    const avgSample = (s0 + s1) >> 1;
    mulawBuffer[i] = encodePcm16SampleToMulaw(avgSample);
  }

  return mulawBuffer;
}

/**
 * Resample arbitrary 16-bit signed little-endian mono PCM buffer to 16kHz PCM16LE
 * (Used when Gemini Live emits 24kHz PCM chunks so they convert cleanly to 16kHz PCM before 8kHz mu-law encoding)
 * @param {Buffer} pcmBuffer
 * @param {number} inputRate
 * @returns {Buffer}
 */
export function resamplePcm16leTo16k(pcmBuffer, inputRate = 16000) {
  if (!pcmBuffer || pcmBuffer.length < 2) return Buffer.alloc(0);
  if (inputRate === 16000) return pcmBuffer;

  const inputSamples = Math.floor(pcmBuffer.length / 2);
  const ratio = inputRate / 16000;
  const outputSamples = Math.floor(inputSamples / ratio);
  const outBuffer = Buffer.allocUnsafe(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, inputSamples - 1);
    const frac = srcPos - idx0;

    const s0 = pcmBuffer.readInt16LE(idx0 * 2);
    const s1 = pcmBuffer.readInt16LE(idx1 * 2);
    const interpolated = Math.round(s0 + (s1 - s0) * frac);
    const clamped = Math.max(-32768, Math.min(32767, interpolated));
    outBuffer.writeInt16LE(clamped, i * 2);
  }

  return outBuffer;
}

function parseSampleRate(mimeType = '') {
  const match = /rate=(\d+)/i.exec(mimeType);
  return match ? parseInt(match[1], 10) : 16000;
}

/**
 * Transcode base64 8kHz mu-law payload from Twilio Media Stream into base64 16kHz PCM16LE for Gemini Live
 * @param {string} base64Mulaw
 * @returns {string}
 */
export function transcodeTwilioMulawToPcm16kBase64(base64Mulaw) {
  if (!base64Mulaw) return '';
  const mulawBytes = Buffer.from(base64Mulaw, 'base64');
  const pcm16kBytes = mulaw8kToPcm16k(mulawBytes);
  return pcm16kBytes.toString('base64');
}

/**
 * Transcode base64 PCM response from Gemini Live (16kHz or 24kHz) into base64 8kHz mu-law for Twilio Media Stream
 * @param {string} base64Pcm
 * @param {string} [mimeType]
 * @returns {string}
 */
export function transcodeGeminiPcmToTwilioMulawBase64(base64Pcm, mimeType = 'audio/pcm;rate=16000') {
  if (!base64Pcm) return '';
  const rawPcmBuffer = Buffer.from(base64Pcm, 'base64');
  const sampleRate = parseSampleRate(mimeType);
  const pcm16kBuffer =
    sampleRate === 16000 ? rawPcmBuffer : resamplePcm16leTo16k(rawPcmBuffer, sampleRate);
  const mulaw8kBuffer = pcm16kToMulaw8k(pcm16kBuffer);
  return mulaw8kBuffer.toString('base64');
}

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build TwiML response instructing Twilio to connect the call to our bidirectional WebSocket Media Stream
 * @param {import('express').Request} req
 * @returns {string}
 */
export function buildTwilioStreamTwiml(req) {
  const configuredHost = (process.env.TWILIO_PUBLIC_HOST || '').trim();
  const forwardedHost = req.headers['x-forwarded-host'];
  const rawHost =
    configuredHost ||
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ||
    req.headers.host ||
    'localhost:3000';

  const cleanHost = String(rawHost)
    .replace(/^https?:\/\//i, '')
    .replace(/^wss?:\/\//i, '')
    .replace(/\/+$/, '');

  if (cleanHost && !cleanHost.startsWith('localhost') && !cleanHost.startsWith('127.0.0.1')) {
    lastPublicHost = cleanHost;
  }

  const streamUrl = `wss://${cleanHost}/twilio/media`;
  const jobId = String(req.query?.job_id || req.body?.job_id || '').trim();

  const paramLines = [];
  if (jobId) {
    paramLines.push(`      <Parameter name="job_id" value="${escapeXml(jobId)}" />`);
  }

  const streamBlock =
    paramLines.length > 0
      ? [
          `    <Stream url="${escapeXml(streamUrl)}">`,
          ...paramLines,
          `    </Stream>`
        ].join('\n')
      : `    <Stream url="${escapeXml(streamUrl)}" />`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    streamBlock,
    '  </Connect>',
    '</Response>'
  ].join('\n');
}

/**
 * Trigger an outbound Twilio phone call back to the user when a background job completes after hangup
 */
export async function triggerTwilioOutboundCallback(job, broadcastToClients = () => {}) {
  try {
    const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
    const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    const fromNumber = (process.env.TWILIO_PHONE_NUMBER || '').trim();
    const toNumber = (process.env.MY_PHONE_NUMBER || lastCallerNumber || '').trim();
    const publicHost = (process.env.TWILIO_PUBLIC_HOST || lastPublicHost || '').trim();

    if (!accountSid || !authToken || !fromNumber || !toNumber || !publicHost) {
      console.log(
        `[TwilioCallback] Skipping outbound call for ${job.job_id} (toNumber=${toNumber || 'none'}, host=${publicHost || 'none'}).`
      );
      return false;
    }

    const cleanHost = publicHost
      .replace(/^https?:\/\//i, '')
      .replace(/^wss?:\/\//i, '')
      .replace(/\/+$/, '');

    const callbackWebhookUrl = `https://${cleanHost}/twilio/voice?job_id=${encodeURIComponent(job.job_id)}`;
    const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const formBody = new URLSearchParams({
      To: toNumber,
      From: fromNumber,
      Url: callbackWebhookUrl,
      Method: 'POST'
    });

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formBody.toString()
      }
    );

    if (res.ok) {
      const data = await res.json();
      console.log(
        `[TwilioCallback] Outbound callback initiated to ${toNumber} for ${job.job_id} (CallSid: ${data.sid})`
      );
      broadcastToClients({
        type: 'callback_log',
        level: 'success',
        message: `[Twilio Outbound Callback] Calling ${toNumber} to report completion of ${job.job_id}...`,
        timestamp: new Date().toISOString()
      });
      return true;
    } else {
      const errText = await res.text();
      console.warn(`[TwilioCallback] Outbound call failed (${res.status}): ${errText}`);
      return false;
    }
  } catch (err) {
    console.error('[TwilioCallback] Error triggering outbound call:', err.message);
    return false;
  }
}

/**
 * Mounts the `/twilio/voice` TwiML webhook endpoint and returns a WebSocketServer for `/twilio/media`.
 *
 * @param {object} options
 * @param {import('express').Express} options.app - Express app instance
 * @param {Set<GeminiLiveSession>} options.activeGeminiSessions - Shared set of active Gemini Live sessions
 * @param {function} [options.broadcastToClients] - Optional UI broadcast helper
 */
export function setupTwilioBridge({
  app,
  activeGeminiSessions = new Set(),
  broadcastToClients = () => {}
}) {
  const router = express.Router();

  // Support both POST (Twilio default) and GET for easy browser/curl testing
  router.all('/voice', (req, res) => {
    const twiml = buildTwilioStreamTwiml(req);
    const caller = req.body?.From || req.query?.From || 'Unknown Caller';
    const toNum = req.body?.To || req.query?.To || '';
    const callSid = req.body?.CallSid || req.query?.CallSid || 'N/A';
    const twilioOwnNum = (process.env.TWILIO_PHONE_NUMBER || '').trim();

    if (caller && caller.startsWith('+') && caller !== twilioOwnNum) {
      lastCallerNumber = caller;
    } else if (toNum && toNum.startsWith('+') && toNum !== twilioOwnNum) {
      lastCallerNumber = toNum;
    }

    console.log(`[TwilioBridge] Call event from ${caller} (CallSid: ${callSid}) -> TwiML Stream`);
    broadcastToClients({
      type: 'callback_log',
      level: 'info',
      message: `[Twilio Voice] Incoming call from ${caller} (CallSid: ${callSid}). Connecting Media Stream...`,
      timestamp: new Date().toISOString()
    });

    res.status(200).type('text/xml').send(twiml);
  });

  app.use('/twilio', router);

  const twilioWss = new WebSocketServer({ noServer: true });

  twilioWss.on('connection', (ws) => {
    let streamSid = null;
    let callSid = null;
    let callbackJobId = null;
    let activeProject = process.env.DEFAULT_PROJECT || 'CoeliSafe';
    let geminiSession = null;
    let sessionConnecting = false;
    const pendingMulawPayloads = [];

    const sendTwilioMedia = (base64Mulaw) => {
      if (!streamSid || ws.readyState !== WebSocket.OPEN || !base64Mulaw) return;
      ws.send(
        JSON.stringify({
          event: 'media',
          streamSid,
          media: {
            payload: base64Mulaw
          }
        })
      );
    };

    const sendTwilioClear = () => {
      if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          event: 'clear',
          streamSid
        })
      );
    };

    const startGeminiSessionForCall = async () => {
      if (geminiSession || sessionConnecting) return;
      sessionConnecting = true;

      geminiSession = new GeminiLiveSession({
        activeProject,
        onOfflineCallbackNeeded: (completedJob) => {
          triggerTwilioOutboundCallback(completedJob, broadcastToClients);
        },
        onAudioChunk: (base64Pcm, mimeType) => {
          const base64Mulaw = transcodeGeminiPcmToTwilioMulawBase64(base64Pcm, mimeType);
          sendTwilioMedia(base64Mulaw);
        },
        onInterrupted: () => {
          sendTwilioClear();
          broadcastToClients({
            type: 'interrupted',
            source: 'twilio',
            timestamp: new Date().toISOString()
          });
        },
        onTranscript: ({ role, text }) => {
          broadcastToClients({
            type: 'transcript',
            role,
            text: `[Twilio] ${text}`,
            timestamp: new Date().toISOString()
          });
        },
        onStatus: ({ status, model, message }) => {
          broadcastToClients({
            type: 'call_status',
            status,
            model,
            message: `[Twilio] ${message}`,
            timestamp: new Date().toISOString()
          });
        },
        onToolEvent: (event) => {
          broadcastToClients({
            type: 'tool_event',
            event
          });
        }
      });

      try {
        const connectedModel = await geminiSession.connect();
        activeGeminiSessions.add(geminiSession);
        console.log(
          `[TwilioBridge] Media Stream ${streamSid} connected to Gemini Live (${connectedModel})`
        );

        broadcastToClients({
          type: 'callback_log',
          level: 'success',
          message: `[Twilio Media Stream] Active on ${connectedModel} (StreamSid: ${streamSid})`,
          timestamp: new Date().toISOString()
        });

        // Flush any buffered audio chunks received while handshake was completing
        while (pendingMulawPayloads.length > 0 && geminiSession?.isConnected) {
          const chunk = pendingMulawPayloads.shift();
          const base64Pcm16k = transcodeTwilioMulawToPcm16kBase64(chunk);
          geminiSession.sendRealtimeAudio(base64Pcm16k);
        }

        // If this call is an outbound callback for a completed job, announce the outcome immediately;
        // otherwise greet the user immediately so there is no dead air on pickup.
        if (callbackJobId) {
          const completedJob = jobManager.getJob(callbackJobId);
          if (completedJob) {
            geminiSession.sendTextPrompt(
              `[OUTBOUND_CALLBACK_CONNECTED] You just rang Sir back on his mobile phone because background job ${completedJob.job_id} on ${completedJob.project_name} finished with status "${completedJob.status}": ${completedJob.result_summary}. Speak first right now in 1-2 crisp sentences to report the outcome.`,
              true
            );
          }
        } else {
          geminiSession.sendTextPrompt(
            `[INCOMING_PHONE_CALL_CONNECTED] Sir just dialed in on the phone line. Greet him first right now in 1 short sentence (e.g. "Jarvis online, Sir. What's the play?").`,
            true
          );
        }
      } catch (err) {
        console.error('[TwilioBridge] Failed to connect Gemini Live session:', err.message);
        broadcastToClients({
          type: 'callback_log',
          level: 'error',
          message: `[Twilio Media Error] ${err.message}`,
          timestamp: new Date().toISOString()
        });
      } finally {
        sessionConnecting = false;
      }
    };

    const cleanupSession = () => {
      pendingMulawPayloads.length = 0;
      if (geminiSession) {
        activeGeminiSessions.delete(geminiSession);
        geminiSession.close();
        geminiSession = null;
      }
    };

    ws.on('message', async (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());

        switch (msg.event) {
          case 'connected': {
            console.log('[TwilioBridge] Media Stream WebSocket connected');
            break;
          }

          case 'start': {
            streamSid = msg.start?.streamSid || msg.streamSid || null;
            callSid = msg.start?.callSid || null;
            if (msg.start?.customParameters?.project) {
              activeProject = msg.start.customParameters.project;
            }
            if (msg.start?.customParameters?.job_id) {
              callbackJobId = msg.start.customParameters.job_id;
            }
            console.log(
              `[TwilioBridge] Stream started (streamSid=${streamSid}, callSid=${callSid}, project=${activeProject}, job_id=${callbackJobId || 'none'})`
            );
            await startGeminiSessionForCall();
            break;
          }

          case 'media': {
            const mulawPayload = msg.media?.payload;
            if (!mulawPayload) break;

            if (geminiSession && geminiSession.isConnected) {
              const base64Pcm16k = transcodeTwilioMulawToPcm16kBase64(mulawPayload);
              geminiSession.sendRealtimeAudio(base64Pcm16k);
            } else {
              // Keep a small rolling buffer (~1 second = 50x 20ms frames) during setup handshake
              if (pendingMulawPayloads.length >= 50) {
                pendingMulawPayloads.shift();
              }
              pendingMulawPayloads.push(mulawPayload);
              if (!geminiSession && !sessionConnecting) {
                startGeminiSessionForCall();
              }
            }
            break;
          }

          case 'stop': {
            console.log(`[TwilioBridge] Stream stopped (streamSid=${streamSid})`);
            cleanupSession();
            broadcastToClients({
              type: 'callback_log',
              level: 'info',
              message: `[Twilio Media Stream] Call ended (StreamSid: ${streamSid || 'N/A'}).`,
              timestamp: new Date().toISOString()
            });
            break;
          }

          default:
            break;
        }
      } catch (err) {
        console.error('[TwilioBridge] Error handling Twilio WS message:', err.message);
      }
    });

    ws.on('close', () => {
      cleanupSession();
    });

    ws.on('error', (err) => {
      console.error('[TwilioBridge] WebSocket error:', err.message);
      cleanupSession();
    });
  });

  return { twilioWss, router };
}

