# AgentHy1 — Claude 작업 브릿지 (프로토타입)

사내 웹앱에 **프로그램 수정 요청**을 올리면, 내 PC의 **RAP Builder → General 탭의 `Orchestrator` Claude Code 세션**이
요청을 받아 수정하고, **답변 + 변경 diff + 진행 로그**를 다시 웹앱으로 돌려주는 구조입니다.

```
 ┌──────────────── 사내 웹 서버 (JSP) ────────────────┐
 │  index.html + style.css   ←  요청자 브라우저        │
 │  api.jsp  (작업 큐, WEB-INF/bridge-data 에 저장)    │
 └───────────────▲──────────────────────┬─────────────┘
                 │ ① 5초마다 "새 작업 있어?"   │ ② 작업 전달
                 │ ④ 진행 로그 / 답변·diff 전송  ▼
 ┌──────────────── 내 PC: RAP Builder → General 탭 ───────────────┐
 │  Claude Code 세션 "Orchestrator"  (C:\Workspaces 에서 실행)     │
 │   └─ 훅 orchestrator-hook.js                                    │
 │       ③ 요청이 오면 쉬고 있던 세션을 깨워 "[웹 브릿지 요청 #N]" 전달 │
 │       ④ 턴이 끝나면 마지막 답변과 git diff 를 서버로 전송          │
 └─────────────────────────────────────────────────────────────────┘
```

- **요청이 Orchestrator 대화에 그대로 들어옵니다.** RAP Builder 화면에서 Claude 가 일하는 과정을 직접 보고, 필요하면 끼어들 수 있습니다.
- **PC → 서버 방향으로만 접속**합니다. PC에 포트를 열 필요가 없습니다.
- Claude Code 의 **훅(hooks)만 사용**합니다. RAP Builder 코드는 바꾸지 않았고, claude.ai 로그인이 필요한 기능(channels)도 쓰지 않아
  **사내 LLM(폐쇄망) 환경에서도 동작**합니다.
- 웹앱 파일은 `html / jsp / css` 3개, 합계 약 60KB 입니다. JSP 는 외부 라이브러리 없이 Java 6 문법으로 작성했습니다.

## 구성

| 경로 | 설명 |
|---|---|
| `webapp/index.html` | 요청 등록, 작업 목록, 진행 로그, 결과/diff 화면 (JS 포함) |
| `webapp/style.css` | 화면 스타일 (라이트/다크) |
| `webapp/api.jsp` | 작업 큐 API. 상단에 비밀번호/토큰 설정 |
| `agent/orchestrator-hook.js` | **Orchestrator 세션 연결 훅** (기본 방식) |
| `agent/agent.js` | 헤드리스 방식: `claude -p` 를 직접 실행 (Orchestrator 를 쓰지 않을 때) |
| `agent/common.js` | 두 방식이 함께 쓰는 설정 / 서버 API / git diff |
| `agent/agent.config.example.json` | 설정 예시 |

## 1. 웹앱 올리기

1. `webapp/api.jsp` 맨 위 설정을 바꿉니다.
   ```java
   static final String UI_PASSWORD = "change-me-ui";     // 웹 화면 로그인 비밀번호
   static final String AGENT_TOKEN = "change-me-agent";  // PC 토큰 (길고 무작위로)
   static final String DATA_DIR    = "";                 // 비우면 WEB-INF/bridge-data
   ```
2. `index.html`, `style.css`, `api.jsp` 세 파일을 같은 폴더에 올립니다. (예: `/claude-bridge/`)
3. 브라우저에서 `http://<서버>/claude-bridge/index.html` 접속 → 이름 + 비밀번호로 로그인.

> 작업 데이터는 `WEB-INF/bridge-data/` 아래 `.properties` 파일로 저장됩니다 (URL 로 직접 열람 불가).
> 웹앱을 재배포하면 이 폴더가 지워질 수 있으니, 유지하려면 `DATA_DIR` 에 배포 폴더 밖의 경로를 지정하세요.

## 2. 내 PC: Orchestrator 세션 연결

준비물: **Node.js 18 이상**(`node` 가 PATH 에 있어야 함), **RAP Builder** 와 Claude Code(테스트한 버전 2.1.316), 프로젝트는 **git 저장소** 권장.

