// 정적 JSON 읽기와, 새 요청·취소·다시 실행을 inbox.json 에 써서 올리기(게시 API).
// 데이터 파일은 PC 에이전트가 게시 API 로 다시 올려 갱신한다.

const DATA = 'app/data';

async function getJson(path, optional) {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404 && optional) return null;
  if (!res.ok) throw new Error(`${path} 를 불러오지 못했습니다 (HTTP ${res.status})`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${path} 의 형식이 올바르지 않습니다`);
  }
}

export async function loadConfig() {
  return (await getJson(`${DATA}/config.json`, true)) || {};
}

export async function loadIndex() {
  const d = (await getJson(`${DATA}/tasks.json`, true)) || {};
  return {
    generatedAt: d.generatedAt || null,
    agents: Array.isArray(d.agents) ? d.agents : [],
    seenInbox: Array.isArray(d.seenInbox) ? d.seenInbox : [],
    tasks: Array.isArray(d.tasks) ? d.tasks : [],
  };
}

export async function loadInbox() {
  const d = await getJson(`${DATA}/inbox.json`, true);
  return d && Array.isArray(d.entries) ? d.entries : [];
}

export const loadTask = (id) => getJson(`${DATA}/tasks/${Number(id)}.json`, true);

export function newEntryId() {
  const r = new Uint32Array(2);
  crypto.getRandomValues(r);
  return `r-${Date.now().toString(36)}-${r[0].toString(36)}${r[1].toString(36)}`;
}

// inbox.json 을 읽어 PC 가 이미 가져간 항목을 빼고, 새 항목을 붙여 게시 API 로 다시 올린다.
export async function pushInbox(config, token, entry, seenInbox) {
  if (!config.apiBase || !config.appName) throw new Error('app/data/config.json 이 없어 업로드할 곳을 모릅니다. 배포 스크립트로 다시 올려 주세요.');
  const seen = new Set(seenInbox);
  const entries = (await loadInbox()).filter((e) => e && !seen.has(e.id)).slice(-200);
  entries.push(entry);
  let res;
  try {
    res = await fetch(`${config.apiBase}/api/upload-file`, {
      method: 'POST',
      headers: { 'Authorization-HCP-GW': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_name: config.appName, file_name: `${DATA}/inbox.json`, content: JSON.stringify({ entries }) }),
    });
  } catch {
    throw new Error('업로드 API 에 연결하지 못했습니다. 이 브라우저에서 업로드 API 호출이 막혀 있을 수 있습니다(CORS). 이 경우 요청은 Orchestrator 탭에 직접 입력해 주세요.');
  }
  if (res.status === 401 || res.status === 403) throw new Error('토큰이 맞지 않거나 이 앱에 올릴 권한이 없습니다.');
  if (!res.ok) throw new Error(`업로드 실패 (HTTP ${res.status})`);
  return entries;
}
