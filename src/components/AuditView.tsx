import { useState } from "react";
import type { AuditLog } from "../types";
import { fmtTime } from "../domain";
import { Panel } from "./ui";

const RESULT_LABEL: Record<AuditLog["result"], string> = {
  ok: "成功",
  denied: "拒绝",
  failed: "失败",
  recovered: "恢复",
  duplicate: "重复",
};

export function AuditView({ audits }: { audits: AuditLog[] }) {
  const [filter, setFilter] = useState<AuditLog["result"] | "">("");
  const list = audits.filter((a) => !filter || a.result === filter);

  return (
    <Panel title="操作留痕" sub={`只追加审计流 · ${audits.length} 条（最近 300 条）`}>
      <div className="filter-pills">
        <button className={filter === "" ? "active" : ""} onClick={() => setFilter("")}>
          全部
        </button>
        {(["ok", "denied", "failed", "recovered", "duplicate"] as const).map((r) => (
          <button
            key={r}
            className={`pill result-${r} ${filter === r ? "active" : ""}`}
            onClick={() => setFilter(filter === r ? "" : r)}
          >
            {RESULT_LABEL[r]}（{audits.filter((a) => a.result === r).length}）
          </button>
        ))}
      </div>

      <ol className="audit-list">
        {list.map((a) => (
          <li key={a.id} className={`audit-item audit-${a.result}`}>
            <div className="audit-dot" />
            <div className="audit-body">
              <div className="audit-head">
                <span className={`badge tone-${toneOf(a.result)}`}>{RESULT_LABEL[a.result]}</span>
                <strong>{a.message}</strong>
              </div>
              <div className="audit-meta">
                <span>{a.id}</span>
                <span>{a.actorName}（{a.actorId}）</span>
                <span>{a.action}</span>
                <span>{a.entityType}{a.entityId ? `:${a.entityId}` : ""}</span>
                <span>{fmtTime(a.at)}</span>
              </div>
              {a.detail ? (
                <details>
                  <summary>详情</summary>
                  <pre>{JSON.stringify(a.detail, null, 2)}</pre>
                </details>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function toneOf(r: AuditLog["result"]): "ok" | "danger" | "warn" | "pink" | "info" | "muted" {
  switch (r) {
    case "ok":
      return "ok";
    case "denied":
    case "failed":
      return "danger";
    case "recovered":
      return "pink";
    case "duplicate":
      return "muted";
  }
}
