import { h } from '../dom.js';

// items: [{ label, value, sub?, tone?: 'blue' | 'green' | 'red' | 'amber' }]
export function kpiCards(items) {
  return h(
    'div',
    { class: 'kpi-grid' },
    items.map((k) =>
      h('div', { class: `kpi${k.tone ? ` tone-${k.tone}` : ''}` }, h('div', { class: 'kpi-label' }, k.label), h('div', { class: 'kpi-value' }, k.value), k.sub ? h('div', { class: 'kpi-sub' }, k.sub) : null),
    ),
  );
}
