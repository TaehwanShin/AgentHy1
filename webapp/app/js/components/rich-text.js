import { h, append } from '../dom.js';

// Claude 결과용 최소 마크다운 렌더러. DOM 으로만 만들어 XSS 를 막는다.
function inline(text) {
  const out = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] ? h('code', null, m[1].slice(1, -1)) : h('strong', null, m[2].slice(2, -2)));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const MD = {
  fence: /^\s*```/,
  head: /^(#{1,6})\s+(.*)$/,
  hr: /^\s*(-{3,}|\*{3,}|_{3,})\s*$/,
  item: /^(\s*)([-*+]|\d+[.)])\s+(.*)$/,
  tsep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/,
};
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function markdown(text) {
  const root = h('div', { class: 'md' });
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const isTable = (k) => /^\s*\|/.test(lines[k]) && k + 1 < lines.length && MD.tsep.test(lines[k + 1]);
  const isBlock = (k) => !lines[k].trim() || MD.fence.test(lines[k]) || MD.head.test(lines[k]) || MD.hr.test(lines[k]) || MD.item.test(lines[k]) || isTable(k);
  let i = 0;
  let m;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
    } else if (MD.fence.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !MD.fence.test(lines[i])) buf.push(lines[i++]);
      i++;
      root.append(h('pre', { class: 'code' }, buf.join('\n')));
    } else if ((m = MD.head.exec(line))) {
      root.append(h(m[1].length <= 2 ? 'h4' : m[1].length === 3 ? 'h5' : 'h6', null, inline(m[2])));
      i++;
    } else if (MD.hr.test(line)) {
      root.append(h('hr'));
      i++;
    } else if (isTable(i)) {
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(cells(lines[i++]));
      root.append(
        h('div', { class: 'md-table' }, h('table', null, h('thead', null, h('tr', null, head.map((c) => h('th', null, inline(c))))), h('tbody', null, body.map((r) => h('tr', null, r.map((c) => h('td', null, inline(c)))))))),
      );
    } else if ((m = MD.item.exec(line))) {
      const list = h(/\d/.test(m[2]) ? 'ol' : 'ul');
      while (i < lines.length && (m = MD.item.exec(lines[i]))) {
        list.append(h('li', { style: m[1].length >= 2 ? `margin-left:${Math.floor(m[1].length / 2) * 1.2}em` : null }, inline(m[3])));
        i++;
      }
      root.append(list);
    } else {
      const p = h('p');
      do {
        if (p.childNodes.length) p.append(h('br'));
        append(p, inline(lines[i++]));
      } while (i < lines.length && !isBlock(i));
      root.append(p);
    }
  }
  return root;
}

export function diffView(diff) {
  const inner = h('div', { class: 'diff-inner' });
  const lines = String(diff).split('\n');
  const MAX = 6000;
  for (const line of lines.slice(0, MAX)) {
    let c = null;
    if (line.startsWith('diff --git')) c = 'd-file';
    else if (line.startsWith('+++') || line.startsWith('---')) c = 'd-hdr';
    else if (line.startsWith('@@')) c = 'd-hunk';
    else if (line[0] === '+') c = 'd-add';
    else if (line[0] === '-') c = 'd-del';
    else if (/^(index |new file|deleted file|similarity|rename |Binary|\\ No newline)/.test(line)) c = 'd-meta';
    inner.append(h('span', { class: c }, line || ' '));
  }
  if (lines.length > MAX) inner.append(h('span', { class: 'd-meta' }, `… ${lines.length - MAX}줄 더 있음 (.patch 받기로 전체 확인)`));
  return h('pre', { class: 'code diff' }, inner);
}

export function filesView(files) {
  const names = { A: '추가', M: '수정', D: '삭제', R: '이름 변경' };
  return h(
    'ul',
    { class: 'files' },
    String(files)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t');
        const st = parts[0].charAt(0);
        return h('li', null, h('span', { class: `fs fs-${st}`, title: names[st] || st }, st), h('code', null, parts.slice(1).join(' → ')));
      }),
  );
}
