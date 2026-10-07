import { useMemo, useState } from "react";
import type { AppState, ProcStatus } from "../types";
import { STATUS_META, statusStats } from "../domain";
import { Panel } from "./ui";
import { ObservationCard } from "./ObservationCard";

const STATUS_KEYS: ProcStatus[] = [
  "pending_verify",
  "pending_review",
  "recalculating",
  "approved",
  "rejected",
  "invalidated",
  "conflict_loser",
];

export function RecordsView({ state }: { state: AppState }) {
  const [status, setStatus] = useState<ProcStatus | "">("");
  const [batchId, setBatchId] = useState("");
  const [mag, setMag] = useState("");
  const [keyword, setKeyword] = useState("");

  const stats = useMemo(() => statusStats(state.observations), [state.observations]);

  const list = state.observations
    .filter((o) => !status || o.status === status)
    .filter((o) => !batchId || o.batchId === batchId)
    .filter((o) => !mag || o.magnification === Number(mag))
    .filter(
      (o) =>
        !keyword ||
        o.structure.includes(keyword) ||
        o.description.includes(keyword) ||
        o.id.includes(keyword)
    )
    .sort((a, b) => b.submittedAt - a.submittedAt);

  return (
    <div className="view-stack">
      <Panel title="观察记录明细" sub={`共 ${state.observations.length} 条`}>
        <div className="filter-pills">
          <button className={status === "" ? "active" : ""} onClick={() => setStatus("")}>
            全部（{state.observations.length}）
          </button>
          {STATUS_KEYS.map((k) => {
            const n = stats.find((s) => s.status === k)?.count ?? 0;
            return (
              <button
                key={k}
                className={`pill tone-${STATUS_META[k].tone} ${status === k ? "active" : ""}`}
                onClick={() => setStatus(status === k ? "" : k)}
              >
                {STATUS_META[k].label}（{n}）
              </button>
            );
          })}
        </div>

        <div className="filter-row wide-filters">
          <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
            <option value="">全部染色批次</option>
            {state.batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}（v{b.version}）
              </option>
            ))}
          </select>
          <select value={mag} onChange={(e) => setMag(e.target.value)}>
            <option value="">全部倍数</option>
            {[100, 200, 400, 1000].map((m) => (
              <option key={m} value={m}>
                {m}x
              </option>
            ))}
          </select>
          <input
            placeholder="搜索编号 / 结构 / 描述"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
      </Panel>

      {list.length === 0 ? (
        <Panel title="结果" sub="筛选">
          <div className="empty-state">没有匹配的记录</div>
        </Panel>
      ) : (
        <div className="obs-grid">
          {list.map((o) => (
            <ObservationCard key={o.id} state={state} obs={o} />
          ))}
        </div>
      )}
    </div>
  );
}
