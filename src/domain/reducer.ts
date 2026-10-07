import type {
  ApplyResult,
  Command,
  LabState,
  Notice,
  Observation,
  StainBatch,
} from "./types";
import {
  batchOf,
  batchOfSlide,
  idempotencyKeyOf,
  nextId,
  slideOf,
  userOf,
} from "./status";

const CONCURRENCY_WINDOW_MS = 2 * 60 * 1000; // 同一玻片并发提交窗口：2 分钟内视为“同时提交”

type BoundCommand = Command & { commandId: string };

function clone(state: LabState): LabState {
  return structuredClone(state);
}

function timeOf(at: string): number {
  return new Date(at).getTime();
}

export class DomainError extends Error {}

function addAudit(
  state: LabState,
  cmd: BoundCommand,
  action: string,
  detail: string,
  targetId?: string,
  extra?: { denied?: boolean; denyReason?: string },
) {
  state.audit.push({
    id: nextId(state, "a"),
    at: cmd.at,
    actorId: cmd.actor.userId,
    actorName: cmd.actor.name,
    role: cmd.actor.role,
    action,
    detail,
    targetId,
    commandId: cmd.commandId,
    denied: extra?.denied,
    denyReason: extra?.denyReason,
  });
}

function deny(state: LabState, cmd: BoundCommand, action: string, reason: string, targetId?: string): ApplyResult {
  addAudit(state, cmd, action, `已拒绝：${reason}`, targetId, { denied: true, denyReason: reason });
  return {
    state,
    commandId: cmd.commandId,
    notices: [{ tone: "error", text: `操作被拒绝：${reason}（已记录操作留痕）` }],
  };
}

function ok(state: LabState, commandId: string, notices: Notice[] = []): ApplyResult {
  return { state, commandId, notices };
}

/** 依据在指定日期是否有效（有效期含首尾） */
function basisValidOn(b: Pick<StainBatch, "validFrom" | "validUntil" | "status">, date: string): boolean {
  return b.status === "ACTIVE" && date >= b.validFrom && date <= b.validUntil;
}

/** 用批次标尺系数把原始读数折算为测量值（μm 保留 1 位） */
function calibrate(raw: number, factor: number): number {
  return Math.round(raw * factor * 10) / 10;
}

function buildObservation(
  state: LabState,
  cmd: { at: string },
  observerId: string,
  data: { slideId: string; magnification: string; structure: string; description: string; rawReading: number },
  opts: { detectConflict?: boolean } = { detectConflict: true },
): { observation: Observation; existing?: Observation; conflictWinner?: Observation } {
  const slide = slideOf(state, data.slideId);
  if (!slide) throw new DomainError("样本不存在");
  const observer = userOf(state, observerId);
  if (!observer || observer.role !== "student") throw new DomainError("观察者必须是在册学生");

  const key = idempotencyKeyOf({
    observerId,
    slideId: data.slideId,
    magnification: data.magnification,
    rawReading: data.rawReading,
  });
  const existingId = state.idempotency[key];
  const existing = existingId ? state.observations.find((o) => o.id === existingId) : undefined;

  const batch = batchOfSlide(state, data.slideId);
  if (!batch) throw new DomainError("玻片未绑定染色批次");
  const measurement = calibrate(data.rawReading, batch.scaleFactor);

  const base: Observation = {
    id: nextId(state, "o"),
    slideId: data.slideId,
    observerId,
    observerName: observer.name,
    magnification: data.magnification,
    structure: data.structure,
    description: data.description,
    rawReading: data.rawReading,
    measurement,
    stainBatchId: batch.id,
    stainVersion: batch.version,
    scaleVersion: batch.scaleVersion,
    status: "PENDING_REVIEW",
    submittedAt: cmd.at,
    idempotencyKey: key,
    invalidationLog: [],
    recomputeHistory: [],
  };

  if (existing) return { observation: base, existing };

  // 同一玻片上已生效的提交（先到者）：冲突保留内容，但不生效（演练模式跳过，由演练统一裁决）
  if (opts.detectConflict !== false) {
    const winner = state.observations
      .filter((o) => o.slideId === data.slideId && o.status !== "CONFLICT")
      .filter((o) => Math.abs(timeOf(o.submittedAt) - timeOf(cmd.at)) <= CONCURRENCY_WINDOW_MS)
      .sort((a, b) => {
        const t = timeOf(a.submittedAt) - timeOf(b.submittedAt);
        if (t !== 0) return t;
        return a.observerId.localeCompare(b.observerId);
      })[0];

    if (winner) {
      base.status = "CONFLICT";
      base.conflictWith = winner.id;
      return { observation: base, conflictWinner: winner };
    }
  }
  return { observation: base };
}

