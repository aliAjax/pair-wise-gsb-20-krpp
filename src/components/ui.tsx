import type { ReactNode } from "react";
import { STATUS_META } from "../domain";
import type { ProcStatus } from "../types";

export function StatusBadge({ status }: { status: ProcStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={`badge tone-${meta.tone}`} title={meta.hint}>
      {meta.label}
    </span>
  );
}

export function Panel({
  title,
  sub,
  actions,
  children,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          {sub ? <p className="eyebrow">{sub}</p> : null}
          <h2>{title}</h2>
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

export function MetaRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="meta-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function Toast({ text, tone, onClose }: { text: string; tone: "ok" | "err" | "info"; onClose: () => void }) {
  return (
    <div className={`toast toast-${tone}`} onClick={onClose} role="status">
      {text}
      <i>×</i>
    </div>
  );
}

