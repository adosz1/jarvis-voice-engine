import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Modality } from '@google/genai';
import { TOOL_DECLARATIONS, executeToolCall, loadProjects } from '../tools/tool-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SYSTEM_PROMPT_PATH = path.resolve(__dirname, '../profiles/system-prompt.md');

export function ensureModelsPrefix(modelName) {
  const cleaned = String(modelName || 'gemini-2.5-flash-native-audio').trim();
  if (
    cleaned.startsWith('models/') ||
    cleaned.startsWith('publishers/') ||
    cleaned.startsWith('projects/')
  ) {
    return cleaned;
  }
  return `models/${cleaned}`;
}

export const LIVE_MODEL = 'models/gemini-2.5-flash-native-audio';
export const PRIMARY_MODEL = LIVE_MODEL;
export const FALLBACK_MODEL = LIVE_MODEL;

const NATIVE_AUDIO_MODEL_CANDIDATES = [
  'models/gemini-2.5-flash-native-audio',
  'models/gemini-2.5-flash-native-audio-preview-12-2025',
  'models/gemini-2.5-flash-native-audio-preview-09-2025',
  'models/gemini-2.5-flash-native-audio-latest',
  'models/gemini-live-2.5-flash-native-audio'
];

export const INPUT_AUDIO_CONFIG = Object.freeze({
  mimeType: 'audio/pcm;rate=16000',
  sampleRateHz: 16000,
  channels: 1,
  bitDepth: 16,
  encoding: 'PCM_S16LE'
});
export const OUTPUT_AUDIO_MIME_TYPE = 'audio/pcm;rate=24000';

function buildVertexCompatibleTools(tools) {
  return (tools || []).map((toolGroup) => {
    if (!Array.isArray(toolGroup.functionDeclarations)) return toolGroup;
    return {
      ...toolGroup,
      functionDeclarations: toolGroup.functionDeclarations.map(({ behavior, ...rest }) => rest)
    };
  });
}

export class GeminiLiveSession {
  /**
   * @param {object} options
   * @param {function} options.onAudioChunk - (base64Pcm, mimeType) => void
   * @param {function} options.onInterrupted - () => void
   * @param {function} options.onTranscript - ({ role, text }) => void
   * @param {function} options.onStatus - ({ status, model, message }) => void
   * @param {function} options.onToolEvent - (event) => void
   * @param {string} options.activeProject - Active project name selected in UI
   */
  constructor(options = {}) {
    this.onAudioChunk = options.onAudioChunk || (() => {});
    this.onInterrupted = options.onInterrupted || (() => {});
    this.onTranscript = options.onTranscript || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.onToolEvent = options.onToolEvent || (() => {});
    this.onOfflineCallbackNeeded = options.onOfflineCallbackNeeded || null;
    this.activeProject = options.activeProject || 'CoeliSafe';

    this.session = null;
    this.activeModel = null;
    this.isConnected = false;
    this.closing = false;
    this.reconnecting = false;
    this.resumptionHandle = null;
  }

  _buildSystemInstruction() {
    let basePrompt = 'You are Jarvis, a concise real-time voice engineering assistant.';
    try {
      if (fs.existsSync(SYSTEM_PROMPT_PATH)) {
        basePrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
      }
    } catch (err) {
      console.warn('[GeminiLive] Failed to read system-prompt.md:', err.message);
    }

    const projects = loadProjects();
    const projectContext = projects
      .map(
        (p) =>
          `- ${p.project_name}: repo="${p.github_repo}", cloudflare_project="${p.cloudflare_project || 'N/A'}", domain="${p.live_domain || 'auto'}", local_path="${p.local_path}", notes="${p.system_notes}"`
      )
      .join('\n');

    return `${basePrompt}\n\n## CURRENT ACTIVE PROJECT\nActive Project: ${this.activeProject}\n\n## CONFIGURED PROJECTS\n${projectContext}`;
  }

