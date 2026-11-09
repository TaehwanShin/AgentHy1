# AgentHy1 — Claude 작업 브릿지 (프로토타입)

사내 **정적 호스팅**에 올린 대시보드 웹앱에서 **프로그램 수정 요청**을 올리면,
내 PC 의 **RAP Builder → General 탭 `Orchestrator` Claude Code 세션**이 처리하고,
**답변 · 변경 diff · 진행 로그**를 다시 웹앱으로 게시하는 구조입니다.

```
 ┌──────── 사내 정적 호스팅 (서버 로직 없음) ────────┐
 │ index.html + app/  ← 대시보드 (브라우저에서 동작)     │
 │ app/data/inbox.json      브라우저가 올린 요청         │
 │ app/data/tasks.json      PC 가 올린 작업 현황         │
 │ app/data/tasks/<번호>.json  작업 상세(답변·diff·로그) │
 └──────▲──────────────────────────┬──────────────────┘
        │ ③ 게시 API 로 결과 업로드     │ ① 요청을 게시 API 로 업로드 (브라우저)
        │                              │ ② 5초마다 inbox.json 확인 (PC)
 ┌──────┴──────── 내 PC: RAP Builder → General 탭 ─────────────────┐
 │ Claude Code 세션 "Orchestrator" + 훅 orchestrator-hook.js         │
 │  요청이 오면 쉬고 있던 세션을 깨워 처리 → 턴이 끝나면 결과 게시      │
 └──────────────────────────────────────────────────────────────────┘
```

- 서버 로직 · DB 없이 **정적 파일만** 씁니다. 데이터는 JSON 파일을 다시 올리는 방식으로 갱신합니다.
- **PC → 서버 방향으로만 접속**합니다. PC 에 포트를 열 필요가 없습니다.
- 외부 라이브러리 · CDN · 빌드 도구 없음 (vanilla JS + ES Modules, 차트는 인라인 SVG). 전체 약 70KB.
- Claude Code 의 **훅(hooks)만 사용**하므로 RAP Builder 코드를 바꾸지 않고, 사내 LLM(폐쇄망) 환경에서도 동작합니다.

## 구성

| 경로 | 설명 |
|---|---|
| `webapp/index.html` | 진입점 · 레이아웃 |
| `webapp/app/styles/main.css` | 화이트/블루 테마, 1920 · 1366px 대응 (최소 1024px) |
| `webapp/app/js/main.js` | 초기화 · 해시 라우팅 · 주기적 갱신 · 토큰 입력 |
| `webapp/app/js/data-loader.js` | JSON 읽기, 요청을 inbox.json 에 업로드 |
| `webapp/app/js/components/` | KPI 카드, SVG 막대 차트, 표 + CSV, 마크다운/diff |
| `webapp/app/js/views/` | 개요 · 작업 목록 · 작업 상세 · 새 요청 화면 |
| `deploy/deploy.js` | 게시 API 로 `webapp/` 을 올리는 스크립트 |
| `agent/orchestrator-hook.js` | Orchestrator 세션 연결 훅 |
| `agent/static-backend.js` | 정적 호스팅용 작업 저장소 (inbox 읽기 · 결과 게시) |
| `agent/agent.js` | 헤드리스 방식 (`claude -p` 직접 실행, Orchestrator 대신 쓸 때) |
| `agent/common.js` | 설정 · 서버 API · git diff 공용 |
| `webapp-jsp/` | JSP 를 실행하는 서버용 이전 버전 (참고) |

## 화면 (해시 라우팅)

| 주소 | 내용 |
|---|---|
| `#/overview` | KPI 6개 (전체 · 오늘 · 진행 중 · 완료 · 실패/취소 · 평균 처리 시간), 최근 14일 요청 차트, PC 상태, 최근 작업 |
| `#/detail` | 필터(상태 · 프로젝트 · 요청자 · 등록 기간 · 제목 검색) + 작업 표 + **CSV 내보내기**. 필터는 URL 해시와 localStorage 에 저장되어 다음에 열 때 복원 |
| `#/task/<번호>` | 요청 · Claude 답변 · 변경 파일 · diff · 실행 로그, 취소 / 다시 실행 / 추가 지시 / .patch 받기 |
| `#/new` | 새 요청 등록 |

