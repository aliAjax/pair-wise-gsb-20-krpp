import type { AppState, Observation } from "../types";
import { STATUS_META, fmtTime } from "../domain";
import { StatusBadge } from "./ui";

export function userName(state: AppState, id: string): string {
  return state.users.find((u) => u.id === id)?.name ?? id;
}

export function slideName(state: AppState, id: string): string {
  return state.slides.find((s) => s.id === id)?.name ?? id;
}

export function ObservationCard({ state, obs }: { state: AppState; obs: Observation }) {
  const slide = state.slides.find((s) => s.id === obs.slideId);
  const batch = state.batches.find((b) => b.id === obs.batchId);
  const winner = obs.conflictWithId
    ? state.observations.find((o) => o.id === obs.conflictWithId)
    : null;
  const openReconsider = obs.reconsider.filter((r) => r.open);

  return (
    <article className={`obs-card obs-${obs.status}`}>
      <header>
        <div>
          <span className="obs-id">{obs.id}</span>
          <h3>{slide?.name ?? obs.slideId}</h3>
        </div>
        <StatusBadge status={obs.status} />
      </header>

      <p className="obs-desc">{obs.description}</p>

      <div className="obs-tags">
        <span>{obs.magnification}x</span>
        <span>{slide?.category}</span>
        <span>{batch ? `${batch.name}${obs.batchVersion != null ? ` v${obs.batchVersion}` : "（版本待核）"}` : "批次缺失"}</span>
        <span>标尺 {obs.rulerVersionId ?? "待核"}</span>
        {obs.measurementDivs != null ? <span>{obs.measurementDivs} 格</span> : null}
      </div>

      <div className="obs-meta">
        <span>观察者：{userName(state, obs.observerId)}</span>
        <span>提交：{fmtTime(obs.submittedAt)}</span>
        {obs.legacy ? <span className="legacy-flag">旧数据</span> : null}
      </div>

      <div className="obs-result">
        <strong>当前结论：</strong>
        {obs.resultText}
      </div>

      {obs.status === "invalidated" && obs.invalidReason ? (
        <div className="alert danger">{obs.invalidReason}</div>
      ) : null}
      {obs.status === "recalculating" ? (
        <div className="alert warn">
          <span className="spinner" /> 依据已变更，正在按新批次/标尺重算…
        </div>
      ) : null}
      {obs.status === "conflict_loser" ? (
        <div className="alert pink">
          冲突保留：同一玻片的先生效记录为{" "}
          <strong>{winner ? `${winner.id}（${userName(state, winner.observerId)}）` : obs.conflictWithId}</strong>
          ，本内容保留但不生效。
        </div>
      ) : null}
      {obs.status === "pending_verify" ? (
        <div className="alert warn">{STATUS_META.pending_verify.hint}</div>
      ) : null}

      {obs.basis ? (
        <div className={`basis-box ${obs.basis.superseded ? "superseded" : ""}`}>
          <div className="basis-head">
            <strong>复核依据{obs.basis.superseded ? "（已被复议修订取代，历史保留）" : "（冻结）"}</strong>
            <span>{obs.basis.reviewId}</span>
          </div>
          <p>
            {obs.basis.reviewerName} · {fmtTime(obs.basis.reviewedAt)} ·{" "}
            {obs.basis.decision === "approved" ? "通过" : "退回"}
          </p>
          <p className="basis-comment">意见：{obs.basis.comment}</p>
          <div className="obs-tags">
            <span>批次 v{obs.basis.batchVersion}</span>
            <span>{obs.basis.rulerVersionId}</span>
            <span>有效期至 {obs.basis.validUntil}</span>
            <span>{obs.basis.magnification}x</span>
          </div>
          {obs.basis.supersededReason ? <p className="basis-comment">取代原因：{obs.basis.supersededReason}</p> : null}
        </div>
      ) : null}

      {openReconsider.length > 0 ? (
        <div className="reconsider-box">
          <strong>待复议项（{openReconsider.length}）：</strong>
          <ul>
            {openReconsider.map((r) => (
              <li key={r.id}>
                <span className={`badge tone-${r.trigger === "ruler_version" ? "pink" : "warn"}`}>
                  {r.trigger === "ruler_version" ? "标尺变更" : "有效期变更"}
                </span>
                {r.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {obs.reconsider.some((r) => !r.open) ? (
        <details className="reconsider-history">
          <summary>已处理复议项（{obs.reconsider.filter((r) => !r.open).length}）</summary>
          <ul>
            {obs.reconsider
              .filter((r) => !r.open)
              .map((r) => (
                <li key={r.id}>
                  {r.detail} → {r.resolution === "maintain" ? "维持原结论" : "修订重算"}（
                  {r.resolverId ? userName(state, r.resolverId) : ""} ·{" "}
                  {r.resolvedAt ? fmtTime(r.resolvedAt) : ""}）
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}
