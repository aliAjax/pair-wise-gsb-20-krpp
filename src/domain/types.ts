// 领域模型：样本 / 染色批次 / 观察记录 / 复核 / 复议 / 操作留痕

export type Role = "student" | "teacher" | "admin";

export interface Actor {
  role: Role;
  userId: string;
  name: string;
}

/** 观察记录的统一处理状态 —— 明细、待办、统计只允许使用这一套状态 */
export type ObsStatus =
  | "PENDING_VERIFY" // 待核：旧数据缺批次版本，等待管理员补核
  | "PENDING_REVIEW" // 待复核：学生提交后等待教师复核（含失效后重算回流）
  | "CONFLICT" // 冲突保留：同一玻片并发提交的后到内容
  | "APPROVED" // 已复核：教师通过，结论按当时依据冻结
  | "REJECTED" // 已驳回
  | "INVALIDATED" // 已失效：批次过期 / 标尺更新且无法重算 / 复议发回
  | "RECONSIDER"; // 已复核·待复议：依据已更新，保留原结论等教师复议

export type StainStatus = "ACTIVE" | "DISCONTINUED";

export interface StainVersionSnapshot {
  version: number;
  validFrom: string; // YYYY-MM-DD
  validUntil: string; // YYYY-MM-DD
  scaleVersion: string; // 标尺版本
  scaleFactor: number; // 标尺校正系数，测量值 = 原始读数 × 系数
  status: StainStatus;
  changedAt: string;
  changeNote: string;
}

export interface StainBatch {
  id: string;
  method: string; // 染色方式
  batchCode: string; // 批号
  version: number;
  validFrom: string;
  validUntil: string;
  scaleVersion: string;
  scaleFactor: number;
  status: StainStatus;
  createdAt: string;
  history: StainVersionSnapshot[];
}

export interface Slide {
  id: string;
  name: string; // 样本名称
  sampleType: string; // 样本类型
  stainBatchId: string; // 该玻片使用的染色批次
  createdAt: string;
}

export interface User extends Actor {}

export interface BasisSnapshot {
  stainBatchId: string;
  stainVersion: number;
  validFrom: string;
  validUntil: string;
  scaleVersion: string;
  scaleFactor: number;
  frozenAt: string;
  reviewerId: string;
  reviewerName: string;
}

export interface InvalidationEvent {
  at: string;
  reason: string;
  causeCommandId: string;
}

export interface RecomputeEvent {
  at: string;
  causeCommandId: string;
  fromScaleVersion: string;
  toScaleVersion: string;
  fromFactor: number;
  toFactor: number;
  fromMeasurement: number;
  toMeasurement: number;
}

export interface ReconsiderationItem {
  id: string;
  raisedAt: string;
  kind: "有效期" | "标尺版本" | "批次状态";
  fromVersion: number;
  toVersion: number;
  detail: string;
  resolution?: "UPHELD" | "RETURNED";
  resolvedAt?: string;
  resolvedBy?: string;
  note?: string;
}

export interface Observation {
  id: string;
  slideId: string;
  observerId: string;
  observerName: string;
  magnification: string; // 放大倍数
  structure: string; // 观察结构
  description: string; // 视野描述
  rawReading: number; // 原始读数（目镜测微尺格数折算前）
  measurement: number; // 校正后测量值 μm
  stainBatchId: string;
  stainVersion: number | null; // 批次版本：旧数据为 null => 待核
  scaleVersion: string | null;
  status: ObsStatus;
  submittedAt: string;
  idempotencyKey: string;
  conflictWith?: string; // 并发后到：先到（生效）记录 id
  basisSnapshot?: BasisSnapshot; // 复核时冻结的当时依据
  reviewedAt?: string;
  reviewerId?: string;
  reviewerName?: string;
  reviewComment?: string;
  invalidationLog: InvalidationEvent[];
  recomputeHistory: RecomputeEvent[];
  reconsideration?: ReconsiderationItem;
}

export interface AuditEntry {
  id: string;
  at: string;
  actorId: string;
  actorName: string;
  role: Role | "system";
  action: string;
  targetId?: string;
  detail: string;
  commandId: string;
  denied?: boolean;
  denyReason?: string;
}

export interface LabState {
  seq: number;
  batches: StainBatch[];
  slides: Slide[];
  users: User[];
  observations: Observation[];
  audit: AuditEntry[];
  idempotency: Record<string, string>; // 幂等键 -> observation id
}

export interface Notice {
  tone: "ok" | "error" | "warn" | "info";
  text: string;
}

// ---------- 命令 ----------

export interface SubmitPayload {
  observerId: string;
  slideId: string;
  magnification: string;
  structure: string;
  description: string;
  rawReading: number;
}

export type Command =
  | { type: "submitObservation"; actor: Actor; data: SubmitPayload; at: string }
  | {
      type: "simultaneousSubmit";
      actor: Actor; // 必须为管理员（演练裁判），两名观察者各自身份在 payload 中
      items: { observerId: string; payload: Omit<SubmitPayload, "observerId"> }[];
      at: string;
    }
  | {
      type: "reviewObservation";
      actor: Actor;
      observationId: string;
      decision: "APPROVE" | "REJECT";
      comment?: string;
      at: string;
    }
  | {
      type: "batchReview";
      actor: Actor;
      batchId: string;
      stainVersion: number;
      magnification: string;
      decision: "APPROVE";
      at: string;
    }
  | {
      type: "resolveReconsideration";
      actor: Actor;
      observationId: string;
      resolution: "UPHELD" | "RETURNED";
      note?: string;
      at: string;
    }
  | {
      type: "updateBatchBasis";
      actor: Actor;
      batchId: string;
      patch: {
        validFrom?: string;
        validUntil?: string;
        scaleVersion?: string;
        scaleFactor?: number;
        status?: StainStatus;
        note: string;
      };
      at: string;
    }
  | { type: "verifyLegacy"; actor: Actor; observationId: string; batchId: string; at: string }
  | {
      type: "importObservations";
      actor: Actor;
      rows: {
        slideName: string;
        stainBatchId?: string;
        observerId?: string;
        magnification: string;
        structure: string;
        description: string;
        rawReading: number;
      }[];
      at: string;
    };

export interface ApplyResult {
  state: LabState;
  notices: Notice[];
  commandId: string;
}

export interface CheckpointMeta {
  id: string;
  seq: number;
  at: string;
  commandId: string;
  label: string;
  checksum: string;
}
