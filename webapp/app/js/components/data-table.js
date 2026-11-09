import { h } from '../dom.js';

// columns: [{ key, label, render?(row) → Node|string, value?(row) → 정렬·CSV 값, align?: 'right', width? }]
export function dataTable({ columns, rows, sortKey, sortDir, onSort, onRowClick, empty }) {
  const valueOf = (c, r) => (c.value ? c.value(r) : r[c.key]);
  const col = columns.find((c) => c.key === sortKey);
  const sorted = col
    ? [...rows].sort((a, b) => {
        const va = valueOf(col, a);
        const vb = valueOf(col, b);
        const cmp = va == null ? 1 : vb == null ? -1 : typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'ko');
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : rows;
  const head = h(
    'tr',
    null,
    columns.map((c) => {
      const active = c.key === sortKey;
      return h(
        'th',
        { class: `${c.align === 'right' ? 'num' : ''}${active ? ' sorted' : ''}`, style: c.width ? `width:${c.width}` : null, 'aria-sort': active ? (sortDir === 'asc' ? 'ascending' : 'descending') : null },
        h('button', { type: 'button', onclick: () => onSort(c.key, active && sortDir === 'desc' ? 'asc' : 'desc') }, c.label, active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''),
      );
    }),
  );
  const body = sorted.length
    ? sorted.map((r) =>
        h(
          'tr',
          { class: onRowClick ? 'clickable' : null, tabindex: onRowClick ? '0' : null, onclick: onRowClick ? () => onRowClick(r) : null, onkeydown: onRowClick ? (e) => e.key === 'Enter' && onRowClick(r) : null },
          columns.map((c) => h('td', { class: c.align === 'right' ? 'num' : null }, c.render ? c.render(r) : r[c.key] ?? '')),
        ),
      )
    : h('tr', null, h('td', { class: 'empty-row', colspan: String(columns.length) }, empty || '데이터가 없습니다.'));
  return { table: h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', null, head), h('tbody', null, body))), sorted };
}

// Excel 에서 한글이 깨지지 않도록 BOM 을 붙이고, =,+,-,@ 로 시작하는 값은 수식으로 실행되지 않게 막는다.
export function toCsv(columns, rows) {
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(c.csv ? c.csv(r) : c.value ? c.value(r) : r[c.key])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
