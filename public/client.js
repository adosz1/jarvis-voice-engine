// Jarvis Voice Engine — Local Browser Mic Testbench (16kHz PCM In / 24kHz PCM Out + Instant Barge-In)

const statusOrb = document.getElementById('statusOrb');
const wsBadge = document.getElementById('wsBadge');
const modelBadge = document.getElementById('modelBadge');
const dryRunBadge = document.getElementById('dryRunBadge');
const apiKeyBadge = document.getElementById('apiKeyBadge');
const callStateLabel = document.getElementById('callStateLabel');
const callJarvisBtn = document.getElementById('callJarvisBtn');
const callBtnText = document.getElementById('callBtnText');
const micLevelBar = document.getElementById('micLevelBar');
const bargeInIndicator = document.getElementById('bargeInIndicator');
const projectSelector = document.getElementById('projectSelector');
const projectMetaBox = document.getElementById('projectMetaBox');
const jobsList = document.getElementById('jobsList');
const callbackLog = document.getElementById('callbackLog');

const taskPromptInput = document.getElementById('taskPromptInput');
const dispatchTaskBtn = document.getElementById('dispatchTaskBtn');
const textPromptInput = document.getElementById('textPromptInput');
const sendTextBtn = document.getElementById('sendTextBtn');
const webhookTestBtn = document.getElementById('webhookTestBtn');
const clearLogBtn = document.getElementById('clearLogBtn');

let ws = null;
let projects = [];
let isCallActive = false;

// Audio Capture & Playback State
let micStream = null;
let captureCtx = null;
let processorNode = null;
let playbackCtx = null;
let nextPlayTime = 0;
let activePlaybackSources = new Set();

function appendLog(message, level = 'info') {
  const div = document.createElement('div');
  div.className = `log-entry ${level}`;
  const now = new Date().toLocaleTimeString();
  div.innerHTML = `<span class="ts">[${now}]</span>`;
  const span = document.createElement('span');
  span.textContent = message;
  div.appendChild(span);
  callbackLog.appendChild(div);
  callbackLog.scrollTop = callbackLog.scrollHeight;
}

function renderProjects(list) {
  projects = Array.isArray(list) ? list : [];
  projectSelector.innerHTML = '';

  for (const proj of projects) {
    const opt = document.createElement('option');
    opt.value = proj.project_name;
    opt.textContent = `${proj.project_name} (${proj.local_path})`;
    projectSelector.appendChild(opt);
  }

  updateProjectMeta();
}

function updateProjectMeta() {
  const selectedName = projectSelector.value;
  const proj = projects.find((p) => p.project_name === selectedName) || projects[0];
  if (!proj) {
    projectMetaBox.textContent = 'No projects configured in /profiles/projects.json';
    return;
  }

  projectMetaBox.innerHTML = `
    <div><strong>Project:</strong> ${proj.project_name}</div>
    <div><strong>GitHub:</strong> ${proj.github_repo || 'N/A'}</div>
    <div><strong>Cloudflare Pages:</strong> ${proj.cloudflare_project || 'N/A'} (${proj.live_domain || 'auto'})</div>
    <div><strong>Local Path:</strong> ${proj.local_path}</div>
    <div style="margin-top:4px; color:#cbd5e1;">${proj.system_notes || ''}</div>
  `;
}

function renderJobs(jobs = []) {
  if (!jobs.length) {
    jobsList.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem;">No background jobs dispatched yet.</div>`;
    return;
  }

  jobsList.innerHTML = '';
  for (const job of jobs) {
    const card = document.createElement('div');
    card.className = 'job-card';
    card.innerHTML = `
      <div class="job-header">
        <span><strong>${job.job_id}</strong> // ${job.project_name}</span>
        <span class="status-pill ${job.status}">${job.status}</span>
      </div>
      <div style="font-size:0.84rem; color:#e2e8f0;">${job.task_prompt}</div>
      <div style="font-size:0.76rem; color:var(--text-muted); font-family:var(--font-mono);">${job.result_summary || ''}</div>
    `;
    jobsList.appendChild(card);
  }
}

