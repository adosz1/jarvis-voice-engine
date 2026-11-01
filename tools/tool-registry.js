import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { jobManager } from '../core/job-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECTS_PATH = path.resolve(__dirname, '../profiles/projects.json');

export function loadProjects() {
  try {
    if (!fs.existsSync(PROJECTS_PATH)) return [];
    const raw = fs.readFileSync(PROJECTS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[ToolRegistry] Error reading projects.json:', err.message);
    return [];
  }
}

export function findProject(projectName) {
  const projects = loadProjects();
  if (!projectName) return projects[0] || null;
  const normalized = projectName.trim().toLowerCase();
  return (
    projects.find((p) => p.project_name.toLowerCase() === normalized) ||
    projects.find((p) => p.project_name.toLowerCase().includes(normalized)) ||
    projects[0] ||
    null
  );
}

function normalizeGithubRepo(repoStr = '') {
  const raw = String(process.env.COELISAFE_GITHUB_REPO || repoStr || '').trim();
  return raw
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
}

function getCloudflareDeployHook(project) {
  return (
    process.env.CLOUDFLARE_DEPLOY_HOOK ||
    project?.cloudflare_deploy_hook ||
    project?.webhooks?.cloudflare_deploy ||
    ''
  ).trim();
}

/**
 * Gemini Live Function Declarations (non-blocking behavior enabled)
 */
export const TOOL_DECLARATIONS = [
  {
    functionDeclarations: [
      {
        name: 'list_projects',
        description:
          'Returns all configured projects from /profiles/projects.json including project_name, github_repo, cloudflare_project, live_domain, and system_notes.',
        parameters: {
          type: 'OBJECT',
          properties: {}
        }
      },
      {
        name: 'dispatch_coding_task',
        description:
          'Dispatches a background coding and Cloudflare auto-deploy task for the target project (such as CoeliSafe). Works 24/7 in Cloud Mode via GitHub + Cloudflare Pages even when the user PC is off, or locally when on PC. Returns immediately with { status: "started", job_id } so Jarvis can continue speaking without blocking, and can call the user back when finished.',
        parameters: {
          type: 'OBJECT',
          properties: {
            project_name: {
              type: 'STRING',
              description: 'Name of the target project (e.g., "CoeliSafe").'
            },
            task_prompt: {
              type: 'STRING',
              description: 'Clear description of the code change, new feature, restaurant entry, or fix to execute and publish.'
            },
            auto_deploy: {
              type: 'BOOLEAN',
              description: 'Whether to automatically push and deploy the changes to Cloudflare Pages once edited (default true).'
            },
            callback_requested: {
              type: 'BOOLEAN',
              description: 'Whether to notify the user (or call their phone back if they hung up) when the background job finishes (default true).'
            }
          },
          required: ['project_name', 'task_prompt']
        }
      },
      {
        name: 'trigger_webhook',
        description:
          'Fires an asynchronous HTTP POST request to trigger a Cloudflare Pages deployment ("cloudflare_deploy") or external automation webhook.',
        parameters: {
          type: 'OBJECT',
          properties: {
            project_name: {
              type: 'STRING',
              description: 'Name of the project associated with the webhook (e.g., "CoeliSafe").'
            },
            action_type: {
              type: 'STRING',
              description: 'Type of webhook action to trigger (e.g., "cloudflare_deploy", "email_notification", "calendar_sync").'
            },
            payload: {
              type: 'OBJECT',
              description: 'Optional JSON payload to send in the POST request body.'
            }
          },
          required: ['project_name', 'action_type']
        }
      }
    ]
  }
];

/**
 * Execute a tool call invoked by Gemini Live or test API
 * @param {string} name - Tool name
 * @param {object} args - Tool arguments
 * @param {object} context - Execution context ({ onJobCompletedCallback, activeProject })
 */
export async function executeToolCall(name, args = {}, context = {}) {
  switch (name) {
    case 'list_projects': {
      const projects = loadProjects();
      return {
        status: 'ok',
        count: projects.length,
        projects
      };
    }

    case 'dispatch_coding_task': {
      const projectName = args.project_name || context.activeProject || 'CoeliSafe';
      const taskPrompt = args.task_prompt || 'Run diagnostics';
      const autoDeploy = args.auto_deploy !== undefined ? Boolean(args.auto_deploy) : true;
      const callbackRequested =
        args.callback_requested !== undefined ? Boolean(args.callback_requested) : true;

      const project = findProject(projectName);
      const targetPath = project ? project.local_path : process.cwd();
      const resolvedProjectName = project ? project.project_name : projectName;
      const isDryRun = String(process.env.DRY_RUN).toLowerCase() === 'true';
      const hasGithubToken = Boolean(
        process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN !== 'your_github_token_here'
      );
      const localPathExists = Boolean(targetPath && fs.existsSync(targetPath));

      let executionMode = 'local';
      if (isDryRun) {
        executionMode = 'dry_run';
      } else if (hasGithubToken) {
        executionMode = 'cloud_github_cloudflare';
      }

      const commandDisplay =
        executionMode === 'dry_run'
          ? `[DRY_RUN] Cloud/Local Edit & Cloudflare Deploy: "${taskPrompt}"`
          : executionMode === 'cloud_github_cloudflare'
          ? `[CLOUD 24/7] GitHub Edit + Cloudflare Pages Deploy (${normalizeGithubRepo(project?.github_repo)})`
          : `[LOCAL + CLOUDFLARE] Edit "${taskPrompt}" in ${targetPath}`;

      const job = jobManager.createJob({
        project_name: resolvedProjectName,
        task_prompt: taskPrompt,
        callback_requested: callbackRequested,
        command: commandDisplay
      });

      // Run background worker without blocking the voice stream
      runBackgroundCodingAndDeploy({
        job,
        project,
        targetPath,
        taskPrompt,
        autoDeploy,
        executionMode,
        onJobCompletedCallback: context.onJobCompletedCallback
      });

      return {
        status: 'started',
        job_id: job.job_id,
        project_name: resolvedProjectName,
        execution_mode: executionMode,
        dry_run: isDryRun,
        message: `Background job ${job.job_id} started on ${resolvedProjectName} (${executionMode}).`
      };
    }

    case 'trigger_webhook': {
      const projectName = args.project_name || context.activeProject || 'CoeliSafe';
      const rawAction = String(args.action_type || 'cloudflare_deploy').toLowerCase();
      const actionType =
        rawAction.includes('netlify') || rawAction.includes('deploy') || rawAction.includes('cloudflare')
          ? 'cloudflare_deploy'
          : rawAction;
      const payload = args.payload || {};

      const project = findProject(projectName);
      if (!project) {
        return {
          status: 'error',
          message: `Project "${projectName}" not found in profiles/projects.json.`
        };
      }

      const webhookUrl =
        actionType === 'cloudflare_deploy'
          ? getCloudflareDeployHook(project)
          : project.webhooks && project.webhooks[actionType];

      const isDryRun = String(process.env.DRY_RUN).toLowerCase() === 'true';

      if (!webhookUrl || webhookUrl.includes('sample_')) {
        const summary = `Cloudflare deploy hook triggered (simulated) for ${project.project_name}. Add CLOUDFLARE_DEPLOY_HOOK in .env for live instant builds.`;
        return {
          status: 'triggered_simulated',
          project_name: project.project_name,
          action_type: actionType,
          webhook_url: webhookUrl || 'not_configured_yet',
          summary
        };
      }

      if (isDryRun) {
        return {
          status: 'triggered_dry_run',
          project_name: project.project_name,
          action_type: actionType,
          webhook_url: webhookUrl,
          summary: `Dry-run Cloudflare deploy POST queued for ${project.project_name}.`
        };
      }

      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: project.project_name,
          action_type: actionType,
          timestamp: new Date().toISOString(),
          ...payload
        })
      })
        .then((res) => {
          console.log(`[Cloudflare Deploy Hook] ${project.project_name} -> HTTP ${res.status}`);
        })
        .catch((err) => {
          console.error(`[Cloudflare Deploy Hook] ${project.project_name} failed:`, err.message);
        });

      return {
        status: 'triggered',
        project_name: project.project_name,
        action_type: actionType,
        summary: `Triggered live Cloudflare Pages deployment for ${project.project_name}.`
      };
    }

    default:
      return {
        status: 'error',
        message: `Unknown tool: ${name}`
      };
  }
}

