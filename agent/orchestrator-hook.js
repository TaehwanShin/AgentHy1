#!/usr/bin/env node
'use strict';
// Claude Code 훅: 이름(세션 제목)이 Orchestrator 인 대화형 세션을 웹 브릿지 작업 큐에 연결한다.
//  - wait (SessionStart/Stop, asyncRewake): 서버에서 작업을 가져오면 exit 2 로 쉬고 있는 세션을 깨워 요청을 전달
//  - Stop 으로 턴이 끝나면 마지막 답변(last_assistant_message)과 git diff 를 서버로 보냄
// 다른 세션에서는 아무 일도 하지 않으며, 내부 오류는 .orchestrator/hook.log 에만 남기고 세션을 방해하지 않는다.
//
// 설치:   node orchestrator-hook.js install C:\Workspaces\.claude\settings.local.json
// 상태:   node orchestrator-hook.js status

const fs = require('fs');
const path = require('path');
const C = require('./common');

const MODE = process.argv[2] || '';
const CLI_WITH_FILE = ['install', 'uninstall'];
const CONFIG = path.resolve((CLI_WITH_FILE.includes(MODE) ? process.argv[4] : process.argv[3]) || path.join(__dirname, 'agent.config.json'));
const DIR = path.join(__dirname, '.orchestrator');
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'hook.log');
const WAKE_PROMPT_MAX = 6000;

const DEFAULT_GUIDE = [
  '사내 웹앱(Claude 작업 브릿지)에서 온 요청입니다. 지금 바로 처리하세요. 요청자에게 되물을 수 없으니 합리적으로 판단해 끝까지 진행하세요.',
  'git commit / push 는 하지 마세요.',
  '이번 턴의 마지막 답변이 그대로 요청자의 웹 화면에 전달됩니다. 마지막 답변에 (1) 변경한 파일 (2) 변경 내용 요약 (3) 요청자가 확인할 점을 한국어로 정리하세요.',
].join('\n');

let cfg;
let api;
function config() {
  if (!cfg) {
    cfg = C.loadConfig(CONFIG);
    api = C.createApi(cfg);
  }
  return cfg;
}
const agentName = () => config().orchestrator.agentName || cfg.orchestrator.sessionName;
const projectNames = () => Object.keys(config().projects).join(',');

function hlog(msg) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1024 * 1024) fs.renameSync(LOG, `${LOG}.old`);
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${MODE}#${process.pid} ${msg}\n`);
  } catch {
    // 로그 실패로 세션을 방해하지 않는다
  }
}

// ---------------- 상태 파일 (여러 훅 프로세스가 공유) ----------------

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}

function save(st) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${STATE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 1));
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, STATE);
      return;
    } catch (e) {
      if (i >= 20) throw e; // Windows 에서 다른 프로세스가 읽는 중이면 잠깐 실패할 수 있다
      sleepSync(25);
    }
  }
}

function update(fn) {
  const st = load();
  fn(st);
  save(st);
  return st;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readInput() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(s));
      } catch {
        resolve({});
      }
    });
    process.stdin.on('error', () => resolve({}));
  });
}

// ---------------- 세션 이름 확인 ----------------

// 세션 중간에 /rename 한 이름은 훅 입력에 없어서, 대화 기록의 custom-title 줄에서 마지막 값을 읽는다.
function transcriptTitle(file) {
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, 16 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, size - len);
    } finally {
      fs.closeSync(fd);
    }
    let title = null;
    for (const line of buf.toString('utf8').match(/^.*"type":"custom-title".*$/gm) || []) {
      try {
        const o = JSON.parse(line);
        if (typeof o.customTitle === 'string') title = o.customTitle;
      } catch {
        // 잘린 첫 줄 등은 무시
      }
    }
    return title;
  } catch {
    return null;
  }
}

function titleOf(input) {
  return typeof input.session_title === 'string' ? input.session_title : transcriptTitle(input.transcript_path);
}

async function bind(input, reason) {
  let orphan = null;
  update((st) => {
    if (st.sessionId === input.session_id) return;
    orphan = st.current || null;
    Object.assign(st, { sessionId: input.session_id, boundAt: new Date().toISOString(), current: null, busy: false, waiterPid: null });
  });
  hlog(`${input.session_id} 세션을 ${config().orchestrator.sessionName} 로 연결 (${reason})`);
  if (orphan) await finish(orphan, 'error', 'Orchestrator 세션이 바뀌어 작업이 중단되었습니다. 다시 실행하세요.');
}

