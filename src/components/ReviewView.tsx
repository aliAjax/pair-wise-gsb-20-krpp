import { useState } from "react";
import type { AppState, ReviewTask, User } from "../types";
import {
  STATUS_META,
  fmtTime,
  openReconsiderTasks,
  openReviewGroups,
} from "../domain";
import { store } from "../store";
import { Empty, Panel, Toast } from "./ui";
import { ObservationCard, slideName, userName } from "./ObservationCard";

export function ReviewView({ state, currentUser }: { state: AppState; currentUser: User }) {
  const groups = openReviewGroups(state);
  const reconsider = openReconsiderTasks(state);
  const [batchFilter, setBatchFilter] = useState<string>("");
  const [magFilter, setMagFilter] = useState<string>("");
  const [comment, setComment] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "err" | "info" } | null>(null);

  const batches = [...new Set(groups.map((g) => g.batchId))];
  const filtered = groups
    .filter((g) => !batchFilter || g.batchId === batchFilter)
    .filter((g) => !magFilter || String(g.magnification) === magFilter);

  function show(message: string, ok = true) {
    setToast({ text: message, tone: ok ? "ok" : "err" });
    window.setTimeout(() => setToast(null), 4200);
  }

  if (currentUser.role !== "teacher") {
    return (
      <Panel title="复核平台" sub="教师入口">
        <div className="alert danger">当前身份无教师复核权限，请切换到教师身份。</div>
      </Panel>
    );
  }

  const decide = (task: ReviewTask, decision: "approved" | "rejected") => {
    const result = store.review(task.id, decision, comment[task.id] ?? "");
    show(result.message, result.ok);
  };

  return (
    <div className="view-stack">
      {toast ? <Toast text={toast.text} tone={toast.tone} onClose={() => setToast(null)} /> : null}

      <Panel
        title="复核任务分组"
        sub="按染色批次 × 放大倍数"
        actions={
          <div className="filter-row">
            <select value={batchFilter} onChange={(e) => setBatchFilter(e.target.value)}>
              <option value="">全部批次</option>
              {batches.map((id) => (
                <option key={id} value={id}>
                  {state.batches.find((b) => b.id === id)?.name ?? id}
                </option>
              ))}
            </select>
            <select value={magFilter} onChange={(e) => setMagFilter(e.target.value)}>
              <option value="">全部倍数</option>
              {[100, 200, 400, 1000].map((m) => (
                <option key={m} value={m}>
                  {m}x
                </option>
              ))}
            </select>
          </div>
        }
      >
        {filtered.length === 0 ? (
          <Empty text="当前筛选下没有待复核任务" />
        ) : (
          <div className="group-stack">
            {filtered.map((g) => (
              <details key={g.groupKey} open className="review-group">
                <summary>
                  <span className="group-title">{g.batchName}</span>
                  <span className="group-mag">{g.magnification}x</span>
                  <span className="group-count">{g.tasks.length} 条</span>
                  <span className="group-key">{g.groupKey}</span>
                </summary>
                <div className="review-rows">
                  {g.tasks.map((t) => {
                    const o = state.observations.find((x) => x.id === t.observationId);
                    if (!o) return null;
                    return (
                      <div key={t.id} className="review-row">
                        <ObservationCard state={state} obs={o} />
                        <div className="review-action">
                          <input
                            placeholder="复核意见（可空）"
                            value={comment[t.id] ?? ""}
                            onChange={(e) => setComment((c) => ({ ...c, [t.id]: e.target.value }))}
                          />
                          <div className="button-row">
                            <button className="primary-action" onClick={() => decide(t, "approved")}>
                              复核通过（冻结依据）
                            </button>
                            <button className="danger-btn" onClick={() => decide(t, "rejected")}>
                              退回
                            </button>
                          </div>
                          <p className="form-note">
                            学生：{userName(state, o.observerId)} · 玻片：{slideName(state, o.slideId)} ·
                            入队 {fmtTime(t.createdAt)}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </details>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="复议任务" sub="已复核结论的依据变更">
        {reconsider.length === 0 ? (
          <Empty text="没有待处理的复议项" />
        ) : (
          <div className="reconsider-stack">
            {reconsider.map((t) => {
              const o = state.observations.find((x) => x.id === t.observationId);
              if (!o) return null;
              return (
                <div key={t.id} className="reconsider-task">
                  <ObservationCard state={state} obs={o} />
                  <div className="review-action">
                    <p className="basis-comment">
                      处理原则：维持则保留当时依据不变；修订则将原依据标记为历史并按批次 v{t.batchVersion} 重算后重新复核。
                    </p>
                    <input
                      placeholder="复议说明（可空）"
                      value={comment[t.id] ?? ""}
                      onChange={(e) => setComment((c) => ({ ...c, [t.id]: e.target.value }))}
                    />
                    <div className="button-row">
                      <button onClick={() => show(store.resolveReconsider(t.id, "maintain", comment[t.id] ?? "").message)}>
                        维持原结论
                      </button>
                      <button
                        className="primary-action"
                        onClick={() => show(store.resolveReconsider(t.id, "revise", comment[t.id] ?? "").message, true)}
                      >
                        修订（按新依据重算）
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel title="复核状态说明" sub="统一处理状态">
        <div className="legend-grid">
          {(Object.keys(STATUS_META) as (keyof typeof STATUS_META)[]).map((k) => (
            <div key={k} className="legend-item">
              <span className={`badge tone-${STATUS_META[k].tone}`}>{STATUS_META[k].label}</span>
              <span>{STATUS_META[k].hint}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