**① 설정 파일 만들기**

```powershell
cd agent
copy agent.config.example.json agent.config.json
# agent.config.json 수정
```

```jsonc
{
  "serverUrl": "http://intranet.example.co.kr/claude-bridge", // index.html 이 있는 폴더 URL
  "agentToken": "change-me-agent",          // api.jsp 의 AGENT_TOKEN 과 동일
  "agentName": "taehwan-pc",                // 헤드리스 방식에서 웹에 표시될 이름
  "fileEncoding": "utf-8",                  // 소스가 EUC-KR 이면 "euc-kr" (diff 표시용)
  "projects": {                             // 웹에서 고르는 프로젝트 이름 → 작업 폴더 (diff 수집 기준)
    "general": "C:/Workspaces",
    "ZSD_ORDER": "C:/Workspaces/RAP_Project/ZSD_ORDER"
  },
  "orchestrator": {
    "sessionName": "Orchestrator",          // 연결할 Claude 세션 이름 (웹에도 이 이름으로 표시)
    "pollIntervalSec": 5,                   // 쉬는 동안 서버 확인 간격
    "maxWaitHours": 23                      // 이 시간 동안 아무 일이 없으면 대기를 쉼 (아무 입력이나 하면 재개)
  }
}
```

**② 훅 설치** — RAP Builder 의 Claude 는 모두 `C:\Workspaces` 에서 시작하므로 그 폴더의 로컬 설정에 넣습니다.

```powershell
node orchestrator-hook.js install C:\Workspaces\.claude\settings.local.json
```

기존 `settings.local.json` 내용(권한 설정 등)은 그대로 두고 훅만 추가합니다(이전 파일은 `.bak` 로 보관).
다시 실행해도 중복되지 않으며, 제거는 `node orchestrator-hook.js uninstall <같은 경로>` 입니다.

**③ RAP Builder 에서 Orchestrator 세션 열기**

1. Workspaces 에서 **General** 을 선택 → 새 **Claude** 탭
2. Claude 입력창에 `/rename Orchestrator`
3. 아무 메시지나 한 번 보냅니다 (예: `웹 브릿지 요청 대기`). 이 턴이 끝나면 연결되고 웹 요청을 기다립니다.
4. 웹 화면 상단에 `● Orchestrator 대기 중` 이 보이면 완료입니다.

다음부터는 RAP Builder 의 **Resume** 에서 `Orchestrator` 를 선택하면 바로 연결됩니다.
이름이 다른 세션(프로그램 탭 등)에는 훅이 아무 일도 하지 않습니다.

> **권한 모드:** 웹 요청을 처리하다 파일 수정 승인을 기다리면, 웹 로그에 `[알림] ... permission` 이 뜨고 PC 에서 승인할 때까지 멈춥니다.
> 자리를 비울 때는 Orchestrator 탭에서 `Shift+Tab` 으로 **accept edits** 모드를 켜 두는 것을 권장합니다.

## 3. 사용 흐름

1. 웹에서 **프로젝트 선택 → 요청 내용 입력 → 요청 등록**
2. 몇 초 안에 Orchestrator 탭에 `[웹 브릿지 요청 #N] 제목` 이 들어오고 Claude 가 바로 작업을 시작합니다.
   웹에는 Claude 가 쓰는 도구(파일 읽기/수정 등)가 **실시간 로그**로 표시됩니다.
3. 그 턴이 끝나면 **Claude 의 마지막 답변, 변경 파일 목록, diff** 가 웹에 표시되고 `.patch` 로 내려받을 수 있습니다.
4. 결과를 보고 **추가 지시**를 쓰면 같은 Orchestrator 대화로 이어서 들어갑니다.
5. 실행 중 **취소**하면 Claude 의 다음 도구 실행이 막히고 "작업이 취소되었습니다" 로 끝납니다.

Claude 는 **커밋/푸시를 하지 않습니다.** 변경은 PC 작업 폴더에 남아 있으니 검토 후 직접 커밋하세요.
diff 는 요청을 받은 시점의 스냅샷과 비교하므로, 원래 있던 미커밋 변경은 결과 diff 에 섞이지 않습니다.