// Connect WebSocket to /core/server.js
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

  ws.onopen = () => {
    wsBadge.textContent = 'WS: Connected';
    wsBadge.className = 'badge ok';
    appendLog('Connected to Jarvis Core Engine WebSocket (/ws).', 'info');
  };

  ws.onclose = () => {
    wsBadge.textContent = 'WS: Disconnected';
    wsBadge.className = 'badge warn';
    appendLog('WebSocket disconnected. Reconnecting in 2s...', 'warn');
    setTimeout(connectWebSocket, 2000);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerEvent(msg);
    } catch (err) {
      console.error('Invalid WS message:', err);
    }
  };
}

function handleServerEvent(msg) {
  switch (msg.type) {
    case 'init': {
      renderProjects(msg.projects || []);
      renderJobs(msg.jobs || []);
      modelBadge.textContent = `Model: ${msg.primary_model} (fallback: ${msg.fallback_model})`;
      dryRunBadge.textContent = `DRY_RUN: ${msg.dry_run}`;
      dryRunBadge.className = msg.dry_run ? 'badge warn' : 'badge ok';
      apiKeyBadge.textContent = msg.api_key_configured ? 'API KEY: Ready' : 'API KEY: Missing in .env';
      apiKeyBadge.className = msg.api_key_configured ? 'badge ok' : 'badge warn';
      break;
    }

    case 'call_status': {
      callStateLabel.textContent = msg.message || msg.status;
      if (msg.model) {
        modelBadge.textContent = `Active Model: ${msg.model}`;
      }
      if (msg.status === 'connected') {
        statusOrb.classList.add('live');
      } else if (msg.status === 'disconnected' || msg.status === 'error') {
        statusOrb.classList.remove('live');
        if (msg.status === 'error') {
          appendLog(`[Error] ${msg.message}`, 'error');
          stopMicCapture();
        }
      }
      break;
    }

    case 'audio_out': {
      if (msg.data) {
        const sampleRate = parseSampleRate(msg.mimeType) || 24000;
        enqueuePcmPlayback(msg.data, sampleRate);
      }
      break;
    }

    case 'interrupted': {
      // Server detected user barge-in: immediately flush all queued audio buffers
      stopAllPlayback('Server barge-in interrupt');
      break;
    }

    case 'transcript': {
      const prefix = msg.role === 'jarvis' ? 'JARVIS' : 'YOU';
      appendLog(`${prefix}: ${msg.text}`, msg.role === 'jarvis' ? 'jarvis' : 'user');
      break;
    }

    case 'tool_event': {
      const ev = msg.event;
      if (ev.type === 'tool_call_started') {
        appendLog(
          `[Tool Call] ${ev.name}(${JSON.stringify(ev.args || {})})`,
          'info'
        );
      } else if (ev.type === 'tool_call_returned') {
        appendLog(
          `[Tool Returned Non-Blocking] ${ev.name} -> ${JSON.stringify(ev.response)}`,
          'success'
        );
      } else if (ev.type === 'background_job_callback') {
        appendLog(
          `[Live Session Callback Injected] Job ${ev.job.job_id} (${ev.job.status}) pushed to Gemini Live session.`,
          'success'
        );
      }
      break;
    }

    case 'job_event': {
      renderJobs(msg.jobs || []);
      if (msg.event === 'created') {
        appendLog(
          `[Job Started] ${msg.job.job_id} on ${msg.job.project_name}: "${msg.job.task_prompt}"`,
          'info'
        );
      }
      break;
    }

    case 'callback_log': {
      appendLog(msg.message, msg.level || 'info');
      break;
    }

    default:
      break;
  }
}

