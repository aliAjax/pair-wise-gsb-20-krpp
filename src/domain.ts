import type {
  AppState,
  AuditLog,
  Observation,
  ProcStatus,
  ReviewBasis,
  ReviewTask,
  StainBatch,
} from "./types";

/* -------------------------------- 常量 -------------------------------- */

export const MAGNIFICATIONS = [100, 200, 400, 1000] as const;

export const STATUS_META: Record<
  ProcStatus,
  { label: string; tone: "muted" | "info" | "ok" | "danger" | "warn" | "pink"; hint: string }
> = {
  pending_verify: { label: "待核", tone: "warn", hint: "旧数据缺批次版本，管理员核对前不进入复核" },
  pending_review: { label: "待复核", tone: "info", hint: "先到结论已生效，等待教师按批次和倍数复核" },
  approved: { label: "已复核", tone: "ok", hint: "结论通过，复核依据已冻结" },
  rejected: { label: "已退回", tone: "danger", hint: "复核退回，学生需修改后重新提交" },
  recalculating: { label: "失效重算中", tone: "pink", hint: "批次依据变更，结论立即失效并重新计算" },
  invalidated: { label: "已失效", tone: "danger", hint: "重算后依据不成立（如有效期不覆盖观察时间）" },
  conflict_loser: { label: "冲突保留", tone: "pink", hint: "同玻片后到提交，内容保留，先到结论生效" },
};

/* -------------------------------- 工具 -------------------------------- */

export function nowTs(): number {
  return Date.now();
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

export function fmtDate(s: string): string {
  return s;
}

export function uid(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(4, "0")}`;
}

export function hashText(text: string): string {
  // 轻量内容指纹，用于幂等键
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function idemKeyOf(observerId: string, slideId: string, mag: number, content: string): string {
  return [observerId, slideId, mag, hashText(content.trim())].join("|");
}

export function taskGroupKey(batchId: string, mag: number): string {
  return `${batchId}@${mag}x`;
}

/* ------------------------------ 选择器 / 查询 ------------------------------ */

export function getBatch(state: AppState, id: string): StainBatch | undefined {
  return state.batches.find((b) => b.id === id);
}

export function getRulerScale(
  state: AppState,
  rulerVersionId: string | null,
  mag: number
): number | null {
  if (!rulerVersionId) return null;
  const ruler = state.rulers.find((r) => r.id === rulerVersionId);
  return ruler ? ruler.scaleByMag[mag] ?? null : null;
}

/** 测量结论：格数 × 当前/快照标尺 = 实际长度 μm */
export function computeActualUm(
  state: AppState,
  rulerVersionId: string | null,
  mag: number,
  divs: number | null
): number | null {
  if (divs == null) return null;
  const scale = getRulerScale(state, rulerVersionId, mag);
  if (scale == null) return null;
  return Math.round(divs * scale * 100) / 100;
}

export function buildResultText(structure: string, actualUm: number | null): string {
  const size = actualUm == null ? "" : `，实测 ${actualUm} μm`;
  return `观察结构：${structure}${size}`;
}

export function dateWithin(day: string, from: string, until: string): boolean {
  return day >= from && day <= until;
}

export function dayOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 该玻片上当前生效的观察（先到生效；失效/退回/冲突后释放） */
export function effectiveOnSlide(observations: Observation[], slideId: string): Observation | null {
  const eligible = observations
    .filter(
      (o) =>
        o.slideId === slideId &&
        (o.status === "pending_review" ||
          o.status === "approved" ||
          o.status === "recalculating")
    )
    .sort((a, b) => a.submittedAt - b.submittedAt || a.id.localeCompare(b.id));
  return eligible[0] ?? null;
}

/* ------------------------------ 统计（统一状态口径） ------------------------------ */

export interface StatusStat {
  status: ProcStatus;
  count: number;
}

export function statusStats(observations: Observation[]): StatusStat[] {
  const order: ProcStatus[] = [
    "pending_verify",
    "pending_review",
    "recalculating",
    "approved",
    "rejected",
    "invalidated",
    "conflict_loser",
  ];
  const counts = new Map<ProcStatus, number>();
  for (const o of observations) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
  return order.map((status) => ({ status, count: counts.get(status) ?? 0 }));
}

/* ------------------------------ 复核分组 ------------------------------ */

export interface ReviewGroup {
  groupKey: string;
  batchId: string;
  batchName: string;
  batchVersion: number;
  magnification: number;
  tasks: ReviewTask[];
}

export function openReviewGroups(state: AppState): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const t of state.tasks) {
    if (t.status !== "open" || t.type !== "review") continue;
    const batch = getBatch(state, t.batchId);
    const key = t.groupKey;
    if (!groups.has(key)) {
      groups.set(key, {
        groupKey: key,
        batchId: t.batchId,
        batchName: batch ? `${batch.name}（v${batch.version}）` : `${t.batchId}（v${t.batchVersion}）`,
        batchVersion: t.batchVersion,
        magnification: t.magnification,
        tasks: [],
      });
    }
    groups.get(key)!.tasks.push(t);
  }
  return [...groups.values()].sort((a, b) => a.groupKey.localeCompare(b.groupKey));
}

export function openReconsiderTasks(state: AppState): ReviewTask[] {
  return state.tasks
    .filter((t) => t.status === "open" && t.type === "reconsider")
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function findObservation(state: AppState, id: string): Observation | undefined {
  return state.observations.find((o) => o.id === id);
}

export function reviewBasisOf(
  state: AppState,
  o: Observation,
  reviewerId: string,
  reviewerName: string,
  decision: "approved" | "rejected",
  comment: string,
  reviewId: string
): ReviewBasis {
  return {
    reviewId,
    reviewerId,
    reviewerName,
    reviewedAt: nowTs(),
    decision,
    comment,
    batchVersion: o.batchVersion ?? 0,
    rulerVersionId: o.rulerVersionId ?? "—",
    validUntil: getBatch(state, o.batchId)?.validUntil ?? "—",
    magnification: o.magnification,
    resultText: o.resultText,
  };
}