  _buildAuthClients(apiKey) {
    const isEphemeralToken = apiKey.startsWith('auth_tokens/');
    const forceVertexEnv =
      String(process.env.GOOGLE_GENAI_USE_VERTEXAI || '').toLowerCase() === 'true';

    const buildGeminiClient = (apiVersion) => ({
      mode: `gemini-${apiVersion}`,
      vertexai: false,
      ai: new GoogleGenAI({
        apiKey,
        vertexai: false,
        apiVersion,
        httpOptions: {
          apiVersion,
          headers: isEphemeralToken ? {} : { 'x-goog-api-key': apiKey }
        }
      })
    });

    const primaryVersion =
      process.env.GEMINI_API_VERSION || (isEphemeralToken ? 'v1alpha' : 'v1beta');
    const secondaryVersion = primaryVersion === 'v1beta' ? 'v1alpha' : 'v1beta';

    const geminiClients = [
      buildGeminiClient(primaryVersion),
      buildGeminiClient(secondaryVersion)
    ];

    if (forceVertexEnv && process.env.GOOGLE_CLOUD_PROJECT && process.env.GOOGLE_CLOUD_LOCATION) {
      const vertexApiVersion = process.env.VERTEX_API_VERSION || 'v1beta1';
      const vertexClient = {
        mode: 'vertex',
        vertexai: true,
        ai: new GoogleGenAI({
          vertexai: true,
          project: process.env.GOOGLE_CLOUD_PROJECT,
          location: process.env.GOOGLE_CLOUD_LOCATION,
          apiVersion: vertexApiVersion,
          httpOptions: {
            apiVersion: vertexApiVersion
          }
        })
      };
      return [vertexClient, ...geminiClients];
    }

    return geminiClients;
  }

