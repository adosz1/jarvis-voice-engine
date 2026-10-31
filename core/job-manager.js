import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const JOBS_FILE_PATH = path.resolve(__dirname, '../profiles/jobs-history.json');

export class JobManager extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.counter = 100;
    this._loadFromDisk();
  }

  _loadFromDisk() {
    try {
      if (fs.existsSync(JOBS_FILE_PATH)) {
        const raw = fs.readFileSync(JOBS_FILE_PATH, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const job of list) {
            this.jobs.set(job.job_id, job);
            const num = parseInt(String(job.job_id).replace(/\D/g, ''), 10);
            if (!isNaN(num) && num >= this.counter) {
              this.counter = num;
            }
          }
        }
      }
    } catch (err) {
      console.warn('[JobManager] Could not load persisted jobs history:', err.message);
    }
  }

  _saveToDisk() {
    try {
      const dir = path.dirname(JOBS_FILE_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const serialized = JSON.stringify(this.getAllJobs(), null, 2);
      fs.writeFileSync(JOBS_FILE_PATH, serialized, 'utf-8');
    } catch (err) {
      console.error('[JobManager] Failed to persist jobs to disk:', err.message);
    }
  }

  createJob({ project_name, task_prompt, callback_requested = true, command = '' }) {
    this.counter += 1;
    const job_id = `job_${this.counter}`;
    const job = {
      job_id,
      project_name,
      task_prompt,
      command,
      callback_requested: Boolean(callback_requested),
      status: 'running',
      result_summary: 'Task dispatched and running in background...',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null
    };

    this.jobs.set(job_id, job);
    this._saveToDisk();
    this.emit('job_created', job);
    return job;
  }

  updateJob(job_id, updates = {}) {
    const existing = this.jobs.get(job_id);
    if (!existing) return null;

    const updated = {
      ...existing,
      ...updates,
      updated_at: new Date().toISOString()
    };

    if (updates.status === 'completed' || updates.status === 'failed') {
      updated.completed_at = new Date().toISOString();
    }

    this.jobs.set(job_id, updated);
    this._saveToDisk();
    this.emit('job_updated', updated);

    if (updates.status === 'completed' || updates.status === 'failed') {
      this.emit('job_finished', updated);
    }

    return updated;
  }

  getJob(job_id) {
    return this.jobs.get(job_id) || null;
  }

  getAllJobs() {
    return Array.from(this.jobs.values()).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }
}

export const jobManager = new JobManager();
