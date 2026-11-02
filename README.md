# AgentHy1 — Claude 작업 브릿지 (프로토타입)

사내 웹앱에 **프로그램 수정 요청**을 올리면, 내 PC에서 돌고 있는 에이전트가 요청을 가져가
**Claude Code로 수정**하고, **결과 요약 + 변경 diff + 실행 로그**를 다시 웹앱으로 돌려주는 구조입니다.

```
 ┌──────────────── 사내 웹 서버 (JSP) ────────────────┐
 │  index.html + style.css   ←  요청자 브라우저        │
 │  api.jsp  (작업 큐, WEB-INF/bridge-data 에 저장)    │
 └───────────────▲──────────────────────┬─────────────┘
                 │ ① 10초마다 "새 작업 있어?"  │ ② 작업 전달
                 │ ④ 진행 로그 / 결과·diff 전송  ▼
 ┌──────────────── 내 PC ─────────────────────────────┐
 │  agent.js (Node.js)                                 │
 │   └─ ③ claude -p  (Claude Code, 프로젝트 폴더에서)   │
 └─────────────────────────────────────────────────────┘
```

- **PC → 서버 방향으로만 접속**합니다. PC에 포트를 열거나 방화벽을 바꿀 필요가 없습니다.
- 웹앱 파일은 `html / jsp / css` 3개, 합계 약 60KB 입니다 (30MB 제한과 무관).
- JSP는 외부 라이브러리 없이 Java 6 문법으로 작성해 오래된 Tomcat / JEUS / WebLogic 에서도 동작하도록 했습니다.

## 구성

| 경로 | 설명 |
|---|---|
| `webapp/index.html` | 요청 등록, 작업 목록, 진행 로그, 결과/diff 화면 (JS 포함) |
| `webapp/style.css` | 화면 스타일 (라이트/다크) |
| `webapp/api.jsp` | 작업 큐 API. 상단에 비밀번호/토큰 설정 |
| `agent/agent.js` | PC 에이전트 (Node.js 18+, 외부 패키지 없음) |
| `agent/agent.config.example.json` | 에이전트 설정 예시 |

## 1. 웹앱 올리기

1. `webapp/api.jsp` 맨 위 설정을 바꿉니다.
   ```java
   static final String UI_PASSWORD = "change-me-ui";     // 웹 화면 로그인 비밀번호
   static final String AGENT_TOKEN = "change-me-agent";  // PC 에이전트 토큰 (길고 무작위로)
   static final String DATA_DIR    = "";                 // 비우면 WEB-INF/bridge-data
   ```
2. `index.html`, `style.css`, `api.jsp` 세 파일을 같은 폴더에 올립니다. (예: `/claude-bridge/`)
3. 브라우저에서 `http://<서버>/claude-bridge/index.html` 접속 → 이름 + 비밀번호로 로그인.

> 작업 데이터는 `WEB-INF/bridge-data/` 아래 `.properties` 파일로 저장됩니다 (URL 로 직접 열람 불가).
> 웹앱을 재배포하면 이 폴더가 지워질 수 있으니, 유지하려면 `DATA_DIR` 에 배포 폴더 밖의 경로를 지정하세요.

## 2. 내 PC 에이전트 실행

준비물: **Node.js 18 이상**, **Claude Code 설치 및 로그인 완료** (`claude` 명령이 터미널에서 동작), 프로젝트는 **git 저장소** 권장.

```bash
cd agent
copy agent.config.example.json agent.config.json     # macOS/Linux: cp
# agent.config.json 수정 후
node agent.js
```

`agent.config.json`:

```jsonc
{
  "serverUrl": "http://intranet.example.co.kr/claude-bridge", // index.html 이 있는 폴더 URL
  "agentToken": "change-me-agent",          // api.jsp 의 AGENT_TOKEN 과 동일
  "agentName": "taehwan-pc",                // 웹 화면에 표시될 PC 이름
  "pollIntervalSec": 10,
  "fileEncoding": "utf-8",                  // 소스가 EUC-KR 이면 "euc-kr" (diff 표시용)
  "projects": {                             // 웹에서 고르는 프로젝트 이름 → 내 PC 폴더
    "sample-web": "C:/work/sample-web"
  },
  "claude": {
    "command": "claude",
    "permissionMode": "acceptEdits",        // 파일 수정은 자동 승인
    "allowedTools": ["Read", "Edit", "Write", "Glob", "Grep", "Bash(git status:*)", "Bash(git diff:*)"],
    "model": null,                          // 예: "sonnet", "opus"
    "maxBudgetUsd": 2,                      // 작업 1건당 비용 상한
    "timeoutMin": 30
  }
}
```