  async connect() {
    const rawKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    const apiKey = rawKey.trim().replace(/^["']|["']$/g, '');
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      throw new Error(
        'Missing GEMINI_API_KEY in .env file. Set your Gemini API key and reconnect.'
      );
    }

    const authClients = this._buildAuthClients(apiKey);
    const modelsToTry = NATIVE_AUDIO_MODEL_CANDIDATES.map((m) => ensureModelsPrefix(m));
    let lastError = null;

    for (const modelCandidate of modelsToTry) {
      for (const clientEntry of authClients) {
        const qualifiedModel = ensureModelsPrefix(modelCandidate);
        try {
          this.onStatus({
            status: 'connecting',
            model: qualifiedModel,
            message: `Connecting to Gemini Live (${qualifiedModel})...`
          });

          await this._connectWithModel(clientEntry.ai, qualifiedModel, clientEntry.vertexai);
          this.activeModel = qualifiedModel;
          this.isConnected = true;

          this.onStatus({
            status: 'connected',
            model: qualifiedModel,
            message: `Live voice session active on ${qualifiedModel}`
          });
          return qualifiedModel;
        } catch (err) {
          lastError = err;
          console.warn(
            `[GeminiLive] Connection failed on model "${qualifiedModel}" (${clientEntry.mode}): ${err.message}.`
          );
        }
      }
    }

    throw lastError || new Error('Failed to connect to Gemini Live API.');
  }

  async _connectWithModel(ai, modelName, isVertex = false) {
    const qualifiedModel = ensureModelsPrefix(modelName);
    return new Promise((resolve, reject) => {
      let settled = false;
      let setupCompleted = false;
      let resolvedSession = null;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (resolvedSession) {
            try {
              resolvedSession.close();
            } catch {
              // Ignore cleanup close error
            }
          }
          reject(new Error(`Connection timeout waiting for setupComplete on ${qualifiedModel}`));
        }
      }, 12000);

      const tryCompleteHandshake = () => {
        if (!settled && !this.closing && setupCompleted && resolvedSession) {
          settled = true;
          clearTimeout(timeout);
          this.session = resolvedSession;
          this.isConnected = true;
          resolve();
        }
      };

      const sessionTools = isVertex
        ? buildVertexCompatibleTools(TOOL_DECLARATIONS)
        : TOOL_DECLARATIONS;

      const voiceName = (process.env.JARVIS_VOICE || 'Charon').trim();

      const connectConfig = {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName
            }
          }
        },
        systemInstruction: {
          parts: [{ text: this._buildSystemInstruction() }]
        },
        tools: sessionTools,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: {
          slidingWindow: {}
        },
        sessionResumption: this.resumptionHandle
          ? { handle: this.resumptionHandle }
          : {}
      };

      ai.live
        .connect({
          model: qualifiedModel,
          config: connectConfig,
          callbacks: {
            onopen: () => {
              console.log(`[GeminiLive:${qualifiedModel}] WebSocket opened, awaiting setupComplete...`);
            },
            onmessage: (message) => {
              if (message?.setupComplete && !setupCompleted) {
                setupCompleted = true;
                tryCompleteHandshake();
              }
              this._handleServerMessage(message);
            },
            onerror: (err) => {
              const errMsg = err?.message || err?.error?.message || String(err);
              console.error(`[GeminiLive:${qualifiedModel}] Socket error:`, errMsg);
              if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(new Error(errMsg));
              } else {
                this.onStatus({
                  status: 'error',
                  model: qualifiedModel,
                  message: `Gemini Live error: ${errMsg}`
                });
              }
            },
            onclose: (event) => {
              const reason = event?.reason || `Code ${event?.code || 'unknown'}`;
              console.log(`[GeminiLive:${qualifiedModel}] Session closed (${reason})`);
              this.isConnected = false;

              if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(new Error(`Closed during handshake: ${reason}`));
              } else if (!this.closing) {
                this._attemptAutoReconnect(qualifiedModel, reason);
              }
            }
          }
        })
        .then((session) => {
          resolvedSession = session;
          this.session = session;
          tryCompleteHandshake();
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(err);
          }
        });
    });
  }

  async _attemptAutoReconnect(modelName, reason) {
    if (this.closing || this.reconnecting) return;
    this.reconnecting = true;
    this.onStatus({
      status: 'connecting',
      model: modelName,
      message: `Session interrupted (${reason}). Reconnecting voice stream...`
    });

    try {
      await new Promise((r) => setTimeout(r, 600));
      if (this.closing) return;
      await this.connect();
    } catch (err) {
      if (!this.closing) {
        this.onStatus({
          status: 'disconnected',
          model: modelName,
          message: `Gemini Live session closed (${reason})`
        });
      }
    } finally {
      this.reconnecting = false;
    }
  }

  async _handleServerMessage(message) {
    try {
      if (message.sessionResumptionUpdate?.newHandle) {
        this.resumptionHandle = message.sessionResumptionUpdate.newHandle;
      }

      if (message.goAway && !this.closing) {
        console.log('[GeminiLive] Server sent goAway signal; preparing seamless resumption...');
      }

      // 1. Handle serverContent (audio chunks, interruption / barge-in, transcriptions)
      const serverContent = message.serverContent;
      if (serverContent) {
        if (serverContent.interrupted) {
          this.onInterrupted();
        }

        if (serverContent.inputTranscription?.text) {
          this.onTranscript({
            role: 'user',
            text: serverContent.inputTranscription.text
          });
        }

        if (serverContent.outputTranscription?.text) {
          this.onTranscript({
            role: 'jarvis',
            text: serverContent.outputTranscription.text
          });
        }

        const parts = serverContent.modelTurn?.parts || [];
        for (const part of parts) {
          if (part.inlineData && part.inlineData.data) {
            const mimeType = part.inlineData.mimeType || OUTPUT_AUDIO_MIME_TYPE;
            this.onAudioChunk(part.inlineData.data, mimeType);
          }
          if (part.text) {
            this.onTranscript({
              role: 'jarvis',
              text: part.text
            });
          }
        }
      }

      // 2. Handle non-blocking function calling (toolCall)
      if (message.toolCall && Array.isArray(message.toolCall.functionCalls)) {
        for (const call of message.toolCall.functionCalls) {
          this._handleFunctionCall(call);
        }
      }
    } catch (err) {
      console.error('[GeminiLive] Error processing server message:', err);
    }
  }

  async _handleFunctionCall(call) {
    const { id, name, args } = call;
    this.onToolEvent({
      type: 'tool_call_started',
      id,
      name,
      args,
      timestamp: new Date().toISOString()
    });

    try {
      const responsePayload = await executeToolCall(name, args || {}, {
        activeProject: this.activeProject,
        onJobCompletedCallback: (completedJob) => {
          this.notifyBackgroundJobCompletion(completedJob);
        }
      });

      this.onToolEvent({
        type: 'tool_call_returned',
        id,
        name,
        response: responsePayload,
        timestamp: new Date().toISOString()
      });

      if (this.session && this.isConnected) {
        await this.session.sendToolResponse({
          functionResponses: [
            {
              id,
              name,
              scheduling: 'INTERRUPT',
              response: responsePayload
            }
          ]
        });
      }
    } catch (err) {
      console.error(`[GeminiLive] Tool execution error (${name}):`, err.message);
      if (this.session && this.isConnected) {
        await this.session.sendToolResponse({
          functionResponses: [
            {
              id,
              name,
              response: {
                status: 'error',
                error: err.message
              }
            }
          ]
        });
      }
    }
  }

  /**
   * Stream 16kHz 16-bit mono PCM audio from browser mic (or future Twilio Media Stream adapter)
   * matching @google/genai SDK Blob encoding requirements (`audio/pcm;rate=16000`).
   * @param {string|Buffer|Uint8Array|ArrayBuffer} pcmChunk - Base64-encoded or binary 16-bit PCM16 little-endian mono audio at 16kHz
   */
  sendRealtimeAudio(pcmChunk) {
    if (!this.session || !this.isConnected || !pcmChunk) return;
    try {
      let base64Pcm = '';
      if (typeof pcmChunk === 'string') {
        base64Pcm = pcmChunk.includes(',') ? pcmChunk.split(',').pop().trim() : pcmChunk.trim();
      } else if (Buffer.isBuffer(pcmChunk)) {
        base64Pcm = pcmChunk.toString('base64');
      } else if (pcmChunk instanceof ArrayBuffer) {
        base64Pcm = Buffer.from(pcmChunk).toString('base64');
      } else if (ArrayBuffer.isView(pcmChunk)) {
        base64Pcm = Buffer.from(
          pcmChunk.buffer,
          pcmChunk.byteOffset,
          pcmChunk.byteLength
        ).toString('base64');
      } else if (typeof pcmChunk === 'object' && typeof pcmChunk.data === 'string') {
        base64Pcm = pcmChunk.data.trim();
      }

      if (!base64Pcm) return;

      this.session.sendRealtimeInput({
        media: {
          mimeType: INPUT_AUDIO_CONFIG.mimeType,
          data: base64Pcm
        }
      });
    } catch (err) {
      console.error('[GeminiLive] Error sending realtime audio chunk:', err.message);
    }
  }

  /**
   * Send a direct text turn into the active Gemini Live session
   */
  sendTextPrompt(text, turnComplete = true) {
    if (!this.session || !this.isConnected) return false;
    try {
      this.session.sendClientContent({
        turns: [
          {
            role: 'user',
            parts: [{ text }]
          }
        ],
        turnComplete
      });
      return true;
    } catch (err) {
      console.error('[GeminiLive] Error sending client content:', err.message);
      return false;
    }
  }

  /**
   * Pushes an immediate completion event back into the active Gemini Live voice session
   * the moment a detached background job finishes.
   */
  notifyBackgroundJobCompletion(job) {
    this.onToolEvent({
      type: 'background_job_callback',
      job,
      sessionActive: Boolean(this.session && this.isConnected),
      timestamp: new Date().toISOString()
    });

    if (!job.callback_requested) return;

    if (this.session && this.isConnected) {
      const prompt = `[BACKGROUND_JOB_COMPLETED] Job ID: ${job.job_id} | Project: ${job.project_name} | Status: ${job.status} | Summary: ${job.result_summary}. Announce this completion concisely to the user right now.`;
      this.sendTextPrompt(prompt, true);
    } else if (typeof this.onOfflineCallbackNeeded === 'function') {
      this.onOfflineCallbackNeeded(job);
    } else {
      console.log(
        `[GeminiLive] Callback logged (no active voice session): ${job.job_id} (${job.status}) - ${job.result_summary}`
      );
    }
  }

  setActiveProject(projectName) {
    this.activeProject = projectName;
    if (this.session && this.isConnected) {
      this.sendTextPrompt(
        `[SYSTEM_CONTEXT_UPDATE] User switched active project in control panel to "${projectName}". Acknowledge briefly only if relevant.`,
        false
      );
    }
  }

  close() {
    this.closing = true;
    this.isConnected = false;
    if (this.session) {
      try {
        this.session.close();
      } catch {
        // Ignore close errors
      }
      this.session = null;
    }
  }
}
