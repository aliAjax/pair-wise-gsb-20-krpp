import { useMemo, useState } from "react";
import type { LabState, ObsStatus } from "../domain/types";
import { STATUS_META, STATUS_ORDER } from "../domain/status";
import { Panel, StatusBadge, batchLabel, fmtDateTime, slideName } from "./shared";

export function RecordsView({ state }: { state: LabState }) {
  const [statusFilter, setStatusFilter] = useState<ObsStatus | "ALL">("ALL");
  const [openId, setOpenId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c = {} as Record<ObsStatus, number>;
    for (const s of STATUS_ORDER) c[s] = 0;
    for (const o of state.observations) c[o.status] += 1;
    return c;
  }, [state]);

  const rows = state.observations
    .filter((o) => statusFilter === "ALL" || o.status === statusFilter)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));

  const batchCounts = useMemo(() => {
    const m = new Map<string, { label: string; total: number; approved: number; pending: number }>();
    for (const o of state.observations) {
      const key = `${o.stainBatchId}#v${o.stainVersion ?? "?"}`;
      const b = state.batches.find((x) => x.id === o.stainBatchId);
      if (!m.has(key)) m.set(key, { label: `${b?.batchCode ?? o.stainBatchId} v${o.stainVersion ?? "?"}`, total: 0, approved: 0, pending: 0 });
      const row = m.get(key)!;
      row.total += 1;
      if (o.status === "APPROVED" || o.status === "RECONSIDER") row.approved += 1;
      if (o.status === "PENDING_REVIEW") row.pending += 1;
    }
    return [...m.values()];
  }, [state]);

  return (
    <div className="view-grid">
      <Panel title="处理统计" sub="全部直接按统一处理状态计数，与明细、待办同一口径">
        <div className="stat-grid">
          {STATUS_ORDER.map((s) => (
            <button key={s} className={`stat-card tone-${STATUS_META[s].tone} ${statusFilter === s ? "selected" : ""}`} onClick={() => setStatusFilter(statusFilter === s ? "ALL" : s)}>
              <span>{STATUS_META[s].label}</span>
              <strong>{counts[s]}</strong>
              <small>{STATUS_META[s].desc}</small>
            </button>
          ))}
        </div>
        <div className="batch-stats">
          <span className="caption">按染色批次版本</span>
          <div className="chips">
            {batchCounts.map((b) => (
              <span key={b.label} className="chip">{b.label}：共 {b.total} · 已复核 {b.approved} · 待复核 {b.pending}</span>
            ))}
          </div>
        </div>
      </Panel>

      <Panel
        title="观察记录明细"
        sub={statusFilter === "ALL" ? `全部 ${rows.length} 条` : `${STATUS_META[statusFilter].label} ${rows.length} 条`}
        right={<button onClick={() => setStatusFilter("ALL")}>清除筛选</button>}
      >
        <table className="records-table">
          <thead>
            <tr>
              <th>编号</th><th>样本</th><th>观察者</th><th>倍数</th><th>批次版本/标尺</th><th>测量</th><th>状态</th><th>提交时间</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const batch = state.batches.find((b) => b.id === o.stainBatchId);
              return (
                <tr key={o.id} className={openId === o.id ? "open" : ""}>
                  <td className="mono">{o.id}</td>
                  <td>{slideName(state, o.slideId)}</td>
                  <td>{o.observerName}</td>
                  <td>{o.magnification}</td>
                  <td>
                    {o.stainVersion === null ? <span className="text-warn">缺版本（{batch?.batchCode}）</span> : `${batch?.batchCode} v${o.stainVersion} / ${o.scaleVersion}`}
                  </td>
                  <td>{o.measurement}μm</td>
                  <td><StatusBadge status={o.status} /></td>
                  <td>{fmtDateTime(o.submittedAt)}</td>
                  <td><button onClick={() => setOpenId(openId === o.id ? null : o.id)}>{openId === o.id ? "收起" : "溯源"}</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {openId && (() => {
          const o = state.observations.find((x) => x.id === openId)!;
          const batch = state.batches.find((b) => b.id === o.stainBatchId);
          const winner = o.conflictWith ? state.observations.find((x) => x.id === o.conflictWith) : undefined;
          return (
            <div className="trace-box">
              <h3>溯源链 · {o.id}</h3>
              <p><b>当前处理状态：</b><StatusBadge status={o.status} /> — {STATUS_META[o.status].desc}</p>
              <p><b>观察内容：</b>{o.structure}；{o.description}</p>
              <p><b>测量：</b>原始读数 {o.rawReading} → 校正 {o.measurement}μm</p>
              <p><b>提交依据：</b>{o.stainVersion === null ? "旧数据缺批次版本（待核）" : batchLabel(batch) + ` / 标尺 ${o.scaleVersion}`}</p>
              {o.basisSnapshot && (
                <div className="basis-grid">
                  <div>
                    <span className="caption">复核依据快照（冻结）</span>
                    <p>{batch?.batchCode} v{o.basisSnapshot.stainVersion}</p>
                    <p>有效期 {o.basisSnapshot.validFrom} ~ {o.basisSnapshot.validUntil}</p>
                    <p>标尺 {o.basisSnapshot.scaleVersion} ×{o.basisSnapshot.scaleFactor}</p>
                    <p>复核人 {o.basisSnapshot.reviewerName} · {fmtDateTime(o.basisSnapshot.frozenAt)}</p>
                  </div>
                  <div>
                    <span className="caption">该批次当前版本</span>
                    <p>{batchLabel(batch)}</p>
                    <p>有效期 {batch?.validFrom} ~ {batch?.validUntil}</p>
                    <p>标尺 {batch?.scaleVersion} ×{batch?.scaleFactor}</p>
                  </div>
                </div>
              )}
              {o.reviewComment && <p><b>复核意见：</b>{o.reviewComment}（{o.reviewerName} · {fmtDateTime(o.reviewedAt ?? "")}）</p>}
              {winner && (
                <p className="text-danger"><b>冲突先到记录：</b>{winner.id}（{winner.observerName} · {fmtDateTime(winner.submittedAt)}）已生效，本条为后到保留内容。</p>
              )}
              {o.reconsideration && (
                <div className="inline-note warn">
                  <b>复议项（{o.reconsideration.kind}）：</b>{o.reconsideration.detail}
                  {o.reconsideration.resolution && (
                    <span> 裁决：{o.reconsideration.resolution === "UPHELD" ? "维持原结论" : "发回重做"}（{o.reconsideration.resolvedBy} · {fmtDateTime(o.reconsideration.resolvedAt ?? "")}）</span>
                  )}
                </div>
              )}
              {o.recomputeHistory.map((r, i) => (
                <div key={i} className="inline-note info">
                  标尺重算：{r.fromScaleVersion}(×{r.fromFactor}) {r.fromMeasurement}μm → {r.toScaleVersion}(×{r.toFactor}) {r.toMeasurement}μm · {fmtDateTime(r.at)}
                </div>
              ))}
              {o.invalidationLog.map((e, i) => (
                <div key={i} className="inline-note error">失效/留痕：{e.reason} · {fmtDateTime(e.at)}</div>
              ))}
            </div>
          );
        })()}
      </Panel>

      <Panel title="操作留痕" sub={`审计日志 ${state.audit.length} 条 · 拒绝与恢复同样记录`}>
        <div className="audit-list">
          {state.audit.slice().reverse().map((a) => (
            <div key={a.id} className={`audit-row ${a.denied ? "denied" : ""}`}>
              <span className="mono">{fmtDateTime(a.at)}</span>
              <span className={`role-tag r-${a.role}`}>{a.role === "system" ? "系统" : a.role === "student" ? "学生" : a.role === "teacher" ? "教师" : "管理员"}</span>
              <span className="mono">{a.actorName}</span>
              <span className="action-name">{a.action}</span>
              <span>{a.detail}</span>
              {a.targetId && <span className="mono hint">{a.targetId}</span>}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