에이전트가 켜지면 웹 화면 상단에 `● taehwan-pc 대기 중` 으로 표시됩니다.
끌 때는 `Ctrl+C` — 실행 중인 작업이 있으면 Claude 를 중단하고 '실패'로 보고한 뒤 종료합니다.

## 3. 사용 흐름

1. 웹에서 **프로젝트 선택 → 요청 내용 입력 → 요청 등록**
2. PC 에이전트가 작업을 가져가 해당 폴더에서 `claude -p` 실행 → 웹에 **실시간 로그** 표시
3. 끝나면 **Claude 결과 요약, 변경 파일 목록, diff** 가 표시되고 `.patch` 로 내려받을 수 있음
4. 결과를 보고 **추가 지시**를 쓰면, Claude 가 같은 대화(세션)를 이어서 수정
5. 필요하면 **취소**(실행 중이면 PC의 Claude 프로세스를 종료) / **다시 실행**

에이전트는 **커밋/푸시를 하지 않습니다.** 변경은 PC 작업 폴더에 남아 있으니 검토 후 직접 커밋하세요.
diff 는 작업 시작 시점 스냅샷과 비교하므로, 원래 있던 미커밋 변경은 결과 diff 에 섞이지 않습니다.

## 보안 — 꼭 읽어 주세요

이 웹앱은 **"내 PC에서 코드를 수정하는 명령을 내리는 창구"** 입니다.

- `UI_PASSWORD`, `AGENT_TOKEN` 은 반드시 바꾸고, 토큰은 길고 무작위로 만드세요.
- 기본 허용 도구는 **파일 읽기/수정 + git status/diff** 뿐입니다. `Bash` 전체 허용(`"Bash"`)은 임의 명령 실행이 되므로 신중히 판단하세요.
  허용 안 된 도구를 Claude 가 쓰려 하면 결과 화면의 **"권한이 없어 실행하지 못한 도구"** 에 표시됩니다.
- `projects` 에 등록한 폴더에서만 실행됩니다. 중요한 폴더(홈 전체 등)는 등록하지 마세요.
- 다른 사내 페이지에서 몰래 요청을 보내는 CSRF 는 전용 헤더 검사로 막았지만, 로그인 시도 제한은 없습니다.
  가능하면 사내 SSO/접근 제어 뒤에 두세요.
- 요청 내용과 소스 일부가 Claude(Anthropic API)로 전송됩니다. 사내 보안 정책을 확인하세요.

## 제한 사항 (프로토타입)

- 저장소가 파일 기반이라 작업 수백 건 수준까지를 가정합니다. (목록은 최근 200건)
- 서버 POST 크기 제한(Tomcat 기본 2MB) 때문에 diff 는 40만 자, 결과는 10만 자에서 잘립니다.
- 추가 지시의 "대화 이어가기"는 같은 PC에서만 됩니다. 다른 PC면 이전 요청/결과를 붙여 새 세션으로 실행합니다.
- 에이전트 1대가 한 번에 1건씩 처리합니다. 여러 PC를 붙이면 프로젝트 이름 기준으로 나눠 가져갑니다.
- IE 는 지원하지 않습니다 (Chrome / Edge).

다음 단계로 생각해 볼 것: 작업별 git 브랜치 자동 생성, 승인 버튼 → 커밋/PR, 사내 메신저 알림, DB 저장소.

## 문제 해결

| 증상 | 확인 |
|---|---|
| 에이전트 `서버 연결 실패: 에이전트 토큰이 맞지 않습니다` | `agentToken` 과 `AGENT_TOKEN` 일치 여부 |
| 에이전트 `JSON 이 아닌 응답` | `serverUrl` 이 `api.jsp` 가 있는 폴더를 가리키는지, 사내 SSO 로그인 페이지로 리다이렉트되는지 |
| 사내 HTTPS 인증서 오류 | `set NODE_EXTRA_CA_CERTS=C:\path\company-ca.pem` 후 실행 |
| `Claude Code 를 실행하지 못했습니다` | 터미널에서 `claude --version` 동작 여부, 안 되면 `claude.command` 에 전체 경로 지정 |
| 한글 diff 가 깨짐 | 소스 인코딩이 EUC-KR 이면 `"fileEncoding": "euc-kr"` |
| 작업이 계속 "실행 중" | 에이전트를 다시 켜면 중단된 작업은 실패로 정리됨 → "다시 실행" |
