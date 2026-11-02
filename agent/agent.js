#!/usr/bin/env node
'use strict';
// 사내 웹앱(api.jsp)을 폴링해서 작업을 가져오고, 이 PC의 Claude Code로 처리한 뒤 결과를 돌려보내는 에이전트.
// PC → 서버 방향으로만 접속하므로 PC에 포트를 열 필요가 없다. Node.js 18 이상, 외부 패키지 없음.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const LIMIT = { diff: 400000, result: 100000, logLine: 2000 };
const isWin = process.platform === 'win32';

const configPath = path.resolve(process.argv[2] || path.join(__dirname, 'agent.config.json'));
const cfg = loadConfig(configPath);
const API = cfg.serverUrl.replace(/\/+$/, '') + '/api.jsp';
const projectNames = Object.keys(cfg.projects).join(',');
const decoder = new TextDecoder(cfg.fileEncoding || 'utf-8');

function loadConfig(file) {
  if (!fs.existsSync(file)) {
    console.error(`설정 파일이 없습니다: ${file}\nagent.config.example.json 을 agent.config.json 으로 복사해서 수정하세요.`);
    process.exit(1);
  }
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['serverUrl', 'agentToken', 'agentName', 'projects']) {
    if (!c[k]) throw new Error(`설정 누락: ${k} (${file})`);
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
  return c;
}

const run = { busy: false, child: null, shuttingDown: false };

// Ctrl+C 시 Claude 프로세스가 혼자 남아 파일을 계속 고치지 않도록, 중단하고 결과를 보낸 뒤 종료한다
function onSignal() {
  if (run.shuttingDown || !run.busy) process.exit(130);
  run.shuttingDown = true;
  log('종료 요청: 실행 중인 작업을 중단하고 결과를 보낸 뒤 종료합니다 (한 번 더 누르면 즉시 종료)');
  if (run.child) killTree(run.child);
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

const clock = () => new Date().toTimeString().slice(0, 8);
const log = (msg) => console.log(`[${clock()}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(action, params = {}) {
  const body = new URLSearchParams({ action });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.append(k, String(v));
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'X-Agent-Token': cfg.agentToken },
    body,
    signal: AbortSignal.timeout(30000),
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
}

async function withRetry(fn, tries) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      log(`재시도 ${i}/${tries - 1}: ${e.message}`);
      await sleep(2000 * 2 ** (i - 1));
    }
  }
}

// ---------------- 진행 상황 전송 ----------------

class Reporter {
  constructor(taskId) {
    this.taskId = taskId;
    this.lines = [];
    this.canceled = false;
    this.onCancel = null;
    this.lastSent = 0;
    this.chain = Promise.resolve();
    this.timer = setInterval(() => this.flush(false), 3000);
  }

  line(text) {
    const s = String(text).slice(0, LIMIT.logLine);
    log(`  #${this.taskId} ${s.split('\n')[0].slice(0, 160)}`);
    this.lines.push(`${clock()} ${s}`);
  }

  flush(force) {
    // 보낼 로그가 없어도 20초마다 보내서 서버가 에이전트를 '온라인'으로 보게 하고 취소 여부도 확인한다
    if (!force && !this.lines.length && Date.now() - this.lastSent < 20000) return this.chain;
    this.lastSent = Date.now();
    const chunk = this.lines.splice(0);
    this.chain = this.chain
      .then(() => api('progress', { id: this.taskId, log: chunk.join('\n') }))
      .then((r) => {
        if (r.canceled && !this.canceled) {
          this.canceled = true;
          log(`  #${this.taskId} 웹에서 취소 요청됨`);
          if (this.onCancel) this.onCancel();
        }
      })
      .catch((e) => {
        this.lines.unshift(...chunk);
        log(`  진행 상황 전송 실패: ${e.message}`);
      });
    return this.chain;
  }

  async stop() {
    clearInterval(this.timer);
    await this.flush(true);
  }
}

// ---------------- git: 이번 작업의 변경분만 수집 ----------------

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
function gitSnapshot(cwd) {
  try {
    if (git(cwd, ['rev-parse', '--is-inside-work-tree']).toString().trim() !== 'true') return null;
  } catch {
    return null;
  }
  let base;
  try {
    git(cwd, ['rev-parse', '--verify', 'HEAD']);
    base = git(cwd, ['stash', 'create']).toString().trim() || 'HEAD';
  } catch {
    base = EMPTY_TREE;
  }
  return { base, untracked: new Set(untracked(cwd)) };
}