async function triggerCloudflareDeployIfConfigured(project) {
  const hookUrl = getCloudflareDeployHook(project);
  if (!hookUrl || hookUrl.includes('sample_')) return false;
  try {
    const res = await fetch(hookUrl, { method: 'POST' });
    return res.ok;
  } catch (err) {
    console.warn('[CloudflareDeploy] Deploy hook call failed:', err.message);
    return false;
  }
}

const CODING_MODEL_WATERFALL = [
  ...(process.env.JARVIS_CODING_MODEL ? [process.env.JARVIS_CODING_MODEL] : []),
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash'
];

function buildSmartFileExcerpt(filePath, content, taskPrompt) {
  if (!content || content.length <= 45000) {
    return content;
  }

  // For large single-page HTML files (like CoeliSafe's 405KB index.html), extract the <body> HTML markup
  // plus any keyword-matched regions so we stay well within fast Free Tier token limits (~45KB instead of 405KB).
  const bodyStart = content.indexOf('<body>');
  const scriptInBody = bodyStart !== -1 ? content.indexOf('<script>', bodyStart) : -1;

  const sections = [];
  if (bodyStart !== -1 && scriptInBody !== -1) {
    const htmlBodyMarkup = content.slice(bodyStart, Math.min(scriptInBody, bodyStart + 36000));
    sections.push(`/* --- HTML BODY MARKUP SECTION --- */\n${htmlBodyMarkup}`);
  } else {
    sections.push(content.slice(0, 25000));
  }

  // Also search for keyword matches across the rest of the file
  const stopWords = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'add', 'small',
    'make', 'change', 'update', 'edit', 'index', 'html', 'coelisafe', 'jarvis', 'file'
  ]);
  const keywords = (taskPrompt.toLowerCase().match(/[a-z0-9_]{4,}/g) || []).filter(
    (w) => !stopWords.has(w)
  );

  if (keywords.length > 0) {
    const lines = content.split('\n');
    const matchedRanges = [];
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      if (keywords.some((kw) => lower.includes(kw))) {
        const start = Math.max(0, i - 12);
        const end = Math.min(lines.length - 1, i + 18);
        if (matchedRanges.length > 0 && start <= matchedRanges[matchedRanges.length - 1].end) {
          matchedRanges[matchedRanges.length - 1].end = end;
        } else {
          matchedRanges.push({ start, end });
        }
        i = end;
        if (matchedRanges.length >= 4) break;
      }
    }
    for (const r of matchedRanges) {
      const snippet = lines.slice(r.start, r.end + 1).join('\n');
      if (snippet.length < 6000) {
        sections.push(`/* --- MATCHED LINES ${r.start + 1}-${r.end + 1} --- */\n${snippet}`);
      }
    }
  }

  return sections.join('\n\n').slice(0, 48000);
}

