import { useState } from "react";
import "./styles.css";
import { store, useStore } from "./store";
import { Dashboard } from "./components/Dashboard";
import { SubmitView } from "./components/SubmitView";
import { ReviewView } from "./components/ReviewView";
import { RecordsView } from "./components/RecordsView";
import { AdminView } from "./components/AdminView";
import { AuditView } from "./components/AuditView";

type Tab = "dashboard" | "submit" | "review" | "records" | "admin" | "audit";

const ROLE_LABEL: Record<string, string> = {
  student: "学生",
  teacher: "教师",
  admin: "管理员",
};

function App() {
  const { state, audits, currentUser, recovery } = useStore();
  const [tab, setTab] = useState<Tab>("dashboard");

  const tabs: { id: Tab; label: string; roles?: string[] }[] = [
    { id: "dashboard", label: "工作台" },
    { id: "submit", label: "学生提交", roles: ["student"] },
    { id: "review", label: "教师复核", roles: ["teacher", "admin"] },
    { id: "records", label: "记录明细" },
    { id: "admin", label: "批次与维护", roles: ["admin"] },
    { id: "audit", label: "操作留痕" },
  ];
  const visibleTabs = tabs.filter((t) => !t.roles || t.roles.includes(currentUser.role));
  const activeTab = visibleTabs.some((t) => t.id === tab) ? tab : "dashboard";

  const pendingVerify = state.observations.filter((o) => o.status === "pending_verify").length;
  const pendingReview = state.tasks.filter((t) => t.type === "review" && t.status === "open").length;
  const pendingReconsider = state.tasks.filter((t) => t.type === "reconsider" && t.status === "open").length;

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-06 · 可追溯显微观察流程</p>
          <h1>显微镜玻片观察</h1>
          <p className="subtitle">
            样本 → 染色批次版本/标尺 → 观察记录 → 复核任务 → 操作留痕的完整追溯链。
            先到生效、越权拒绝、批次变更级联失效与复议、检查点回滚、幂等去重全部内置。
          </p>
        </div>
        <div className="stack-card">
          <span>当前身份</span>
          <select
            className="role-switch"
            value={currentUser.id}
            onChange={(e) => {
              store.setCurrentUser(e.target.value);
              setTab("dashboard");
            }}
          >
            {state.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} · {ROLE_LABEL[u.role]}
                {u.className ? `（${u.className}）` : ""}
              </option>
            ))}
          </select>
          <span className="role-note">
            权限按身份生效：学生只能提交本人结论；教师按批次×倍数复核；管理员维护批次/标尺/导入。
          </span>
        </div>
      </section>

      <nav className="tab-bar">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            className={`tab-btn ${activeTab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "review" && currentUser.role === "teacher" && pendingReview > 0 ? (
              <i className="tab-count">{pendingReview}</i>
            ) : null}
            {t.id === "review" && currentUser.role === "teacher" && pendingReconsider > 0 ? (
              <i className="tab-count pink">{pendingReconsider} 复议</i>
            ) : null}
            {t.id === "admin" && pendingVerify > 0 ? (
              <i className="tab-count warn">{pendingVerify} 待核</i>
            ) : null}
          </button>
        ))}
      </nav>

      {recovery && activeTab !== "admin" ? (
        <div className="alert recovered global-recovery">
          <strong>已恢复：</strong>
          {recovery}
          <button className="link-btn" onClick={() => store.clearRecoveryNotice()}>
            知道了
          </button>
        </div>
      ) : null}

      {activeTab === "dashboard" ? <Dashboard state={state} currentUserId={currentUser.id} /> : null}
      {activeTab === "submit" ? <SubmitView state={state} currentUser={currentUser} /> : null}
      {activeTab === "review" ? <ReviewView state={state} currentUser={currentUser} /> : null}
      {activeTab === "records" ? <RecordsView state={state} /> : null}
      {activeTab === "admin" ? (
        <AdminView state={state} currentUser={currentUser} recovery={recovery} />
      ) : null}
      {activeTab === "audit" ? <AuditView audits={audits} /> : null}

      <footer className="app-footer">
        本地持久化：主存储 + 独立完整检查点（校验和信封）+ 只追加审计流。写入/导入失败自动从最近完整检查点回滚。
      </footer>
    </main>
  );
}

export default App;
