#!/usr/bin/env node
'use strict';
// 사내 웹앱 게시 API 로 webapp/ 의 세 파일(index.html, style.css, api.jsp)을 올린다.
//   1단계: 버리는 임시 비밀번호로 올려 api.jsp 가 서버에서 실제로 실행되는지 확인한다.
//          실행되지 않고 원문이 그대로 보이면 진짜 비밀번호가 노출되므로 여기서 멈춘다.
//   2단계: 진짜 비밀번호/토큰을 넣어 다시 올리고 로그인까지 확인한다.
// 저장소의 api.jsp 에는 기본값만 남고, 진짜 값은 올리는 순간에만 들어간다.
//
// PowerShell:
//   $env:QUICK_BASE_URL = "<사내 가이드의 BASE_URL>"
//   $env:QUICK_TOKEN = "<게시 API 토큰>"
//   $env:BRIDGE_UI_PASSWORD = "<웹 화면 로그인 비밀번호>"
//   node deploy\deploy.js                     게시 (앱 이름 기본값 claude-bridge, --app 으로 변경)
//   node deploy\deploy.js probe               quick DB 탐색 페이지 올리기 (앱 이름 bridge-probe)
//   node deploy\deploy.js list                내 앱 목록
//   node deploy\deploy.js delete --app <이름> --yes

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const WEBAPP = path.join(ROOT, 'webapp');
const STATIC = ['index.html', 'style.css'];
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.jsp': 'text/plain' };
const MAX_BYTES = 30 * 1024 * 1024;

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'deploy';
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const app = option('app') || (command === 'probe' ? 'bridge-probe' : 'claude-bridge');

function fail(msg) {
  console.error(`\n[실패] ${msg}`);
  process.exit(1);
}

function env(name, hint) {
  const v = (process.env[name] || '').trim();
  if (!v) fail(`환경 변수 ${name} 가 필요합니다 (${hint}).`);
  return v;
}

const BASE = env('QUICK_BASE_URL', '사내 가이드의 BASE_URL').replace(/\/+$/, '');
const HEADERS = { 'Authorization-HCP-GW': `Bearer ${env('QUICK_TOKEN', '게시 API 토큰')}` };

// ---------------- 게시 API ----------------

async function call(method, apiPath, { json, form } = {}) {
  const res = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: json ? { ...HEADERS, 'Content-Type': 'application/json' } : HEADERS,
    body: json ? JSON.stringify(json) : form,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // JSON 이 아닌 응답은 원문으로 다룬다
  }
  if (!res.ok) fail(`${method} ${apiPath} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return data === null ? text : data;
}

function upload(files) {
  const form = new FormData();
  form.append('app_name', app);
  for (const f of files) form.append('files', new Blob([f.content], { type: TYPES[path.extname(f.name)] || 'text/plain' }), f.name);
  return call('POST', '/api/upload', { form });
}

function folderOf(resp) {
  const url = resp && typeof resp === 'object' ? resp.url : null;
  if (typeof url !== 'string' || !url) fail(`업로드 응답에 url 이 없습니다: ${JSON.stringify(resp).slice(0, 300)}`);
  return new URL(url, `${BASE}/`).href.replace(/[^/]*$/, ''); // 파일 이름을 떼고 폴더 주소만
}

// ---------------- 게시된 앱 확인 (브라우저처럼 토큰 없이 접근) ----------------

async function get(url) {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

// html/css 는 올린 내용의 앞부분이 보이는지(서버가 스크립트를 덧붙이거나 줄바꿈을 바꿔도 되도록),
// api.jsp 는 존재하는지(404 가 아닌지) 본다
const norm = (s) => s.replace(/\r/g, '').trim();
async function missingFiles(folder, files) {
  const missing = [];
  for (const f of files) {
    const r = await get(folder + f.name);
    const ok = f.name.endsWith('.jsp') ? r.status !== 404 : r.status === 200 && norm(r.text).includes(norm(f.content).slice(0, 300));
    if (!ok) missing.push(f);
  }
  return missing;
}

async function probeJsp(folder) {
  const r = await get(`${folder}api.jsp?action=status`);
  if (r.status >= 300 && r.status < 400) return { why: `로그인 페이지 등으로 리다이렉트됩니다 (HTTP ${r.status} → ${r.location}). PC 에이전트도 이 주소에 접근하지 못하니 게시 서버 담당자에게 확인이 필요합니다.` };
  let data = null;
  try {
    data = JSON.parse(r.text);
  } catch {
    // 아래에서 원문 여부를 본다
  }
  if (r.status === 200 && data && typeof data === 'object' && 'user' in data) return { ok: true };
  if (r.text.includes('<%@') || r.text.includes('static final String')) return { raw: true };
  return { why: `api.jsp 응답이 예상과 다릅니다 (HTTP ${r.status}): ${r.text.slice(0, 200)}` };
}

async function loginWorks(folder, password) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${folder}api.jsp`, {
      method: 'POST',
      headers: { 'X-Bridge-UI': '1' },
      body: new URLSearchParams({ action: 'login', name: 'deploy-check', password }),
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => null) : null;
    if (data && data.user === 'deploy-check') return true;
    await new Promise((r) => setTimeout(r, 2000)); // JSP 가 바뀐 파일을 다시 컴파일할 시간을 준다
  }
  return false;
}

