import type { Actor, LabState, Observation, ObsStatus } from "./types";

/** 统一处理状态：明细、待办、统计全部从这里取标签与含义，禁止各处自定义状态 */
export const STATUS_META: Record<
  ObsStatus,
  { label: string; tone: "ok" | "warn" | "danger" | "info" | "muted"; desc: string }
> = {
  PENDING_VERIFY: {
    label: "待核",
    tone: "warn",
    desc: "旧数据缺少染色批次版本，管理员补核前不进入复核",
  },
  PENDING_REVIEW: { label: "待复核", tone: "info", desc: "等待教师按染色批次和放大倍数复核" },
  CONFLICT: {
    label: "冲突保留",
    tone: "danger",
    desc: "同一玻片并发提交的后到内容，已保留但不生效，等待教师查看",
  },
  APPROVED: { label: "已复核", tone: "ok", desc: "教师已通过，结论依据为复核当时冻结的批次版本与标尺" },
  REJECTED: { label: "已驳回", tone: "danger", desc: "教师驳回，学生可重新提交" },
  INVALIDATED: {
    label: "已失效",
    tone: "danger",
    desc: "批次过期、标尺更新无法重算或复议发回，原结论不再有效",
  },
  RECONSIDER: {
    label: "已复核·待复议",
    tone: "warn",
    desc: "依据已更新：原结论保留，复议项等待教师裁决",
  },
};

export const STATUS_ORDER: ObsStatus[] = [
  "PENDING_VERIFY",
  "PENDING_REVIEW",
  "CONFLICT",
  "APPROVED",
  "RECONSIDER",
  "REJECTED",
  "INVALIDATED",
];

export const MAGNIFICATIONS = ["100x", "200x", "400x", "1000x"];

export function nextId(state: LabState, prefix: string): string {
  state.seq += 1;
  return `${prefix}-${state.seq}`;
}

export function batchOf(state: LabState, id: string) {
  return state.batches.find((b) => b.id === id);
}

export function slideOf(state: LabState, id: string) {
  return state.slides.find((s) => s.id === id);
}

export function userOf(state: LabState, id: string) {
  return state.users.find((u) => u.userId === id);
}

export function obsOf(state: LabState, id: string) {
  return state.observations.find((o) => o.id === id);
}

/** 玻片所用批次（样本级溯源：玻片记录绑定染色批次） */
export function batchOfSlide(state: LabState, slideId: string) {
  const slide = state.slides.find((s) => s.id === slideId);
  return slide ? batchOf(state, slide.stainBatchId) : undefined;
}

/** 提交/重算时的幂等键：同一观察者+同一玻片+同一放大倍数+同一原始读数只允许一条 */
export function idempotencyKeyOf(input: {
  observerId: string;
  slideId: string;
  magnification: string;
  rawReading: number;
}) {
  return `obs:${input.observerId}:${input.slideId}:${input.magnification}:${input.rawReading}`;
}

/** 学生越权代写判定：只允许学生本人以自己的身份提交 */
export function isStudentSelfSubmit(actor: Actor, observerId: string): boolean {
  return actor.role === "student" && actor.userId === observerId;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 复核队列分组键：染色批次（含版本） × 放大倍数 */
export function reviewGroupKey(obs: Observation): string {
  return `${obs.stainBatchId}#v${obs.stainVersion ?? "?"}|${obs.magnification}`;
}