## 1. 웹앱 올리기 (사내 PC, PowerShell)

```powershell
cd AgentHy1
$env:QUICK_API_BASE = "<가이드의 BASE_URL>"     # 업로드 API 주소
$env:QUICK_HOST     = "<가이드의 HOST>"         # 게시된 앱이 열리는 주소
$env:QUICK_TOKEN    = "<게시 API 토큰>"
node deploy\deploy.js                          # 앱 이름 claude-bridge (--app <이름> 으로 변경)
```

- `index.html` 로 앱을 만든 뒤 `app/` 아래 파일을 상대 경로 그대로 올리고, 게시 주소에서 모든 파일이 보이는지 확인합니다.
- `app/data/config.json` 에 업로드 API 주소와 앱 이름만 씁니다 (토큰은 넣지 않음).
- 작업 데이터(`tasks.json`, `inbox.json`)는 처음에만 만들고, 다시 올릴 때는 건드리지 않습니다.
- 끝나면 웹 주소와 `agent.config.json` 에 넣을 `static` 값을 출력합니다.
- 그 밖의 명령: `node deploy\deploy.js list`, `node deploy\deploy.js delete --app <이름> --yes`

## 2. 내 PC: Orchestrator 연결

준비물: **Node.js 18 이상**, **RAP Builder** 와 Claude Code (테스트한 버전 2.1.316), 프로젝트는 **git 저장소** 권장.

**① 설정** — `agent\agent.config.example.json` 을 `agent\agent.config.json` 으로 복사하고 수정합니다.

```jsonc
{
  "agentName": "taehwan-pc",
  "fileEncoding": "utf-8",                  // 소스가 EUC-KR 이면 "euc-kr" (diff 표시용)
  "projects": {                             // 웹에서 고르는 프로젝트 이름 → 작업 폴더 (diff 수집 기준)
    "general": "C:/Workspaces",
    "ZSD_ORDER": "C:/Workspaces/RAP_Project/ZSD_ORDER"
  },
  "static": {                               // deploy.js 가 출력한 값
    "apiBase": "...", "appName": "claude-bridge", "appUrl": "...",
    "token": "<게시 API 토큰>",              // 또는 환경 변수 QUICK_TOKEN
    "publishDiff": true                     // false 면 diff 는 게시하지 않고 PC 에만 남김
  },
  "orchestrator": { "sessionName": "Orchestrator", "pollIntervalSec": 5, "maxWaitHours": 23 }
}
```

**② 훅 설치** — RAP Builder 의 Claude 는 모두 `C:\Workspaces` 에서 시작하므로 그 폴더의 로컬 설정에 넣습니다.

```powershell
node agent\orchestrator-hook.js install C:\Workspaces\.claude\settings.local.json
```

기존 설정(RAP-Kit 훅, 권한 등)은 그대로 두고 훅만 추가합니다. 제거는 `uninstall <같은 경로>`.

**③ RAP Builder 에서 Orchestrator 세션 열기**

1. Workspaces 에서 **General** 선택 → 새 **Claude** 탭 → `/rename Orchestrator`
2. 아무 메시지나 한 번 보냅니다 (예: `웹 브릿지 요청 대기`). 이 턴이 끝나면 연결됩니다.
3. 웹 화면 오른쪽 위에 `● Orchestrator 대기 중` 이 보이면 완료입니다. 다음부터는 **Resume** 에서 `Orchestrator` 를 고르면 됩니다.

> 자리를 비울 때는 Orchestrator 탭에서 `Shift+Tab` 으로 **accept edits** 를 켜 두세요. 승인 대기 중이면 웹 로그에 `[알림]` 이 뜨고 PC 에서 승인할 때까지 멈춥니다.

## 3. 사용 흐름

1. 웹에서 **새 요청** → 처음 한 번 **요청자 이름과 게시 API 토큰** 입력 → 요청이 `inbox.json` 에 올라가고 `접수 대기` 로 표시됩니다.
2. 몇 초 안에 PC 가 가져가 번호를 붙이고(`대기` → `실행 중`), Orchestrator 탭에 `[웹 브릿지 요청 #N]` 이 들어와 Claude 가 작업합니다.
3. 턴이 끝나면 답변 · 변경 파일 · diff 가 게시되어 작업 상세에 표시됩니다 (웹은 5~15초마다 갱신).
4. **추가 지시**는 같은 Orchestrator 대화로 이어지고, **취소**하면 Claude 의 다음 도구 실행이 막혀 `취소됨` 으로 끝납니다.