// 한 번에 올린 파일이 다 보이지 않으면(서버가 파일 하나만 받는 경우) 빠진 파일만 하나씩 다시 올린다
async function uploadAndVerify(files) {
  const resp = await upload(files);
  const folder = folderOf(resp);
  let missing = await missingFiles(folder, files);
  if (missing.length) {
    console.log(`  한 번에 올린 파일 중 ${missing.map((f) => f.name).join(', ')} 이(가) 보이지 않아 하나씩 다시 올립니다.`);
    for (const f of missing) await upload([f]);
    missing = await missingFiles(folder, files);
    if (missing.length) fail(`업로드 후에도 ${missing.map((f) => f.name).join(', ')} 이(가) ${folder} 에 없습니다. 업로드 응답: ${JSON.stringify(resp).slice(0, 300)}`);
  }
  return folder;
}

// ---------------- 비밀번호 / 토큰 ----------------

function secrets() {
  const ui = env('BRIDGE_UI_PASSWORD', '웹 화면 로그인 비밀번호, 8자 이상');
  let token = (process.env.BRIDGE_AGENT_TOKEN || '').trim();
  const agentConfig = path.join(ROOT, 'agent', 'agent.config.json');
  if (!token && fs.existsSync(agentConfig)) {
    try {
      token = String(JSON.parse(fs.readFileSync(agentConfig, 'utf8')).agentToken || '').trim();
    } catch (e) {
      fail(`agent\\agent.config.json 을 읽을 수 없습니다: ${e.message}`);
    }
  }
  if (!token) fail('에이전트 토큰이 필요합니다. agent\\agent.config.json 의 agentToken 을 쓰거나 환경 변수 BRIDGE_AGENT_TOKEN 을 설정하세요.');
  if (ui.length < 8 || ui.startsWith('change-me')) fail('BRIDGE_UI_PASSWORD 는 8자 이상이어야 하고 기본값(change-me...)은 쓸 수 없습니다.');
  if (token.length < 16 || token.startsWith('change-me')) {
    fail('에이전트 토큰은 16자 이상의 무작위 값이어야 합니다. 만들기: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"');
  }
  if (/[\x00-\x1f]/.test(ui + token)) fail('비밀번호/토큰에 제어 문자를 쓸 수 없습니다.');
  return { ui, token };
}

// Java 문자열로 넣는다. % 는 JSP 의 %> 로 읽히지 않도록 유니코드 이스케이프로 쓴다.
const javaString = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '\\u0025');

function jspWith(source, uiPassword, agentToken) {
  let out = source;
  for (const [name, value] of [['UI_PASSWORD', uiPassword], ['AGENT_TOKEN', agentToken]]) {
    const re = new RegExp(`(static final String ${name}\\s*=\\s*)"(?:[^"\\\\]|\\\\.)*"`);
    if (!re.test(out)) fail(`api.jsp 에서 ${name} 설정 줄을 찾지 못했습니다.`);
    out = out.replace(re, (_, head) => `${head}"${javaString(value)}"`);
  }
  return out;
}