// ---------------- 서버 통신 ----------------

async function finish(cur, status, result, sessionId) {
  config();
  let changes = { diff: '', files: '' };
  if (cur.snap && cur.cwd) {
    try {
      changes = C.collectChanges(cur.cwd, cur.snap, cfg.fileEncoding);
    } catch (e) {
      hlog(`#${cur.id} diff 수집 실패: ${e.message}`);
    }
  }
  const params = {
    id: cur.id,
    status,
    result: String(result || '').slice(0, C.LIMIT.result),
    diff: changes.diff,
    files: changes.files,
    sessionId,
    durationMs: Date.now() - cur.startedAt,
  };
  try {
    await C.withRetry(() => api('complete', params), 4);
    hlog(`#${cur.id} 결과 전송 (${status})`);
  } catch (e) {
    const backup = path.join(DIR, `unsent-task-${cur.id}.json`);
    fs.writeFileSync(backup, JSON.stringify(params, null, 1));
    hlog(`#${cur.id} 결과 전송 실패: ${e.message} → ${backup}`);
  }
}

function progress(cur, line, timeoutMs = 5000) {
  return api('progress', { id: cur.id, log: `${C.clock()} ${line}` }, timeoutMs);
}

function wakeMessage(task, cwd, file) {
  const head = task.parentId
    ? `[웹 브릿지 추가 지시 #${task.id} ← #${task.parentId}] ${task.title}`
    : `[웹 브릿지 요청 #${task.id}] ${task.title}`;
  let body = task.prompt;
  if (body.length > WAKE_PROMPT_MAX) body = `${body.slice(0, WAKE_PROMPT_MAX)}\n…(요청이 길어 잘렸습니다. 전체 내용: ${file})`;
  return [
    head,
    `요청자: ${task.requester} · 프로젝트: ${task.project}${cwd ? ` · 작업 폴더: ${cwd}` : ''}`,
    task.parentId ? `이전 요청 #${task.parentId} 에 이어지는 추가 지시입니다.` : null,
    '',
    body,
    '',
    '---',
    cfg.orchestrator.instructions || DEFAULT_GUIDE,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

async function deliver(task, sessionId) {
  const cwd = cfg.projects[task.project];
  const hasDir = !!cwd && fs.existsSync(cwd);
  let snap = null;
  if (hasDir) {
    try {
      snap = C.gitSnapshot(cwd);
    } catch (e) {
      hlog(`#${task.id} git 스냅샷 실패: ${e.message}`);
    }
  }
  const file = path.join(DIR, `task-${task.id}.md`);
  fs.writeFileSync(file, task.prompt);
  const cur = { id: task.id, title: task.title, project: task.project, cwd: hasDir ? cwd : null, snap, startedAt: Date.now() };
  update((st) => {
    st.current = cur;
    st.busy = true;
    st.waiterPid = null;
  });
  hlog(`#${task.id} 를 세션 ${sessionId} 에 전달`);
  try {
    const note = hasDir ? (snap ? '' : ' (git 저장소가 아니어서 diff 는 수집하지 않음)') : ` (프로젝트 폴더 없음: ${cwd})`;
    await progress(cur, `[Orchestrator] ${agentName()} 세션에 요청을 전달했습니다${note}`, 10000);
  } catch (e) {
    hlog(`진행 로그 전송 실패: ${e.message}`);
  }
  process.stderr.write(wakeMessage(task, cur.cwd, file));
  process.exitCode = 2; // asyncRewake: exit 2 면 쉬고 있는 세션도 즉시 깨어나 stderr 를 읽는다
}

// ---------------- 훅 이벤트 ----------------

async function onSessionStart(input) {
  const sid = input.session_id;
  if (!sid) return;
  const named = titleOf(input) === config().orchestrator.sessionName;
  if (!named && load().sessionId !== sid) return;
  if (named) await bind(input, `SessionStart/${input.source}`);
  if (input.source === 'startup' || input.source === 'resume') {
    const cur = load().current;
    update((st) => {
      st.current = null;
      st.busy = false;
    });
    if (cur) await finish(cur, 'error', 'Orchestrator 세션이 다시 시작되어 작업이 중단되었습니다. 다시 실행하세요.', sid);
    try {
      await api('hello', { agent: agentName(), projects: projectNames() }, 10000);
    } catch (e) {
      hlog(`서버 연결 실패: ${e.message}`);
    }
  }
  const context = [
    `이 세션은 사내 웹앱 'Claude 작업 브릿지'의 ${cfg.orchestrator.sessionName} 입니다.`,
    '웹에서 온 요청은 "[웹 브릿지 요청 #번호]" 로 시작하는 알림으로 도착합니다. 알림이 오면 그 요청을 바로 처리하세요.',
    '그 턴의 마지막 답변이 요청자의 웹 화면에 그대로 전달됩니다.',
  ].join('\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
}

async function onWait(input) {
  const sid = input.session_id;
  if (!sid) return;
  config();
  const event = input.hook_event_name;
  if (event === 'SessionStart') await C.sleep(1500); // 동기 session-start 훅이 먼저 세션을 연결하도록
  let st = load();
  if (st.sessionId !== sid) {
    if (event !== 'Stop' || titleOf(input) !== cfg.orchestrator.sessionName) return;
    await bind(input, 'Stop');
    st = load();
  }

  if (event === 'Stop') {
    const cur = st.current;
    update((s) => {
      s.busy = false;
      s.current = null;
    });
    if (cur) await finish(cur, 'done', input.last_assistant_message || '(Claude 가 텍스트 답변 없이 턴을 마쳤습니다.)', sid);
  }

  st = load();
  if (st.waiterPid && st.waiterPid !== process.pid && alive(st.waiterPid)) return; // 이미 대기 중인 프로세스가 있음
  update((s) => {
    s.waiterPid = process.pid;
  });

  const deadline = Date.now() + cfg.orchestrator.maxWaitHours * 3600 * 1000;
  let down = false;
  while (Date.now() < deadline) {
    st = load();
    if (st.sessionId !== sid || st.waiterPid !== process.pid) return; // 세션이 바뀌었거나 끝남
    try {
      if (st.busy || st.current) {
        await api('ping', { agent: agentName(), projects: projectNames(), busy: st.current ? String(st.current.id) : '' }, 10000);
      } else {
        const { task } = await api('claim', { agent: agentName(), projects: projectNames() }, 15000);
        if (task) return deliver(task, sid);
      }
      if (down) hlog('서버 연결 복구');
      down = false;
    } catch (e) {
      if (!down) hlog(`서버 연결 실패: ${e.message} (계속 재시도)`);
      down = true;
    }
    await C.sleep(cfg.orchestrator.pollIntervalSec * 1000);
  }
  hlog(`${cfg.orchestrator.maxWaitHours}시간 동안 요청이 없어 대기를 마칩니다. 세션에 아무 입력이나 하면 다시 대기합니다.`);
  update((s) => {
    if (s.waiterPid === process.pid) s.waiterPid = null;
  });
}

async function onPrompt(input) {
  const sid = input.session_id;
  if (!sid) return;
  if (load().sessionId !== sid) {
    if (titleOf(input) !== config().orchestrator.sessionName) return;
    await bind(input, 'UserPromptSubmit');
  }
  update((st) => {
    st.busy = true;
  });
}

async function onPreTool(input) {
  const st = load();
  if (st.sessionId !== input.session_id || !st.current) return;
  config();
  let r;
  try {
    r = await progress(st.current, `[도구] ${C.describeTool(input.tool_name, input.tool_input, st.current.cwd)}`);
  } catch (e) {
    hlog(`진행 로그 전송 실패: ${e.message}`);
    return;
  }
  if (!r.canceled) return;
  hlog(`#${st.current.id} 웹에서 취소됨: 도구 실행 차단`);
  const reason = `웹에서 작업 #${st.current.id} 이(가) 취소되었습니다. 더 진행하지 말고 "작업이 취소되었습니다" 라고만 답하세요.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

async function onNotify(input) {
  const st = load();
  if (st.sessionId !== input.session_id || !st.current || !input.message) return;
  config();
  await progress(st.current, `[알림] ${input.message}`).catch((e) => hlog(`진행 로그 전송 실패: ${e.message}`));
}

async function onSessionEnd(input) {
  const st = load();
  if (st.sessionId !== input.session_id) return;
  config();
  const cur = st.current;
  update((s) => {
    s.current = null;
    s.busy = false;
    s.waiterPid = null; // 남아 있는 대기 프로세스가 스스로 끝나도록
  });
  if (cur) await finish(cur, 'error', 'Orchestrator 세션이 종료되어 작업이 중단되었습니다. 다시 실행하세요.', input.session_id);
  await api('ping', { agent: agentName(), busy: '' }, 5000).catch(() => {});
}

// ---------------- 설치 / 상태 ----------------

function hookSettings() {
  const fwd = (p) => p.replace(/\\/g, '/');
  const h = (mode, extra) => ({ type: 'command', command: `node "${fwd(__filename)}" ${mode} "${fwd(CONFIG)}"`, ...extra });
  return {
    SessionStart: [{ hooks: [h('session-start', { timeout: 30 }), h('wait', { asyncRewake: true, timeout: 86400 })] }],
    UserPromptSubmit: [{ hooks: [h('prompt', { timeout: 10 })] }],
    PreToolUse: [{ hooks: [h('pre-tool', { timeout: 10 })] }],
    Notification: [{ hooks: [h('notify', { async: true })] }],
    Stop: [{ hooks: [h('wait', { asyncRewake: true, timeout: 86400 })] }],
    SessionEnd: [{ hooks: [h('session-end', { timeout: 30 })] }],
  };
}

function install(file, remove) {
  if (!file) throw new Error(`사용법: node orchestrator-hook.js ${remove ? 'uninstall' : 'install'} <settings.json 경로> [agent.config.json 경로]`);
  file = path.resolve(file);
  if (!remove) config(); // 설정이 잘못됐으면 설치 전에 알린다
  let json = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    json = text.trim() ? JSON.parse(text) : {};
    fs.copyFileSync(file, `${file}.bak`);
  }
  const ours = (entry) => (entry.hooks || []).some((x) => typeof x.command === 'string' && x.command.includes('orchestrator-hook.js'));
  json.hooks = json.hooks || {};
  for (const ev of Object.keys(json.hooks)) {
    json.hooks[ev] = json.hooks[ev].filter((e) => !ours(e));
    if (!json.hooks[ev].length) delete json.hooks[ev];
  }
  if (!remove) for (const [ev, entries] of Object.entries(hookSettings())) json.hooks[ev] = [...(json.hooks[ev] || []), ...entries];
  if (!Object.keys(json.hooks).length) delete json.hooks;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  if (remove) return console.log(`훅을 제거했습니다: ${file}`);
  console.log(`훅을 설치했습니다: ${file}${fs.existsSync(`${file}.bak`) ? ` (이전 파일: ${file}.bak)` : ''}`);
  console.log(`  서버: ${api.url}`);
  console.log(`  연결할 세션 이름: ${cfg.orchestrator.sessionName} · 웹에 표시될 이름: ${agentName()}`);
  console.log(`  프로젝트: ${projectNames()}`);
  console.log('다음: 그 폴더에서 시작하는 Claude 세션의 이름을 Orchestrator 로 하세요 (claude --name Orchestrator, 또는 세션 안에서 /rename Orchestrator).');
}

function status() {
  const st = load();
  const out = {
    config: CONFIG,
    sessionId: st.sessionId || null,
    boundAt: st.boundAt || null,
    busy: !!st.busy,
    current: st.current ? { id: st.current.id, title: st.current.title, cwd: st.current.cwd, gitSnapshot: !!st.current.snap } : null,
    waiter: st.waiterPid ? `${st.waiterPid} (${alive(st.waiterPid) ? '대기 중' : '종료됨'})` : null,
    log: LOG,
  };
  console.log(JSON.stringify(out, null, 2));
}

async function main() {
  switch (MODE) {
    case 'session-start':
      return onSessionStart(await readInput());
    case 'wait':
      return onWait(await readInput());
    case 'prompt':
      return onPrompt(await readInput());
    case 'pre-tool':
      return onPreTool(await readInput());
    case 'notify':
      return onNotify(await readInput());
    case 'session-end':
      return onSessionEnd(await readInput());
    case 'install':
      return install(process.argv[3], false);
    case 'uninstall':
      return install(process.argv[3], true);
    case 'print-settings':
      return console.log(JSON.stringify({ hooks: hookSettings() }, null, 2));
    case 'status':
      return status();
    default:
      console.error('사용법: node orchestrator-hook.js install|uninstall|print-settings|status');
      process.exitCode = 1;
  }
}

const isCli = ['install', 'uninstall', 'print-settings', 'status', ''].includes(MODE);
main().catch((e) => {
  if (isCli) {
    console.error(e.message);
    process.exitCode = 1;
  } else {
    hlog(`오류: ${e.stack || e.message}`);
    process.exitCode = 0; // 훅 오류로 사용자의 세션을 막지 않는다
  }
});
