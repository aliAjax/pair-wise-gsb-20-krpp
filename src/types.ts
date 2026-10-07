// 领域模型：样本、染色批次、标尺、观察记录、复核任务、操作留痕

export type Role = "student" | "teacher" | "admin";

export interface User {
  id: string;
  name: string;
  role: Role;
  className?: string;
}

export type SlideCategory = "植物组织" | "动物组织" | "微生物" | "血液涂片";

export interface Slide {
  id: string;
  name: string;
  category: SlideCategory;
  /** 制片时采用的染色批次（历史观察结论以观察记录上的快照为准） */
  stainBatchId: string;
  preparedAt: string;
  archived?: boolean;
}

export interface StainBatch {
  id: string;
  name: string;
  method: string;
  version: number;
  validFrom: string; // YYYY-MM-DD
  validUntil: string; // YYYY-MM-DD
  rulerVersionId: string;
  active: boolean;
}

export interface RulerVersion {
  id: string;
  name: string;
  /** 目镜测微尺每格对应的实际长度 μm，按放大倍数索引 */
  scaleByMag: Record<number, number>;
  note: string;
}

/** 统一处理状态：明细、待办、统计全部使用同一套状态口径 */
export type ProcStatus =
  | "pending_verify" // 待核：旧数据缺批次版本
  | "pending_review" // 待复核：已生效，等待教师复核
  | "approved" // 已复核通过（结论生效，依据已冻结）
  | "rejected" // 复核退回
  | "recalculating" // 批次依据变更，失效重算中
  | "invalidated" // 重算后失效（有效期不覆盖观察时间等）
  | "conflict_loser"; // 同玻片后到提交：内容保留、显示冲突

export interface ReconsiderItem {
  id: string;
  triggeredAt: number;
  trigger: "batch_validity" | "ruler_version";
  detail: string;
  oldValue: string;
  newValue: string;
  open: boolean;
  resolution?: "maintain" | "revise";
  resolvedAt?: number;
  resolverId?: string;
}

export interface ReviewBasis {
  reviewId: string;
  reviewerId: string;
  reviewerName: string;
  reviewedAt: number;
  decision: "approved" | "rejected";
  comment: string;
  /** 复核当时冻结的依据 */
  batchVersion: number;
  rulerVersionId: string;
  validUntil: string;
  magnification: number;
  resultText: string;
  /** 复议修订后原依据标记为被取代，但保留可追溯 */
  superseded?: boolean;
  supersededReason?: string;
}

export interface Observation {
  id: string;
  /** 幂等键：观察者|玻片|倍数|内容指纹，重复提交不再生成记录 */
  idemKey: string;
  slideId: string;
  observerId: string;
  magnification: number;
  structure: string;
  description: string;
  measurementDivs: number | null;
  /** 结论与测量重算结果 */
  resultText: string;
  computedActualUm: number | null;
  submittedAt: number;
  /** 提交时快照的依据 */
  batchId: string;
  batchVersion: number | null; // 旧数据为 null → 待核
  rulerVersionId: string | null;
  legacy: boolean;
  status: ProcStatus;
  invalidReason: string | null;
  /** 后到冲突：指向先生效的观察记录 */
  conflictWithId: string | null;
  /** 复核依据（已复核则冻结） */
  basis: ReviewBasis | null;
  /** 已复核结论在批次变更后产生的复议项 */
  reconsider: ReconsiderItem[];
}

export type TaskType = "review" | "reconsider";
export type TaskStatus = "open" | "done" | "cancelled";

export interface ReviewTask {
  id: string;
  type: TaskType;
  observationId: string;
  batchId: string;
  batchVersion: number;
  magnification: number;
  status: TaskStatus;
  createdAt: number;
  closedAt: number | null;
  /** 分组键：染色批次 + 放大倍数 */
  groupKey: string;
}

export interface AuditLog {
  id: string;
  at: number;
  actorId: string;
  actorName: string;
  action: string;
  message: string;
  entityType: "observation" | "slide" | "batch" | "review" | "import" | "system";
  entityId?: string;
  result: "ok" | "denied" | "failed" | "recovered" | "duplicate";
  detail?: Record<string, unknown>;
}

export interface CheckpointMeta {
  at: number;
  label: string;
  seq: number;
}

export interface AppState {
  seq: number;
  users: User[];
  slides: Slide[];
  batches: StainBatch[];
  rulers: RulerVersion[];
  observations: Observation[];
  tasks: ReviewTask[];
  lastCheckpoint: CheckpointMeta | null;
}
