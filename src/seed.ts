import type { AppState, AuditLog, Observation, ReviewTask } from "./types";
import { buildResultText, computeActualUm, idemKeyOf, taskGroupKey } from "./domain";

const DAY = 24 * 3600 * 1000;
const ts = (s: string) => new Date(s.replace(" ", "T") + "+08:00").getTime();

function buildSeedState(): AppState {
  const state: AppState = {
    seq: 2000,
    users: [
      { id: "U-001", name: "林晓雯", role: "student", className: "高二(3)班" },
      { id: "U-002", name: "周子墨", role: "student", className: "高二(3)班" },
      { id: "U-T01", name: "沈老师", role: "teacher" },
      { id: "U-A01", name: "系统管理员", role: "admin" },
    ],
    rulers: [
      {
        id: "RV-2025",
        name: "2025 级目镜测微尺标定",
        scaleByMag: { 100: 10, 200: 5, 400: 2.5, 1000: 1 },
        note: "按 2025 学年镜台测微尺标定，每格标称整值",
      },
      {
        id: "RV-2026",
        name: "2026 级目镜测微尺标定",
        scaleByMag: { 100: 9.8, 200: 4.9, 400: 2.45, 1000: 0.98 },
        note: "2026-09 重新标定，修正物镜齐焦误差",
      },
    ],
    batches: [
      {
        id: "B-IODINE",
        name: "碘液染液",
        method: "碘液染色",
        version: 1,
        validFrom: "2026-09-01",
        validUntil: "2026-12-31",
        rulerVersionId: "RV-2026",
        active: true,
      },
      {
        id: "B-WRIGHT",
        name: "瑞氏染液",
        method: "瑞氏染色",
        version: 1,
        validFrom: "2026-09-01",
        validUntil: "2026-11-30",
        rulerVersionId: "RV-2026",
        active: true,
      },
      {
        id: "B-LIVE",
        name: "活体培养液",
        method: "活体观察",
        version: 1,
        validFrom: "2026-09-15",
        validUntil: "2026-10-15",
        rulerVersionId: "RV-2026",
        active: true,
      },
      {
        id: "B-METH",
        name: "亚甲基蓝染液",
        method: "亚甲基蓝染色",
        version: 1,
        validFrom: "2026-09-01",
        validUntil: "2026-12-31",
        rulerVersionId: "RV-2026",
        active: true,
      },
    ],
    slides: [
      { id: "SL-01", name: "洋葱表皮", category: "植物组织", stainBatchId: "B-IODINE", preparedAt: "2026-10-06" },
      { id: "SL-02", name: "人血涂片", category: "血液涂片", stainBatchId: "B-WRIGHT", preparedAt: "2026-10-05" },
      { id: "SL-03", name: "草履虫培养液", category: "微生物", stainBatchId: "B-LIVE", preparedAt: "2026-10-07" },
      { id: "SL-04", name: "人口腔上皮", category: "动物组织", stainBatchId: "B-METH", preparedAt: "2026-10-06" },
    ],
    observations: [],
    tasks: [],
    lastCheckpoint: {
      at: ts("2026-10-05 08:00:00"),
      label: "初始完整检查点",
      seq: 1,
    },
  };

  const legacy = (
    id: string,
    slideId: string,
    observerId: string,
    mag: number,
    structure: string,
    description: string,
    submittedAt: number
  ): Observation => ({
    id,
    idemKey: idemKeyOf(observerId, slideId, mag, structure + description),
    slideId,
    observerId,
    magnification: mag,
    structure,
    description,
    measurementDivs: null,
    resultText: buildResultText(structure, null),
    computedActualUm: null,
    submittedAt,
    batchId: state.slides.find((s) => s.id === slideId)!.stainBatchId,
    batchVersion: null,
    rulerVersionId: null,
    legacy: true,
    status: "pending_verify",
    invalidReason: null,
    conflictWithId: null,
    basis: null,
    reconsider: [],
  });

  const normal = (
    id: string,
    slideId: string,
    observerId: string,
    mag: number,
    structure: string,
    description: string,
    divs: number | null,
    submittedAt: number,
    status: Observation["status"] = "pending_review"
  ): Observation => {
    const slide = state.slides.find((s) => s.id === slideId)!;
    const batch = state.batches.find((b) => b.id === slide.stainBatchId)!;
    const actual = computeActualUm(state, batch.rulerVersionId, mag, divs);
    return {
      id,
      idemKey: idemKeyOf(observerId, slideId, mag, structure + description),
      slideId,
      observerId,
      magnification: mag,
      structure,
      description,
      measurementDivs: divs,
      resultText: buildResultText(structure, actual),
      computedActualUm: actual,
      submittedAt,
      batchId: batch.id,
      batchVersion: batch.version,
      rulerVersionId: batch.rulerVersionId,
      legacy: false,
      status,
      invalidReason: null,
      conflictWithId: null,
      basis: null,
      reconsider: [],
    };
  };

  const reviewTask = (o: Observation, createdAt: number): ReviewTask => ({
    id: `RT-${o.id}`,
    type: "review",
    observationId: o.id,
    batchId: o.batchId,
    batchVersion: o.batchVersion ?? 1,
    magnification: o.magnification,
    status: "open",
    createdAt,
    closedAt: null,
    groupKey: taskGroupKey(o.batchId, o.magnification),
  });

  const obs: Observation[] = [
    // 旧数据：缺批次版本 → 待核
    legacy("O-9001", "SL-01", "U-001", 400, "细胞壁、细胞核", "细胞壁清晰，细胞核可见", ts("2026-09-20 10:12:00")),
    legacy("O-9002", "SL-02", "U-002", 1000, "红细胞", "红细胞分布均匀", ts("2026-09-21 14:30:00")),
    legacy("O-9003", "SL-03", "U-001", 200, "纤毛", "纤毛运动明显", ts("2026-09-22 09:05:00")),
    // 正常提交，待复核
    normal("O-1001", "SL-01", "U-001", 400, "细胞壁与细胞核", "表皮细胞排列整齐，核被碘液染成棕黄，测量长径 6 格", 6, ts("2026-10-06 10:02:00")),
    normal("O-1003", "SL-04", "U-001", 400, "细胞核", "上皮细胞核染色较深，测量核径 5 格", 5, ts("2026-10-06 11:20:00")),
    // 同玻片两人先后提交：先到生效，后到冲突保留
    normal("O-1004", "SL-03", "U-001", 200, "纤毛、口沟", "纤毛摆动明显，体长约 4 格", 4, ts("2026-10-07 09:15:00")),
  ];

  const loser = normal(
    "O-1005",
    "SL-03",
    "U-002",
    200,
    "伸缩泡、收集管",
    "观察到伸缩泡节律收缩，内容与先到记录不同",
    null,
    ts("2026-10-07 09:18:00"),
    "conflict_loser"
  );
  loser.conflictWithId = "O-1004";
  obs.push(loser);

  const approved = normal(
    "O-1002",
    "SL-02",
    "U-002",
    1000,
    "红细胞直径",
    "红细胞双凹圆盘状，直径约 7.5 格，分布均匀",
    7.5,
    ts("2026-10-06 15:40:00"),
    "approved"
  );
  approved.basis = {
    reviewId: "RV-O-1002",
    reviewerId: "U-T01",
    reviewerName: "沈老师",
    reviewedAt: ts("2026-10-06 16:10:00"),
    decision: "approved",
    comment: "红细胞形态与直径测量符合预期",
    batchVersion: 1,
    rulerVersionId: "RV-2026",
    validUntil: "2026-11-30",
    magnification: 1000,
    resultText: approved.resultText,
  };
  obs.push(approved);

  state.observations = obs.sort((a, b) => a.submittedAt - b.submittedAt);
  state.tasks = obs
    .filter((o) => o.status === "pending_review")
    .map((o) => reviewTask(o, o.submittedAt + 5 * 60 * 1000));

  return state;
}

export const SEED_STATE: AppState = buildSeedState();

export const SEED_AUDITS: AuditLog[] = [
  {
    id: "A-0001",
    at: ts("2026-10-05 08:00:00"),
    actorId: "system",
    actorName: "系统",
    action: "checkpoint.create",
    message: "建立初始完整检查点",
    entityType: "system",
    result: "ok",
  },
  {
    id: "A-0002",
    at: ts("2026-10-05 08:05:00"),
    actorId: "system",
    actorName: "系统",
    action: "import.legacy",
    message: "导入 3 条历史观察记录，缺少染色批次版本，已置为待核",
    entityType: "import",
    result: "ok",
    detail: { count: 3 },
  },
];

export { DAY, ts };
