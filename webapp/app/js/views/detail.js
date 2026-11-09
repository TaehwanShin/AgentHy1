import { h, card, badge, statusLabel, fmtDate, dur, dayKey, download, STATUS } from '../dom.js';
import { dataTable, toCsv } from '../components/data-table.js';

const KEYS = ['status', 'project', 'requester', 'from', 'to', 'q', 'sort', 'dir'];
const STORE = 'bridge.detail.filters';
const DEFAULTS = { sort: 'createdAt', dir: 'desc' };

const COLUMNS = [
  { key: 'id', label: '번호', width: '76px', value: (t) => t.id ?? Number.MAX_SAFE_INTEGER, render: (t) => (t.id ? `#${t.id}` : '접수') },
  { key: 'title', label: '제목' },
  { key: 'project', label: '프로젝트', width: '140px' },
  { key: 'requester', label: '요청자', width: '110px' },
  { key: 'status', label: '상태', width: '110px', value: statusLabel, render: badge },
  { key: 'createdAt', label: '등록', width: '140px', render: (t) => fmtDate(t.createdAt, true) },
  { key: 'durationMs', label: '소요', width: '100px', align: 'right', render: (t) => dur(t.durationMs) },
  { key: 'fileCount', label: '변경 파일', width: '90px', align: 'right', render: (t) => (t.fileCount ? String(t.fileCount) : '') },
  { key: 'agent', label: '에이전트', width: '130px' },
];

const CSV_COLUMNS = [
  { label: '번호', csv: (t) => t.id || '' },
  { label: '제목', csv: (t) => t.title },
  { label: '프로젝트', csv: (t) => t.project },
  { label: '요청자', csv: (t) => t.requester },
  { label: '상태', csv: statusLabel },
  { label: '등록', csv: (t) => fmtDate(t.createdAt, true) },
  { label: '시작', csv: (t) => fmtDate(t.startedAt, true) },
  { label: '종료', csv: (t) => fmtDate(t.finishedAt, true) },
  { label: '소요(초)', csv: (t) => (t.durationMs ? Math.round(t.durationMs / 1000) : '') },
  { label: '변경 파일 수', csv: (t) => t.fileCount || 0 },
  { label: '에이전트', csv: (t) => t.agent || '' },
];

function readStored() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || '{}');
  } catch {
    return {};
  }
}

export function renderDetail(root, ctx) {
  const fromHash = KEYS.some((k) => ctx.query.has(k));
  const f = { ...DEFAULTS, ...(fromHash ? Object.fromEntries(KEYS.filter((k) => ctx.query.get(k)).map((k) => [k, ctx.query.get(k)])) : readStored()) };

  function persist() {
    const clean = Object.fromEntries(KEYS.filter((k) => f[k] && f[k] !== DEFAULTS[k]).map((k) => [k, f[k]]));
    try {
      localStorage.setItem(STORE, JSON.stringify(clean));
    } catch {
      // 저장소를 쓸 수 없어도 화면은 동작한다
    }
    ctx.setQuery(clean);
  }

  const field = (label, control) => h('label', { class: 'field' }, h('span', null, label), control);
  const select = (key, options) => {
    const el = h('select', { onchange: () => { f[key] = el.value; persist(); drawTable(); } });
    fill(el, options, f[key]);
    return el;
  };
  function fill(el, options, value) {
    const sig = JSON.stringify(options);
    if (el.dataset.sig === sig) return; // 열려 있는 목록이 주기적 갱신으로 닫히지 않도록, 바뀐 경우에만 다시 그린다
    el.dataset.sig = sig;
    el.replaceChildren(...options.map(([v, l]) => h('option', { value: v }, l)));
    if (value && !options.some(([v]) => v === value)) el.append(h('option', { value }, value));
    el.value = value || '';
  }
  const uniq = (key) => [...new Set(ctx.tasks().map((t) => t[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));

  const statusSel = select('status', [['', '전체'], ...Object.entries(STATUS)]);
  const projectSel = select('project', [['', '전체'], ...uniq('project').map((p) => [p, p])]);
  const requesterSel = select('requester', [['', '전체'], ...uniq('requester').map((p) => [p, p])]);
  const dateInput = (key) => {
    const el = h('input', { type: 'date', value: f[key] || '', onchange: () => { f[key] = el.value; persist(); drawTable(); } });
    return el;
  };
  const fromIn = dateInput('from');
  const toIn = dateInput('to');
  let searchTimer;
  const search = h('input', { type: 'search', placeholder: '제목 검색', value: f.q || '', oninput: () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { f.q = search.value.trim(); persist(); drawTable(); }, 200); } });
  const count = h('span', { class: 'muted' });
  let lastRows = [];

  const reset = () => {
    for (const k of KEYS) delete f[k];
    Object.assign(f, DEFAULTS);
    statusSel.value = projectSel.value = requesterSel.value = fromIn.value = toIn.value = search.value = '';
    persist();
    drawTable();
  };
  const exportCsv = () => download(`claude-bridge-${dayKey(new Date())}.csv`, toCsv(CSV_COLUMNS, lastRows), 'text/csv;charset=utf-8');

  const tableBox = h('div');
  function filtered() {
    const q = (f.q || '').toLowerCase();
    return ctx.tasks().filter((t) => {
      const day = t.createdAt ? dayKey(new Date(t.createdAt)) : '';
      return (
        (!f.status || t.status === f.status) &&
        (!f.project || t.project === f.project) &&
        (!f.requester || t.requester === f.requester) &&
        (!f.from || day >= f.from) &&
        (!f.to || day <= f.to) &&
        (!q || String(t.title || '').toLowerCase().includes(q))
      );
    });
  }
  function drawTable() {
    const { table, sorted } = dataTable({
      columns: COLUMNS,
      rows: filtered(),
      sortKey: f.sort,
      sortDir: f.dir,
      onSort: (key, dir) => { f.sort = key; f.dir = dir; persist(); drawTable(); },
      onRowClick: (t) => t.id && ctx.go(`#/task/${t.id}`),
      empty: ctx.tasks().length ? '조건에 맞는 작업이 없습니다.' : '아직 요청이 없습니다.',
    });
    lastRows = sorted;
    count.textContent = `${sorted.length}건`;
    tableBox.replaceChildren(table);
  }

  root.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', null, '작업 목록'), h('a', { class: 'btn primary', href: '#/new' }, '새 요청')),
    card(
      null,
      h(
        'div',
        { class: 'filters' },
        field('상태', statusSel),
        field('프로젝트', projectSel),
        field('요청자', requesterSel),
        field('등록 시작일', fromIn),
        field('등록 종료일', toIn),
        field('검색', search),
        h('div', { class: 'filter-actions' }, count, h('button', { type: 'button', class: 'btn', onclick: reset }, '초기화'), h('button', { type: 'button', class: 'btn', onclick: exportCsv }, 'CSV 내보내기')),
      ),
    ),
    tableBox,
  );
  persist();
  drawTable();

  return {
    update() {
      fill(projectSel, [['', '전체'], ...uniq('project').map((p) => [p, p])], f.project);
      fill(requesterSel, [['', '전체'], ...uniq('requester').map((p) => [p, p])], f.requester);
      drawTable();
    },
  };
}
