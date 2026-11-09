#!/usr/bin/env node
'use strict';
// 사내 정적 호스팅에 webapp/ 을 올린다 (게시 API: /api/upload, /api/upload-file, /api/list, /api/delete).
//  - index.html 은 /api/upload(multipart)로 올려 앱을 만들고 게시 주소를 받는다.
//  - app/ 아래 파일은 /api/upload-file 로 상대 경로 그대로 올린다.
//  - app/data/config.json 에 업로드 API 주소와 앱 이름을 써서, 웹 화면이 요청을 올릴 곳을 알게 한다(토큰은 넣지 않음).
//  - 작업 데이터(app/data/tasks.json, inbox.json)는 이미 있으면 건드리지 않는다.
//
// PowerShell:
//   $env:QUICK_API_BASE = "<가이드의 BASE_URL>"        업로드 API 주소
//   $env:QUICK_HOST     = "<가이드의 HOST>"            게시된 앱이 열리는 주소
//   $env:QUICK_TOKEN    = "<게시 API 토큰>"
//   node deploy\deploy.js [--app claude-bridge]       게시
//   node deploy\deploy.js list                        내 앱 목록
//   node deploy\deploy.js delete --app <이름> --yes    삭제

const fs = require('fs');
const path = require('path');

const WEBAPP = path.join(__dirname, '..', 'webapp');
const MAX_BYTES = 30 * 1024 * 1024;
const TEXT = ['.html', '.css', '.js', '.json', '.svg', '.txt'];

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'deploy';
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const app = option('app') || 'claude-bridge';

function fail(msg) {
  console.error(`\n[실패] ${msg}`);
  process.exit(1);
}

function env(name, hint, optional) {
  const v = (process.env[name] || '').trim();
  if (!v && !optional) fail(`환경 변수 ${name} 가 필요합니다 (${hint}).`);
  return v;
}

const API_BASE = env('QUICK_API_BASE', '가이드의 BASE_URL, 업로드 API 주소').replace(/\/+$/, '');
const HEADERS = { 'Authorization-HCP-GW': `Bearer ${env('QUICK_TOKEN', '게시 API 토큰')}` };

async function call(method, apiPath, { json, form } = {}) {
  const res = await fetch(`${API_BASE}${apiPath}`, {
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

const uploadFile = (fileName, content) => call('POST', '/api/upload-file', { json: { app_name: app, file_name: fileName, content } });

function webappFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(WEBAPP, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (rel !== 'app/data') walk(full); // 작업 데이터는 PC 에이전트가 올린다
      } else if (TEXT.includes(path.extname(e.name))) {
        out.push({ path: rel, content: fs.readFileSync(full, 'utf8') });
      } else {
        console.log(`  (건너뜀: 텍스트 파일만 올립니다) ${rel}`);
      }
    }
  })(WEBAPP);
  return out.sort((a, b) => (a.path === 'index.html' ? -1 : b.path === 'index.html' ? 1 : a.path.localeCompare(b.path)));
}

async function get(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(30000) });
  return { status: res.status, type: res.headers.get('content-type') || '', location: res.headers.get('location'), text: await res.text() };
}

const norm = (s) => s.replace(/\r/g, '').trim();

