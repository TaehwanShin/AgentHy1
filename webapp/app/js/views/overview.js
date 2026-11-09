import { h, card, badge, fmtDate, dur, ago, dayKey, ACTIVE } from '../dom.js';
import { kpiCards } from '../components/kpi-cards.js';
import { stackedBarChart } from '../components/bar-chart.js';

const SERIES = [
  { key: 'done', label: '완료', color: '#1f5fd6' },
  { key: 'active', label: '진행 중', color: '#8db4f2' },
  { key: 'failed', label: '실패 · 취소', color: '#d4574a' },
];

const groupOf = (t) => (t.status === 'done' ? 'done' : t.status === 'error' || t.status === 'canceled' ? 'failed' : 'active');

export function renderOverview(root, ctx) {
  function draw() {
    const tasks = ctx.tasks();
    const { index } = ctx.state;
    const count = (f) => tasks.filter(f).length;
    const today = dayKey(new Date());
    const done = count((t) => t.status === 'done');
    const failed = count((t) => t.status === 'error' || t.status === 'canceled');
    const active = count((t) => ACTIVE.includes(t.status));
    const durations = tasks.filter((t) => t.status === 'done' && t.durationMs).map((t) => t.durationMs);
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    const kpis = kpiCards([
      { label: '전체 요청', value: tasks.length, sub: index.generatedAt ? `데이터 갱신 ${ago(index.generatedAt)}` : '아직 게시된 데이터 없음', tone: 'blue' },
      { label: '오늘 요청', value: count((t) => t.createdAt && dayKey(new Date(t.createdAt)) === today) },
      {
        label: '진행 중',
        value: active,
        sub: `접수 대기 ${count((t) => t.status === 'queued')} · 대기 ${count((t) => t.status === 'pending')} · 실행 ${count((t) => t.status === 'running')}`,
        tone: active ? 'amber' : null,
      },
      { label: '완료', value: done, sub: done + failed ? `완료율 ${Math.round((done / (done + failed)) * 100)}%` : '', tone: 'green' },
      { label: '실패 · 취소', value: failed, tone: failed ? 'red' : null },
      { label: '평균 처리 시간', value: avg ? dur(avg) : '-', sub: durations.length ? `완료 ${durations.length}건 기준` : '' },
    ]);

    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      days.push({ key: dayKey(d), label: `${d.getMonth() + 1}/${d.getDate()}`, values: {} });
    }
    const byDay = Object.fromEntries(days.map((d) => [d.key, d]));
    for (const t of tasks) {
      const d = t.createdAt && byDay[dayKey(new Date(t.createdAt))];
      if (d) d.values[groupOf(t)] = (d.values[groupOf(t)] || 0) + 1;
    }

    const agents = index.agents.length
      ? h(
          'ul',
          { class: 'agents' },
          index.agents.map((a) => {
            const on = ctx.online(a);
            return h(
              'li',
              null,
              h('span', { class: `dot ${on ? (a.busy ? 'busy' : 'on') : 'off'}` }),
              h(
                'div',
                null,
                h('b', null, a.name),
                h('div', { class: 'muted' }, on ? (a.busy ? h('a', { href: `#/task/${a.busy}` }, `작업 중 #${a.busy}`) : '요청 대기 중') : `오프라인 · 마지막 신호 ${ago(a.lastSeen)}`),
                a.projects ? h('div', { class: 'muted small' }, `프로젝트: ${a.projects.split(',').join(', ')}`) : null,
              ),
            );
          }),
        )
      : h('p', { class: 'muted' }, '아직 연결된 PC 에이전트가 없습니다. PC 에서 Orchestrator 세션을 열면 표시됩니다.');

    const recent = tasks.slice(0, 6);
    const recentList = recent.length
      ? h(
          'ul',
          { class: 'recent' },
          recent.map((t) =>
            h(
              'li',
              null,
              h(
                'a',
                { href: t.id ? `#/task/${t.id}` : '#/detail' },
                h('span', { class: 'rid' }, t.id ? `#${t.id}` : '접수'),
                h('span', { class: 'rtitle' }, t.title),
                h('span', { class: 'muted small' }, `${t.project || ''} · ${t.requester || ''}`),
                badge(t),
                h('span', { class: 'muted small rtime' }, fmtDate(t.createdAt)),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted' }, '요청이 없습니다. [새 요청] 에서 등록하세요.');

    root.replaceChildren(
      h('div', { class: 'page-head' }, h('h1', null, '개요'), h('a', { class: 'btn primary', href: '#/new' }, '새 요청')),
      kpis,
      h('div', { class: 'grid-main' }, card('최근 14일 요청', stackedBarChart({ days, series: SERIES })), card('PC 에이전트', agents)),
      card('최근 작업', recentList, h('a', { href: '#/detail', class: 'link' }, '전체 보기 →')),
    );
  }
  draw();
  return { update: draw };
}