Claude 는 커밋/푸시를 하지 않습니다. 변경은 PC 작업 폴더에 남으니 검토 후 직접 커밋하세요.

## 보안 — 꼭 읽어 주세요

- **토큰은 브라우저에 저장하지 않습니다.** 사내 정적 호스팅의 앱들은 같은 주소(origin)를 쓰므로 localStorage 에 넣으면 다른 앱이 읽을 수 있습니다.
  그래서 페이지 메모리에만 두고, 새로고침하면 다시 입력합니다.
- **요청은 게시 API 토큰을 가진 사람만** 올릴 수 있습니다. 웹 요청은 Orchestrator 세션의 권한 그대로 실행됩니다.
- **게시된 JSON 은 주소를 아는 사람 누구나 읽을 수 있습니다.** 요청 내용 · 답변 · diff(소스 일부)가 포함되니,
  민감한 프로젝트는 `"publishDiff": false` 로 diff 를 PC 에만 남기세요.
- 저장소(AgentHy1)는 공개 저장소이므로 사내 주소 · 토큰은 코드에 넣지 않고 환경 변수 / 로컬 설정으로만 받습니다.

## 제한 사항 (프로토타입)

- **브라우저에서 업로드 API 를 호출할 수 있어야(CORS 허용)** 웹에서 요청을 올릴 수 있습니다.
  막혀 있으면 "업로드 API 에 연결하지 못했습니다" 가 표시되며, 이때는 대시보드를 보기 전용으로 쓰고 요청은 Orchestrator 탭에 직접 입력하세요.
- 작업 기록의 원본은 PC 의 `agent\.bridge-data\` 입니다. **앱 하나에 PC 한 대만** 연결하고, 이 폴더는 지우지 마세요(지우면 번호가 1부터 다시 시작).
- 요청을 동시에 여러 탭에서 올리면 드물게 하나가 빠질 수 있습니다 (`inbox.json` 을 통째로 다시 쓰는 방식).
- Orchestrator 탭에 직접 입력하는 턴과 웹 요청이 겹치면 그 턴의 답변이 웹으로 갑니다. 웹 요청은 쉬고 있을 때만 가져갑니다.
- 게시 API 호출 수를 줄이려고 진행 로그는 5초, PC 상태는 1분 간격으로 올립니다.

## 다른 방식

- **헤드리스 (`node agent\agent.js`)**: Orchestrator 탭 없이 작업마다 `claude -p` 를 실행합니다. 같은 `static` 설정을 씁니다. Orchestrator 와 동시에 켜지 마세요.
- **JSP 서버 (`webapp-jsp/`)**: JSP 를 실행하는 서버가 있으면 `api.jsp` 백엔드를 쓸 수 있습니다. 이때 설정은 `static` 대신 `serverUrl`, `agentToken` 을 씁니다.

## 문제 해결

| 증상 | 확인 |
|---|---|
| 배포 중 `하위 폴더` / `Content-Type` 경고 | 게시 서버가 `app/` 하위 폴더나 `.js` 의 JavaScript 형식을 지원하지 않는 경우입니다. 출력 내용을 알려 주세요 |
| 배포 중 `HTTP 401` | `QUICK_TOKEN` 확인 |
| 웹에 Orchestrator 가 안 보임 | `node agent\orchestrator-hook.js status` 의 `sessionId` 확인, `agent\.orchestrator\hook.log` 의 게시 API 오류 확인 |
| 요청이 계속 `접수 대기` | PC 가 꺼져 있거나 Orchestrator 가 다른 일 / 승인 대기 중. 23시간 넘게 쉬었다면 Orchestrator 에 아무 메시지나 한 번 보내기 |
| 한글 diff 가 깨짐 | 소스 인코딩이 EUC-KR 이면 `"fileEncoding": "euc-kr"` |
