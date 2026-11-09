// DOM 생성 / 형식화 공용 함수. 모든 데이터는 textContent 로만 넣는다(innerHTML 금지).

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}

export function append(el, kid) {
  if (kid == null || kid === false) return;
  if (Array.isArray(kid)) kid.forEach((k) => append(el, k));
  else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
}

export const STATUS = { queued: '접수 대기', pending: '대기', running: '실행 중', done: '완료', error: '실패', canceled: '취소됨' };
export const ACTIVE = ['queued', 'pending', 'running'];
export const FINISHED = ['done', 'error', 'canceled'];

export const statusLabel = (t) => (t.status === 'running' && t.cancelRequested ? '취소 요청됨' : STATUS[t.status] || t.status);
export const badge = (t) => h('span', { class: `badge s-${t.status}` }, statusLabel(t));

const pad = (n) => String(n).padStart(2, '0');
export function fmtDate(iso, withYear) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = `${withYear ? `${d.getFullYear()}-` : ''}${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function ago(iso) {
  if (!iso) return '';
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}초 전`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return `${Math.floor(sec / 86400)}일 전`;
}

export function dur(ms) {
  ms = Number(ms);
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분 ${s % 60}초`;
  return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
}

let toastTimer;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const card = (title, body, extra) => h('section', { class: 'card' }, title ? h('div', { class: 'card-head' }, h('h2', null, title), extra || null) : null, body);