async function generateWithBestCodingModel(ai, { contents, config }) {
  let lastErr = null;
  for (const model of CODING_MODEL_WATERFALL) {
    try {
      const resp = await ai.models.generateContent({
        model,
        contents,
        config: {
          ...(config || {}),
          abortSignal: AbortSignal.timeout(45000)
        }
      });
      return { resp, usedModel: model };
    } catch (err) {
      lastErr = err;
      console.warn(`[CodingAgent] Model ${model} unavailable (${err.status || err.message?.slice(0, 80)}), falling back...`);
    }
  }
  throw lastErr || new Error('All coding models in waterfall failed.');
}

/**
 * Cloud-native GitHub + Gemini code editor (runs 24/7 even when the user's PC is completely off)
 */
async function executeCloudGithubCodeEdit({ project, taskPrompt, autoDeploy }) {
  const token = (process.env.GITHUB_TOKEN || '').trim();
  const repo = normalizeGithubRepo(project?.github_repo);
  const branch = project?.github_branch || process.env.GITHUB_BRANCH || 'main';

  if (!token || !repo) {
    throw new Error(
      'Missing GITHUB_TOKEN or github_repo config for 24/7 Cloud Code Editing.'
    );
  }

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Jarvis-Voice-Engine'
  };

  // 1. Fetch repository file tree
  const treeRes = await fetch(
    `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`,
    { headers: ghHeaders }
  );
  if (!treeRes.ok) {
    throw new Error(`GitHub API tree lookup failed (${treeRes.status}) on ${repo}@${branch}`);
  }
  const treeData = await treeRes.json();
  const allFiles = (treeData.tree || [])
    .filter(
      (item) =>
        item.type === 'blob' &&
        !item.path.includes('node_modules/') &&
        !item.path.startsWith('.git/') &&
        !item.path.endsWith('.lock') &&
        !item.path.endsWith('package-lock.json') &&
        (item.size || 0) < 500000
    )
    .map((item) => item.path);

  const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  const ai = new GoogleGenAI({ apiKey });

  // 2. Select target files directly if named in prompt (saves an API call), otherwise ask Gemini
  const lowerPrompt = taskPrompt.toLowerCase();
  let targetFiles = allFiles.filter((f) => lowerPrompt.includes(f.toLowerCase()));
  if (targetFiles.length === 0 && allFiles.includes('index.html')) {
    targetFiles = ['index.html'];
  }
  if (targetFiles.length === 0) {
    const { resp: fileSelectResp } = await generateWithBestCodingModel(ai, {
      contents: `You are Jarvis editing the "${project?.project_name || 'CoeliSafe'}" repository (${repo}).
Task requested by user on voice call: "${taskPrompt}"

Repository files:
${allFiles.slice(0, 250).join('\n')}

Return ONLY a JSON array of up to 2 file paths from the repository that need to be read and edited (or created) to accomplish this task. Example: ["index.html"]`,
      config: {
        responseMimeType: 'application/json'
      }
    });

    try {
      targetFiles = JSON.parse(fileSelectResp.text || '[]');
    } catch {
      targetFiles = allFiles.slice(0, 2);
    }
  }
  if (!Array.isArray(targetFiles) || targetFiles.length === 0) {
    targetFiles = allFiles.slice(0, 2);
  }

  // 3. Fetch current contents + SHA of selected files from GitHub
  const fileSnapshots = [];
  for (const filePath of targetFiles.slice(0, 5)) {
    const fileRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath)}?ref=${branch}`,
      { headers: ghHeaders }
    );
    if (fileRes.ok) {
      const fileJson = await fileRes.json();
      const decoded = Buffer.from(fileJson.content || '', 'base64')
        .toString('utf-8')
        .replace(/\r\n/g, '\n');
      fileSnapshots.push({
        path: filePath,
        sha: fileJson.sha,
        content: decoded
      });
    } else {
      fileSnapshots.push({
        path: filePath,
        sha: null,
        content: ''
      });
    }
  }

  // 4. Ask Gemini for fast surgical search-and-replace patches (instead of rewriting entire 150KB files)
  const { resp: editResp, usedModel } = await generateWithBestCodingModel(ai, {
    contents: `You are Jarvis, an autonomous coding agent editing "${project?.project_name || 'CoeliSafe'}".