async function deploy() {
  const files = webappFiles();
  const bytes = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  if (bytes > MAX_BYTES) fail(`파일 합계가 30MB 를 넘습니다 (${bytes} bytes).`);
  console.log(`앱 '${app}' 게시 → ${API_BASE}  (파일 ${files.length}개, ${Math.ceil(bytes / 1024)}KB)`);

  const index = files.shift();
  const form = new FormData();
  form.append('app_name', app);
  form.append('files', new Blob([index.content], { type: 'text/html' }), 'index.html');
  const resp = await call('POST', '/api/upload', { form });
  const url = resp && typeof resp === 'object' ? resp.url : null;
  if (typeof url !== 'string' || !url) fail(`업로드 응답에 url 이 없습니다: ${JSON.stringify(resp).slice(0, 300)}`);
  let pageUrl;
  if (/^https?:\/\//i.test(url)) pageUrl = url;
  else {
    const host = env('QUICK_HOST', '가이드의 HOST, 게시된 앱이 열리는 주소. 업로드 응답의 url 이 상대 경로라 필요합니다');
    pageUrl = new URL(url.replace(/^\/+/, ''), host.replace(/\/*$/, '/')).href;
  }
  const appUrl = pageUrl.replace(/[^/]*$/, '');
  console.log(`  index.html → ${pageUrl}`);

  for (const f of files) {
    await uploadFile(f.path, f.content);
    console.log(`  ${f.path}`);
  }
  await uploadFile('app/data/config.json', JSON.stringify({ apiBase: API_BASE, appName: app, appUrl }, null, 2));
  console.log('  app/data/config.json (업로드 API 주소 · 앱 이름)');
  for (const [name, initial] of [['app/data/tasks.json', { generatedAt: null, agents: [], seenInbox: [], tasks: [] }], ['app/data/inbox.json', { entries: [] }]]) {
    const r = await get(appUrl + name);
    if (r.status === 404) {
      await uploadFile(name, JSON.stringify(initial));
      console.log(`  ${name} (처음 만듦)`);
    } else {
      console.log(`  ${name} (이미 있어 그대로 둠)`);
    }
  }

  // 게시된 주소에서 실제로 보이는지 확인한다
  const problems = [];
  for (const f of [index, ...files]) {
    const r = await get(appUrl + f.path);
    if (r.status >= 300 && r.status < 400) {
      problems.push(`${f.path}: 로그인 페이지 등으로 리다이렉트됨 (HTTP ${r.status} → ${r.location})`);
    } else if (r.status !== 200 || !norm(r.text).includes(norm(f.content).slice(0, 300))) {
      problems.push(`${f.path}: HTTP ${r.status}${r.status === 200 ? ' (내용이 다름)' : ''}`);
    } else if (f.path.endsWith('.js') && !/javascript|ecmascript/i.test(r.type)) {
      problems.push(`${f.path}: Content-Type 이 '${r.type}' 입니다. 브라우저가 JS 모듈로 실행하지 않을 수 있습니다.`);
    }
  }
  if (problems.length) {
    fail(
      [
        `게시는 했지만 ${problems.length}개 파일이 ${appUrl} 에서 제대로 보이지 않습니다:`,
        ...problems.map((p) => `  - ${p}`),
        'app/ 같은 하위 폴더를 지원하지 않는 서버라면 알려 주세요. 파일 구성을 바꾸겠습니다.',
      ].join('\n  '),
    );
  }

  console.log('\n완료 — 모든 파일이 게시 주소에서 확인됐습니다.');
  console.log(`  웹 화면: ${pageUrl}`);
  console.log('  agent\\agent.config.json 에 넣을 값:');
  console.log(`    "static": { "apiBase": "${API_BASE}", "appName": "${app}", "appUrl": "${appUrl}", "token": "<게시 API 토큰>" }`);
}

async function main() {
  if (command === 'deploy') return deploy();
  if (command === 'list') return console.log(JSON.stringify(await call('GET', '/api/list'), null, 2));
  if (command === 'delete') {
    if (!option('app')) fail('지울 앱 이름을 --app 으로 지정하세요.');
    if (!argv.includes('--yes')) fail(`앱 '${app}' 을(를) 지우려면 --yes 를 붙이세요. 게시된 파일과 작업 데이터가 모두 사라집니다.`);
    return console.log(JSON.stringify(await call('POST', '/api/delete', { json: { app_name: app } }), null, 2));
  }
  fail(`알 수 없는 명령: ${command} (deploy | list | delete)`);
}

main().catch((e) => fail(e.cause ? `${e.message}: ${e.cause.message || e.cause}` : e.message));
