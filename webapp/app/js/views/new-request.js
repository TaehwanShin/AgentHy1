import { h, card, toast } from '../dom.js';

export function renderNew(root, ctx) {
  const projects = [...new Set([...ctx.state.index.agents.flatMap((a) => String(a.projects || '').split(',')), ...ctx.tasks().map((t) => t.project)].filter(Boolean))].sort();
  const lastProject = (() => {
    try {
      return localStorage.getItem('bridge.project') || '';
    } catch {
      return '';
    }
  })();

  const project = h('input', { name: 'project', list: 'projectList', required: true, maxlength: '60', placeholder: 'PC 에 등록된 프로젝트 이름', autocomplete: 'off', value: lastProject });
  const title = h('input', { name: 'title', maxlength: '100', placeholder: '비우면 요청 내용 첫 줄' });
  const prompt = h('textarea', { name: 'prompt', rows: '10', required: true, placeholder: "예) 주문 목록 화면(orderList.jsp)에 '배송일' 컬럼을 추가해 주세요. 정렬은 기존처럼 주문일 내림차순." });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, '요청 등록');
  prompt.value = ctx.drafts.new || '';
  prompt.addEventListener('input', () => (ctx.drafts.new = prompt.value));
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  const form = h(
    'form',
    {
      class: 'request-form',
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        try {
          await ctx.actions.submit({ project: project.value.trim(), title: title.value.trim(), prompt: prompt.value.trim() });
          try {
            localStorage.setItem('bridge.project', project.value.trim());
          } catch {
            // 저장 실패는 무시
          }
          delete ctx.drafts.new;
          toast('요청을 올렸습니다. PC 가 가져가면 번호가 붙습니다.');
          ctx.go('#/overview'); // 작업 목록은 저장된 필터 때문에 새 요청이 안 보일 수 있다
        } catch (err) {
          if (err && err.message) toast(err.message);
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('label', { class: 'field' }, h('span', null, '프로젝트'), project),
    h('datalist', { id: 'projectList' }, projects.map((p) => h('option', { value: p }))),
    h('label', { class: 'field' }, h('span', null, '제목 ', h('em', null, '선택')), title),
    h('label', { class: 'field' }, h('span', null, '요청 내용'), prompt),
    h('div', { class: 'form-foot' }, h('span', { class: 'muted small' }, '게시 API 토큰이 필요합니다 (이 페이지 메모리에만 보관) · Ctrl+Enter 로 등록'), submit),
  );

  const online = ctx.state.index.agents.filter((a) => ctx.online(a));
  const howto = h(
    'ol',
    { class: 'steps' },
    h('li', null, '요청이 이 앱의 ', h('code', null, 'app/data/inbox.json'), ' 에 올라갑니다.'),
    h('li', null, 'PC 의 Orchestrator 세션이 가져가 Claude Code 로 처리합니다.'),
    h('li', null, '진행 로그, 답변, 변경 diff 가 이 화면의 작업 목록에 표시됩니다.'),
  );

  root.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', null, '새 요청')),
    h(
      'div',
      { class: 'grid-form' },
      card(null, form),
      card(
        '처리 방식',
        h(
          'div',
          null,
          howto,
          h('p', { class: online.length ? 'ok-text' : 'warn-text' }, online.length ? `지금 연결된 PC: ${online.map((a) => a.name).join(', ')}` : '지금 연결된 PC 가 없습니다. 요청은 쌓였다가 PC 가 연결되면 처리됩니다.'),
        ),
      ),
    ),
  );
  if (!project.value) project.focus();
  else prompt.focus();
  return null;
}
