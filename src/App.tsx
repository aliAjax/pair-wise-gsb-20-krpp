import { useEffect, useState } from "react";
import "./styles.css";
import { useLab } from "./domain/useStore";
import type { Actor, Notice, Role } from "./domain/types";
import { STATUS_META } from "./domain/status";
import { StudentView } from "./ui/StudentView";
import { TeacherView } from "./ui/TeacherView";
import { AdminView } from "./ui/AdminView";
import { RecordsView } from "./ui/RecordsView";

const ROLE_LABEL: Record<Role, string> = { student: "学生", teacher: "教师", admin: "管理员" };
type Tab = "student" | "teacher" | "admin" | "records";

function App() {
  const { state, dispatch } = useLab();
  const [actorId, setActorId] = useState("s01");
  const [tab, setTab] = useState<Tab>("student");
  const [toasts, setToasts] = useState<Notice[]>([]);

  const actor: Actor = state.users.find((u) => u.userId === actorId) ?? state.users[0];

  const push = (list: Notice[]) => {
    if (!list?.length) return;
    setToasts((t) => [...t, ...list]);
  };
  const run = (cmd: Parameters<typeof dispatch>[0]) => {
    const result = dispatch(cmd);
    push(result.notices);
    return result.notices;
  };

  // 管理员面板里“重新载入恢复”按钮绕过 dispatch，经全局事件回传提示
  useEffect(() => {
    const handler = (e: Event) => push([(e as CustomEvent<Notice>).detail]);
    window.addEventListener("hxwl06-notice", handler);
    return () => window.removeEventListener("hxwl06-notice", handler);
  }, []);

  useEffect(() => {
    if (!toasts.length) return;
    const timer = setTimeout(() => setToasts((t) => t.slice(1)), 5200);
    return () => clearTimeout(timer);
  }, [toasts]);

  const todoCounts = {
    verify: state.observations.filter((o) => o.status === "PENDING_VERIFY").length,
    review: state.observations.filter((o) => o.status === "PENDING_REVIEW").length,
    conflict: state.observations.filter((o) => o.status === "CONFLICT").length,
    reconsider: state.observations.filter((o) => o.status === "RECONSIDER").length,
    invalidated: state.observations.filter((o) => o.status === "INVALIDATED").length,
  };

  const tabs: { id: Tab; label: string; roles: Role[]; badge?: number }[] = [
    { id: "student", label: "学生工作台", roles: ["student", "teacher", "admin"] },
    { id: "teacher", label: "教师复核", roles: ["student", "teacher", "admin"], badge: todoCounts.review + todoCounts.reconsider + todoCounts.conflict },
    { id: "admin", label: "管理员维护", roles: ["admin", "teacher", "student"], badge: todoCounts.verify },
    { id: "records", label: "明细 / 统计 / 留痕", roles: ["student", "teacher", "admin"] },
  ];

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-06 · 显微镜玻片观察 · 可追溯流程</p>
          <h1>样本 · 观察 · 复核 · 留痕</h1>
          <p className="subtitle">
            学生本人提交（越权代写拒绝并留痕）→ 教师按染色批次版本×放大倍数复核并冻结依据 →
            管理员调整有效期/标尺后未复核结论立即失效重算、已复核结论保留依据并复议；同玻片先到生效、后到冲突保留；
            写入失败按最近完整检查点恢复；缺批次版本的旧数据统一“待核”。
          </p>
        </div>
        <div className="stack-card">
          <span>当前身份（可切换演示权限）</span>
          <select className="input" value={actorId} onChange={(e) => setActorId(e.target.value)}>
            {state.users.map((u) => (
              <option key={u.userId} value={u.userId}>
                {ROLE_LABEL[u.role]} · {u.name}（{u.userId}）
              </option>
            ))}
          </select>
          <div className="todo-strip">
            <span className="todo"><b>{todoCounts.verify}</b> 待核</span>
            <span className="todo"><b>{todoCounts.review}</b> 待复核</span>
            <span className="todo"><b>{todoCounts.conflict}</b> 冲突</span>
            <span className="todo"><b>{todoCounts.reconsider}</b> 待复议</span>
            <span className="todo"><b>{todoCounts.invalidated}</b> 已失效</span>
          </div>
        </div>
      </section>

      <nav className="tabbar">
        {tabs.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
            {t.badge ? <i className="tab-badge">{t.badge}</i> : null}
          </button>
        ))}
      </nav>

      <section className="legend">
        {Object.values(STATUS_META).map((m) => (
          <span key={m.label} className={`legend-item tone-${m.tone}`} title={m.desc}>{m.label}</span>
        ))}
      </section>

      {tab === "student" && <StudentView state={state} actor={actor} run={run} />}
      {tab === "teacher" && <TeacherView state={state} actor={actor} run={run} />}
      {tab === "admin" && <AdminView state={state} actor={actor} run={run} />}
      {tab === "records" && <RecordsView state={state} />}

      <div className="toast-stack">
        {toasts.map((n, i) => (
          <div key={i} className={`toast ${n.tone}`} onClick={() => setToasts((t) => t.filter((_, idx) => idx !== i))}>
            {n.text}
          </div>
        ))}
      </div>
    </main>
  );
}

export default App;
