<%@ page contentType="application/json; charset=UTF-8" pageEncoding="UTF-8" trimDirectiveWhitespaces="true" session="false"
    import="java.io.*,java.util.*,java.text.SimpleDateFormat,java.security.MessageDigest" %><%!
/* ======================= 설정 (배포 전에 반드시 변경) ======================= */
static final String UI_PASSWORD = "change-me-ui";      // 웹 화면 로그인 비밀번호
static final String AGENT_TOKEN = "change-me-agent";   // PC 에이전트 토큰 (agent.config.json 의 agentToken 과 동일하게)
static final String DATA_DIR    = "";                  // 비우면 WEB-INF/bridge-data, 쓸 수 없으면 java.io.tmpdir/claude-bridge
static final int    ONLINE_SEC  = 60;                  // 이 시간 안에 신호가 있으면 에이전트 '온라인'
static final int    MAX_LOG     = 200000;              // 작업당 보관하는 실행 로그 최대 글자 수
/* ========================================================================== */

static final Object LOCK = new Object();
static final String[] LIST_FIELDS = {"project", "title", "status", "requester", "createdAt", "startedAt",
        "finishedAt", "agent", "parentId", "costUsd", "durationMs", "cancelRequested"};
static final String[] FULL_FIELDS = {"project", "title", "status", "requester", "createdAt", "startedAt",
        "finishedAt", "agent", "parentId", "costUsd", "durationMs", "cancelRequested",
        "prompt", "result", "diff", "files", "log", "sessionId", "numTurns", "denials"};
static final String[] RUN_FIELDS = {"agent", "startedAt", "finishedAt", "result", "diff", "files", "log",
        "sessionId", "costUsd", "durationMs", "numTurns", "denials", "cancelRequested"};

static class ApiError extends Exception {
    final int code;
    ApiError(int code, String msg) { super(msg); this.code = code; }
}

static String nz(String s) { return s == null ? "" : s.trim(); }

static String cut(String s, int max) { return s == null || s.length() <= max ? s : s.substring(0, max); }

static String now() { return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new Date()); }

static String q(String s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder(s.length() + 16).append('"');
    for (int i = 0; i < s.length(); i++) {
        char c = s.charAt(i);
        switch (c) {
            case '"': b.append("\\\""); break;
            case '\\': b.append("\\\\"); break;
            case '\n': b.append("\\n"); break;
            case '\r': b.append("\\r"); break;
            case '\t': b.append("\\t"); break;
            case '<': b.append("\\u003c"); break;
            default:
                if (c < 0x20 || c == ' ' || c == ' ') b.append(String.format("\\u%04x", (int) c));
                else b.append(c);
        }
    }
    return b.append('"').toString();
}

static boolean secretEquals(String given, String expected) {
    if (given == null) return false;
    try {
        return MessageDigest.isEqual(given.getBytes("UTF-8"), expected.getBytes("UTF-8"));
    } catch (UnsupportedEncodingException e) {
        return false;
    }
}

static File dataDir(ServletContext app) throws IOException {
    File d = null;
    if (DATA_DIR.length() > 0) d = new File(DATA_DIR);
    else {
        String webInf = app.getRealPath("/WEB-INF");
        if (webInf != null) d = new File(webInf, "bridge-data");
    }
    if (d == null || !(d.isDirectory() || d.mkdirs()) || !d.canWrite())
        d = new File(System.getProperty("java.io.tmpdir"), "claude-bridge");
    if (!d.isDirectory() && !d.mkdirs()) throw new IOException("데이터 폴더를 만들 수 없습니다: " + d);
    return d;
}

static Properties load(File f) throws IOException {
    Properties p = new Properties();
    if (!f.exists()) return p;
    Reader r = new InputStreamReader(new FileInputStream(f), "UTF-8");
    try { p.load(r); } finally { r.close(); }
    return p;
}

static void save(File f, Properties p) throws IOException {
    File tmp = new File(f.getPath() + ".tmp");
    Writer w = new OutputStreamWriter(new FileOutputStream(tmp), "UTF-8");
    try { p.store(w, null); } finally { w.close(); }
    if (f.exists() && !f.delete()) throw new IOException("파일을 교체할 수 없습니다: " + f);
    if (!tmp.renameTo(f)) throw new IOException("파일을 저장할 수 없습니다: " + f);
}

