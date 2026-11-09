'use strict';
// agent.js(헤드리스 실행)와 orchestrator-hook.js(Orchestrator 세션 연결)가 함께 쓰는 설정 / 서버 API / git diff.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const LIMIT = { diff: 400000, result: 100000, logLine: 2000 };

function loadConfig(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`설정 파일이 없습니다: ${file}\nagent.config.example.json 을 agent.config.json 으로 복사해서 수정하세요.`);
  }
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  // static 이 있으면 정적 호스팅(게시 API) 방식, 없으면 api.jsp 서버 방식
  for (const k of c.static ? ['agentName', 'projects'] : ['serverUrl', 'agentToken', 'agentName', 'projects']) {
    if (!c[k]) throw new Error(`설정 누락: ${k} (${file})`);
  }
  if (c.static) {
    c.static = { publishDiff: true, ...c.static, token: c.static.token || process.env.QUICK_TOKEN };
    for (const k of ['apiBase', 'appName', 'appUrl', 'token']) {
      if (!c.static[k]) throw new Error(`설정 누락: static.${k} (${file})${k === 'token' ? ' — 또는 환경 변수 QUICK_TOKEN' : ''}`);
    }
    c.static.apiBase = c.static.apiBase.replace(/\/+$/, '');
    c.static.appUrl = c.static.appUrl.replace(/\/*$/, '/');
  }
  for (const [name, dir] of Object.entries(c.projects)) c.projects[name] = path.resolve(path.dirname(file), dir);
  c.pollIntervalSec = c.pollIntervalSec || 10;
  c.claude = {
    command: 'claude',
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git diff:*)'],
    timeoutMin: 30,
    ...c.claude,
  };
  c.orchestrator = { sessionName: 'Orchestrator', pollIntervalSec: 5, maxWaitHours: 23, ...c.orchestrator };
  return c;
}

const clock = () => new Date().toTimeString().slice(0, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createApi(cfg) {
  if (cfg.static) return require('./static-backend').createStaticApi(cfg);
  const url = cfg.serverUrl.replace(/\/+$/, '') + '/api.jsp';
  const api = async (action, params = {}, timeoutMs = 30000) => {
    const body = new URLSearchParams({ action });
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.append(k, String(v));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Agent-Token': cfg.agentToken },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status}, JSON 이 아닌 응답: ${text.slice(0, 200)}`);
    }
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };
  api.url = url;
  return api;
}

async function withRetry(fn, tries, log) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      if (log) log(`재시도 ${i}/${tries - 1}: ${e.message}`);
      await sleep(2000 * 2 ** (i - 1));
    }
  }
}

// ---------------- git: 작업 하나의 변경분만 수집 ----------------

function git(cwd, args, okCodes = [0]) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, maxBuffer: 200 * 1024 * 1024, windowsHide: true });
  if (r.error) throw r.error;
  if (!okCodes.includes(r.status)) throw new Error(`git ${args.join(' ')} 실패: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

function untracked(cwd) {
  return git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean);
}

// 작업 전 상태를 커밋 객체로 찍어 둔다(stash create 는 작업 트리를 건드리지 않음). 기존 미커밋 변경은 diff 에서 빠진다.
// 결과는 JSON 으로 저장할 수 있는 값이라 다른 프로세스(Stop 훅)에서 diff 를 계산할 때도 쓴다.
function gitSnapshot(cwd) {
  try {
    if (git(cwd, ['rev-parse', '--is-inside-work-tree']).toString().trim() !== 'true') return null;
  } catch {
    return null;
  }
  let base;
  try {
    const head = git(cwd, ['rev-parse', '--verify', 'HEAD']).toString().trim();
    base = git(cwd, ['stash', 'create']).toString().trim() || head;
  } catch {
    base = EMPTY_TREE;
  }
  return { base, untracked: untracked(cwd) };
}

function collectChanges(cwd, snap, encoding) {
  const decoder = new TextDecoder(encoding || 'utf-8');
  const before = new Set(snap.untracked);
  const diffs = [decoder.decode(git(cwd, ['diff', '--no-color', '--no-ext-diff', snap.base]))];
  const files = [git(cwd, ['diff', '--name-status', snap.base]).toString('utf8').trim()];
  for (const f of untracked(cwd)) {
    if (before.has(f)) continue;
    diffs.push(decoder.decode(git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', f], [0, 1])));
    files.push(`A\t${f}`);
  }
  let diff = diffs.filter(Boolean).join('\n');
  if (diff.length > LIMIT.diff) diff = diff.slice(0, LIMIT.diff) + `\n\n... (diff 가 너무 커서 잘림, 전체 ${diff.length}자)`;
  return { diff, files: files.filter(Boolean).join('\n') };
}

function describeTool(name, input, cwd) {
  const i = input || {};
  let detail = i.file_path || i.notebook_path || i.path || i.command || i.pattern || i.url || i.description || '';
  if (typeof detail === 'string' && cwd && path.isAbsolute(detail) && detail.startsWith(cwd)) detail = path.relative(cwd, detail);
  return `${name} ${String(detail).replace(/\s+/g, ' ')}`.trim().slice(0, 300);
}

module.exports = { LIMIT, loadConfig, createApi, withRetry, clock, sleep, gitSnapshot, collectChanges, describeTool };