// ---------- 管理员调整批次依据：级联失效 / 重算 / 复议 ----------

function cascadeBatchChange(
  state: LabState,
  cmd: BoundCommand,
  batch: StainBatch,
  before: { version: number; validFrom: string; validUntil: string; scaleVersion: string; scaleFactor: number; status: StainBatch["status"] },
  after: { version: number; validFrom: string; validUntil: string; scaleVersion: string; scaleFactor: number; status: StainBatch["status"] },
): Notice[] {
  const notices: Notice[] = [];
  const today = cmd.at.slice(0, 10);
  const windowShrunk = after.validUntil < before.validUntil || after.validFrom > before.validFrom;
  const becameInactive = before.status === "ACTIVE" && after.status === "DISCONTINUED";
  const scaleChanged = after.scaleVersion !== before.scaleVersion;
  const changedKinds: string[] = [];
  if (windowShrunk) changedKinds.push("有效期");
  if (scaleChanged) changedKinds.push("标尺版本");
  if (becameInactive) changedKinds.push("批次状态");

  let invalidated = 0;
  let recomputed = 0;
  let reconsidered = 0;

  for (const o of state.observations) {
    if (o.stainBatchId !== batch.id || o.stainVersion !== before.version) continue;

    if (o.status === "APPROVED") {
      // 已复核：保留当时依据，列复议项
      const kind = (changedKinds[0] ?? "有效期") as "有效期" | "标尺版本" | "批次状态";
      o.status = "RECONSIDER";
      o.reconsideration = {
        id: nextId(state, "rc"),
        raisedAt: cmd.at,
        kind,
        fromVersion: before.version,
        toVersion: after.version,
        detail:
          `批次 ${batch.batchCode} 依据变更（${changedKinds.join("、")}）：` +
          `有效期 ${before.validFrom}~${before.validUntil} → ${after.validFrom}~${after.validUntil}；` +
          `标尺 ${before.scaleVersion}(×${before.scaleFactor}) → ${after.scaleVersion}(×${after.scaleFactor})；` +
          `原结论与复核依据已冻结保留。`,
      };
      reconsidered += 1;
      continue;
    }

    if (o.status !== "PENDING_REVIEW") continue; // 待核/冲突/失效/驳回不受级联影响

    // 未复核：立即失效并重算
    const nowInvalid = becameInactive || !basisValidOn(after, today);
    if (nowInvalid) {
      o.status = "INVALIDATED";
      o.invalidationLog.push({
        at: cmd.at,
        reason: `批次 ${batch.batchCode} v${after.version} 当前不在有效期${becameInactive ? "（批次已停用）" : ""}，未复核结论立即失效，需按新批次重做`,
        causeCommandId: cmd.commandId,
      });
      invalidated += 1;
    } else if (scaleChanged) {
      const newMeasurement = calibrate(o.rawReading, after.scaleFactor);
      o.recomputeHistory.push({
        at: cmd.at,
        causeCommandId: cmd.commandId,
        fromScaleVersion: before.scaleVersion,
        toScaleVersion: after.scaleVersion,
        fromFactor: before.scaleFactor,
        toFactor: after.scaleFactor,
        fromMeasurement: o.measurement,
        toMeasurement: newMeasurement,
      });
      // 重算后跟随新批次版本，教师按 批次版本×倍数 复核时与现行依据一致
      o.stainVersion = after.version;
      o.measurement = newMeasurement;
      o.scaleVersion = after.scaleVersion;
      recomputed += 1;
    } else {
      // 有效期放宽等不影响测量的调整：版本跟随新批次，状态不变，仅留痕
      o.stainVersion = after.version;
      o.invalidationLog.push({
        at: cmd.at,
        reason: `批次依据变更（${changedKinds.join("、") || "备注更新"}），当前结论仍满足新有效期，继续待复核；依据跟随 v${after.version}`,
        causeCommandId: cmd.commandId,
      });
    }
  }

  if (invalidated) notices.push({ tone: "warn", text: `${invalidated} 条未复核结论已立即失效，需重做` });
  if (recomputed) notices.push({ tone: "ok", text: `${recomputed} 条未复核结论已按新标尺 ${after.scaleVersion} 重算测量值` });
  if (reconsidered) notices.push({ tone: "warn", text: `${reconsidered} 条已复核结论保留原依据，已生成复议项` });
  if (!notices.length) notices.push({ tone: "info", text: "当前没有受该版本影响的结论" });
  return notices;
}