System Notes: ${project?.system_notes || ''}
User Voice Instruction: "${taskPrompt}"

Current file contents (or relevant sections for large files):
${fileSnapshots
  .map((f) => `--- FILE: ${f.path} ---\n${buildSmartFileExcerpt(f.path, f.content, taskPrompt)}\n--- END FILE: ${f.path} ---`)
  .join('\n\n')}

Apply the user's requested changes using concise, exact search-and-replace blocks (do NOT output the entire file unless creating a brand-new file). Return a JSON object with:
{
  "summary": "1-sentence spoken summary of what was changed",
  "edits": [
    {
      "path": "relative/path/to/file",
      "search": "exact existing substring from the file to find",
      "replace": "updated substring to replace it with"
    }
  ]
}`,
    config: {
      responseMimeType: 'application/json'
    }
  });

  const editPlan = JSON.parse(editResp.text || '{}');
  const fileMap = new Map(fileSnapshots.map((f) => [f.path, { ...f, modified: false }]));

  if (Array.isArray(editPlan.edits)) {
    for (const patch of editPlan.edits) {
      const target = fileMap.get(patch.path);
      const cleanSearch = String(patch.search || '').replace(/\r\n/g, '\n');
      const cleanReplace = String(patch.replace ?? '').replace(/\r\n/g, '\n');
      if (target && cleanSearch) {
        if (target.content.includes(cleanSearch)) {
          target.content = target.content.replace(cleanSearch, cleanReplace);
          target.modified = true;
        } else if (target.content.includes(cleanSearch.trim())) {
          target.content = target.content.replace(cleanSearch.trim(), cleanReplace);
          target.modified = true;
        } else {
          // Whitespace-tolerant multi-line regex fallback
          const escapedLines = cleanSearch
            .trim()
            .split('\n')
            .map((line) => line.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .filter(Boolean);
          if (escapedLines.length > 0) {
            const flexRegex = new RegExp(escapedLines.join('\\s+'));
            if (flexRegex.test(target.content)) {
              target.content = target.content.replace(flexRegex, () => cleanReplace);
              target.modified = true;
            }
          }
        }
      } else if (!target && cleanReplace) {
        fileMap.set(patch.path, { path: patch.path, sha: null, content: cleanReplace, modified: true });
      }
    }
  }

  if (Array.isArray(editPlan.files)) {
    for (const fullFile of editPlan.files) {
      if (fullFile.path && typeof fullFile.content === 'string') {
        const existing = fileMap.get(fullFile.path);
        fileMap.set(fullFile.path, {
          path: fullFile.path,
          sha: existing?.sha || null,
          content: fullFile.content,
          modified: true
        });
      }
    }
  }

  const updatedFiles = Array.from(fileMap.values()).filter((f) => f.modified);
  if (updatedFiles.length === 0) {
    throw new Error('No matching search-and-replace changes were produced by the cloud coding model.');
  }

  // 5. Commit each updated file back to GitHub (triggers Cloudflare Pages automatic deployment)
  const committedPaths = [];
  for (const edited of updatedFiles) {
    const body = {
      message: `Jarvis Voice Task: ${taskPrompt}`,
      content: Buffer.from(edited.content, 'utf-8').toString('base64'),
      branch
    };
    if (edited.sha) {
      body.sha = edited.sha;
    }

    const putRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(edited.path)}`,
      {
        method: 'PUT',
        headers: {
          ...ghHeaders,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    if (!putRes.ok) {
      const errText = await putRes.text();
      throw new Error(`Failed committing ${edited.path} to GitHub (${putRes.status}): ${errText}`);
    }
    committedPaths.push(edited.path);
  }

  // 6. Trigger explicit Cloudflare Pages deploy hook if configured (in addition to GitHub auto-deploy)
  let hookTriggered = false;
  if (autoDeploy) {
    hookTriggered = await triggerCloudflareDeployIfConfigured(project);
  }

  const deployNote = hookTriggered
    ? 'Pushed to GitHub and triggered Cloudflare Pages deploy hook.'
    : 'Committed to GitHub (Cloudflare Pages auto-deploy triggered).';

  return `[Model: ${usedModel}] ${editPlan.summary || `Updated ${committedPaths.join(', ')}`}. ${deployNote}`;
}