function collectChanges(cwd, snap) {
  const diffs = [decoder.decode(git(cwd, ['diff', '--no-color', '--no-ext-diff', snap.base]))];
  const files = [git(cwd, ['diff', '--name-status', snap.base]).toString('utf8').trim()];
  for (const f of untracked(cwd)) {
    if (snap.untracked.has(f)) continue;
    diffs.push(decoder.decode(git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', f], [0, 1])));
    files.push(`A\t${f}`);
  }
  let diff = diffs.filter(Boolean).join('\n');
  if (diff.length > LIMIT.diff) diff = diff.slice(0, LIMIT.diff) + `\n\n... (diff 가 너무 커서 잘림, 전체 ${diff.length}자)`;
  return { diff, files: files.filter(Boolean).join('\n') };
}

// ---------------- Claude Code 실행 ----------------

const DEFAULT_INSTRUCTIONS = [
  '이 요청은 사내 웹앱을 통해 원격으로 전달되었습니다. 요청자에게 되물을 수 없으니 합리적으로 판단해서 작업을 끝까지 진행하세요.',
  'git commit / push 는 하지 마세요. 변경 사항은 요청자가 검토한 뒤 직접 반영합니다.',
  '마지막 답변에는 (1) 변경한 파일 (2) 변경 내용 요약 (3) 요청자가 확인할 점을 한국어로 정리하세요.',
].join('\n');

function buildPrompt(task, resuming) {
  if (resuming) return `[추가 지시 - 요청자: ${task.requester}]\n${task.prompt}`;
  const parts = [cfg.claude.instructions || DEFAULT_INSTRUCTIONS, ''];
  if (task.parentId) {
    parts.push(`[이전 작업 #${task.parentId} 요청]`, task.parentPrompt || '', '', `[이전 작업 결과]`, task.parentResult || '', '');
  }
  parts.push(`[작업 #${task.id}] ${task.title}`, `요청자: ${task.requester}`, '', task.prompt);
  return parts.join('\n');
}

function winQuote(s) {
  return /^[\w\-.,:/\\=]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`;
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else {
    child.kill('SIGTERM');
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5000).unref();
  }
}

function describeTool(block, cwd) {
  const i = block.input || {};
  let detail = i.file_path || i.notebook_path || i.path || i.command || i.pattern || i.url || i.description || '';
  if (typeof detail === 'string' && path.isAbsolute(detail) && detail.startsWith(cwd)) detail = path.relative(cwd, detail);
  return `${block.name} ${String(detail).replace(/\s+/g, ' ')}`.trim().slice(0, 300);
}

function runClaude(task, cwd, reporter, resumeId) {
  const c = cfg.claude;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', c.permissionMode];
  if (c.allowedTools && c.allowedTools.length) args.push('--allowedTools', c.allowedTools.join(','));
  if (c.model) args.push('--model', c.model);
  if (c.maxTurns) args.push('--max-turns', String(c.maxTurns));
  if (c.maxBudgetUsd) args.push('--max-budget-usd', String(c.maxBudgetUsd));
  if (resumeId) args.push('--resume', resumeId);

  return new Promise((resolve) => {
    // 프롬프트는 stdin 으로 넘긴다: Windows 명령줄 따옴표/한글 깨짐 문제를 피하기 위해
    const child = isWin
      ? spawn([c.command, ...args].map(winQuote).join(' '), [], { cwd, shell: true, windowsHide: true })
      : spawn(c.command, args, { cwd });
    run.child = child;
    let buf = '';
    let stderr = '';
    let final = null;
    let sessionId = null;
    let gotInit = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      reporter.line(`[에이전트] ${c.timeoutMin}분 제한 시간 초과로 중단합니다`);
      killTree(child);
    }, c.timeoutMin * 60000);
    reporter.onCancel = () => killTree(child);

    const onEvent = (line) => {
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        reporter.line(line);
        return;
      }
      if (ev.type === 'system' && ev.subtype === 'init') {
        gotInit = true;
        sessionId = ev.session_id;
        reporter.line(`[세션] ${ev.session_id}${ev.model ? ` · ${ev.model}` : ''}`);
      } else if (ev.type === 'assistant') {
        for (const b of (ev.message && ev.message.content) || []) {
          if (b.type === 'text' && b.text.trim()) reporter.line(`[Claude] ${b.text.trim()}`);
          else if (b.type === 'tool_use') reporter.line(`[도구] ${describeTool(b, cwd)}`);
        }
      } else if (ev.type === 'user') {
        const content = (ev.message && ev.message.content) || [];
        for (const b of Array.isArray(content) ? content : []) {
          if (b.type === 'tool_result' && b.is_error) {
            const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            reporter.line(`[도구 오류] ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
          }
        }
      } else if (ev.type === 'result') {
        final = ev;
      }
    };

    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reporter.onCancel = null;
      run.child = null;
      resolve(out);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onEvent(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-5000);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(buildPrompt(task, !!resumeId), 'utf8');

    child.on('error', (e) => finish({ ok: false, result: `Claude Code 를 실행하지 못했습니다 (${c.command}): ${e.message}` }));
    child.on('close', (code) => {
      onEvent(buf);
      if (resumeId && !gotInit && /No conversation found/i.test(stderr)) return finish({ resumeFailed: true });
      const denials = ((final && final.permission_denials) || [])
        .map((d) => describeTool({ name: d.tool_name, input: d.tool_input }, cwd))
        .join('\n');
      let result = (final && final.result) || '';
      if (reporter.canceled) result = `[웹에서 취소 요청으로 중단됨]${result ? `\n\n${result}` : ''}`;
      else if (run.shuttingDown) result = `[PC 에이전트가 종료되어 중단됨]${result ? `\n\n${result}` : ''}`;
      else if (timedOut) result = `[제한 시간 ${c.timeoutMin}분 초과로 중단됨]${result ? `\n\n${result}` : ''}`;
      else if (!result) result = stderr.trim() || `Claude Code 가 결과 없이 종료되었습니다 (종료 코드 ${code})`;
      finish({
        ok: !!final && !final.is_error && !timedOut,
        canceled: reporter.canceled,
        result: result.slice(0, LIMIT.result),
        sessionId: (final && final.session_id) || sessionId,
        costUsd: final && final.total_cost_usd != null ? final.total_cost_usd.toFixed(4) : null,
        durationMs: final ? final.duration_ms : null,
        numTurns: final ? final.num_turns : null,
        denials,
      });
    });
  });
}