상태 확인: `node orchestrator-hook.js status` (연결된 세션, 진행 중인 작업, 대기 프로세스) · 로그: `agent\.orchestrator\hook.log`

## 다른 방식: 헤드리스 에이전트 (`agent.js`)

Orchestrator 탭을 열어 두지 않고 백그라운드에서 처리하고 싶을 때는 `node agent.js` 를 실행합니다.
작업마다 `claude -p` 를 새로 실행하며, 설정의 `claude` 항목(허용 도구, 권한 모드, 비용 상한, 제한 시간)을 따릅니다.
**두 방식을 같은 프로젝트에 동시에 켜지 마세요** — 먼저 가져가는 쪽이 작업을 처리합니다.

## 보안 — 꼭 읽어 주세요

이 웹앱은 **"내 PC의 Claude 에게 코드 수정을 지시하는 창구"** 입니다.

- `UI_PASSWORD`, `AGENT_TOKEN` 은 반드시 바꾸고, 토큰은 길고 무작위로 만드세요.
- 웹 요청은 Orchestrator 세션의 **권한 설정 그대로** 실행됩니다. 세션에서 Bash 전체 허용 등 넓은 권한을 주면 웹 요청도 그 권한을 갖습니다.
- 다른 사내 페이지에서 몰래 요청을 보내는 CSRF 는 전용 헤더 검사로 막았지만, 로그인 시도 제한은 없습니다.
  가능하면 사내 SSO/접근 제어 뒤에 두세요.
- 요청 내용과 소스 일부가 Claude 가 연결된 LLM 으로 전송됩니다. 사내 보안 정책을 확인하세요.

## 제한 사항 (프로토타입)

- Orchestrator 탭에 직접 입력하는 중에 웹 요청이 처리되면, 그 턴의 마지막 답변이 웹으로 갑니다. 웹 요청은 쉬고 있을 때만 가져갑니다.
- 훅은 `C:\Workspaces` 에서 시작한 모든 Claude 세션에서 도구 실행마다 잠깐(node 실행) 돌지만, Orchestrator 가 아니면 즉시 끝납니다.
- `/clear` 하면 새 세션이 되어 연결이 끊길 수 있습니다. 다시 `/rename Orchestrator` 후 메시지를 한 번 보내세요.
- Orchestrator 방식에서는 비용/턴 수가 웹에 표시되지 않습니다.
- 서버 POST 크기 제한(Tomcat 기본 2MB) 때문에 diff 는 40만 자, 결과는 10만 자에서 잘립니다.
- 저장소가 파일 기반이라 작업 수백 건 수준까지를 가정합니다. (목록은 최근 200건) IE 는 지원하지 않습니다.

## 문제 해결

| 증상 | 확인 |
|---|---|
| 웹에 Orchestrator 가 안 보임 | `node orchestrator-hook.js status` 의 `sessionId` 가 비어 있으면 세션 이름 확인(`/rename Orchestrator` 후 메시지 1회), `hook.log` 의 서버 오류 확인 |
| 요청이 계속 "대기" | Orchestrator 가 다른 일을 하는 중이거나 승인 대기 중인지 확인. 23시간 넘게 쉬었다면 아무 메시지나 한 번 보내기 |
| `에이전트 토큰이 맞지 않습니다` | `agentToken` 과 `AGENT_TOKEN` 일치 여부 |
| `JSON 이 아닌 응답` | `serverUrl` 이 `api.jsp` 가 있는 폴더를 가리키는지, 사내 SSO 로그인 페이지로 리다이렉트되는지 |
| 사내 HTTPS 인증서 오류 | 시스템 환경 변수 `NODE_EXTRA_CA_CERTS=C:\path\company-ca.pem` 설정 후 RAP Builder 재시작 |
| 한글 diff 가 깨짐 | 소스 인코딩이 EUC-KR 이면 `"fileEncoding": "euc-kr"` |
| 작업이 계속 "실행 중" | Orchestrator 세션을 다시 시작(Resume)하면 중단된 작업은 실패로 정리됨 → "다시 실행" |