/**
 * Local direct Gemini file editor fallback when running on PC with DRY_RUN=false
 */
async function executeLocalGeminiCodeEdit({ project, targetPath, taskPrompt, autoDeploy }) {
  const walkFiles = (dir, base = dir, acc = []) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'dist' ||
        entry.name === 'build' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(base, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walkFiles(full, base, acc);
      } else {
        const stat = fs.statSync(full);
        if (stat.size < 120000) {
          acc.push(rel);
        }
      }
    }
    return acc;
  };

  const allFiles = walkFiles(targetPath);
  const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  const ai = new GoogleGenAI({ apiKey });

  const { resp: fileSelectResp } = await generateWithBestCodingModel(ai, {
    contents: `You are Jarvis editing "${project?.project_name || 'CoeliSafe'}" at ${targetPath}.
Task: "${taskPrompt}"
Files:
${allFiles.slice(0, 250).join('\n')}
Return ONLY a JSON array of up to 5 relative file paths to read and edit.`,
    config: { responseMimeType: 'application/json' }
  });

  let targetFiles = [];
  try {
    targetFiles = JSON.parse(fileSelectResp.text || '[]');
  } catch {
    targetFiles = allFiles.slice(0, 3);
  }

  const fileSnapshots = [];
  for (const relPath of (targetFiles || []).slice(0, 5)) {
    const fullPath = path.resolve(targetPath, relPath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      fileSnapshots.push({
        path: relPath,
        content: fs.readFileSync(fullPath, 'utf-8')
      });
    }
  }

  const { resp: editResp, usedModel } = await generateWithBestCodingModel(ai, {
    contents: `You are Jarvis editing "${project?.project_name || 'CoeliSafe'}".
User Voice Instruction: "${taskPrompt}"

Files:
${fileSnapshots.map((f) => `--- FILE: ${f.path} ---\n${f.content}\n--- END FILE ---`).join('\n\n')}

Return JSON:
{
  "summary": "1-sentence spoken summary of the code changes made",
  "files": [{ "path": "relative/path", "content": "full updated file content" }]
}`,
    config: { responseMimeType: 'application/json' }
  });

  const editPlan = JSON.parse(editResp.text || '{}');
  const updatedFiles = Array.isArray(editPlan.files) ? editPlan.files : [];
  for (const edited of updatedFiles) {
    const dest = path.resolve(targetPath, edited.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, edited.content, 'utf-8');
  }

  let hookTriggered = false;
  if (autoDeploy) {
    hookTriggered = await triggerCloudflareDeployIfConfigured(project);
  }

  return `[Model: ${usedModel}] ${editPlan.summary || `Updated ${updatedFiles.map((f) => f.path).join(', ')}`}${
    hookTriggered ? ' and triggered Cloudflare Pages deploy.' : '.'
  }`;
}

