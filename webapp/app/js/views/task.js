import { h, card, statusLabel, fmtDate, dur, toast, download, FINISHED } from '../dom.js';
import { loadTask } from '../data-loader.js';
import { markdown, diffView, filesView } from '../components/rich-text.js';

export function renderTask(root, ctx, idText) {
  const id = Number(idText);
  let task = null;
  let sig = '';
  let logOpen = false;

  function action(label, cls, fn) {
    return h('button', {
      type: 'button',
      class: `btn ${cls}`,
      onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        try {
          await fn();
        } catch (err) {
          if (err && err.message) toast(err.message);
        } finally {
          b.disabled = false;
        }
      },
    }, label);
  }

  const section = (title, body) => h('section', { class: 'sec' }, h('h3', null, title), body);

  function draw() {
    const t = task;
    const pendingCtl = ctx.pendingControls(t.id);
    const running = t.status === 'running' || t.status === 'pending';
    const finished = FINISHED.includes(t.status);

    const actions = [];
    if (running) {
      actions.push(
        action(t.cancelRequested ? '강제 중단' : '취소', 'danger', async () => {
          if (t.cancelRequested && !confirm('PC 응답 없이 이 작업을 취소 상태로 바꿉니다. 계속할까요?')) return;
          await ctx.actions.cancel(t, !!t.cancelRequested);
          toast('취소 요청을 올렸습니다. PC 가 반영하면 상태가 바뀝니다.');
        }),
      );
    }
    if (finished) {
      actions.push(
        action('다시 실행', '', async () => {
          if (!confirm('같은 요청을 처음부터 다시 실행합니다. 이전 결과는 지워집니다.')) return;
          await ctx.actions.retry(t);
          toast('다시 실행 요청을 올렸습니다.');
        }),
      );
    }
    if (t.diff) actions.push(action('.patch 받기', '', () => download(`task-${t.id}.patch`, t.diff, 'text/x-diff')));

    const meta = [
      ['요청자', t.requester],
      ['등록', fmtDate(t.createdAt, true)],
      ['시작', fmtDate(t.startedAt, true)],
      ['종료', fmtDate(t.finishedAt, true)],
      ['에이전트', t.agent],
      ['소요', dur(t.durationMs)],
      ['비용', t.costUsd ? `$${t.costUsd}` : ''],
      ['턴', t.numTurns],
    ].filter((m) => m[1]);

    const lineage = [];
    if (t.parentId) lineage.push(h('a', { href: `#/task/${t.parentId}` }, `← #${t.parentId} 에서 이어진 작업`));
    for (const c of ctx.tasks().filter((x) => x.parentId === t.id)) lineage.push(h('a', { href: c.id ? `#/task/${c.id}` : '#/detail' }, `→ ${c.id ? `#${c.id}` : '접수 대기'} 추가 지시 (${statusLabel(c)})`));

    const parts = [
      h(
        'div',
        { class: 'task-head' },
        h('div', null, h('div', { class: 'muted' }, h('a', { href: '#/detail' }, '작업 목록'), ` / #${t.id} · ${t.project || ''}`), h('h1', null, t.title)),
        h('span', { class: `badge lg s-${t.status}` }, statusLabel(t)),
      ),
      h('dl', { class: 'meta' }, meta.map((m) => h('div', null, h('dt', null, m[0]), h('dd', null, m[1])))),
      lineage.length ? h('div', { class: 'lineage' }, lineage) : null,
      actions.length ? h('div', { class: 'actions' }, actions) : null,
      pendingCtl.length ? h('div', { class: 'state-note' }, `${pendingCtl.map((e) => (e.type === 'cancel' ? '취소' : '다시 실행')).join(', ')} 요청을 올렸습니다. PC 가 반영하기를 기다리는 중입니다.`) : null,
    ];

    if (t.status === 'pending') parts.push(h('div', { class: 'state-note' }, h('span', { class: 'spinner' }), 'PC 에이전트가 가져가기를 기다리는 중입니다.'));
    if (t.status === 'running') {
      const last = (t.log || '').trim().split('\n').pop() || '시작하는 중…';
      parts.push(h('div', { class: 'state-note run' }, h('span', { class: 'spinner' }), h('div', null, h('b', null, t.cancelRequested ? '취소 요청을 전달하는 중…' : 'Claude 가 작업 중입니다'), h('div', { class: 'last' }, last))));
    }

    parts.push(section('요청 내용', h('pre', { class: 'prose' }, t.prompt || '')));
    if (t.result) {
      const md = markdown(t.result);
      md.classList.add(t.status === 'done' ? 'ok' : 'bad');
      parts.push(section(t.status === 'done' ? 'Claude 결과' : '결과 / 오류', md));
    }
    if (t.denials) {
      parts.push(section('권한이 없어 실행하지 못한 도구', h('div', { class: 'warn' }, h('p', null, '허용 목록에 없어 거부된 동작입니다. 필요하면 PC 의 Claude 권한 설정을 바꾸세요.'), h('pre', { class: 'code' }, t.denials))));
    }
    if (t.files) parts.push(section('변경 파일', filesView(t.files)));
    if (t.diff) parts.push(section('변경 내역 (diff)', diffView(t.diff)));
    else if (t.diffHidden) parts.push(section('변경 내역 (diff)', h('p', { class: 'muted' }, 'PC 설정에서 diff 를 게시하지 않도록 해 두었습니다. PC 의 작업 폴더에서 확인하세요.')));
    else if (t.status === 'done') parts.push(section('변경 내역 (diff)', h('p', { class: 'muted' }, '변경된 파일이 없습니다.')));

    if (t.log) {
      const det = h(
        'details',
        { class: 'sec logbox', open: running || logOpen ? true : null, ontoggle: () => (logOpen = det.open) },
        h('summary', null, '실행 로그 ', h('span', { class: 'muted' }, `${t.log.split('\n').length}줄`)),
        h('pre', { class: 'code log' }, t.log),
      );
      parts.push(det);
    }

    if (finished) {
      const ta = h('textarea', { rows: '3', required: true, placeholder: '예) 컬럼 헤더 이름을 "배송 예정일"로 바꿔 주세요.', oninput: () => (ctx.drafts[t.id] = ta.value) });
      ta.value = ctx.drafts[t.id] || '';
      const form = h(
        'form',
        {
          class: 'followup',
          onsubmit: async (e) => {
            e.preventDefault();
            const b = form.querySelector('button');
            b.disabled = true;
            try {
              await ctx.actions.followUp(t, ta.value.trim());
              delete ctx.drafts[t.id];
              toast('추가 지시를 올렸습니다.');
              ctx.go('#/overview');
            } catch (err) {
              if (err && err.message) toast(err.message);
            } finally {
              b.disabled = false;
            }
          },
        },
        h('h3', null, '추가 지시'),
        h('p', { class: 'muted' }, 'PC 의 같은 Orchestrator 대화로 이어서 전달됩니다.'),
        ta,
        h('div', { class: 'form-foot' }, h('button', { class: 'btn primary', type: 'submit' }, '이어서 요청')),
      );
      parts.push(form);
    }

    const oldLog = root.querySelector('.log');
    const atBottom = !oldLog || oldLog.scrollTop + oldLog.clientHeight >= oldLog.scrollHeight - 8;
    const logTop = oldLog ? oldLog.scrollTop : 0;
    root.replaceChildren(...parts.filter(Boolean));
    const newLog = root.querySelector('.log');
    if (newLog) newLog.scrollTop = atBottom ? newLog.scrollHeight : logTop;
  }

  async function load() {
    try {
      const t = await loadTask(id);
      if (!t) {
        if (!task) root.replaceChildren(card(null, h('p', null, `작업 #${id} 을(를) 찾을 수 없습니다. PC 가 아직 게시하지 않았거나 지워졌습니다.`), null));
        return;
      }
      const s = JSON.stringify(t) + JSON.stringify(ctx.pendingControls(t.id));
      if (s === sig) return;
      sig = s;
      task = t;
      draw();
    } catch (e) {
      toast(e.message);
    }
  }

  root.replaceChildren(h('p', { class: 'muted' }, '불러오는 중…'));
  load();
  return { update: load };
}