static File taskFile(File dir, int id) { return new File(dir, String.format("task-%06d.properties", id)); }

static Properties loadTask(File dir, String idParam) throws Exception {
    int id;
    try { id = Integer.parseInt(nz(idParam)); } catch (NumberFormatException e) { throw new ApiError(400, "잘못된 작업 번호"); }
    File f = taskFile(dir, id);
    if (!f.exists()) throw new ApiError(404, "작업 #" + id + " 이(가) 없습니다");
    return load(f);
}

static void saveTask(File dir, Properties t) throws IOException {
    save(taskFile(dir, Integer.parseInt(t.getProperty("id"))), t);
}

static List<Properties> allTasks(File dir) throws IOException {
    String[] names = dir.list();
    List<String> files = new ArrayList<String>();
    if (names != null) for (String n : names) if (n.matches("task-\\d+\\.properties")) files.add(n);
    Collections.sort(files);
    List<Properties> list = new ArrayList<Properties>();
    for (String n : files) list.add(load(new File(dir, n)));
    return list;
}

static int nextId(File dir) throws IOException {
    File f = new File(dir, "seq.properties");
    Properties p = load(f);
    int id = Integer.parseInt(p.getProperty("last", "0")) + 1;
    p.setProperty("last", String.valueOf(id));
    save(f, p);
    return id;
}

static String taskJson(Properties t, boolean full) {
    StringBuilder b = new StringBuilder("{\"id\":").append(t.getProperty("id"));
    for (String k : full ? FULL_FIELDS : LIST_FIELDS) b.append(",\"").append(k).append("\":").append(q(t.getProperty(k)));
    return b.append('}').toString();
}

static void heartbeat(File dir, String agent, String projects, String busy) throws IOException {
    File f = new File(dir, "agents.properties");
    Properties p = load(f);
    p.setProperty("lastSeen." + agent, String.valueOf(System.currentTimeMillis()));
    if (projects != null) p.setProperty("projects." + agent, projects);
    if (busy != null) p.setProperty("busy." + agent, busy);
    save(f, p);
}

static String agentsJson(File dir) throws IOException {
    Properties p = load(new File(dir, "agents.properties"));
    List<String> names = new ArrayList<String>();
    for (String k : p.stringPropertyNames()) if (k.startsWith("lastSeen.")) names.add(k.substring(9));
    Collections.sort(names);
    long nowMs = System.currentTimeMillis();
    StringBuilder b = new StringBuilder("[");
    for (String n : names) {
        long seen = Long.parseLong(p.getProperty("lastSeen." + n, "0"));
        if (b.length() > 1) b.append(',');
        b.append("{\"name\":").append(q(n))
         .append(",\"lastSeen\":").append(seen)
         .append(",\"online\":").append(nowMs - seen < ONLINE_SEC * 1000L)
         .append(",\"projects\":").append(q(p.getProperty("projects." + n, "")))
         .append(",\"busy\":").append(q(p.getProperty("busy." + n, "")))
         .append('}');
    }
    return b.append(']').toString();
}

static String agentName(HttpServletRequest req) throws ApiError {
    String a = cut(nz(req.getParameter("agent")).replaceAll("[\\p{Cntrl}]", ""), 40);
    if (a.length() == 0) throw new ApiError(400, "agent 이름이 필요합니다");
    return a;
}

static Set<String> csv(String s) {
    Set<String> set = new LinkedHashSet<String>();
    for (String x : nz(s).split(",")) if (nz(x).length() > 0) set.add(nz(x));
    return set;
}

static void clearRun(Properties t) { for (String k : RUN_FIELDS) t.remove(k); }

