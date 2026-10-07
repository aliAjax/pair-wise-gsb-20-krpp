import type { AuditEntry, LabState, Observation } from "./types";
import { idempotencyKeyOf } from "./status";

const AT = "2026-10-07T08:30:00.000Z";

function audit(
  id: string,
  role: AuditEntry["role"],
  actorId: string,
  actorName: string,
  action: string,
  detail: string,
  targetId?: string,
): AuditEntry {
  return { id, at: AT, actorId, actorName, role, action, detail, targetId, commandId: "seed" };
}

function obs(partial: Partial<Observation> & Pick<Observation, "id" | "slideId" | "observerId" | "observerName" | "magnification" | "structure" | "description" | "rawReading" | "measurement" | "submittedAt">): Observation {
  return {
    stainBatchId: "",
    stainVersion: null,
    scaleVersion: null,
    status: "PENDING_REVIEW",
    invalidationLog: [],
    recomputeHistory: [],
    idempotencyKey: "",
    ...partial,
  };
}

export function createInitialState(): LabState {
  const state: LabState = {
    seq: 1020,
    batches: [
      {
        id: "b-i2",
        method: "碘液染色",
        batchCode: "LOT-I2-202607",
        version: 1,
        validFrom: "2026-09-01",
        validUntil: "2026-12-31",
        scaleVersion: "SV-2025",
        scaleFactor: 1,
        status: "ACTIVE",
        createdAt: "2026-09-01T00:00:00.000Z",
        history: [
          {
            version: 1,
            validFrom: "2026-09-01",
            validUntil: "2026-12-31",
            scaleVersion: "SV-2025",
            scaleFactor: 1,
            status: "ACTIVE",
            changedAt: "2026-09-01T00:00:00.000Z",
            changeNote: "批次建档",
          },
        ],
      },
      {
        id: "b-wright",
        method: "瑞氏染色",
        batchCode: "LOT-WR-202604",
        version: 1,
        validFrom: "2026-08-01",
        validUntil: "2026-11-30",
        scaleVersion: "SV-2025",
        scaleFactor: 1,
        status: "ACTIVE",
        createdAt: "2026-08-01T00:00:00.000Z",
        history: [
          {
            version: 1,
            validFrom: "2026-08-01",
            validUntil: "2026-11-30",
            scaleVersion: "SV-2025",
            scaleFactor: 1,
            status: "ACTIVE",
            changedAt: "2026-08-01T00:00:00.000Z",
            changeNote: "批次建档",
          },
        ],
      },
      {
        id: "b-mg",
        method: "甲基绿",
        batchCode: "LOT-MG-202603",
        version: 1,
        validFrom: "2026-06-01",
        validUntil: "2026-10-31",
        scaleVersion: "SV-2024",
        scaleFactor: 0.92,
        status: "ACTIVE",
        createdAt: "2026-06-01T00:00:00.000Z",
        history: [
          {
            version: 1,
            validFrom: "2026-06-01",
            validUntil: "2026-10-31",
            scaleVersion: "SV-2024",
            scaleFactor: 0.92,
            status: "ACTIVE",
            changedAt: "2026-06-01T00:00:00.000Z",
            changeNote: "批次建档（沿用 SV-2024 旧标尺）",
          },
        ],
      },
      {
        id: "b-live",
        method: "活体观察（不染色）",
        batchCode: "LOT-LIVE",
        version: 1,
        validFrom: "2026-01-01",
        validUntil: "2027-12-31",
        scaleVersion: "SV-2025",
        scaleFactor: 1,
        status: "ACTIVE",
        createdAt: "2026-01-01T00:00:00.000Z",
        history: [
          {
            version: 1,
            validFrom: "2026-01-01",
            validUntil: "2027-12-31",
            scaleVersion: "SV-2025",
            scaleFactor: 1,
            status: "ACTIVE",
            changedAt: "2026-01-01T00:00:00.000Z",
            changeNote: "活体观察占位批次（无染色剂）",
          },
        ],
      },
    ],
    slides: [
      { id: "sl-onion", name: "洋葱表皮", sampleType: "植物组织", stainBatchId: "b-i2", createdAt: AT },
      { id: "sl-blood", name: "人血涂片", sampleType: "血液涂片", stainBatchId: "b-wright", createdAt: AT },
      { id: "sl-cheek", name: "口腔上皮", sampleType: "动物组织", stainBatchId: "b-mg", createdAt: AT },
      { id: "sl-paramecium", name: "草履虫", sampleType: "微生物", stainBatchId: "b-live", createdAt: AT },
    ],
    users: [
      { role: "student", userId: "s01", name: "林晓" },
      { role: "student", userId: "s02", name: "周禾" },
      { role: "teacher", userId: "t01", name: "沈老师" },
      { role: "admin", userId: "a01", name: "实验管理员" },
    ],
    observations: [],
    audit: [],
    idempotency: {},
  };

  const records: Observation[] = [
    // —— 旧数据：迁移时缺失染色批次版本，一律“待核”，不进入复核队列 ——
    obs({
      id: "o-1001",
      slideId: "sl-onion",
      observerId: "s01",
      observerName: "林晓",
      magnification: "400x",
      structure: "细胞壁 / 细胞核",
      description: "细胞壁清晰，细胞核可见（旧表迁移，未登记批次版本）",
      rawReading: 12,
      measurement: 12,
      submittedAt: "2026-09-12T09:10:00.000Z",
      stainBatchId: "b-i2",
      status: "PENDING_VERIFY",
      idempotencyKey: "legacy:o-1001",
    }),
    obs({
      id: "o-1002",
      slideId: "sl-paramecium",
      observerId: "s02",
      observerName: "周禾",
      magnification: "200x",
      structure: "纤毛 / 口沟",
      description: "纤毛运动明显（旧表迁移，未登记批次版本）",
      rawReading: 30,
      measurement: 30,
      submittedAt: "2026-09-15T10:00:00.000Z",
      stainBatchId: "b-live",
      status: "PENDING_VERIFY",
      idempotencyKey: "legacy:o-1002",
    }),
    // —— 已复核：冻结当时依据，供管理员更新标尺后演示“保留依据 + 复议项” ——
    obs({
      id: "o-1003",
      slideId: "sl-cheek",
      observerId: "s02",
      observerName: "周禾",
      magnification: "400x",
      structure: "细胞核 / 细胞膜",
      description: "细胞核染色较深，细胞膜边界完整",
      rawReading: 50,
      measurement: 46,
      submittedAt: "2026-09-20T11:00:00.000Z",
      stainBatchId: "b-mg",
      stainVersion: 1,
      scaleVersion: "SV-2024",
      status: "APPROVED",
      idempotencyKey: idempotencyKeyOf({ observerId: "s02", slideId: "sl-cheek", magnification: "400x", rawReading: 50 }),
      reviewedAt: "2026-09-22T14:20:00.000Z",
      reviewerId: "t01",
      reviewerName: "沈老师",
      reviewComment: "结构典型，测量值按 SV-2024 标尺校正",
      basisSnapshot: {
        stainBatchId: "b-mg",
        stainVersion: 1,
        validFrom: "2026-06-01",
        validUntil: "2026-10-31",
        scaleVersion: "SV-2024",
        scaleFactor: 0.92,
        frozenAt: "2026-09-22T14:20:00.000Z",
        reviewerId: "t01",
        reviewerName: "沈老师",
      },
    }),
    // —— 已驳回：学生待办里提示重提 ——
    obs({
      id: "o-1004",
      slideId: "sl-blood",
      observerId: "s02",
      observerName: "周禾",
      magnification: "400x",
      structure: "红细胞分布",
      description: "视野边缘有叠连（待重选均匀视野）",
      rawReading: 8.5,
      measurement: 8.5,
      submittedAt: "2026-10-01T09:30:00.000Z",
      stainBatchId: "b-wright",
      stainVersion: 1,
      scaleVersion: "SV-2025",
      status: "REJECTED",
      idempotencyKey: idempotencyKeyOf({ observerId: "s02", slideId: "sl-blood", magnification: "400x", rawReading: 8.5 }),
      reviewedAt: "2026-10-02T08:40:00.000Z",
      reviewerId: "t01",
      reviewerName: "沈老师",
      reviewComment: "细胞叠连，请换均匀视野重拍后提交",
    }),
    // —— 待复核：教师队列按批次×倍数分组 ——
    obs({
      id: "o-1005",
      slideId: "sl-blood",
      observerId: "s01",
      observerName: "林晓",
      magnification: "1000x",
      structure: "红细胞 / 白细胞",
      description: "红细胞分布均匀，可见一个分叶核中性粒细胞",
      rawReading: 7.2,
      measurement: 7.2,
      submittedAt: "2026-10-05T15:10:00.000Z",
      stainBatchId: "b-wright",
      stainVersion: 1,
      scaleVersion: "SV-2025",
      status: "PENDING_REVIEW",
      idempotencyKey: idempotencyKeyOf({ observerId: "s01", slideId: "sl-blood", magnification: "1000x", rawReading: 7.2 }),
    }),
    obs({
      id: "o-1006",
      slideId: "sl-onion",
      observerId: "s02",
      observerName: "周禾",
      magnification: "400x",
      structure: "细胞核",
      description: "细胞核位置居中，核内颗粒可见",
      rawReading: 8,
      measurement: 8,
      submittedAt: "2026-10-02T16:00:00.000Z",
      stainBatchId: "b-i2",
      stainVersion: 1,
      scaleVersion: "SV-2025",
      status: "PENDING_REVIEW",
      idempotencyKey: idempotencyKeyOf({ observerId: "s02", slideId: "sl-onion", magnification: "400x", rawReading: 8 }),
    }),
  ];

  state.observations = records;
  for (const r of records) state.idempotency[r.idempotencyKey] = r.id;

  state.audit = [
    audit("a-1001", "system", "sys", "系统迁移", "data.migrate", "静态观察表迁移入库；缺少批次版本的记录标记为待核"),
    audit("a-1002", "student", "s02", "周禾", "observation.submit", "提交口腔上皮 400x 观察记录", "o-1003"),
    audit("a-1003", "teacher", "t01", "沈老师", "observation.approve", "复核通过并冻结批次 b-mg v1 / SV-2024 依据", "o-1003"),
    audit("a-1004", "student", "s01", "林晓", "observation.submit", "提交人血涂片 1000x 观察记录", "o-1005"),
  ];

  return state;
}