// ---------------- 명령 ----------------

async function deploy() {
  const { ui, token } = secrets();
  const read = (name) => fs.readFileSync(path.join(WEBAPP, name), 'utf8');
  const jspSource = read('api.jsp');
  const files = (apiJsp) => [...STATIC.map((name) => ({ name, content: read(name) })), { name: 'api.jsp', content: apiJsp }];
  const bytes = files(jspSource).reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  if (bytes > MAX_BYTES) fail(`파일 합계가 30MB 를 넘습니다 (${bytes} bytes).`);
  console.log(`앱 '${app}' 게시 → ${BASE}  (파일 3개, ${Math.ceil(bytes / 1024)}KB)`);

  const throwaway = crypto.randomBytes(18).toString('hex');
  const folder = await uploadAndVerify(files(jspWith(jspSource, throwaway, throwaway)));
  console.log(`[1/2] 업로드 확인: ${folder}`);
  const probe = await probeJsp(folder);
  if (probe.raw) {
    fail(
      [
        '서버가 api.jsp 를 실행하지 않고 파일 내용을 그대로 보여 줍니다.',
        '이 상태로 진짜 비밀번호를 올리면 누구나 볼 수 있어서 여기서 멈췄습니다. (1단계에 쓴 값은 버리는 임시 값입니다)',
        '이 게시 서버에서는 JSP 백엔드를 쓸 수 없습니다. 앱을 지우려면: node deploy\\deploy.js delete --app ' + app + ' --yes',
      ].join('\n  '),
    );
  }
  if (!probe.ok) fail(probe.why);
  console.log('[1/2] 서버가 api.jsp 를 실행하는 것을 확인했습니다.');

  const finalFolder = await uploadAndVerify(files(jspWith(jspSource, ui, token)));
  if (finalFolder !== folder) console.log(`  (참고) 게시 주소가 바뀌었습니다: ${folder} → ${finalFolder}`);
  if (!(await loginWorks(finalFolder, ui))) fail('진짜 비밀번호로 로그인 확인에 실패했습니다. 잠시 후 다시 실행해 보세요.');
  console.log('[2/2] 비밀번호를 넣어 다시 올렸고 로그인까지 확인했습니다.');
  console.log(`\n완료`);
  console.log(`  웹 화면:   ${finalFolder}index.html`);
  console.log(`  agent\\agent.config.json 의 serverUrl: "${finalFolder.replace(/\/$/, '')}"`);
}

// quick.js 의 DB 함수와 호출 경로를 화면에 보여 주는 탐색 페이지를 올린다
async function probe() {
  const page = { name: 'index.html', content: fs.readFileSync(path.join(ROOT, 'tools', 'quick-probe.html'), 'utf8') };
  const folder = await uploadAndVerify([page]);
  console.log(`탐색 페이지를 올렸습니다: ${folder}index.html`);
  console.log('브라우저로 열어 [탐색 시작] 을 누르고, 결과 화면을 사진으로 보내 주세요.');
  console.log(`다 보면 지우기: node deploy\\deploy.js delete --app ${app} --yes`);
}

async function main() {
  if (command === 'deploy') return deploy();
  if (command === 'probe') return probe();
  if (command === 'list') return console.log(JSON.stringify(await call('GET', '/api/list'), null, 2));
  if (command === 'delete') {
    if (!option('app')) fail('지울 앱 이름을 --app 으로 지정하세요.');
    if (!argv.includes('--yes')) fail(`앱 '${app}' 을(를) 지우려면 --yes 를 붙이세요. 게시된 파일과 주소가 사라집니다.`);
    return console.log(JSON.stringify(await call('POST', '/api/delete', { json: { app_name: app } }), null, 2));
  }
  fail(`알 수 없는 명령: ${command} (deploy | probe | list | delete)`);
}

main().catch((e) => fail(e.cause ? `${e.message}: ${e.cause.message || e.cause}` : e.message));
