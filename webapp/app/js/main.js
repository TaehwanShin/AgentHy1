// 초기화, 해시 라우팅(#/overview, #/detail, #/new, #/task/<번호>), 주기적 갱신, 토큰 입력.
import { h, toast, ACTIVE } from './dom.js';
import { loadConfig, loadIndex, loadInbox, pushInbox, newEntryId } from './data-loader.js';
import { renderOverview } from './views/overview.js';
import { renderDetail } from './views/detail.js';
import { renderTask } from './views/task.js';
import { renderNew } from './views/new-request.js';

const ROUTES = { overview: renderOverview, detail: renderDetail, new: renderNew, task: renderTask };
const TITLES = { overview: '개요', detail: '작업 목록', new: '새 요청', task: '작업' };
const ONLINE_MS = 150000; // PC 는 쉬는 동안 1분마다 상태를 올린다

const local = {
  get: (k) => {
    try {
      return localStorage.getItem(k) || '';
    } catch {
      return '';
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // 저장 실패는 무시
    }
  },
};

const state = {
  config: {},
  index: { generatedAt: null, agents: [], seenInbox: [], tasks: [] },
  inbox: [],
  // 같은 사내 호스트의 다른 앱이 읽을 수 있으므로 토큰은 localStorage/sessionStorage 에 두지 않고 메모리에만 둔다
  token: '',
  name: local.get('bridge.name'),
};
let current = null;
let timer = null;

const firstLine = (s) => String(s || '').trim().split('\n')[0].slice(0, 60);

function parseHash() {
  const m = /^#\/([a-z]+)(?:\/([^?]*))?(?:\?(.*))?$/.exec(location.hash);
  return { view: m ? m[1] : 'overview', arg: m ? decodeURIComponent(m[2] || '') : '', query: new URLSearchParams(m ? m[3] || '' : '') };
}

function tasks() {
  const seen = new Set(state.index.seenInbox);
  const queued = state.inbox
    .filter((e) => e && e.type === 'request' && !seen.has(e.id))
    .map((e) => ({ id: null, requestId: e.id, title: e.title || firstLine(e.prompt), project: e.project, requester: e.requester, status: 'queued', createdAt: e.createdAt, parentId: e.parentId || null }));
  return [...queued, ...state.index.tasks].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

const ctx = {
  state,
  tasks,
  query: new URLSearchParams(),
  drafts: {},
  online: (a) => !!a.lastSeen && Date.now() - new Date(a.lastSeen).getTime() < ONLINE_MS,
  pendingControls: (taskId) => {
    const seen = new Set(state.index.seenInbox);
    return state.inbox.filter((e) => e && e.taskId === taskId && (e.type === 'cancel' || e.type === 'retry') && !seen.has(e.id));
  },
  go: (hash) => {
    if (location.hash === hash) route(true);
    else location.hash = hash;
  },
  setQuery: (params) => {
    const qs = new URLSearchParams(params).toString();
    const { view, arg } = parseHash();
    history.replaceState(null, '', `#/${view}${arg ? `/${arg}` : ''}${qs ? `?${qs}` : ''}`);
  },
  actions: {
    submit: ({ project, title, prompt }) => {
      if (!project || !prompt) return Promise.reject(new Error('프로젝트와 요청 내용을 입력하세요.'));
      return pushEntry({ type: 'request', project, title, prompt });
    },
    followUp: (task, prompt) => {
      if (!prompt) return Promise.reject(new Error('추가 지시 내용을 입력하세요.'));
      return pushEntry({ type: 'request', parentId: task.id, project: task.project, title: '', prompt });
    },
    cancel: (task, force) => pushEntry({ type: 'cancel', taskId: task.id, force: !!force }),
    retry: (task) => pushEntry({ type: 'retry', taskId: task.id }),
  },
};

async function pushEntry(entry) {
  await requireToken();
  const full = { id: newEntryId(), createdAt: new Date().toISOString(), requester: state.name, ...entry };
  state.inbox = await pushInbox(state.config, state.token, full, state.index.seenInbox);
  renderChrome();
  if (current && current.handle && current.handle.update) current.handle.update();
  scheduleRefresh(3000);
  return full;
}

// ---------- 토큰 입력 ----------

function requireToken() {
  if (state.token && state.name) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const name = h('input', { required: true, maxlength: '30', autocomplete: 'name', value: state.name });
    const token = h('input', { type: 'password', required: true, autocomplete: 'off', value: state.token });
    const close = (ok) => {
      dialog.remove();
      document.removeEventListener('keydown', onKey);
      if (ok) resolve();
      else reject(new Error(''));
    };
    const onKey = (e) => e.key === 'Escape' && close(false);
    const dialog = h(
      'div',
      { class: 'modal-backdrop', onclick: (e) => e.target === dialog && close(false) },
      h(
        'form',
        {
          class: 'modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'tokenTitle',
          onsubmit: (e) => {
            e.preventDefault();
            state.name = name.value.trim();
            state.token = token.value.trim();
            local.set('bridge.name', state.name);
            renderChrome();
            close(true);
          },
        },
        h('h2', { id: 'tokenTitle' }, '게시 API 토큰'),
        h('p', { class: 'muted' }, '요청을 올리려면 이 앱을 게시한 계정의 게시 API 토큰이 필요합니다. 토큰은 이 페이지 메모리에만 두고 저장하지 않으므로, 새로고침하면 다시 입력해야 합니다.'),
        h('label', { class: 'field' }, h('span', null, '요청자 이름'), name),
        h('label', { class: 'field' }, h('span', null, '토큰'), token),
        h('div', { class: 'form-foot' }, h('button', { type: 'button', class: 'btn', onclick: () => close(false) }, '취소'), h('button', { type: 'submit', class: 'btn primary' }, '확인')),
      ),
    );
    document.body.append(dialog);
    document.addEventListener('keydown', onKey);
    (state.name ? token : name).focus();
  });
}

