import type { ReactNode } from "react";
import type { LabState, ObsStatus, StainBatch } from "../domain/types";
import { STATUS_META } from "../domain/status";

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function slideName(state: LabState, slideId: string): string {
  return state.slides.find((s) => s.id === slideId)?.name ?? slideId;
}

export function batchLabel(b?: StainBatch): string {
  if (!b) return "未知批次";
  return `${b.method} ${b.batchCode} v${b.version}`;
}

export function StatusBadge({ status }: { status: ObsStatus }) {
  const meta = STATUS_META[status];
  return <span className={`badge tone-${meta.tone}`}>{meta.label}</span>;
}

export function Panel({
  title,
  sub,
  right,
  children,
}: {
  title: string;
  sub?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          {sub && <p className="eyebrow">{sub}</p>}
          <h2>{title}</h2>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

const inputCls = "input";
export { inputCls };
