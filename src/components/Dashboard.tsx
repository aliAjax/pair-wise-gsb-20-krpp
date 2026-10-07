import type { AppState } from "../types";
import { STATUS_META, fmtTime, openReconsiderTasks, openReviewGroups, statusStats } from "../domain";
import { Empty, MetaRow, Panel, StatusBadge } from "./ui";
import { ObservationCard, slideName, userName } from "./ObservationCard";

export function Dashboard({ state, currentUserId }: { state: AppState; currentUserId: string }) {
  const stats = statusStats(state.observations);
  const groups = openReviewGroups(state);
  const reconsider = openReconsiderTasks(state);
  const role = state.users.find((u) => u.id === currentUserId)?.role;

  const myTodo = state.observations.filter(
    (o) => o.observerId === currentUserId && (o.status === "rejected" || o.status === "invalidated")
  );
  const verifyTodo = state.observations.filter((o) => o.status === "pending_verify");
  const pendingForMe = role === "student"
    ? state.observations.filter((o) => o.observerId === currentUserId && o.status === "pending_review")
    : [];

  return (
    <div className="view-stack">
      <Panel title="处理状态统计" sub="统一口径">
        <div className="stat-grid">
          {stats.map((s) => (
            <div key={s.status} className={`stat-card stat-tone-${STATUS_META[s.status].tone}`}>
              <strong>{s.count}</strong>
              <StatusBadge status={s.status} />
              <span className="stat-hint">{STATUS_META[s.status].hint}</span>
            </div>
          ))}
        </div>
      </Panel>

      <div className="two-col">
        <Panel title="待办" sub="按当前角色">
          {role === "student" ? (
            <ul className="todo-list">
              <li>你有 <strong>{pendingForMe.length}</strong> 条观察等待教师复核</li>
              <li>你有 <strong>{myTodo.length}</strong> 条结论被退回或失效，需重新提交</li>
              {myTodo.slice(0, 5).map((o) => (
                <li key={o.id} className="todo-sub">
                  {o.id} · {slideName(state, o.slideId)} · <StatusBadge status={o.status} />
                </li>
              ))}
            </ul>
          ) : null}
          {role === "teacher" ? (
            <ul className="todo-list">
              <li>
                待复核分组 <strong>{groups.length}</strong> 个（按染色批次 + 放大倍数），共{" "}
                <strong>{groups.reduce((n, g) => n + g.tasks.length, 0)}</strong> 条
              </li>
              <li>待复议任务 <strong className="text-pink">{reconsider.length}</strong> 条（已复核结论依据变更）</li>
            </ul>
          ) : null}
          {role === "admin" ? (
            <ul className="todo-list">
              <li>
                旧数据待核 <strong className="text-warn">{verifyTodo.length}</strong> 条（缺批次版本）
              </li>
              <li>
                教师待复议 <strong className="text-pink">{reconsider.length}</strong> 条
              </li>
              <li>染色批次 {state.batches.length} 个，标尺版本 {state.rulers.length} 个</li>
            </ul>
          ) : null}
        </Panel>

        <Panel title="最近检查点" sub="恢复基线">
          {state.lastCheckpoint ? (
            <div className="checkpoint-box">
              <MetaRow label="检查点序号" value={`#${state.lastCheckpoint.seq}`} />
              <MetaRow label="说明" value={state.lastCheckpoint.label} />
              <MetaRow label="建立时间" value={fmtTime(state.lastCheckpoint.at)} />
            </div>
          ) : (
            <Empty text="尚无检查点" />
          )}
        </Panel>
      </div>

      <Panel title="最新动态" sub="处理中/需关注的记录">
        {state.observations.filter((o) =>
          ["recalculating", "invalidated", "conflict_loser", "pending_verify"].includes(o.status)
        ).length === 0 ? (
          <Empty text="当前没有需要关注的记录" />
        ) : (
          <div className="obs-grid">
            {state.observations
              .filter((o) =>
                ["recalculating", "invalidated", "conflict_loser", "pending_verify"].includes(o.status)
              )
              .sort((a, b) => b.submittedAt - a.submittedAt)
              .slice(0, 6)
              .map((o) => (
                <ObservationCard key={o.id} state={state} obs={o} />
              ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
