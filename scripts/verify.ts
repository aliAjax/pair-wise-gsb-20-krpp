/* 端到端规则验证：直接驱动 Store，断言关键流程 */
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离 localStorage 到临时目录的内存实现
class MemStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}
(globalThis as { localStorage?: Storage; window?: unknown }).localStorage = new MemStorage() as unknown as Storage;
(globalThis as { window?: unknown }).window = { location: { reload() {} } };

const { store } = await import("../src/store.ts");
const { SEED_STATE } = await import("../src/seed.ts");

let passed = 0;
function check(name: string, cond: boolean, extra?: string) {
  assert.ok(cond, name + (extra ? ` — ${extra}` : ""));
  passed++;
  console.log(`  ✓ ${name}`);
}

const s = () => store.getState();
const obs = (id: string) => s().observations.find((o) => o.id === id)!;

console.log("1) 越权代写拒绝（学生以他人名义）");
store.setCurrentUser("U-001");
const ghost = store.submitObservation({
  slideId: "SL-04",
  magnification: 400,
  structure: "越权测试",
  description: "以周子墨名义",
  measurementDivs: 2,
  observerId: "U-002",
});
check("代写被拒绝", ghost.ok === false && ghost.denied === "ghostwrite");
check("拒绝写入留痕", store.getAudits().some((a) => a.action === "observation.deny" && a.result === "denied"));
check("拒绝不产生记录", !s().observations.some((o) => o.structure === "越权测试"));

console.log("2) 非学生角色录入拒绝");
store.setCurrentUser("U-T01");
const teacherSubmit = store.submitObservation({
  slideId: "SL-04", magnification: 400, structure: "x", description: "y", measurementDivs: null, observerId: "U-T01",
});
check("教师录入被拒绝", teacherSubmit.ok === false);

console.log("3) 正常提交 + 幂等去重");
store.setCurrentUser("U-001");
const before = s().observations.length;
const r1 = store.submitObservation({
  slideId: "SL-04", magnification: 400, structure: "测试结构A", description: "同一段描述内容", measurementDivs: 3, observerId: "U-001",
});
check("首次提交成功", r1.ok);
const r2 = store.submitObservation({
  slideId: "SL-04", magnification: 400, structure: "测试结构A", description: "同一段描述内容", measurementDivs: 3, observerId: "U-001",
});
check("重复提交不产生第二条", r2.duplicate === true && s().observations.length === before + 1);

console.log("4) 同玻片先到生效 / 后到冲突保留（SL-03 已有 O-1004 生效）");
store.setCurrentUser("U-002");
const conf = store.submitObservation({
  slideId: "SL-03", magnification: 200, structure: "新冲突结构", description: "后到观察者的不同内容", measurementDivs: null, observerId: "U-002",
});
const confObs = s().observations.find((o) => o.structure === "新冲突结构")!;
check("后到记录保存但冲突", conf.ok && confObs.status === "conflict_loser" && confObs.conflictWithId === "O-1004");

console.log("5) 教师按批次×倍数复核");
store.setCurrentUser("U-T01");
const pendingTask = s().tasks.find((t) => t.status === "open" && t.type === "review" && t.groupKey === "B-METH@400x")!;
check("按批次+倍数生成分组任务", !!pendingTask);
const reviewRes = store.review(pendingTask.id, "approved", "结构清晰");
const reviewed = obs(pendingTask.observationId);
check("复核通过并冻结依据", reviewRes.ok && reviewed.status === "approved" && reviewed.basis?.batchVersion === 1 && reviewed.basis.rulerVersionId === "RV-2026");

console.log("6) 管理员调整标尺版本：未复核立即失效重算，已复核生成复议项");
store.setCurrentUser("U-A01");
// 待复核：B-IODINE@400x 的 O-1001；已复核：B-WRIGHT@1000x 的 O-1002
const upd = store.updateBatch("B-WRIGHT", { rulerVersionId: "RV-2025" });
check("批次版本升级", s().batches.find((b) => b.id === "B-WRIGHT")!.version === 2);
check("已复核保留结论+复议项", obs("O-1002").status === "approved" && obs("O-1002").reconsider.some((r) => r.open && r.trigger === "ruler_version"));
check("复议任务已生成", s().tasks.some((t) => t.type === "reconsider" && t.status === "open" && t.observationId === "O-1002"));
check("级联结果提示", upd.ok);

console.log("7) 有效期缩短导致重算后失效");
store.updateBatch("B-IODINE", { validUntil: "2026-09-30" });
check("未复核记录立即进入重算中", obs("O-1001").status === "recalculating");
await new Promise((r) => setTimeout(r, 1400));
check("观察日期 10-06 超出有效期 → 已失效", obs("O-1001").status === "invalidated" && /有效期/.test(obs("O-1001").invalidReason ?? ""));
check("原复核任务被取消", !s().tasks.some((t) => t.observationId === "O-1001" && t.status === "open" && t.type === "review"));