// ---------- 화면 틀 ----------

function renderChrome() {
  const { view } = parseHash();
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('on', a.dataset.view === view || (view === 'task' && a.dataset.view === 'detail'));
  const agents = state.index.agents;
  const box = document.getElementById('agentStatus');
  box.replaceChildren(
    ...(agents.length
      ? agents.map((a) => {
          const on = ctx.online(a);
          return h('span', { class: `chip ${on ? (a.busy ? 'busy' : 'on') : 'off'}`, title: `프로젝트: ${a.projects || '-'}` }, h('i'), h('b', null, a.name), on ? (a.busy ? ` 작업 중 #${a.busy}` : ' 대기 중') : ' 오프라인');
        })
      : [h('span', { class: 'chip off' }, h('i'), '연결된 PC 없음')]),
  );
  const auth = document.getElementById('auth');
  auth.replaceChildren(
    state.token
      ? h('span', { class: 'auth-on' }, `${state.name} · 토큰 입력됨 `, h('button', { type: 'button', class: 'btn sm', onclick: () => { state.token = ''; renderChrome(); } }, '토큰 지우기'))
      : h('button', { type: 'button', class: 'btn sm', onclick: () => requireToken().catch(() => {}) }, '토큰 입력'),
  );
}

function setNotice(msg) {
  const n = document.getElementById('notice');
  n.textContent = msg;
  n.hidden = !msg;
}

function route(force) {
  const { view, arg, query } = parseHash();
  if (!ROUTES[view] || (view === 'task' && !/^\d+$/.test(arg))) {
    location.replace('#/overview');
    return;
  }
  ctx.query = query;
  if (!force && current && current.view === view && current.arg === arg) return;
  if (current && current.handle && current.handle.dispose) current.handle.dispose();
  const root = document.getElementById('view');
  root.replaceChildren();
  current = { view, arg, handle: ROUTES[view](root, ctx, arg) };
  document.title = `${TITLES[view]}${view === 'task' ? ` #${arg}` : ''} · Claude 작업 브릿지`;
  renderChrome();
  window.scrollTo(0, 0);
}

// ---------- 주기적 갱신 ----------

function scheduleRefresh(ms) {
  clearTimeout(timer);
  timer = setTimeout(refresh, ms);
}

async function refresh() {
  if (document.hidden) return scheduleRefresh(5000);
  try {
    const [index, inbox] = await Promise.all([loadIndex(), loadInbox()]);
    state.index = index;
    state.inbox = inbox;
    setNotice(state.config.apiBase ? '' : 'app/data/config.json 이 없어 요청을 올릴 수 없습니다. 배포 스크립트(deploy.js)로 올린 앱에서 사용하세요.');
  } catch (e) {
    setNotice(`데이터를 불러오지 못했습니다: ${e.message}`);
  }
  renderChrome();
  if (current && current.handle && current.handle.update) current.handle.update();
  scheduleRefresh(tasks().some((t) => ACTIVE.includes(t.status)) ? 5000 : 15000);
}

async function init() {
  try {
    state.config = await loadConfig();
  } catch (e) {
    toast(e.message);
  }
  window.addEventListener('hashchange', () => route(false));
  document.addEventListener('visibilitychange', () => !document.hidden && scheduleRefresh(0));
  if (!location.hash) history.replaceState(null, '', '#/overview');
  await refresh();
  route(true);
}

init();
