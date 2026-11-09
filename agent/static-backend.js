'use strict';
// 정적 호스팅 백엔드. 서버 로직이 없으므로 작업 상태의 원본은 이 PC(.bridge-data/)에 두고,
// 게시 API(upload-file)로 app/data/tasks.json 과 app/data/tasks/<번호>.json 을 올려 웹 화면이 읽게 한다.
// 새 요청·취소·다시 실행은 브라우저가 app/data/inbox.json 에 써 두고, 여기서 그 파일을 읽어 반영한다.
// agent.js / orchestrator-hook.js 가 쓰는 api(action, params) 형태(hello, claim, progress, complete, ping)를 그대로 제공한다.

const fs = require('fs');
const path = require('path');

const INDEX_FILE = 'app/data/tasks.json';
const INBOX_FILE = 'app/data/inbox.json';
const taskFile = (id) => `app/data/tasks/${id}.json`;
const MAX_LOG = 200000;
const SEEN_KEEP = 500;
const INDEX_TASKS = 500;
const INBOX_SYNC_MS = 4000;
const TASK_PUBLISH_MS = 5000;
const HEARTBEAT_PUBLISH_MS = 60000;
const RUN_FIELDS = ['agent', 'startedAt', 'finishedAt', 'result', 'diff', 'files', 'log', 'sessionId', 'costUsd', 'durationMs', 'numTurns', 'denials', 'cancelRequested'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const cut = (s, n) => String(s == null ? '' : s).slice(0, n);

class ApiError extends Error {}

function createStaticApi(cfg, storeDir) {
  const s = cfg.static;
  const dir = storeDir || path.join(__dirname, '.bridge-data');
  const tasksDir = path.join(dir, 'tasks');
  const metaPath = path.join(dir, 'meta.json');
  const lockPath = path.join(dir, '.lock');
  fs.mkdirSync(tasksDir, { recursive: true });

  // ---------- 로컬 저장소 (여러 훅 프로세스가 함께 쓰므로 잠금 + 원자적 쓰기) ----------

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  function writeJson(file, obj) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        if (i >= 20) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }

  async function withLock(fn) {
    for (let i = 0; ; i++) {
      try {
        fs.closeSync(fs.openSync(lockPath, 'wx'));
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs > 60000) fs.rmSync(lockPath, { force: true }); // 죽은 프로세스가 남긴 잠금
        } catch {
          // 다른 프로세스가 방금 지웠다
        }
        if (i > 400) throw new Error('로컬 작업 저장소 잠금을 얻지 못했습니다');
        await sleep(50);
      }
    }
    try {
      return await fn();
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  }

  const loadMeta = () => ({ nextId: 1, seen: [], agents: {}, lastInboxSync: 0, lastIndexPublish: 0, lastTaskPublish: {}, ...readJson(metaPath, {}) });
  const saveMeta = (m) => writeJson(metaPath, m);
  const taskPath = (id) => path.join(tasksDir, `${Number(id)}.json`);
  const loadTask = (id) => readJson(taskPath(id), null);
  const saveTask = (t) => writeJson(taskPath(t.id), t);
  const allTasks = () =>
    fs
      .readdirSync(tasksDir)
      .filter((n) => /^\d+\.json$/.test(n))
      .map((n) => readJson(path.join(tasksDir, n), null))
      .filter(Boolean)
      .sort((a, b) => a.id - b.id);

  function mustTask(id) {
    const t = loadTask(id);
    if (!t) throw new ApiError(`작업 #${id} 이(가) 없습니다`);
    return t;
  }

  // ---------- 게시 API / 게시된 파일 ----------

  async function upload(fileName, obj) {
    const res = await fetch(`${s.apiBase}/api/upload-file`, {
      method: 'POST',
      headers: { 'Authorization-HCP-GW': `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_name: s.appName, file_name: fileName, content: JSON.stringify(obj) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`게시 API ${fileName} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  async function fetchPublished(fileName) {
    const res = await fetch(`${s.appUrl}${fileName}?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${fileName} 읽기 실패: HTTP ${res.status}`);
    return res.json();
  }

  function publicTask(t) {
    if (s.publishDiff) return t;
    const { diff, ...rest } = t;
    return { ...rest, diffHidden: !!diff };
  }

  async function publishTasks(meta, ids) {
    for (const id of new Set(ids)) {
      const t = loadTask(id);
      if (!t) continue;
      await upload(taskFile(id), publicTask(t));
      meta.lastTaskPublish[id] = Date.now();
    }
  }

  async function publishIndex(meta) {
    const summaries = allTasks()
      .reverse()
      .slice(0, INDEX_TASKS)
      .map((t) => ({
        id: t.id,
        title: t.title,
        project: t.project,
        requester: t.requester,
        status: t.status,
        createdAt: t.createdAt,
        startedAt: t.startedAt || null,
        finishedAt: t.finishedAt || null,
        agent: t.agent || null,
        parentId: t.parentId || null,
        durationMs: t.durationMs || null,
        cancelRequested: !!t.cancelRequested,
        fileCount: t.files ? t.files.split('\n').filter(Boolean).length : 0,
      }));
    const agents = Object.entries(meta.agents).map(([name, a]) => ({ name, ...a }));
    await upload(INDEX_FILE, { generatedAt: now(), agents, seenInbox: meta.seen.slice(-200), tasks: summaries });
    meta.lastIndexPublish = Date.now();
  }

  function heartbeat(meta, agent, projects, busy) {
    if (!agent) return false;
    const a = meta.agents[agent] || {};
    const changed = !meta.agents[agent] || (busy !== undefined && busy !== null && a.busy !== busy);
    meta.agents[agent] = {
      lastSeen: now(),
      projects: projects != null ? projects : a.projects || '',
      busy: busy != null ? busy : a.busy || '',
    };
    return changed;
  }

  // ---------- inbox: 브라우저가 쓴 요청 / 취소 / 다시 실행 ----------

  function finish(t, status, result) {
    t.status = status;
    t.finishedAt = now();
    if (result) t.result = result;
  }

  async function syncInbox(meta, force) {
    if (!force && Date.now() - meta.lastInboxSync < INBOX_SYNC_MS) return [];
    meta.lastInboxSync = Date.now();
    const inbox = await fetchPublished(INBOX_FILE);
    const entries = (inbox && Array.isArray(inbox.entries) ? inbox.entries : []).filter((e) => e && typeof e.id === 'string');
    const seen = new Set(meta.seen);
    const dirty = [];
    for (const e of entries.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      meta.seen.push(e.id);
      if (e.type === 'request') {
        const prompt = cut(e.prompt, 50000).trim();
        if (!prompt) continue;
        const parent = e.parentId ? loadTask(e.parentId) : null;
        const title = cut(e.title, 100).trim() || (parent ? `#${parent.id} 추가 지시` : cut(prompt.split('\n')[0], 60));
        const t = {
          id: meta.nextId++,
          requestId: e.id,
          project: parent ? parent.project : cut(e.project, 60).trim(),
          title,
          prompt,
          requester: cut(e.requester, 30).trim() || '(이름 없음)',
          status: 'pending',
          createdAt: typeof e.createdAt === 'string' ? e.createdAt : now(),
          parentId: parent ? parent.id : null,
        };
        saveTask(t);
        dirty.push(t.id);
      } else if (e.type === 'cancel' || e.type === 'retry') {
        const t = loadTask(e.taskId);
        if (!t) continue;
        if (e.type === 'cancel') {
          if (t.status === 'pending') finish(t, 'canceled');
          else if (t.status === 'running' && (t.cancelRequested || e.force)) finish(t, 'canceled', t.result || '웹에서 강제 중단했습니다.');
          else if (t.status === 'running') t.cancelRequested = true;
          else continue;
        } else {
          if (t.status === 'pending' || t.status === 'running') continue;
          for (const k of RUN_FIELDS) delete t[k];
          t.status = 'pending';
          t.createdAt = now();
        }
        saveTask(t);
        dirty.push(t.id);
      }
    }
    meta.seen = meta.seen.slice(-SEEN_KEEP);
    return dirty;
  }

  function withParent(t) {
    const out = { ...t };
    if (t.parentId) {
      const p = loadTask(t.parentId);
      if (p) Object.assign(out, { resumeSessionId: p.sessionId || null, parentPrompt: cut(p.prompt, 4000), parentResult: cut(p.result, 4000) });
    }
    return out;
  }

  // ---------- api.jsp 와 같은 동작 ----------

  const actions = {
    async hello({ agent, projects }) {
      const meta = loadMeta();
      const dirty = [];
      for (const t of allTasks()) {
        if (t.status === 'running' && t.agent === agent) {
          finish(t, 'error', '에이전트가 재시작되어 작업이 중단되었습니다. 다시 실행하세요.');
          saveTask(t);
          dirty.push(t.id);
        }
      }
      heartbeat(meta, agent, projects, '');
      await publishTasks(meta, dirty);
      await publishIndex(meta);
      saveMeta(meta);
      return { ok: true, orphaned: dirty.length };
    },

    async claim({ agent, projects }) {
      const meta = loadMeta();
      const dirty = await syncInbox(meta, true);
      const wanted = new Set(String(projects || '').split(',').map((p) => p.trim()).filter(Boolean));
      const task = allTasks().find((t) => t.status === 'pending' && (!wanted.size || wanted.has(t.project)));
      let changed = heartbeat(meta, agent, projects, task ? String(task.id) : undefined);
      if (task) {
        Object.assign(task, { status: 'running', agent, startedAt: now() });
        saveTask(task);
        dirty.push(task.id);
        changed = true;
      }
      await publishTasks(meta, dirty);
      if (dirty.length || changed || Date.now() - meta.lastIndexPublish > HEARTBEAT_PUBLISH_MS) await publishIndex(meta);
      saveMeta(meta);
      return { task: task ? withParent(task) : null };
    },

    async progress({ id, log }) {
      const meta = loadMeta();
      let t = mustTask(id);
      if (log) {
        t.log = t.log ? `${t.log}\n${log}` : String(log);
        if (t.log.length > MAX_LOG) t.log = t.log.slice(-MAX_LOG);
        saveTask(t);
      }
      const dirty = await syncInbox(meta, false);
      t = mustTask(id);
      const changed = heartbeat(meta, t.agent, null, String(t.id));
      if (dirty.length || Date.now() - (meta.lastTaskPublish[t.id] || 0) > TASK_PUBLISH_MS) dirty.push(t.id);
      await publishTasks(meta, dirty);
      if (dirty.length > 1 || changed || Date.now() - meta.lastIndexPublish > HEARTBEAT_PUBLISH_MS) await publishIndex(meta);
      saveMeta(meta);
      return { canceled: !!t.cancelRequested || t.status === 'canceled' };
    },

    async complete(p) {
      const meta = loadMeta();
      const t = mustTask(p.id);
      let status = ['done', 'error', 'canceled'].includes(p.status) ? p.status : 'error';
      if (t.cancelRequested || t.status === 'canceled') status = 'canceled';
      for (const k of ['result', 'diff', 'files', 'sessionId', 'costUsd', 'durationMs', 'numTurns', 'denials']) {
        if (p[k] !== undefined && p[k] !== null && p[k] !== '') t[k] = k === 'durationMs' || k === 'numTurns' ? Number(p[k]) : String(p[k]);
        else delete t[k];
      }
      finish(t, status);
      saveTask(t);
      heartbeat(meta, t.agent, null, '');
      await publishTasks(meta, [t.id]);
      await publishIndex(meta);
      saveMeta(meta);
      return { ok: true };
    },

    async ping({ agent, projects, busy }) {
      const meta = loadMeta();
      const changed = heartbeat(meta, agent, projects, busy == null ? undefined : String(busy));
      if (changed || Date.now() - meta.lastIndexPublish > HEARTBEAT_PUBLISH_MS) await publishIndex(meta);
      saveMeta(meta);
      return { ok: true };
    },
  };

  const api = (action, params = {}) => {
    if (!actions[action]) return Promise.reject(new Error(`알 수 없는 action: ${action}`));
    return withLock(() => actions[action](params));
  };
  api.url = s.appUrl;
  return api;
}

module.exports = { createStaticApi };