// ---------- 主分发 ----------

export function applyCommand(input: LabState, command: BoundCommand): ApplyResult {
  const state = clone(input);
  const cmd: BoundCommand = command;

  switch (cmd.type) {
    case "submitObservation": {
      const { actor, data } = cmd;
      // 权限：只有学生能提交，且必须本人 —— 越权代写（教师/管理员代交、学生 A 替学生 B 交）一律拒绝
      if (actor.role !== "student") {
        return deny(state, cmd, "observation.submit", "学生观察记录只允许学生本人提交，教师/管理员代交属于越权代写", data.slideId);
      }
      if (actor.userId !== data.observerId) {
        const target = userOf(state, data.observerId);
        return deny(
          state,
          cmd,
          "observation.submit",
          `不能为他人提交：当前身份是 ${actor.name}，被代写人是 ${target?.name ?? data.observerId}`,
          data.slideId,
        );
      }
      let built;
      try {
        built = buildObservation(state, cmd, data.observerId, data);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return deny(state, cmd, "observation.submit", reason, data.slideId);
      }
      const { observation, existing, conflictWinner } = built;

      if (existing) {
        // 重复提交不生成第二条记录
        addAudit(state, cmd, "observation.submit.dedup", `重复提交命中幂等键，未生成第二条记录（关联 ${existing.id}）`, existing.id);
        return ok(state, cmd.commandId, [
          { tone: "warn", text: `重复提交：该内容已存在（${existing.id}，${existing.status}），未生成第二条记录` },
        ]);
      }

      state.observations.push(observation);
      state.idempotency[observation.idempotencyKey] = observation.id;
      if (conflictWinner) {
        addAudit(
          state,
          cmd,
          "observation.conflict",
          `同一玻片并发提交：先到结论 ${conflictWinner.id}（${conflictWinner.observerName}）生效，本条 ${observation.id}（${observation.observerName}）内容保留并标记冲突`,
          observation.id,
        );
        return ok(state, cmd.commandId, [
          {
            tone: "error",
            text: `并发冲突：${conflictWinner.observerName} 的先到结论已生效，你的内容已保留为“冲突保留”，可在明细中对照`,
          },
        ]);
      }
      addAudit(state, cmd, "observation.submit", `提交 ${observation.magnification} 观察记录，批次 v${observation.stainVersion} / ${observation.scaleVersion}`, observation.id);
      return ok(state, cmd.commandId, [{ tone: "ok", text: `提交成功（${observation.id}），进入待复核队列` }]);
    }

    case "simultaneousSubmit": {
      // 并发演练：仅管理员可发起（裁判角色），两名观察者仍以各自身份提交，代写检查逐条执行
      if (cmd.actor.role !== "admin") {
        return deny(state, cmd, "simulation.run", "并发提交演练仅管理员可发起");
      }
      if (cmd.items.length !== 2) {
        return deny(state, cmd, "simulation.run", "并发演练必须提供两名观察者的提交");
      }
      const slideIds = new Set(cmd.items.map((i) => i.payload.slideId));
      if (slideIds.size !== 1) {
        return deny(state, cmd, "simulation.run", "并发演练要求两名观察者提交同一玻片");
      }
      const notices: Notice[] = [];
      const created: Observation[] = [];
      for (const item of cmd.items) {
        const observer = userOf(state, item.observerId);
        if (!observer || observer.role !== "student") {
          return deny(state, cmd, "simulation.run", `观察者 ${item.observerId} 不是在册学生`);
        }
        // 以观察者本人身份走同一套建单逻辑（含幂等）；同玻片冲突由演练在两条都建完后统一裁决
        const built = buildObservation(state, { at: cmd.at }, item.observerId, { ...item.payload }, { detectConflict: false });
        if (built.existing) {
          return deny(state, cmd, "simulation.run", `${observer.name} 的提交与现有记录 ${built.existing.id} 完全重复，请调整读数后演练`);
        }
        state.observations.push(built.observation);
        state.idempotency[built.observation.idempotencyKey] = built.observation.id;
        created.push(built.observation);
      }
      // 同刻提交：先到者由提交时刻 + 观察者编号确定性决出，后到者改判冲突保留
      const [first, second] = [...created].sort((a, b) => {
        const t = timeOf(a.submittedAt) - timeOf(b.submittedAt);
        if (t !== 0) return t;
        return a.observerId.localeCompare(b.observerId);
      });
      second.status = "CONFLICT";
      second.conflictWith = first.id;
      addAudit(
        state,
        cmd,
        "observation.concurrent",
        `同一玻片并发演练：${first.observerName}（${first.id}）先到生效；${second.observerName}（${second.id}）后到，内容保留并标记冲突`,
      );
      notices.push({ tone: "warn", text: `并发结果：${first.observerName} 先到生效，${second.observerName} 内容保留为冲突` });
      return ok(state, cmd.commandId, notices);
    }

    case "reviewObservation": {
      if (cmd.actor.role !== "teacher") {
        return deny(state, cmd, "observation.review", "复核任务仅教师可执行");
      }
      const o = state.observations.find((x) => x.id === cmd.observationId);
      if (!o) return deny(state, cmd, "observation.review", "记录不存在");
      if (o.status !== "PENDING_REVIEW") {
        return deny(state, cmd, "observation.review", `当前状态为“${o.status}”，只有待复核记录可复核`, o.id);
      }
      const batch = batchOf(state, o.stainBatchId);
      if (!batch || o.stainVersion !== batch.version) {
        return deny(state, cmd, "observation.review", "依据版本与当前批次不一致，该记录需要重新进入流程", o.id);
      }
      const today = cmd.at.slice(0, 10);
      if (!basisValidOn(batch, today)) {
        return deny(state, cmd, "observation.review", "批次当前不在有效期，不能据此复核，请等待管理员处理", o.id);
      }

      if (cmd.decision === "APPROVE") {
        o.status = "APPROVED";
        o.reviewedAt = cmd.at;
        o.reviewerId = cmd.actor.userId;
        o.reviewerName = cmd.actor.name;
        o.reviewComment = cmd.comment ?? "复核通过";
        // 冻结当时依据：以后批次再变，也能看清当时按什么通过的
        o.basisSnapshot = {
          stainBatchId: batch.id,
          stainVersion: batch.version,
          validFrom: batch.validFrom,
          validUntil: batch.validUntil,
          scaleVersion: batch.scaleVersion,
          scaleFactor: batch.scaleFactor,
          frozenAt: cmd.at,
          reviewerId: cmd.actor.userId,
          reviewerName: cmd.actor.name,
        };
        addAudit(state, cmd, "observation.approve", `复核通过，冻结 ${batch.batchCode} v${batch.version} / ${batch.scaleVersion} 依据`, o.id);
        return ok(state, cmd.commandId, [{ tone: "ok", text: `已通过复核（${o.id}），依据已冻结` }]);
      }
      o.status = "REJECTED";
      o.reviewedAt = cmd.at;
      o.reviewerId = cmd.actor.userId;
      o.reviewerName = cmd.actor.name;
      o.reviewComment = cmd.comment ?? "复核不通过";
      addAudit(state, cmd, "observation.reject", `驳回：${o.reviewComment}`, o.id);
      return ok(state, cmd.commandId, [{ tone: "info", text: `已驳回（${o.id}），学生可修改后重新提交` }]);
    }

    case "batchReview": {
      if (cmd.actor.role !== "teacher") {
        return deny(state, cmd, "observation.batchReview", "批量复核仅教师可执行");
      }
      const targets = state.observations.filter(
        (o) =>
          o.status === "PENDING_REVIEW" &&
          o.stainBatchId === cmd.batchId &&
          o.stainVersion === cmd.stainVersion &&
          o.magnification === cmd.magnification,
      );
      if (!targets.length) {
        return deny(state, cmd, "observation.batchReview", "该批次×倍数分组下没有待复核记录");
      }
      const batch = batchOf(state, cmd.batchId);
      if (!batch) return deny(state, cmd, "observation.batchReview", "批次不存在");
      const today = cmd.at.slice(0, 10);
      if (!basisValidOn(batch, today)) {
        return deny(state, cmd, "observation.batchReview", "批次当前不在有效期，不能批量复核");
      }
      for (const o of targets) {
        o.status = "APPROVED";
        o.reviewedAt = cmd.at;
        o.reviewerId = cmd.actor.userId;
        o.reviewerName = cmd.actor.name;
        o.reviewComment = `按 ${batch.batchCode} v${batch.version} × ${o.magnification} 分组批量通过`;
        o.basisSnapshot = {
          stainBatchId: batch.id,
          stainVersion: batch.version,
          validFrom: batch.validFrom,
          validUntil: batch.validUntil,
          scaleVersion: batch.scaleVersion,
          scaleFactor: batch.scaleFactor,
          frozenAt: cmd.at,
          reviewerId: cmd.actor.userId,
          reviewerName: cmd.actor.name,
        };
      }
      addAudit(state, cmd, "observation.batchApprove", `批量通过 ${targets.length} 条（${batch.batchCode} v${batch.version} / ${cmd.magnification}）`);
      return ok(state, cmd.commandId, [{ tone: "ok", text: `已按分组批量通过 ${targets.length} 条记录` }]);
    }

    case "resolveReconsideration": {
      if (cmd.actor.role !== "teacher") {
        return deny(state, cmd, "reconsideration.resolve", "复议裁决仅教师可执行");
      }
      const o = state.observations.find((x) => x.id === cmd.observationId);
      if (!o?.reconsideration) return deny(state, cmd, "reconsideration.resolve", "该记录没有待裁决的复议项");
      if (o.status !== "RECONSIDER") return deny(state, cmd, "reconsideration.resolve", "复议项已裁决");
      const rc = o.reconsideration;
      rc.resolution = cmd.resolution;
      rc.resolvedAt = cmd.at;
      rc.resolvedBy = cmd.actor.name;
      rc.note = cmd.note;
      if (cmd.resolution === "UPHELD") {
        o.status = "APPROVED";
        addAudit(state, cmd, "reconsideration.upheld", `复议维持原结论（${o.id}），复核依据快照保留`, o.id);
        return ok(state, cmd.commandId, [{ tone: "ok", text: `已维持原结论（${o.id}），当时依据继续有效` }]);
      }
      o.status = "INVALIDATED";
      o.invalidationLog.push({
        at: cmd.at,
        reason: `复议发回：依据已变更为 v${rc.toVersion}，教师要求学生重做`,
        causeCommandId: cmd.commandId,
      });
      addAudit(state, cmd, "reconsideration.returned", `复议发回重做（${o.id}），原结论与依据留档`, o.id);
      return ok(state, cmd.commandId, [{ tone: "warn", text: `已发回重做（${o.id}），原结论留档可溯` }]);
    }

    case "updateBatchBasis": {
      if (cmd.actor.role !== "admin") {
        return deny(state, cmd, "batch.updateBasis", "批次有效期与标尺版本仅实验管理员可调整");
      }
      const batch = batchOf(state, cmd.batchId);
      if (!batch) return deny(state, cmd, "batch.updateBasis", "批次不存在");
      const before = {
        version: batch.version,
        validFrom: batch.validFrom,
        validUntil: batch.validUntil,
        scaleVersion: batch.scaleVersion,
        scaleFactor: batch.scaleFactor,
        status: batch.status,
      };
      const next = {
        validFrom: cmd.patch.validFrom ?? batch.validFrom,
        validUntil: cmd.patch.validUntil ?? batch.validUntil,
        scaleVersion: cmd.patch.scaleVersion ?? batch.scaleVersion,
        scaleFactor: cmd.patch.scaleFactor ?? batch.scaleFactor,
        status: cmd.patch.status ?? batch.status,
      };
      if (next.validUntil < next.validFrom) {
        return deny(state, cmd, "batch.updateBasis", "有效期结束日不能早于开始日");
      }
      if (
        next.validUntil === before.validUntil &&
        next.validFrom === before.validFrom &&
        next.scaleVersion === before.scaleVersion &&
        next.scaleFactor === before.scaleFactor &&
        next.status === before.status
      ) {
        return deny(state, cmd, "batch.updateBasis", "没有任何实质变更");
      }

      const newVersion = before.version + 1;
      batch.version = newVersion;
      batch.validFrom = next.validFrom;
      batch.validUntil = next.validUntil;
      batch.scaleVersion = next.scaleVersion;
      batch.scaleFactor = next.scaleFactor;
      batch.status = next.status;
      batch.history.push({
        version: newVersion,
        validFrom: next.validFrom,
        validUntil: next.validUntil,
        scaleVersion: next.scaleVersion,
        scaleFactor: next.scaleFactor,
        status: next.status,
        changedAt: cmd.at,
        changeNote: cmd.patch.note,
      });

      addAudit(
        state,
        cmd,
        "batch.basisChanged",
        `批次 ${batch.batchCode} 发布 v${newVersion}：有效期/标尺/状态调整（${cmd.patch.note}）`,
        batch.id,
      );
      const notices = cascadeBatchChange(state, cmd, batch, before, { ...next, version: newVersion });
      return ok(state, cmd.commandId, notices);
    }

    case "verifyLegacy": {
      if (cmd.actor.role !== "admin") {
        return deny(state, cmd, "legacy.verify", "旧数据补核仅实验管理员可执行");
      }
      const o = state.observations.find((x) => x.id === cmd.observationId);
      if (!o) return deny(state, cmd, "legacy.verify", "记录不存在");
      if (o.status !== "PENDING_VERIFY") return deny(state, cmd, "legacy.verify", "该记录不是待核状态", o.id);
      const batch = batchOf(state, cmd.batchId);
      if (!batch) return deny(state, cmd, "legacy.verify", "批次不存在");
      const before = o.measurement;
      o.stainBatchId = batch.id;
      o.stainVersion = batch.version;
      o.scaleVersion = batch.scaleVersion;
      o.measurement = calibrate(o.rawReading, batch.scaleFactor);
      o.status = "PENDING_REVIEW";
      o.invalidationLog.push({
        at: cmd.at,
        reason: `管理员补核：绑定 ${batch.batchCode} v${batch.version} / ${batch.scaleVersion}，测量值 ${before}→${o.measurement}μm`,
        causeCommandId: cmd.commandId,
      });
      addAudit(state, cmd, "legacy.verify", `旧数据补核完成，进入待复核（${batch.batchCode} v${batch.version}）`, o.id);
      return ok(state, cmd.commandId, [{ tone: "ok", text: `补核完成（${o.id}），已进入教师复核队列` }]);
    }

    case "importObservations": {
      if (cmd.actor.role !== "admin") {
        return deny(state, cmd, "import.run", "导入仅实验管理员可执行");
      }
      if (!cmd.rows.length) return deny(state, cmd, "import.run", "导入内容为空");

      // 事务：先整批校验，任一行不合法则整体不落库
      const planned: {
        observerId: string;
        slideId: string;
        magnification: string;
        structure: string;
        description: string;
        rawReading: number;
        withBatch: boolean;
      }[] = [];
      for (const [idx, row] of cmd.rows.entries()) {
        const slide = state.slides.find((s) => s.name === row.slideName);
        if (!slide) return deny(state, cmd, "import.run", `第 ${idx + 1} 行样本“${row.slideName}”不存在，整批导入已中止`);
        const observerId = row.observerId ?? "s01";
        const observer = userOf(state, observerId);
        if (!observer || observer.role !== "student") {
          return deny(state, cmd, "import.run", `第 ${idx + 1} 行观察者 ${observerId} 不在册，整批导入已中止`);
        }
        planned.push({
          observerId,
          slideId: slide.id,
          magnification: row.magnification,
          structure: row.structure,
          description: row.description,
          rawReading: row.rawReading,
          withBatch: Boolean(row.stainBatchId),
        });
      }

      let normal = 0;
      let pending = 0;
      let skipped = 0;
      for (const item of planned) {
        const key = idempotencyKeyOf({
          observerId: item.observerId,
          slideId: item.slideId,
          magnification: item.magnification,
          rawReading: item.rawReading,
        });
        if (item.withBatch) {
          const built = buildObservation(state, { at: cmd.at }, item.observerId, item);
          if (built.existing) {
            skipped += 1;
            continue;
          }
          state.observations.push(built.observation);
          state.idempotency[built.observation.idempotencyKey] = built.observation.id;
          normal += 1;
        } else {
          // 旧数据缺批次版本：先待核（重复行不生成第二条记录）
          if (state.idempotency[key]) {
            skipped += 1;
            continue;
          }
          const observer = userOf(state, item.observerId)!;
          const slide = slideOf(state, item.slideId)!;
          const slideBatch = batchOfSlide(state, slide.id)!;
          const o: Observation = {
            id: nextId(state, "o"),
            slideId: slide.id,
            observerId: observer.userId,
            observerName: observer.name,
            magnification: item.magnification,
            structure: item.structure,
            description: item.description + "（导入：缺批次版本）",
            rawReading: item.rawReading,
            measurement: item.rawReading,
            stainBatchId: slideBatch.id,
            stainVersion: null,
            scaleVersion: null,
            status: "PENDING_VERIFY",
            submittedAt: cmd.at,
            idempotencyKey: key,
            invalidationLog: [],
            recomputeHistory: [],
          };
          state.observations.push(o);
          state.idempotency[key] = o.id;
          pending += 1;
        }
      }
      addAudit(state, cmd, "import.run", `导入完成：${normal} 条待复核，${pending} 条缺批次版本待核，${skipped} 条重复已去重`);
      return ok(state, cmd.commandId, [
        { tone: "ok", text: `导入成功：${normal} 条进入待复核，${pending} 条标记待核${skipped ? `，${skipped} 条重复未生成新记录` : ""}` },
      ]);
    }
  }
}
