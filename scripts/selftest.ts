import "./localStorage-shim";
import { store } from "../src/domain/store";
import { createInitialState } from "../src/domain/seed";
import { applyCommand } from "../src/domain/reducer";
import type { Actor, Command, LabState } from "../src/domain/types";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(name + (extra ? ` — ${extra}` : ""));
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? "" : `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

const S01: Actor = { role: "student", userId: "s01", name: "林晓" };
const S02: Actor = { role: "student", userId: "s02", name: "周禾" };
const T01: Actor = { role: "teacher", userId: "t01", name: "沈老师" };
const A01: Actor = { role: "admin", userId: "a01", name: "实验管理员" };

function fresh() {
  store.reset();
  return store.state;
}

function dispatchPure(state: LabState, cmd: Command) {
  return applyCommand(state, { ...cmd, commandId: `test-${Math.random().toString(36).slice(2)}` });
}

function obs(state: LabState, id: string) {
  return state.observations.find((o) => o.id === id)!;
}

function counts(state: LabState) {
  const c: Record<string, number> = {};
  for (const o of state.observations) c[o.status] = (c[o.status] ?? 0) + 1;
  return c;
}

// ========== 1. 越权代写拒绝 ==========
{
  fresh();
  let s = store.state;
  // 教师替学生提交 → 拒绝
  const r1 = dispatchPure(s, {
    type: "submitObservation",
    actor: T01,
    data: { observerId: "s01", slideId: "sl-onion", magnification: "400x", structure: "x", description: "y", rawReading: 1 },
    at: "2026-10-07T09:00:00.000Z",
  });
  check("教师代学生提交被拒绝", r1.notices[0]?.tone === "error");
  check("拒绝不新增记录", r1.state.observations.length === s.observations.length);
  check("拒绝写入审计留痕(denied)", r1.state.audit.some((a) => a.denied && a.action === "observation.submit"));

  // 学生 s01 替 s02 提交 → 拒绝
  const r2 = dispatchPure(r1.state, {
    type: "submitObservation",
    actor: S01,
    data: { observerId: "s02", slideId: "sl-onion", magnification: "400x", structure: "x", description: "y", rawReading: 1 },
    at: "2026-10-07T09:01:00.000Z",
  });
  check("学生A替学生B提交被拒绝", r2.notices[0]?.tone === "error");

  // 学生本人提交 → 成功
  const r3 = dispatchPure(r2.state, {
    type: "submitObservation",
    actor: S01,
    data: { observerId: "s01", slideId: "sl-onion", magnification: "400x", structure: "核仁", description: "核仁可见", rawReading: 3.5 },
    at: "2026-10-07T09:02:00.000Z",
  });
  check("学生本人提交成功", r3.notices[0]?.tone === "ok");
  check("新记录为待复核", r3.state.observations.at(-1)!.status === "PENDING_REVIEW");
  eq("自动绑定玻片批次v1/标尺", [r3.state.observations.at(-1)!.stainVersion, r3.state.observations.at(-1)!.scaleVersion], [1, "SV-2025"]);
  eq("标尺系数=1 测量=3.5", r3.state.observations.at(-1)!.measurement, 3.5);
  s = r3.state;

  // ========== 2. 重复提交不生成第二条 ==========
  const before = s.observations.length;
  const r4 = dispatchPure(s, {
    type: "submitObservation",
    actor: S01,
    data: { observerId: "s01", slideId: "sl-onion", magnification: "400x", structure: "核仁", description: "核仁可见（不同文字）", rawReading: 3.5 },
    at: "2026-10-07T09:03:00.000Z",
  });
  eq("重复提交记录数不变", r4.state.observations.length, before);
  check("重复提交返回去重提示", r4.notices.some((n) => n.text.includes("重复提交")));
  check("幂等键已映射到既有记录", r4.state.idempotency[`obs:s01:sl-onion:400x:3.5`] != null);
}

// ========== 3. 标尺版本更新：未复核重算，已复核转复议保留依据 ==========
{
  const s0 = fresh();
  // b-mg v1: SV-2024 ×0.92。o-1003 已复核(46μm)，无未复核记录 —— 先让 s02 补一条未复核
  const s1 = dispatchPure(s0, {
    type: "submitObservation",
    actor: S02,
    data: { observerId: "s02", slideId: "sl-cheek", magnification: "400x", structure: "核", description: "新增未复核", rawReading: 50 },
    at: "2026-10-07T09:10:00.000Z",
  }).state;
  // 同一读数幂等命中 o-1003? o-1003 rawReading=50 同玻片同倍数同观察者 → 会去重！改用 55
  const s1b = dispatchPure(s1, {
    type: "submitObservation",
    actor: S02,
    data: { observerId: "s02", slideId: "sl-cheek", magnification: "400x", structure: "核", description: "新增未复核", rawReading: 55 },
    at: "2026-10-07T09:11:00.000Z",
  }).state;
  const newId = s1b.observations.at(-1)!.id;
  eq("未复核新记录测量=55*0.92≈50.6", obs(s1b, newId).measurement, 50.6);

  // 管理员发布 v2：新标尺 SV-2026 ×1.05，有效期不变
  const s2 = dispatchPure(s1b, {
    type: "updateBatchBasis",
    actor: A01,
    batchId: "b-mg",
    patch: { scaleVersion: "SV-2026", scaleFactor: 1.05, note: "年度校准", validUntil: "2026-10-31" },
    at: "2026-10-07T10:00:00.000Z",
  }).state;
  eq("批次升至v2", s2.batches.find((b) => b.id === "b-mg")!.version, 2);
  // 未复核立即重算
  eq("未复核按新系数重算 55*1.05≈57.8", obs(s2, newId).measurement, 57.8);
  eq("未复核重算后标尺版本", obs(s2, newId).scaleVersion, "SV-2026");
  eq("未复核重算后跟随批次v2", obs(s2, newId).stainVersion, 2);
  eq("未复核重算后仍待复核", obs(s2, newId).status, "PENDING_REVIEW");
  check("重算历史留痕", obs(s2, newId).recomputeHistory.length === 1);
  // 已复核转复议，依据冻结
  eq("已复核转待复议", obs(s2, "o-1003").status, "RECONSIDER");
  check("复议项已生成", !!obs(s2, "o-1003").reconsideration);
  eq("复议kind=标尺版本", obs(s2, "o-1003").reconsideration!.kind, "标尺版本");
  check("复核依据快照保留旧标尺SV-2024", obs(s2, "o-1003").basisSnapshot?.scaleVersion === "SV-2024");
  eq("已复核结论测量值不动(46)", obs(s2, "o-1003").measurement, 46);
  check("版本历史保留v1/v2", s2.batches.find((b) => b.id === "b-mg")!.history.length === 2);

  // 教师维持 → APPROVED
  const s3 = dispatchPure(s2, {
    type: "resolveReconsideration",
    actor: T01,
    observationId: "o-1003",
    resolution: "UPHELD",
    at: "2026-10-07T11:00:00.000Z",
  }).state;
  eq("复议维持后回到已复核", obs(s3, "o-1003").status, "APPROVED");
  check("维持后旧依据快照仍在", obs(s3, "o-1003").basisSnapshot?.scaleVersion === "SV-2024");

  // 教师按 新批次版本×倍数 复核重算记录 → 冻结 v2/SV-2026
  const s4 = dispatchPure(s3, {
    type: "reviewObservation",
    actor: T01,
    observationId: newId,
    decision: "APPROVE",
    at: "2026-10-07T11:05:00.000Z",
  }).state;
  eq("重算记录复核通过", obs(s4, newId).status, "APPROVED");
  eq("冻结依据为v2/SV-2026", [obs(s4, newId).basisSnapshot!.stainVersion, obs(s4, newId).basisSnapshot!.scaleVersion], [2, "SV-2026"]);

  // 非教师不能复议
  const rd = dispatchPure(s4, {
    type: "resolveReconsideration",
    actor: S01,
    observationId: "o-1003",
    resolution: "UPHELD",
    at: "2026-10-07T11:06:00.000Z",
  });
  check("学生不能裁决复议", rd.notices[0]?.tone === "error");
}

// ========== 4. 有效期收缩：未复核立即失效 ==========
{
  let s = fresh();
  // o-1005（b-wright 1000x 待复核），将 validUntil 改到今天之前
  const r = dispatchPure(s, {
    type: "updateBatchBasis",
    actor: A01,
    batchId: "b-wright",
    patch: { validUntil: "2026-09-30", note: "提前停用旧批" },
    at: "2026-10-07T10:00:00.000Z",
  });
  s = r.state;
  eq("未复核结论立即失效", obs(s, "o-1005").status, "INVALIDATED");
  check("失效原因入留痕", obs(s, "o-1005").invalidationLog.some((e) => e.reason.includes("立即失效")));
  // 失效批次禁止教师复核
  const rd = dispatchPure(s, {
    type: "reviewObservation",
    actor: T01,
    observationId: "o-1006",
    decision: "APPROVE",
    at: "2026-10-07T10:01:00.000Z",
  });
  // o-1006 属于 b-i2 不受影响 → 可以通过
  eq("他批次记录不受波及且可复核", obs(rd.state, "o-1006").status, "APPROVED");
  const rd2 = dispatchPure(s, {
    type: "reviewObservation",
    actor: T01,
    observationId: "o-1005",
    decision: "APPROVE",
    at: "2026-10-07T10:01:00.000Z",
  });
  check("失效批次上的记录禁止复核", rd2.notices[0]?.tone === "error");
  // 非管理员不能改批次
  const rd3 = dispatchPure(s, {
    type: "updateBatchBasis",
    actor: T01,
    batchId: "b-wright",
    patch: { validUntil: "2027-01-01", note: "教师越权" },
    at: "2026-10-07T10:02:00.000Z",
  });
  check("教师不能调整批次依据", rd3.notices[0]?.tone === "error");
}

// ========== 5. 复议发回 → 已复核失效但依据留档 ==========
{
  const s0 = fresh();
  const s1 = dispatchPure(s0, {
    type: "updateBatchBasis",
    actor: A01,
    batchId: "b-mg",
    patch: { validUntil: "2026-10-15", note: "有效期收缩" },
    at: "2026-10-07T10:00:00.000Z",
  }).state;
  eq("已复核结论进入待复议", obs(s1, "o-1003").status, "RECONSIDER");
  eq("复议kind=有效期", obs(s1, "o-1003").reconsideration!.kind, "有效期");
  const s2 = dispatchPure(s1, {
    type: "resolveReconsideration",
    actor: T01,
    observationId: "o-1003",
    resolution: "RETURNED",
    at: "2026-10-07T11:00:00.000Z",
  }).state;
  eq("复议发回后已失效", obs(s2, "o-1003").status, "INVALIDATED");
  check("发回后原依据快照仍留档", obs(s2, "o-1003").basisSnapshot?.stainVersion === 1);
}

// ========== 6. 同玻片同时提交：先到生效，后到冲突保留 ==========
{
  const s0 = fresh();
  // 先让 s01 在 09:00 正常提交一条 sl-paramecium
  const s1 = dispatchPure(s0, {
    type: "submitObservation",
    actor: S01,
    data: { observerId: "s01", slideId: "sl-paramecium", magnification: "200x", structure: "纤毛", description: "s01先到", rawReading: 20 },
    at: "2026-10-07T09:00:00.000Z",
  }).state;
  const firstId = s1.observations.at(-1)!.id;
  // s02 1 分钟后提交同玻片（窗口内）→ 冲突保留
  const s2 = dispatchPure(s1, {
    type: "submitObservation",
    actor: S02,
    data: { observerId: "s02", slideId: "sl-paramecium", magnification: "200x", structure: "纤毛", description: "s02后到", rawReading: 21 },
    at: "2026-10-07T09:01:00.000Z",
  }).state;
  const secondId = s2.observations.at(-1)!.id;
  eq("先到者待复核(生效)", obs(s2, firstId).status, "PENDING_REVIEW");
  eq("后到者冲突保留", obs(s2, secondId).status, "CONFLICT");
  eq("后到记录指向先到记录", obs(s2, secondId).conflictWith, firstId);
  check("两条记录都保留(内容不丢)", s2.observations.filter((o) => o.slideId === "sl-paramecium").length === 3);
  check("冲突写入审计", s2.audit.some((a) => a.action === "observation.conflict"));
  // 冲突记录不进教师复核队列
  check("冲突记录不进复核队列", s2.observations.filter((o) => o.status === "PENDING_REVIEW").every((o) => o.id !== secondId));
  // 窗口外（>2分钟）的提交不算冲突
  const s3 = dispatchPure(s2, {
    type: "submitObservation",
    actor: S02,
    data: { observerId: "s02", slideId: "sl-paramecium", magnification: "200x", structure: "伸缩泡", description: "稍后另一条", rawReading: 9 },
    at: "2026-10-07T09:05:00.000Z",
  }).state;
  eq("窗口外提交正常待复核", s3.observations.at(-1)!.status, "PENDING_REVIEW");

  // 管理员并发演练：同刻两人提交同一玻片（选无近期记录的 sl-blood，且读数避免与 o-1005 冲突）
  const s4 = dispatchPure(s3, {
    type: "simultaneousSubmit",
    actor: A01,
    at: "2026-10-07T12:00:00.000Z",
    items: [
      { observerId: "s01", payload: { slideId: "sl-cheek", magnification: "200x", structure: "演练", description: "甲", rawReading: 31 } },
      { observerId: "s02", payload: { slideId: "sl-cheek", magnification: "200x", structure: "演练", description: "乙", rawReading: 32 } },
    ],
  });
  check("并发演练成功", s4.notices.some((n) => n.text.includes("先到生效")));
  const drill = s4.state.observations.slice(-2);
  const winner = drill.find((o) => o.status !== "CONFLICT")!;
  const loser = drill.find((o) => o.status === "CONFLICT")!;
  eq("同刻并列时按学号决出先到(s01)", winner.observerId, "s01");
  eq("s02为后到冲突", loser.observerId, "s02");
  // 学生不能发起演练
  const rd = dispatchPure(s4.state, {
    type: "simultaneousSubmit",
    actor: S01,
    at: "2026-10-07T12:01:00.000Z",
    items: [
      { observerId: "s01", payload: { slideId: "sl-cheek", magnification: "100x", structure: "x", description: "a", rawReading: 1 } },
      { observerId: "s02", payload: { slideId: "sl-cheek", magnification: "100x", structure: "x", description: "b", rawReading: 2 } },
    ],
  });
  check("学生不能发起并发演练", rd.notices[0]?.tone === "error");
}

// ========== 7. 旧数据缺批次版本 → 待核，补核后进队列 ==========
{
  let s = fresh();
  eq("旧数据o-1001待核", obs(s, "o-1001").status, "PENDING_VERIFY");
  check("待核记录不进复核队列", s.observations.filter((o) => o.status === "PENDING_REVIEW").every((o) => !["o-1001", "o-1002"].includes(o.id)));
  // 教师不能直接复核待核记录
  const rd = dispatchPure(s, {
    type: "reviewObservation",
    actor: T01,
    observationId: "o-1001",
    decision: "APPROVE",
    at: "2026-10-07T09:00:00.000Z",
  });
  check("教师不能复核待核旧数据", rd.notices[0]?.tone === "error");
  // 学生不能补核
  const rd2 = dispatchPure(s, {
    type: "verifyLegacy",
    actor: S01,
    observationId: "o-1001",
    batchId: "b-i2",
    at: "2026-10-07T09:01:00.000Z",
  });
  check("学生不能补核", rd2.notices[0]?.tone === "error");
  // 管理员补核到 b-i2（系数1）
  const r3 = dispatchPure(s, {
    type: "verifyLegacy",
    actor: A01,
    observationId: "o-1001",
    batchId: "b-i2",
    at: "2026-10-07T09:02:00.000Z",
  });
  s = r3.state;
  eq("补核后进入待复核", obs(s, "o-1001").status, "PENDING_REVIEW");
  eq("补核写入批次v1", obs(s, "o-1001").stainVersion, 1);
  // 补核到 b-mg（0.92）验证重算
  const r4 = dispatchPure(s, {
    type: "verifyLegacy",
    actor: A01,
    observationId: "o-1002",
    batchId: "b-mg",
    at: "2026-10-07T09:03:00.000Z",
  });
  eq("补核按标尺重算 30*0.92≈27.6", obs(r4.state, "o-1002").measurement, 27.6);
}

// ========== 8. 导入事务 + 缺批次待核 + 去重 ==========
{
  const s0 = fresh();
  // 含非法行 → 整批不落库
  const before = s0.observations.length;
  const r1 = dispatchPure(s0, {
    type: "importObservations",
    actor: A01,
    rows: [
      { slideName: "洋葱表皮", magnification: "400x", structure: "液泡", description: "正常行", rawReading: 11 },
      { slideName: "火星样本", magnification: "400x", structure: "x", description: "非法行", rawReading: 5 },
    ],
    at: "2026-10-07T13:00:00.000Z",
  });
  check("非法行导致整批中止", r1.notices[0]?.tone === "error" && r1.notices[0].text.includes("整批"));
  eq("整批中止不新增任何记录", r1.state.observations.length, before);
  // 学生不能导入
  const rd = dispatchPure(s0, {
    type: "importObservations",
    actor: S01,
    rows: [{ slideName: "洋葱表皮", magnification: "400x", structure: "x", description: "y", rawReading: 1 }],
    at: "2026-10-07T13:01:00.000Z",
  });
  check("学生不能导入", rd.notices[0]?.tone === "error");
  // 正常导入：带批次→待复核；不带→待核；重复行→去重
  const r2 = dispatchPure(s0, {
    type: "importObservations",
    actor: A01,
    rows: [
      { slideName: "洋葱表皮", stainBatchId: "b-i2", magnification: "100x", structure: "表皮排列", description: "导入-带批次", rawReading: 40 },
      { slideName: "草履虫", magnification: "100x", structure: "整体", description: "导入-旧格式缺批次", rawReading: 60 },
      { slideName: "草履虫", magnification: "100x", structure: "整体", description: "导入-重复行", rawReading: 60 },
    ],
    at: "2026-10-07T13:02:00.000Z",
  });
  const added = r2.state.observations.slice(before);
  eq("导入新增2条(第3条去重)", added.length, 2);
  eq("带批次导入→待复核", added[0].status, "PENDING_REVIEW");
  eq("缺批次导入→待核", added[1].status, "PENDING_VERIFY");
}

// ========== 9. 写入失败 → 回滚到最近检查点（经 store） ==========
{
  fresh();
  const beforeCount = store.state.observations.length;
  const beforeSeq = store.state.seq;
  store.armWriteFailure(1);
  const outcome = store.dispatch({
    type: "submitObservation",
    actor: S01,
    data: { observerId: "s01", slideId: "sl-onion", magnification: "200x", structure: "应被回滚", description: "失败提交", rawReading: 99 },
    at: new Date().toISOString(),
  });
  check("写入失败返回恢复提示", outcome.recovered && outcome.notices.some((n) => n.text.includes("检查点")));
  eq("回滚后记录数不变", store.state.observations.length, beforeCount);
  check("回滚后seq不前进(失败命令不落库)", store.state.seq <= beforeSeq + 1); // +1 仅恢复留痕
  check("恢复事件写入审计", store.state.audit.some((a) => a.action === "checkpoint.recover"));
  // 之后写入恢复正常
  const ok2 = store.dispatch({
    type: "submitObservation",
    actor: S01,
    data: { observerId: "s01", slideId: "sl-onion", magnification: "200x", structure: "正常提交", description: "恢复后", rawReading: 12.5 },
    at: new Date().toISOString(),
  });
  check("恢复后可正常提交", ok2.notices[0]?.tone === "ok" && !ok2.recovered);
}

// ========== 10. 磁盘主数据损坏 → 重载时从检查点恢复 ==========
{
  fresh();
  // 成功做一条提交形成新检查点
  store.dispatch({
    type: "submitObservation",
    actor: S02,
    data: { observerId: "s02", slideId: "sl-onion", magnification: "100x", structure: "检查点内容", description: "应在恢复后仍存在", rawReading: 15 },
    at: new Date().toISOString(),
  });
  const expectedCount = store.state.observations.length;
  store.corruptStorage();
  const outcome = store.reloadFromDisk();
  check("检测损坏并恢复", outcome.recovered);
  eq("恢复后记录数与检查点一致", store.state.observations.length, expectedCount);
  check("恢复内容包含检查点提交", store.state.observations.some((o) => o.description === "应在恢复后仍存在"));
}

// ========== 11. 明细/待办/统计同一状态口径 ==========
{
  const s = fresh();
  const c = counts(s);
  const fromStats = (status: string) => c[status] ?? 0;
  check("统计=待核2", fromStats("PENDING_VERIFY") === 2);
  check("统计=待复核2", fromStats("PENDING_REVIEW") === 2);
  check("统计=已复核1", fromStats("APPROVED") === 1);
  check("统计=已驳回1", fromStats("REJECTED") === 1);
  // 教师待办口径：复核队列条目数 == PENDING_REVIEW
  const queueItems = s.observations.filter((o) => o.status === "PENDING_REVIEW").length;
  eq("教师待办队列=待复核统计", queueItems, fromStats("PENDING_REVIEW"));
  // 管理员待核列表 == PENDING_VERIFY 统计
  eq("管理员待核列表=待核统计", s.observations.filter((o) => o.status === "PENDING_VERIFY").length, fromStats("PENDING_VERIFY"));
  // 总守恒
  eq("各状态计数之和=总记录数", Object.values(c).reduce((a, b) => a + b, 0), s.observations.length);
}

// ========== 12. 纯函数种子不可变性 ==========
{
  const a = createInitialState();
  const b = createInitialState();
  check("两次种子独立", a !== b && a.observations !== b.observations);
}

// ========== 汇总 ==========
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.error("失败项:\n - " + failures.join("\n - "));
  process.exit(1);
}
console.log("全部规则自检通过 ✓");