console.log("8) 复议维持：保留当时依据");
const reconsiderTask = s().tasks.find((t) => t.type === "reconsider" && t.status === "open")!;
store.setCurrentUser("U-T01");
store.resolveReconsider(reconsiderTask.id, "maintain", "依据仍有效");
check("复议维持后状态仍 approved", obs("O-1002").status === "approved");
check("复议项关闭且依据未被取代", obs("O-1002").reconsider.every((r) => !r.open) && !obs("O-1002").basis?.superseded);

console.log("9) 复议修订：原依据保留为历史，按新依据重算后重新复核");
store.setCurrentUser("U-A01");
store.updateBatch("B-METH", { rulerVersionId: "RV-2025" }); // O-1004? no — find approved meth
const approvedMeth = s().observations.find((o) => o.status === "approved" && o.batchId === "B-METH");
if (approvedMeth) {
  const rt = s().tasks.find((t) => t.type === "reconsider" && t.status === "open" && t.observationId === approvedMeth.id)!;
  store.setCurrentUser("U-T01");
  store.resolveReconsider(rt.id, "revise", "按新标尺修订");
  check("修订后原依据标记 superseded 但保留", approvedMeth.basis?.superseded === true);
  check("结论进入重算", approvedMeth.status === "recalculating");
  await new Promise((r) => setTimeout(r, 1400));
  check("重算完成重新进入待复核", approvedMeth.status === "pending_review");
  check("按旧标尺 RV-2025 重算数值", approvedMeth.rulerVersionId === "RV-2025");
} else {
  console.log("  - 无 METH 已复核记录，跳过（种子数据中由第5步生成）");
}

console.log("10) 旧数据缺批次版本 → 待核，补核后入复核");
const legacy = obs("O-9001");
check("旧数据待核", legacy.status === "pending_verify" && legacy.batchVersion === null);
store.setCurrentUser("U-A01");
const iodineVersion = s().batches.find((b) => b.id === "B-IODINE")!.version;
const v = store.verifyLegacy("O-9001");
check("补核成功", v.ok && obs("O-9001").status === "pending_review" && obs("O-9001").batchVersion === iodineVersion);
check("补核生成复核任务", s().tasks.some((t) => t.observationId === "O-9001" && t.status === "open"));

console.log("11) 导入：失败整批回滚 + 重复跳过 + 缺版本待核");
store.setCurrentUser("U-A01");
const beforeImport = s().observations.length;
store.armImportCrash();
const badImport = store.importRecords(JSON.stringify([
  { slideId: "SL-01", observerId: "U-002", magnification: 400, structure: "导入1", description: "内容1", measurementDivs: 2 },
]));
check("导入提交失败回滚", badImport.ok === false && s().observations.length === beforeImport);
check("回滚留痕", store.getAudits().some((a) => a.action === "import.rollback"));
const goodImport = store.importRecords(JSON.stringify([
  { slideId: "SL-01", observerId: "U-002", magnification: 400, structure: "导入1", description: "内容1", measurementDivs: 2 },
  { slideId: "SL-01", observerId: "U-002", magnification: 400, structure: "导入1", description: "内容1", measurementDivs: 2 },
]));
const imported = s().observations.find((o) => o.structure === "导入1")!;
check("导入成功且重复仅一条", goodImport.ok && imported.status === "pending_verify");
check("导入记录数只增 1（重复合并）", s().observations.length === beforeImport + 1);

console.log("12) 本地写入截断失败 → 从检查点回滚，不留假成功");
const beforeCrash = s().observations.length;
store.armWriteCrash();
store.setCurrentUser("U-001");
const crashRes = store.submitObservation({
  slideId: "SL-01", magnification: 100, structure: "崩溃测试", description: "这条写入应当被回滚", measurementDivs: null, observerId: "U-001",
});
check("写入失败返回回滚", crashRes.ok === false);
check("回滚后记录数不变", store.getState().observations.length === beforeCrash);
check("系统回滚留痕存在", store.getAudits().some((a) => a.action === "system.rollback"));
check("回滚后仍可正常写入（故障一次性）", store.submitObservation({
  slideId: "SL-01", magnification: 100, structure: "恢复后正常提交", description: "检查点恢复后的新写入", measurementDivs: null, observerId: "U-001",
}).ok);

console.log("13) 原先生效记录失效后，冲突保留记录释放为待复核");
// O-1004 (B-LIVE@200x) 生效，O-1005 冲突；缩短 B-LIVE 有效期让 O-1004 失效
store.setCurrentUser("U-A01");
store.updateBatch("B-LIVE", { validUntil: "2026-09-30" });
await new Promise((r) => setTimeout(r, 1400));
check("O-1004 失效", obs("O-1004").status === "invalidated");
check("O-1005 释放为待复核", obs("O-1005").status === "pending_review" && obs("O-1005").conflictWithId === null);

console.log("14) 统一状态统计覆盖全部口径");
const { statusStats } = await import("../src/domain.ts");
const stats = statusStats(s().observations);
check("统计包含全部 7 种状态", stats.length === 7);
check("统计总数与记录数一致", stats.reduce((n, x) => n + x.count, 0) === s().observations.length);

console.log(`\n全部通过：${passed} 项断言`);
void SEED_STATE;
void mkdtempSync;
void tmpdir;
void join;
