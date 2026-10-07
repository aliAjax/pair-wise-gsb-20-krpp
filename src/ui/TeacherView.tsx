import { useMemo, useState } from "react";
import type { Actor, Command, LabState, Notice, Observation } from "../domain/types";
import { batchOf, reviewGroupKey } from "../domain/status";
import { Panel, StatusBadge, batchLabel, fmtDateTime, slideName } from "./shared";

type Run = (cmd: Command) => Notice[];

export function TeacherView({ state, actor, run }: { state: LabState; actor: Actor; run: Run }) {
  const [comment, setComment] = useState<Record<string, string>>({});

  const groups = useMemo(() => {
    const map = new Map<string, Observation[]>();
    for (const o of state.observations.filter((o) => o.status === "PENDING_REVIEW")) {
      const key = reviewGroupKey(o);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(o);
    }
    return [...map.entries()].sort(([a], [a2]) => a.localeCompare(a2));
  }, [state]);

  const reconsider = state.observations.filter((o) => o.status === "RECONSIDER");
  const conflicts = state.observations.filter((o) => o.status === "CONFLICT");

  const review = (id: string, decision: "APPROVE" | "REJECT") =>
    run({ type: "reviewObservation", actor, observationId: id, decision, comment: comment[id] || undefined, at: new Date().toISOString() });

  if (actor.role !== "teacher") {
    return <Panel title="教师复核工作台" sub="权限提示"><div className="inline-note error">当前身份不是教师，复核任务不可执行（服务端按角色拦截，此处仅展示）。</div></Panel>;
  }

  return (
    <div className="view-grid">
      <Panel title="复核队列" sub="按染色批次（版本） × 放大倍数分组">
        {groups.length === 0 && <p className="hint">队列为空：没有待复核记录（待核旧数据不会出现在这里）。</p>}
        {groups.map(([key, items]) => {
          const first = items[0];
          const batch = batchOf(state, first.stainBatchId);
          const today = new Date().toISOString().slice(0, 10);
          const valid = batch && batch.status === "ACTIVE" && today >= batch.validFrom && today <= batch.validUntil;
          return (
            <article key={key} className="review-group">
              <div className="group-head">
                <div>
                  <strong>
                    {batchLabel(batch)} · {first.magnification}
                  </strong>
                  <span className={`validity ${valid ? "ok" : "bad"}`}>{valid ? "依据当前有效" : "批次失效中（禁止复核）"}</span>
                </div>
                <button
                  className="primary-action"
                  disabled={!valid}
                  onClick={() =>
                    run({
                      type: "batchReview",
                      actor,
                      batchId: first.stainBatchId,
                      stainVersion: first.stainVersion!,
                      magnification: first.magnification,
                      decision: "APPROVE",
                      at: new Date().toISOString(),
                    })
                  }
                >
                  整组通过（{items.length}）
                </button>
              </div>
              <div className="card-list compact">
                {items.map((o) => (
                  <article key={o.id} className="obs-card pending">
                    <div className="obs-head">
                      <strong>
                        {slideName(state, o.slideId)} · {o.observerName}
                      </strong>
                      <span className="obs-id">{o.id}</span>
                    </div>
                    <p className="obs-line">{o.structure}</p>
                    <p className="obs-dim">{o.description}</p>
                    <div className="obs-meta">
                      <span>测量 {o.measurement}μm</span>
                      <span>标尺 {o.scaleVersion}</span>
                      <span>提交 {fmtDateTime(o.submittedAt)}</span>
                    </div>
                    {o.recomputeHistory.length > 0 && (
                      <div className="inline-note info">
                        标尺更新后已自动重算：{o.recomputeHistory[o.recomputeHistory.length - 1].fromMeasurement}→
                        {o.recomputeHistory[o.recomputeHistory.length - 1].toMeasurement}μm（
                        {o.recomputeHistory[o.recomputeHistory.length - 1].toScaleVersion}），请按新值复核。
                      </div>
                    )}
                    <div className="action-row">
                      <input
                        className="input grow"
                        placeholder="复核意见（可选）"
                        value={comment[o.id] ?? ""}
                        onChange={(e) => setComment((c) => ({ ...c, [o.id]: e.target.value }))}
                      />
                      <button className="primary-action" onClick={() => review(o.id, "APPROVE")}>通过</button>
                      <button className="danger" onClick={() => review(o.id, "REJECT")}>驳回</button>
                    </div>
                  </article>
                ))}
              </div>
            </article>
          );
        })}
      </Panel>

      <Panel title="复议项" sub={`已复核结论依据变更 · ${reconsider.length} 项`}>
        <div className="card-list">
          {reconsider.length === 0 && <p className="hint">没有待裁决的复议项。已复核结论在批次调整后保留当时依据并在此列出。</p>}
          {reconsider.map((o) => {
            const rc = o.reconsideration!;
            return (
              <article key={o.id} className="obs-card reconsider">
                <div className="obs-head">
                  <strong>
                    {slideName(state, o.slideId)} · {o.magnification} · {o.observerName}
                  </strong>
                  <StatusBadge status={o.status} />
                </div>
                <div className="basis-grid">
                  <div>
                    <span className="caption">原结论（保留）</span>
                    <p>{o.structure}；{o.measurement}μm</p>
                  </div>
                  <div>
                    <span className="caption">复核当时依据（冻结快照）</span>
                    <p>
                      v{o.basisSnapshot?.stainVersion} / {o.basisSnapshot?.scaleVersion} / 有效期 {o.basisSnapshot?.validFrom}~{o.basisSnapshot?.validUntil}
                    </p>
                  </div>
                </div>
                <div className="inline-note warn">
                  {rc.kind}变更（v{rc.fromVersion} → v{rc.toVersion}）：{rc.detail}
                </div>
                <div className="action-row">
                  <button className="primary-action" onClick={() => run({ type: "resolveReconsideration", actor, observationId: o.id, resolution: "UPHELD", at: new Date().toISOString() })}>
                    维持原结论
                  </button>
                  <button className="danger" onClick={() => run({ type: "resolveReconsideration", actor, observationId: o.id, resolution: "RETURNED", at: new Date().toISOString() })}>
                    发回学生重做
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </Panel>

      <Panel title="并发冲突对照" sub={`同一玻片后到内容 · ${conflicts.length} 条`}>
        <div className="card-list">
          {conflicts.length === 0 && <p className="hint">暂无冲突记录。</p>}
          {conflicts.map((o) => {
            const winner = state.observations.find((x) => x.id === o.conflictWith);
            return (
              <article key={o.id} className="conflict-grid">
                <div className="obs-card winner">
                  <div className="obs-head"><strong>先到 · 已生效</strong><StatusBadge status={winner?.status ?? "PENDING_REVIEW"} /></div>
                  <p className="obs-line">{winner ? `${slideName(state, winner.slideId)} · ${winner.magnification} · ${winner.observerName}` : "—"}</p>
                  {winner && <>
                    <p className="obs-dim">{winner.description}</p>
                    <div className="obs-meta"><span>{winner.id}</span><span>{fmtDateTime(winner.submittedAt)}</span></div>
                  </>}
                </div>
                <div className="obs-card loser">
                  <div className="obs-head"><strong>后到 · 保留冲突</strong><StatusBadge status="CONFLICT" /></div>
                  <p className="obs-line">{slideName(state, o.slideId)} · {o.magnification} · {o.observerName}</p>
                  <p className="obs-dim">{o.description}</p>
                  <div className="obs-meta"><span>{o.id}</span><span>{fmtDateTime(o.submittedAt)}</span></div>
                </div>
              </article>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
