import { useMemo, useState } from "react";
import type { Actor, Command, LabState, Notice } from "../domain/types";
import { MAGNIFICATIONS } from "../domain/status";
import { Panel, StatusBadge, fmtDateTime, slideName } from "./shared";

type Run = (cmd: Command) => Notice[];

export function StudentView({ state, actor, run }: { state: LabState; actor: Actor; run: Run }) {
  const [slideId, setSlideId] = useState(state.slides[0].id);
  const [magnification, setMagnification] = useState("400x");
  const [structure, setStructure] = useState("");
  const [description, setDescription] = useState("");
  const [rawReading, setRawReading] = useState("");
  // 自检用：尝试替谁提交
  const others = state.users.filter((u) => u.role === "student" && u.userId !== actor.userId);
  const [ghostTarget, setGhostTarget] = useState(others[0]?.userId ?? "");

  const mine = useMemo(
    () =>
      state.observations
        .filter((o) => o.observerId === actor.userId)
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)),
    [state, actor.userId],
  );

  const reset = () => {
    setStructure("");
    setDescription("");
    setRawReading("");
  };

  const submit = (observerId: string) => {
    const reading = Number(rawReading);
    if (!structure.trim() || !description.trim() || !Number.isFinite(reading) || reading <= 0) {
      return [{ tone: "error" as const, text: "请填写观察结构、视野描述和大于 0 的原始读数" }];
    }
    const notices = run({
      type: "submitObservation",
      actor,
      data: { observerId, slideId, magnification, structure: structure.trim(), description: description.trim(), rawReading: reading },
      at: new Date().toISOString(),
    });
    if (notices.some((n) => n.tone === "ok")) reset();
    return notices;
  };

  const isStudent = actor.role === "student";

  return (
    <div className="view-grid">
      <Panel title="提交观察记录" sub="学生工作台 · 玻片观察">
        {!isStudent && (
          <div className="inline-note error">
            当前登录身份是“{actor.name}（{actor.role === "teacher" ? "教师" : "管理员"}）”。观察记录只允许学生本人提交，可点下方按钮自检越权代写拦截。
          </div>
        )}
        <div className="form-grid">
          <label className="field">
            <span>提交人（本人，不可代填）</span>
            <input className="input" value={`${actor.name}（${actor.userId}）`} disabled />
          </label>
          <label className="field">
            <span>玻片 / 样本</span>
            <select className="input" value={slideId} onChange={(e) => setSlideId(e.target.value)}>
              {state.slides.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.sampleType}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>放大倍数</span>
            <select className="input" value={magnification} onChange={(e) => setMagnification(e.target.value)}>
              {MAGNIFICATIONS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>原始读数（测微尺格数折算 μm）</span>
            <input className="input" inputMode="decimal" value={rawReading} onChange={(e) => setRawReading(e.target.value)} placeholder="如 7.2" />
          </label>
          <label className="field wide">
            <span>观察结构</span>
            <input className="input" value={structure} onChange={(e) => setStructure(e.target.value)} placeholder="如 细胞壁 / 细胞核" />
          </label>
          <label className="field wide">
            <span>视野描述</span>
            <textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="描述本视野内可见的结构与现象" />
          </label>
        </div>
        <div className="action-row">
          <button className="primary-action" onClick={() => submit(actor.userId)}>
            以本人身份提交
          </button>
          {isStudent && others.length > 0 && (
            <>
              <span className="hint">越权代写自检：尝试以</span>
              <select className="input small" value={ghostTarget} onChange={(e) => setGhostTarget(e.target.value)}>
                {others.map((u) => (
                  <option key={u.userId} value={u.userId}>
                    {u.name}
                  </option>
                ))}
              </select>
              <span className="hint">的身份提交（应被拒绝并留痕）</span>
              <button onClick={() => submit(ghostTarget)}>替 TA 提交（自检）</button>
            </>
          )}
        </div>
        <p className="hint">
          幂等规则：同一观察者 + 同一玻片 + 同一倍数 + 同一读数重复提交，不会生成第二条记录。提交时自动绑定玻片当前染色批次版本与标尺。
        </p>
      </Panel>

      <Panel title="我的观察记录" sub={`共 ${mine.length} 条 · 状态口径与待办、统计一致`}>
        <div className="card-list">
          {mine.length === 0 && <p className="hint">暂无记录。</p>}
          {mine.map((o) => {
            const winner = o.conflictWith ? state.observations.find((x) => x.id === o.conflictWith) : undefined;
            return (
              <article key={o.id} className={`obs-card status-${o.status}`}>
                <div className="obs-head">
                  <strong>
                    {slideName(state, o.slideId)} · {o.magnification}
                  </strong>
                  <StatusBadge status={o.status} />
                </div>
                <p className="obs-line">{o.structure}</p>
                <p className="obs-dim">{o.description}</p>
                <div className="obs-meta">
                  <span>编号 {o.id}</span>
                  <span>
                    批次 v{o.stainVersion ?? "—"} / 标尺 {o.scaleVersion ?? "—"}
                  </span>
                  <span>测量 {o.measurement}μm</span>
                  <span>提交 {fmtDateTime(o.submittedAt)}</span>
                </div>
                {o.status === "CONFLICT" && winner && (
                  <div className="inline-note error">
                    并发后到：先到结论 {winner.id}（{winner.observerName}，{fmtDateTime(winner.submittedAt)}）已生效；你的内容已保留在此对照。
                  </div>
                )}
                {(o.status === "REJECTED" || o.status === "INVALIDATED") && (
                  <div className="inline-note warn">
                    {o.status === "REJECTED" ? "教师已驳回" : "结论已失效（批次过期/标尺更新/复议发回）"}：请修改读数或描述后重新提交；重复内容仍会去重。
                    {o.reviewComment && <span> 意见：{o.reviewComment}</span>}
                  </div>
                )}
                {o.status === "RECONSIDER" && (
                  <div className="inline-note warn">教师正在对该已复核结论进行复议，原结论暂时保留。</div>
                )}
              </article>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