function parseSampleRate(mimeType = '') {
  const match = /rate=(\d+)/i.exec(mimeType);
  return match ? parseInt(match[1], 10) : 24000;
}

/**
 * Play incoming raw 16-bit PCM little-endian base64 chunks seamlessly
 */
function enqueuePcmPlayback(base64Pcm, sampleRate = 24000) {
  if (!playbackCtx) {
    playbackCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 24000
    });
  }

  if (playbackCtx.state === 'suspended') {
    playbackCtx.resume();
  }

  const binaryStr = atob(base64Pcm);
  const byteLength = binaryStr.length;
  const int16Count = Math.floor(byteLength / 2);
  const float32Data = new Float32Array(int16Count);

  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < int16Count; i++) {
    const int16 = view.getInt16(i * 2, true);
    float32Data[i] = int16 / 32768.0;
  }

  const audioBuffer = playbackCtx.createBuffer(1, float32Data.length, sampleRate);
  audioBuffer.getChannelData(0).set(float32Data);

  const source = playbackCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(playbackCtx.destination);

  const now = playbackCtx.currentTime;
  if (nextPlayTime < now) {
    nextPlayTime = now + 0.015;
  }

  source.start(nextPlayTime);
  nextPlayTime += audioBuffer.duration;

  activePlaybackSources.add(source);
  source.onended = () => {
    activePlaybackSources.delete(source);
  };
}

/**
 * Instant Barge-In: Immediately halt any playing/queued Jarvis audio chunks
 */
function stopAllPlayback(reason = 'User barge-in') {
  if (activePlaybackSources.size > 0) {
    for (const src of activePlaybackSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Ignore already stopped source
      }
    }
    activePlaybackSources.clear();
    if (playbackCtx) {
      nextPlayTime = playbackCtx.currentTime;
    }
    bargeInIndicator.textContent = `Barge-In Triggered (${reason})`;
    bargeInIndicator.style.color = '#fbbf24';
    setTimeout(() => {
      bargeInIndicator.textContent = 'Barge-In Ready';
      bargeInIndicator.style.color = '';
    }, 1400);
  }
}

/**
 * Downsample Float32 audio buffer to 16kHz 16-bit mono PCM ArrayBuffer
 */
function float32To16kHzPcm16(float32Buffer, inputSampleRate) {
  const targetRate = 16000;
  const ratio = inputSampleRate / targetRate;
  const outputLength = Math.floor(float32Buffer.length / ratio);
  const pcm16Buffer = new ArrayBuffer(outputLength * 2);
  const view = new DataView(pcm16Buffer);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = Math.floor(i * ratio);
    const sample = Math.max(-1, Math.min(1, float32Buffer[srcIndex]));
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(i * 2, int16, true);
  }

  return pcm16Buffer;
}

async function startMicCapture() {
  try {
    if (!playbackCtx) {
      playbackCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 24000
      });
    }
    await playbackCtx.resume();

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    captureCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 16000
    });

    const source = captureCtx.createMediaStreamSource(micStream);
    processorNode = captureCtx.createScriptProcessor(2048, 1, 1);

    let bargeInFrames = 0;

    processorNode.onaudioprocess = (event) => {
      if (!isCallActive || !ws || ws.readyState !== WebSocket.OPEN) return;

      const inputData = event.inputBuffer.getChannelData(0);

      // Compute RMS mic level for UI meter + local instant barge-in detection
      let sumSquares = 0;
      for (let i = 0; i < inputData.length; i++) {
        sumSquares += inputData[i] * inputData[i];
      }
      const rms = Math.sqrt(sumSquares / inputData.length);
      const levelPct = Math.min(100, Math.round(rms * 380));
      micLevelBar.style.width = `${levelPct}%`;

      // Local instant barge-in if user speaks clearly while Jarvis audio is playing
      if (rms > 0.045 && activePlaybackSources.size > 0) {
        bargeInFrames += 1;
        if (bargeInFrames >= 2) {
          stopAllPlayback('Voice detected');
          bargeInFrames = 0;
        }
      } else {
        bargeInFrames = 0;
      }

      const pcm16Buffer = float32To16kHzPcm16(inputData, captureCtx.sampleRate);
      // Stream binary 16kHz PCM frame directly over WebSocket
      ws.send(pcm16Buffer);
    };

    source.connect(processorNode);
    processorNode.connect(captureCtx.destination);

    isCallActive = true;
    callJarvisBtn.classList.add('active');
    callBtnText.textContent = 'End Call (Hang Up)';

    ws.send(
      JSON.stringify({
        type: 'start_call',
        activeProject: projectSelector.value || 'CoeliSafe'
      })
    );

    appendLog('Microphone stream active (16kHz 16-bit mono PCM). Calling Jarvis...', 'info');
  } catch (err) {
    appendLog(`Microphone access failed: ${err.message}`, 'error');
  }
}