// ---------------- 작업 처리 ----------------

async function runTask(task) {
  log(`#${task.id} [${task.project}] ${task.title} — ${task.requester} 요청 처리 시작`);
  const reporter = new Reporter(task.id);
  let outcome;
  try {
    const cwd = cfg.projects[task.project];
    if (!cwd || !fs.existsSync(cwd)) throw new Error(`프로젝트 폴더를 찾을 수 없습니다: ${task.project} → ${cwd}`);
    const snap = gitSnapshot(cwd);
    reporter.line(`[에이전트] ${cfg.agentName} 에서 실행 · ${cwd}${snap ? '' : ' (git 저장소가 아니어서 diff 는 수집하지 않음)'}`);

    let out = await runClaude(task, cwd, reporter, task.resumeSessionId);
    if (out.resumeFailed && !run.shuttingDown) {
      reporter.line('[에이전트] 이전 세션을 이 PC에서 찾지 못해 이전 요청/결과를 붙여 새 세션으로 실행합니다');
      out = await runClaude(task, cwd, reporter, null);
    }
    const changes = snap ? collectChanges(cwd, snap) : { diff: '', files: '' };
    if (snap) reporter.line(`[에이전트] 변경 파일 ${changes.files ? changes.files.split('\n').length : 0}개`);
    outcome = {
      status: out.canceled ? 'canceled' : out.ok ? 'done' : 'error',
      result: out.result || '[PC 에이전트가 종료되어 중단됨]',
      diff: changes.diff,
      files: changes.files,
      sessionId: out.sessionId,
      costUsd: out.costUsd,
      durationMs: out.durationMs,
      numTurns: out.numTurns,
      denials: out.denials,
    };
  } catch (e) {
    reporter.line(`[에이전트 오류] ${e.message}`);
    outcome = { status: 'error', result: `에이전트 오류: ${e.message}` };
  }
  await reporter.stop();
  try {
    await withRetry(() => api('complete', { id: task.id, ...outcome }), 6);
    log(`#${task.id} 결과 전송 완료 (${outcome.status})`);
  } catch (e) {
    const backup = path.join(__dirname, `unsent-task-${task.id}.json`);
    fs.writeFileSync(backup, JSON.stringify({ task, outcome }, null, 2));
    log(`#${task.id} 결과 전송 실패: ${e.message} → ${backup} 에 저장`);
  }
}

async function main() {
  log(`에이전트 "${cfg.agentName}" 시작 → ${API}`);
  for (const [name, dir] of Object.entries(cfg.projects)) log(`  프로젝트 ${name} = ${dir}`);
  let greeted = false;
  let wasDown = false;
  for (;;) {
    let task = null;
    try {
      if (!greeted) {
        const r = await api('hello', { agent: cfg.agentName, projects: projectNames });
        if (r.orphaned) log(`이전에 중단된 작업 ${r.orphaned}건을 실패로 정리했습니다`);
        greeted = true;
      }
      ({ task } = await api('claim', { agent: cfg.agentName, projects: projectNames }));
      if (wasDown) log('서버 연결 복구');
      wasDown = false;
    } catch (e) {
      if (!wasDown) log(`서버 연결 실패: ${e.message} (계속 재시도합니다)`);
      wasDown = true;
    }
    if (task) {
      run.busy = true;
      await runTask(task);
      run.busy = false;
      if (run.shuttingDown) process.exit(0);
    } else await sleep(cfg.pollIntervalSec * 1000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