function runBackgroundCodingAndDeploy({
  job,
  project,
  targetPath,
  taskPrompt,
  autoDeploy,
  executionMode,
  onJobCompletedCallback
}) {
  const finishJob = (status, resultSummary) => {
    const updated = jobManager.updateJob(job.job_id, {
      status,
      result_summary: resultSummary
    });
    if (onJobCompletedCallback && updated) {
      onJobCompletedCallback(updated);
    }
  };

  // 1. Dry-run mode (4.5s non-blocking simulation)
  if (executionMode === 'dry_run') {
    setTimeout(() => {
      finishJob(
        'completed',
        `[DRY_RUN] Completed simulated edit & Cloudflare Pages deploy for "${taskPrompt}" on ${job.project_name}. (Set DRY_RUN=false in .env for real edits)`
      );
    }, 4500);
    return;
  }

  // 2. 24/7 Cloud Mode (PC off -> edits GitHub directly + triggers Cloudflare Pages deploy)
  if (executionMode === 'cloud_github_cloudflare') {
    executeCloudGithubCodeEdit({ project, taskPrompt, autoDeploy })
      .then((summary) => finishJob('completed', summary))
      .catch((err) => finishJob('failed', `Cloud edit failed: ${err.message}`));
    return;
  }

  // 3. Local Mode: try `agy -p` if available, or fall back to direct Gemini file editing
  const cwd = targetPath && fs.existsSync(targetPath) ? targetPath : process.cwd();
  try {
    const child = spawn('agy', ['-p', taskPrompt], {
      cwd,
      detached: true,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    child.on('error', () => {
      // Fallback to direct Gemini file editing if `agy` CLI is not in PATH
      executeLocalGeminiCodeEdit({ project, targetPath: cwd, taskPrompt, autoDeploy })
        .then((summary) => finishJob('completed', summary))
        .catch((err) => finishJob('failed', err.message));
    });

    child.on('close', async (code) => {
      if (code !== 0) {
        // Fallback to direct Gemini file editing if `agy` CLI was not recognized by the shell
        try {
          const summary = await executeLocalGeminiCodeEdit({
            project,
            targetPath: cwd,
            taskPrompt,
            autoDeploy
          });
          finishJob('completed', summary);
          return;
        } catch (fallbackErr) {
          finishJob('failed', `Task failed: ${fallbackErr.message || stderrData}`);
          return;
        }
      }

      if (autoDeploy) {
        await triggerCloudflareDeployIfConfigured(project);
      }

      const rawOutput = (stdoutData || stderrData || '').trim();
      const snippet = rawOutput.length > 350 ? rawOutput.slice(-350) : rawOutput;
      finishJob(
        'completed',
        snippet || `Completed "${taskPrompt}" on ${job.project_name} and synced Cloudflare deploy.`
      );
    });

    child.unref();
  } catch {
    executeLocalGeminiCodeEdit({ project, targetPath: cwd, taskPrompt, autoDeploy })
      .then((summary) => finishJob('completed', summary))
      .catch((err) => finishJob('failed', err.message));
  }
}