function stopMicCapture() {
  isCallActive = false;
  stopAllPlayback('Call ended');

  if (processorNode) {
    processorNode.disconnect();
    processorNode = null;
  }
  if (captureCtx) {
    captureCtx.close().catch(() => {});
    captureCtx = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }

  micLevelBar.style.width = '0%';
  callJarvisBtn.classList.remove('active');
  callBtnText.textContent = 'Call Jarvis (Mic)';
  statusOrb.classList.remove('live');
  callStateLabel.textContent = 'Standby';
}

// UI Event Listeners
callJarvisBtn.addEventListener('click', () => {
  if (!isCallActive) {
    startMicCapture();
  } else {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'end_call' }));
    }
    stopMicCapture();
  }
});

projectSelector.addEventListener('change', () => {
  updateProjectMeta();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'select_project',
        project_name: projectSelector.value
      })
    );
  }
});

dispatchTaskBtn.addEventListener('click', async () => {
  const taskPrompt = taskPromptInput.value.trim();
  const projectName = projectSelector.value || 'CoeliSafe';
  if (!taskPrompt) return;

  appendLog(
    `[Manual Dispatch] Calling dispatch_coding_task("${projectName}", "${taskPrompt}")...`,
    'info'
  );

  try {
    const res = await fetch('/api/tools/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: 'dispatch_coding_task',
        args: {
          project_name: projectName,
          task_prompt: taskPrompt,
          callback_requested: true
        }
      })
    });
    const data = await res.json();
    if (data.ok) {
      appendLog(
        `[Tool Response] Immediately returned: ${JSON.stringify(data.result)}`,
        'success'
      );
    } else {
      appendLog(`[Tool Error] ${data.error}`, 'error');
    }
  } catch (err) {
    appendLog(`[Request Failed] ${err.message}`, 'error');
  }
});

webhookTestBtn.addEventListener('click', async () => {
  const projectName = projectSelector.value || 'CoeliSafe';
  appendLog(`[Cloudflare Deploy] Firing cloudflare_deploy hook for "${projectName}"...`, 'info');
  try {
    const res = await fetch('/api/tools/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: 'trigger_webhook',
        args: {
          project_name: projectName,
          action_type: 'cloudflare_deploy',
          payload: { triggered_by: 'Jarvis Control Panel' }
        }
      })
    });
    const data = await res.json();
    appendLog(`[Webhook Result] ${JSON.stringify(data.result)}`, 'success');
  } catch (err) {
    appendLog(`[Webhook Error] ${err.message}`, 'error');
  }
});

sendTextBtn.addEventListener('click', () => {
  const text = textPromptInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'text_in', text }));
  appendLog(`YOU (Text): ${text}`, 'user');
  textPromptInput.value = '';
});

textPromptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendTextBtn.click();
});

clearLogBtn.addEventListener('click', () => {
  callbackLog.innerHTML = '';
});

connectWebSocket();
