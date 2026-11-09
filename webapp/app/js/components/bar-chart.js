import { h } from '../dom.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

// 의존성 없는 누적 막대 차트.
// days: [{ label, values: { [seriesKey]: number } }], series: [{ key, label, color }]
export function stackedBarChart({ days, series, height = 240 }) {
  const width = 1000;
  const pad = { top: 16, right: 12, bottom: 30, left: 34 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const totals = days.map((d) => series.reduce((n, sr) => n + (d.values[sr.key] || 0), 0));
  const max = Math.max(1, ...totals);
  const step = max <= 4 ? 1 : Math.ceil(max / 4);
  const top = Math.ceil(max / step) * step;
  const y = (v) => pad.top + innerH - (v / top) * innerH;
  const slot = innerW / days.length;
  const barW = Math.min(36, slot * 0.62);

  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img', 'aria-label': '일별 요청 수' });
  for (let v = 0; v <= top; v += step) {
    svg.append(s('line', { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v), class: 'grid' }));
    svg.append(s('text', { x: pad.left - 8, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }, String(v)));
  }
  const labelEvery = Math.ceil(days.length / 10);
  days.forEach((d, i) => {
    const x = pad.left + slot * i + (slot - barW) / 2;
    let acc = 0;
    for (const sr of series) {
      const v = d.values[sr.key] || 0;
      if (!v) continue;
      const rect = s('rect', { x, y: y(acc + v), width: barW, height: Math.max(0, y(acc) - y(acc + v)), fill: sr.color, rx: 2 });
      rect.append(s('title', null, `${d.label} · ${sr.label} ${v}건`));
      svg.append(rect);
      acc += v;
    }
    if (totals[i]) svg.append(s('text', { x: x + barW / 2, y: y(acc) - 5, class: 'value', 'text-anchor': 'middle' }, String(totals[i])));
    if (i % labelEvery === 0 || i === days.length - 1) svg.append(s('text', { x: x + barW / 2, y: height - 10, class: 'axis', 'text-anchor': 'middle' }, d.label));
  });

  const legend = h(
    'div',
    { class: 'legend' },
    series.map((sr) => h('span', null, h('i', { style: `background:${sr.color}` }), sr.label)),
  );
  return h('div', { class: 'chart-wrap' }, svg, legend);
}