String handle(String action, HttpServletRequest req, ServletContext app) throws Exception {
    File dir = dataDir(app);
    boolean post = "POST".equalsIgnoreCase(req.getMethod());
    HttpSession session = req.getSession(false);
    String user = session == null ? null : (String) session.getAttribute("bridgeUser");

    /* ---------- 웹 화면용 ---------- */
    if ("status".equals(action)) {
        if (user == null) return "{\"user\":null}";
        return "{\"user\":" + q(user) + ",\"serverTime\":" + System.currentTimeMillis() + ",\"agents\":" + agentsJson(dir) + "}";
    }
    if ("login".equals(action)) {
        if (!post) throw new ApiError(405, "POST 만 허용됩니다");
        String name = cut(nz(req.getParameter("name")).replaceAll("[\\p{Cntrl}]", ""), 30);
        if (name.length() == 0) throw new ApiError(400, "이름을 입력하세요");
        if (!secretEquals(req.getParameter("password"), UI_PASSWORD)) throw new ApiError(401, "비밀번호가 맞지 않습니다");
        if (session != null) session.invalidate();
        req.getSession(true).setAttribute("bridgeUser", name);
        return "{\"user\":" + q(name) + "}";
    }
    if ("logout".equals(action)) {
        if (session != null) session.invalidate();
        return "{\"ok\":true}";
    }

    boolean uiAction = "list".equals(action) || "get".equals(action) || "create".equals(action)
            || "retry".equals(action) || "cancel".equals(action);
    if (uiAction) {
        if (user == null) throw new ApiError(401, "로그인이 필요합니다");
        // 다른 사내 페이지에서 폼을 몰래 전송하는 CSRF 차단: 브라우저는 교차 출처 요청에 이 헤더를 붙일 수 없다
        if (post && !"1".equals(req.getHeader("X-Bridge-UI"))) throw new ApiError(403, "허용되지 않은 요청");
        if (!post && !"list".equals(action) && !"get".equals(action)) throw new ApiError(405, "POST 만 허용됩니다");

        if ("list".equals(action)) {
            List<Properties> tasks = allTasks(dir);
            StringBuilder b = new StringBuilder("{\"tasks\":[");
            for (int i = tasks.size() - 1, n = 0; i >= 0 && n < 200; i--, n++) {
                if (n > 0) b.append(',');
                b.append(taskJson(tasks.get(i), false));
            }
            return b.append("]}").toString();
        }
        if ("get".equals(action)) return "{\"task\":" + taskJson(loadTask(dir, req.getParameter("id")), true) + "}";

        if ("create".equals(action)) {
            String project = cut(nz(req.getParameter("project")), 60);
            String prompt = cut(nz(req.getParameter("prompt")), 50000);
            String title = cut(nz(req.getParameter("title")), 100);
            String parentId = nz(req.getParameter("parentId"));
            if (project.length() == 0) throw new ApiError(400, "프로젝트를 입력하세요");
            if (prompt.length() == 0) throw new ApiError(400, "요청 내용을 입력하세요");
            if (parentId.length() > 0) {
                Properties parent = loadTask(dir, parentId);
                project = parent.getProperty("project");
                if (title.length() == 0) title = "#" + parentId + " 추가 지시";
            }
            if (title.length() == 0) title = cut(prompt.split("\n")[0], 60);
            Properties t = new Properties();
            t.setProperty("id", String.valueOf(nextId(dir)));
            t.setProperty("project", project);
            t.setProperty("title", title);
            t.setProperty("prompt", prompt);
            t.setProperty("status", "pending");
            t.setProperty("requester", user);
            t.setProperty("createdAt", now());
            if (parentId.length() > 0) t.setProperty("parentId", parentId);
            saveTask(dir, t);
            return "{\"task\":" + taskJson(t, true) + "}";
        }

        Properties t = loadTask(dir, req.getParameter("id"));
        String st = t.getProperty("status");
        if ("retry".equals(action)) {
            if ("pending".equals(st) || "running".equals(st)) throw new ApiError(409, "대기/실행 중인 작업은 재시도할 수 없습니다");
            clearRun(t);
            t.setProperty("status", "pending");
            t.setProperty("createdAt", now());
        } else { // cancel
            if ("pending".equals(st)) {
                t.setProperty("status", "canceled");
                t.setProperty("finishedAt", now());
            } else if ("running".equals(st)) {
                if ("1".equals(t.getProperty("cancelRequested"))) { // 두 번째 취소: 에이전트 응답이 없으면 강제 종료 처리
                    t.setProperty("status", "canceled");
                    t.setProperty("finishedAt", now());
                } else t.setProperty("cancelRequested", "1");
            } else throw new ApiError(409, "이미 끝난 작업입니다");
        }
        saveTask(dir, t);
        return "{\"task\":" + taskJson(t, true) + "}";
    }

    /* ---------- PC 에이전트용 ---------- */
    if (!secretEquals(req.getHeader("X-Agent-Token"), AGENT_TOKEN)) throw new ApiError(401, "에이전트 토큰이 맞지 않습니다");
    if (!post) throw new ApiError(405, "POST 만 허용됩니다");

    if ("hello".equals(action)) {
        String agent = agentName(req);
        int orphaned = 0;
        for (Properties t : allTasks(dir)) {
            if ("running".equals(t.getProperty("status")) && agent.equals(t.getProperty("agent"))) {
                t.setProperty("status", "error");
                t.setProperty("result", "에이전트가 재시작되어 작업이 중단되었습니다. 재시도하세요.");
                t.setProperty("finishedAt", now());
                saveTask(dir, t);
                orphaned++;
            }
        }
        heartbeat(dir, agent, nz(req.getParameter("projects")), "");
        return "{\"ok\":true,\"orphaned\":" + orphaned + "}";
    }
    if ("claim".equals(action)) {
        String agent = agentName(req);
        Set<String> projects = csv(req.getParameter("projects"));
        for (Properties t : allTasks(dir)) {
            if (!"pending".equals(t.getProperty("status"))) continue;
            if (!projects.isEmpty() && !projects.contains(t.getProperty("project"))) continue;
            t.setProperty("status", "running");
            t.setProperty("agent", agent);
            t.setProperty("startedAt", now());
            saveTask(dir, t);
            heartbeat(dir, agent, nz(req.getParameter("projects")), t.getProperty("id"));
            StringBuilder b = new StringBuilder(taskJson(t, true));
            String parentId = t.getProperty("parentId");
            if (parentId != null) {
                File pf = taskFile(dir, Integer.parseInt(parentId));
                if (pf.exists()) {
                    Properties parent = load(pf);
                    b.setLength(b.length() - 1);
                    b.append(",\"resumeSessionId\":").append(q(parent.getProperty("sessionId")))
                     .append(",\"parentPrompt\":").append(q(cut(parent.getProperty("prompt"), 4000)))
                     .append(",\"parentResult\":").append(q(cut(parent.getProperty("result"), 4000)))
                     .append('}');
                }
            }
            return "{\"task\":" + b + "}";
        }
        heartbeat(dir, agent, nz(req.getParameter("projects")), "");
        return "{\"task\":null}";
    }
    if ("progress".equals(action)) {
        Properties t = loadTask(dir, req.getParameter("id"));
        String add = req.getParameter("log");
        if (add != null && add.length() > 0) {
            String log = t.getProperty("log", "");
            log = log.length() == 0 ? add : log + "\n" + add;
            if (log.length() > MAX_LOG) log = log.substring(log.length() - MAX_LOG);
            t.setProperty("log", log);
            saveTask(dir, t);
        }
        if (t.getProperty("agent") != null) heartbeat(dir, t.getProperty("agent"), null, t.getProperty("id"));
        boolean canceled = "1".equals(t.getProperty("cancelRequested")) || "canceled".equals(t.getProperty("status"));
        return "{\"canceled\":" + canceled + "}";
    }
    if ("complete".equals(action)) {
        Properties t = loadTask(dir, req.getParameter("id"));
        String status = nz(req.getParameter("status"));
        if (!"done".equals(status) && !"error".equals(status) && !"canceled".equals(status)) status = "error";
        if ("1".equals(t.getProperty("cancelRequested")) || "canceled".equals(t.getProperty("status"))) status = "canceled";
        t.setProperty("status", status);
        t.setProperty("finishedAt", now());
        String[] keys = {"result", "diff", "files", "sessionId", "costUsd", "durationMs", "numTurns", "denials"};
        for (String k : keys) {
            String v = req.getParameter(k);
            if (v != null && v.length() > 0) t.setProperty(k, v); else t.remove(k);
        }
        saveTask(dir, t);
        if (t.getProperty("agent") != null) heartbeat(dir, t.getProperty("agent"), null, "");
        return "{\"ok\":true}";
    }
    throw new ApiError(400, "알 수 없는 action: " + action);
}
%><%
request.setCharacterEncoding("UTF-8");
response.setHeader("Cache-Control", "no-store");
String body;
try {
    synchronized (LOCK) {
        body = handle(nz(request.getParameter("action")), request, application);
    }
} catch (ApiError e) {
    response.setStatus(e.code);
    body = "{\"error\":" + q(e.getMessage()) + "}";
} catch (Exception e) {
    response.setStatus(500);
    body = "{\"error\":" + q("서버 오류: " + e) + "}";
}
out.print(body);
%>
