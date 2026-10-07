import { useSyncExternalStore } from "react";
import type {
  AppState,
  AuditLog,
  Observation,
  ProcStatus,
  ReviewTask,
  Role,
  Slide,
  StainBatch,
  User,
} from "./types";
import {
  buildResultText,
  computeActualUm,
  dateWithin,
  dayOf,
  effectiveOnSlide,
  idemKeyOf,
  nowTs,
  taskGroupKey,
  uid,
} from "./domain";
import {
  DEFAULT_CRASH,
  appendAudit,
  commitState,
  corruptStateStorage,
  loadInitial,
  loadInitialAudits,
  persistCheckpoint,
  type CrashConfig,
} from "./storage";

export interface Outcome {
  ok: boolean;
  denied?: string;
  message: string;
  duplicate?: boolean;
}

export interface SubmitInput {
  slideId: string;
  magnification: number;
  structure: string;
  description: string;
  measurementDivs: number | null;
  observerId: string; // 表单中“以谁的名义提交”
  submittedAt?: number;
}

type Listener = () => void;

const RECALC_DELAY = 1200;

class Store {
  private state: AppState;
  private audits: AuditLog[];
  private users: User[];
  private currentUserId: string;
  private listeners = new Set<Listener>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  crash: CrashConfig = { ...DEFAULT_CRASH };
  lastRecovery: string | null = null;

  constructor() {
    const initial = loadInitial();
    this.state = initial.state;
    this.lastRecovery = initial.recovered ? initial.detail : null;
    this.audits = loadInitialAudits();
    this.users = initial.state.users;
    this.currentUserId = this.users[0].id;
    if (initial.recovered) {
      this.writeAudit({
        action: "system.recover",
        message: initial.detail ?? "已从检查点恢复",
        entityType: "system",
        result: "recovered",
      });
    }
  }

  /* ------------------------------ React 订阅 ------------------------------ */

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): AppState => this.state;
  getAudits = (): AuditLog[] => this.audits;

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  /* -------------------------------- 用户 -------------------------------- */

  currentUser(): User {
    return this.users.find((u) => u.id === this.currentUserId) ?? this.users[0];
  }

  setCurrentUser(id: string): void {
    this.currentUserId = id;
    this.emit();
  }

  role(): Role {
    return this.currentUser().role;
  }

  /* -------------------------------- 留痕 -------------------------------- */

  private writeAudit(
    partial: Omit<AuditLog, "id" | "at" | "actorId" | "actorName">
  ): AuditLog {
    const actor = this.currentUser();
    const log: AuditLog = {
      id: `A-${nowTs().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: nowTs(),
      actorId: actor.id,
      actorName: actor.name,
      ...partial,
    };
    appendAudit(log);
    this.audits = [log, ...this.audits].slice(0, 300);
    return log;
  }

  private nextSeq(): number {
    this.state.seq += 1;
    return this.state.seq;
  }

  /**
   * 事务提交：返回 { state: 回滚后/提交后的状态, outcome }。
   * 失败注入触发一次后自动复位，后续写入恢复正常。
   * 业务留痕仅在提交成功后写入；失败只记录系统回滚留痕，不产生“假成功”。
   */
  private commit(
    label: string,
    pendingAudit?:
      | Omit<AuditLog, "id" | "at" | "actorId" | "actorName">
      | Omit<AuditLog, "id" | "at" | "actorId" | "actorName">[]
  ): { ok: boolean; detail: string | null } {
    const crashOnce: CrashConfig = { ...this.crash };
    if (crashOnce.truncateStateAt != null) this.crash.truncateStateAt = null;
    if (crashOnce.failImportCommit) this.crash.failImportCommit = false;

    const result = commitState(this.state, crashOnce);
    if (!result.ok && result.recovered) {
      this.state = result.state;
      this.lastRecovery = result.detail;
      this.writeAudit({
        action: "system.rollback",
        message: result.detail ?? "写入失败，已回滚到检查点",
        entityType: "system",
        result: "recovered",
        detail: { operation: label },
      });
    } else if (!result.ok) {
      this.lastRecovery = result.detail;
    } else if (pendingAudit) {
      const list = Array.isArray(pendingAudit) ? pendingAudit : [pendingAudit];
      list.forEach((a) => this.writeAudit(a));
    }
    this.emit();
    return { ok: result.ok, detail: result.detail };
  }

  /* ------------------------------ 学生：提交观察 ------------------------------ */

  submitObservation(input: SubmitInput): Outcome {
    const actor = this.currentUser();

    // 规则：只有学生本人可以提交；教师/管理员角色不开放学生录入
    if (actor.role !== "student") {
      this.writeAudit({
        action: "observation.deny",
        message: `提交被拒绝：${actor.name}（${actor.role}）不允许录入学生观察结论`,
        entityType: "observation",
        result: "denied",
      });
      this.emit();
      return { ok: false, denied: "role", message: "仅学生本人可提交观察结论" };
    }

    // 规则：学生越权代写（以他人名义）必须拒绝
    if (input.observerId !== actor.id) {
      const target = this.users.find((u) => u.id === input.observerId);
      this.writeAudit({
        action: "observation.deny",
        message: `越权代写被拒绝：${actor.name} 试图以 ${target?.name ?? input.observerId} 的名义提交观察结论`,
        entityType: "observation",
        result: "denied",
        detail: { actor: actor.id, claimedObserver: input.observerId },
      });
      this.emit();
      return { ok: false, denied: "ghostwrite", message: "拒绝越权代写：只能提交本人观察结论" };
    }

    if (!input.structure.trim() || !input.description.trim()) {
      return { ok: false, message: "观察结构与视野描述为必填项" };
    }
    const slide = this.state.slides.find((s) => s.id === input.slideId && !s.archived);
    if (!slide) return { ok: false, message: "玻片不存在或已归档" };

    const key = idemKeyOf(
      input.observerId,
      input.slideId,
      input.magnification,
      input.structure + input.description
    );

    // 规则：重复提交不生成第二条记录（幂等）
    const existing = this.state.observations.find((o) => o.idemKey === key);
    if (existing) {
      this.writeAudit({
        action: "observation.duplicate",
        message: `重复提交被合并：与 ${existing.id} 内容一致，不生成第二条记录`,
        entityType: "observation",
        entityId: existing.id,
        result: "duplicate",
      });
      this.emit();
      return {
        ok: true,
        duplicate: true,
        message: `重复提交，已存在记录 ${existing.id}，不重复生成`,
      };
    }

    const batch = this.state.batches.find((b) => b.id === slide.stainBatchId && b.active);
    const id = uid("O", this.nextSeq());
    const actual = computeActualUm(
      this.state,
      batch?.rulerVersionId ?? null,
      input.magnification,
      input.measurementDivs
    );
    const winner = effectiveOnSlide(this.state.observations, slide.id);

    const obs: Observation = {
      id,
      idemKey: key,
      slideId: slide.id,
      observerId: actor.id,
      magnification: input.magnification,
      structure: input.structure.trim(),
      description: input.description.trim(),
      measurementDivs: input.measurementDivs,
      resultText: buildResultText(input.structure.trim(), actual),
      computedActualUm: actual,
      submittedAt: input.submittedAt ?? nowTs(),
      batchId: slide.stainBatchId,
      batchVersion: batch ? batch.version : null,
      rulerVersionId: batch ? batch.rulerVersionId : null,
      legacy: false,
      status: "pending_review",
      invalidReason: null,
      conflictWithId: null,
      basis: null,
      reconsider: [],
    };

    let task: ReviewTask | null = null;
    // 规则：同玻片先到结论生效，后到内容保留并显示冲突
    if (winner) {
      obs.status = "conflict_loser";
      obs.conflictWithId = winner.id;
    } else {
      task = {
        id: uid("RT", this.state.seq + 1),
        type: "review",
        observationId: id,
        batchId: obs.batchId,
        batchVersion: obs.batchVersion ?? 1,
        magnification: obs.magnification,
        status: "open",
        createdAt: nowTs(),
        closedAt: null,
        groupKey: taskGroupKey(obs.batchId, obs.magnification),
      };
      this.nextSeq();
    }

    this.state.observations.push(obs);
    if (task) this.state.tasks.push(task);

    const c = this.commit("提交观察 " + id, {
      action: winner ? "observation.conflict" : "observation.submit",
      message: winner
        ? `${actor.name} 提交 ${slide.name} 观察：先生效记录 ${winner.id} 已存在，本次 ${id} 内容保留并标记冲突`
        : `${actor.name} 提交 ${slide.name} 观察 ${id}，结论生效并进入复核队列`,
      entityType: "observation",
      entityId: id,
      result: "ok",
      detail: winner
        ? { winner: winner.id, loser: id }
        : { batchId: obs.batchId, batchVersion: obs.batchVersion, magnification: obs.magnification },
    });
    if (!c.ok) return { ok: false, message: c.detail ?? "提交失败，已回滚" };
    return {
      ok: true,
      message: winner
        ? `已保存为冲突保留（${id}），先生效记录 ${winner.id}`
        : `提交成功（${id}），等待教师按批次/倍数复核`,
    };
  }

  /* ------------------------------ 管理员：旧数据待核 ------------------------------ */

  verifyLegacy(obsId: string): Outcome {
    const actor = this.currentUser();
    if (actor.role !== "admin") {
      this.emit();
      return { ok: false, denied: "role", message: "仅管理员可核对旧数据的批次版本" };
    }
    const o = this.state.observations.find((x) => x.id === obsId);
    if (!o || o.status !== "pending_verify") {
      return { ok: false, message: "记录不在待核状态" };
    }
    const batch = this.state.batches.find((b) => b.id === o.batchId && b.active);
    if (!batch) return { ok: false, message: "对应染色批次不可用，无法核对" };

    const actual = computeActualUm(this.state, batch.rulerVersionId, o.magnification, o.measurementDivs);
    o.batchVersion = batch.version;
    o.rulerVersionId = batch.rulerVersionId;
    o.invalidReason = null;
    o.resultText = buildResultText(o.structure, actual);
    o.computedActualUm = actual;

    // 补核与重算同口径：观察日期不在当前批次有效期内则直接失效，不进入复核
    if (!dateWithin(dayOf(o.submittedAt), batch.validFrom, batch.validUntil)) {
      o.status = "invalidated";
      o.invalidReason = `观察日期 ${dayOf(o.submittedAt)} 不在批次 v${batch.version} 有效期 ${batch.validFrom} ~ ${batch.validUntil} 内`;
      this.writeAudit({
        action: "legacy.verify",
        message: `旧数据 ${o.id} 补核后失效：观察日期不在批次 ${batch.name} v${batch.version} 有效期内`,
        entityType: "observation",
        entityId: o.id,
        result: "ok",
        detail: { batchId: batch.id, batchVersion: batch.version },
      });
      const c0 = this.commit("旧数据补核失效 " + o.id);
      return c0.ok
        ? { ok: true, message: `${o.id} 已补核，但观察日期超出批次有效期，置为已失效` }
        : { ok: false, message: c0.detail ?? "操作失败" };
    }

    o.status = "pending_review";

    this.state.tasks.push({
      id: uid("RT", this.nextSeq()),
      type: "review",
      observationId: o.id,
      batchId: batch.id,
      batchVersion: batch.version,
      magnification: o.magnification,
      status: "open",
      createdAt: nowTs(),
      closedAt: null,
      groupKey: taskGroupKey(batch.id, o.magnification),
    });

    const c = this.commit("旧数据补核 " + o.id, {
      action: "legacy.verify",
      message: `旧数据 ${o.id} 已补核染色批次 ${batch.name} v${batch.version}，进入复核队列`,
      entityType: "observation",
      entityId: o.id,
      result: "ok",
      detail: { batchId: batch.id, batchVersion: batch.version, rulerVersionId: batch.rulerVersionId },
    });
    return c.ok ? { ok: true, message: `${o.id} 已补核，进入待复核` } : { ok: false, message: c.detail ?? "操作失败" };
  }

  /* ----------------------- 管理员：调整批次有效期 / 标尺版本（级联） ----------------------- */

  updateBatch(
    batchId: string,
    patch: { validUntil?: string; rulerVersionId?: string }
  ): Outcome {
    const actor = this.currentUser();
    if (actor.role !== "admin") {
      this.emit();
      return { ok: false, denied: "role", message: "仅管理员可调整染色批次" };
    }
    const batch = this.state.batches.find((b) => b.id === batchId);
    if (!batch) return { ok: false, message: "批次不存在" };
    if (patch.validUntil != null && patch.validUntil < batch.validFrom) {
      return { ok: false, message: "有效期止日不能早于起日" };
    }

    const oldValidUntil = batch.validUntil;
    const oldRulerId = batch.rulerVersionId;
    const validityChanged = patch.validUntil != null && patch.validUntil !== oldValidUntil;
    const rulerChanged = patch.rulerVersionId != null && patch.rulerVersionId !== oldRulerId;
    if (!validityChanged && !rulerChanged) {
      return { ok: true, message: "参数无变化" };
    }

    const newRulerId = patch.rulerVersionId ?? oldRulerId;
    const newValidUntil = patch.validUntil ?? oldValidUntil;
    batch.version += 1;
    batch.validUntil = newValidUntil;
    batch.rulerVersionId = newRulerId;

    const affectedIds: string[] = [];
    let reconsiderCount = 0;

    for (const o of this.state.observations) {
      if (o.batchId !== batchId) continue;

      // 已复核：保留当时依据，列出复议项
      if (o.status === "approved" && o.basis) {
        const items: { trigger: "batch_validity" | "ruler_version"; detail: string; oldValue: string; newValue: string }[] = [];
        if (validityChanged) {
          items.push({
            trigger: "batch_validity",
            detail: `批次有效期由 ${oldValidUntil} 调整为 ${newValidUntil}（v${batch.version}）`,
            oldValue: oldValidUntil,
            newValue: newValidUntil,
          });
        }
        if (rulerChanged) {
          items.push({
            trigger: "ruler_version",
            detail: `标尺版本由 ${oldRulerId} 切换为 ${newRulerId}（v${batch.version}），实测值需重算`,
            oldValue: oldRulerId,
            newValue: newRulerId,
          });
        }
        for (const it of items) {
          const openExisting = o.reconsider.some((r) => r.open && r.trigger === it.trigger);
          if (openExisting) continue;
          o.reconsider.push({
            id: uid("RC", this.state.seq + 1),
            triggeredAt: nowTs(),
            trigger: it.trigger,
            detail: it.detail,
            oldValue: it.oldValue,
            newValue: it.newValue,
            open: true,
          });
          this.nextSeq();
        }
        const hasOpen = this.state.tasks.some(
          (t) => t.type === "reconsider" && t.observationId === o.id && t.status === "open"
        );
        if (!hasOpen) {
          this.state.tasks.push({
            id: uid("RT", this.state.seq + 1),
            type: "reconsider",
            observationId: o.id,
            batchId: batch.id,
            batchVersion: batch.version,
            magnification: o.magnification,
            status: "open",
            createdAt: nowTs(),
            closedAt: null,
            groupKey: taskGroupKey(batch.id, o.magnification),
          });
          this.nextSeq();
          reconsiderCount += 1;
        }
        affectedIds.push(o.id);
        continue;
      }

      // 冲突保留：结论未生效，不做状态级联，仅静默重算数值
      if (o.status === "conflict_loser") {
        o.computedActualUm = computeActualUm(this.state, newRulerId, o.magnification, o.measurementDivs);
        o.resultText = buildResultText(o.structure, o.computedActualUm);
        continue;
      }

      // 未复核的生效/退回/已失效结论：立即失效重算（待核记录补核时再取新版本，此处不动）
      if (o.status === "pending_review" || o.status === "rejected" || o.status === "invalidated") {
        o.status = "recalculating";
        o.invalidReason = null;
        o.batchVersion = batch.version;
        o.rulerVersionId = newRulerId;
        o.computedActualUm = computeActualUm(this.state, newRulerId, o.magnification, o.measurementDivs);
        o.resultText = buildResultText(o.structure, o.computedActualUm);
        for (const t of this.state.tasks) {
          if (t.observationId === o.id && t.status === "open") {
            t.status = "cancelled";
            t.closedAt = nowTs();
          }
        }
        affectedIds.push(o.id);
      }
    }

    const c = this.commit("批次调整 " + batch.id, {
      action: "batch.update",
      message: `批次 ${batch.name} 升级至 v${batch.version}：${affectedIds.length} 条受影响，${reconsiderCount} 条已复核结论生成复议项`,
      entityType: "batch",
      entityId: batch.id,
      result: "ok",
      detail: {
        validUntil: { from: oldValidUntil, to: newValidUntil, changed: validityChanged },
        rulerVersionId: { from: oldRulerId, to: newRulerId, changed: rulerChanged },
        affected: affectedIds,
      },
    });
    if (c.ok && affectedIds.some((id) => this.state.observations.find((o) => o.id === id)?.status === "recalculating")) {
      this.scheduleRecalc(affectedIds);
    }
    return c.ok
      ? {
          ok: true,
          message: `批次已升级至 v${batch.version}：未复核结论已失效重算，${reconsiderCount} 条已复核结论待复议`,
        }
      : { ok: false, message: c.detail ?? "批次调整失败，已回滚" };
  }

  private scheduleRecalc(ids: string[]): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.finishRecalc(ids);
    }, RECALC_DELAY);
    this.timers.add(timer);
  }

  /** 重算落点：批次有效期不覆盖观察时间 → 已失效；否则按新标尺重算并重新进入复核 */
  private finishRecalc(ids: string[]): void {
    const finished: string[] = [];
    for (const id of ids) {
      const o = this.state.observations.find((x) => x.id === id);
      if (!o || o.status !== "recalculating") continue;
      const batch = this.state.batches.find((b) => b.id === o.batchId);
      if (!batch) continue;

      const within = dateWithin(dayOf(o.submittedAt), batch.validFrom, batch.validUntil);
      if (!within) {
        o.status = "invalidated";
        o.invalidReason = `观察日期 ${dayOf(o.submittedAt)} 不在批次 v${batch.version} 有效期 ${batch.validFrom} ~ ${batch.validUntil} 内`;
      } else {
        o.computedActualUm = computeActualUm(this.state, batch.rulerVersionId, o.magnification, o.measurementDivs);
        o.resultText = buildResultText(o.structure, o.computedActualUm);
        o.status = "pending_review";
        o.invalidReason = null;
        this.state.tasks.push({
          id: uid("RT", this.nextSeq()),
          type: "review",
          observationId: o.id,
          batchId: batch.id,
          batchVersion: batch.version,
          magnification: o.magnification,
          status: "open",
          createdAt: nowTs(),
          closedAt: null,
          groupKey: taskGroupKey(batch.id, o.magnification),
        });
      }
      finished.push(o.id);
    }

    if (finished.length > 0) {
      // 原先生效的记录若已失效，释放同玻片最早的冲突保留记录
      const releaseAudits: Omit<AuditLog, "id" | "at" | "actorId" | "actorName">[] = [];
      for (const id of finished) {
        const o = this.state.observations.find((x) => x.id === id);
        if (o && o.status === "invalidated") releaseAudits.push(...this.releaseLosers(id));
      }
      this.commit("重算落点", [
        {
          action: "observation.recalculated",
          message: `重算完成：${finished.join("、")}`,
          entityType: "observation",
          result: "ok",
          detail: { ids: finished },
        },
        ...releaseAudits,
      ]);
    }
  }

  private releaseLosers(
    winnerId: string
  ): Omit<AuditLog, "id" | "at" | "actorId" | "actorName">[] {
    const extra: Omit<AuditLog, "id" | "at" | "actorId" | "actorName">[] = [];
    const losers = this.state.observations
      .filter((o) => o.status === "conflict_loser" && o.conflictWithId === winnerId)
      .sort((a, b) => a.submittedAt - b.submittedAt);
    const first = losers[0];
    if (!first) return extra;
    first.status = "pending_review";
    first.conflictWithId = null;
    first.invalidReason = null;
    this.state.tasks.push({
      id: uid("RT", this.state.seq + 1),
      type: "review",
      observationId: first.id,
      batchId: first.batchId,
      batchVersion: first.batchVersion ?? 1,
      magnification: first.magnification,
      status: "open",
      createdAt: nowTs(),
      closedAt: null,
      groupKey: taskGroupKey(first.batchId, first.magnification),
    });
    this.nextSeq();
    extra.push({
      action: "observation.conflict.release",
      message: `原先生效的 ${winnerId} 失效，冲突保留记录 ${first.id} 转入待复核`,
      entityType: "observation",
      entityId: first.id,
      result: "ok",
    });
    return extra;
  }

  /* ------------------------------ 教师：复核 / 复议 ------------------------------ */

  review(taskId: string, decision: "approved" | "rejected", comment: string): Outcome {
    const actor = this.currentUser();
    if (actor.role !== "teacher") {
      this.emit();
      return { ok: false, denied: "role", message: "仅教师可执行复核" };
    }
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || task.status !== "open" || task.type !== "review") {
      return { ok: false, message: "复核任务不存在或已关闭" };
    }
    const o = this.state.observations.find((x) => x.id === task.observationId);
    if (!o || o.status !== "pending_review") {
      task.status = "cancelled";
      task.closedAt = nowTs();
      this.commit("关闭失效任务");
      return { ok: false, message: "观察记录当前不可复核（可能已被级联失效）" };
    }

    task.status = "done";
    task.closedAt = nowTs();
    const status: ProcStatus = decision === "approved" ? "approved" : "rejected";
    o.status = status;
    o.invalidReason = null;
    o.basis = {
      reviewId: uid("RV", this.state.seq + 1),
      reviewerId: actor.id,
      reviewerName: actor.name,
      reviewedAt: nowTs(),
      decision,
      comment: comment.trim() || (decision === "approved" ? "复核通过" : "复核退回"),
      batchVersion: o.batchVersion ?? 0,
      rulerVersionId: o.rulerVersionId ?? "—",
      validUntil: this.state.batches.find((b) => b.id === o.batchId)?.validUntil ?? "—",
      magnification: o.magnification,
      resultText: o.resultText,
    };
    this.nextSeq();

    const c = this.commit("复核 " + o.id, {
      action: "review.decide",
      message: `${actor.name} 按批次 ${task.batchId} v${task.batchVersion}、${task.magnification}x 分组${
        decision === "approved" ? "通过" : "退回"
      } ${o.id}`,
      entityType: "review",
      entityId: o.id,
      result: "ok",
      detail: {
        group: task.groupKey,
        decision,
        batchVersion: o.basis!.batchVersion,
        rulerVersionId: o.basis!.rulerVersionId,
      },
    });
    return c.ok
      ? { ok: true, message: `${o.id} 复核${decision === "approved" ? "通过" : "退回"}，依据已冻结` }
      : { ok: false, message: c.detail ?? "复核失败，已回滚" };
  }

  resolveReconsider(taskId: string, resolution: "maintain" | "revise", comment: string): Outcome {
    const actor = this.currentUser();
    if (actor.role !== "teacher") {
      this.emit();
      return { ok: false, denied: "role", message: "仅教师可处理复议" };
    }
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || task.status !== "open" || task.type !== "reconsider") {
      return { ok: false, message: "复议任务不存在或已关闭" };
    }
    const o = this.state.observations.find((x) => x.id === task.observationId);
    if (!o || o.status !== "approved") return { ok: false, message: "结论状态已变化" };

    const openItems = o.reconsider.filter((r) => r.open);
    if (resolution === "maintain") {
      task.status = "done";
      task.closedAt = nowTs();
      for (const r of openItems) {
        r.open = false;
        r.resolution = "maintain";
        r.resolvedAt = nowTs();
        r.resolverId = actor.id;
      }
      const c = this.commit("复议维持 " + o.id, {
        action: "review.reconsider.maintain",
        message: `复议维持原结论 ${o.id}：复核当时依据保留（${openItems.length} 项关闭）`,
        entityType: "review",
        entityId: o.id,
        result: "ok",
        detail: { comment, items: openItems.map((r) => r.id) },
      });
      return c.ok ? { ok: true, message: `${o.id} 复议维持，原依据保留` } : { ok: false, message: c.detail ?? "操作失败" };
    }

    // revise：原依据标记被取代并保留，结论立即按新依据重算后重新复核
    task.status = "done";
    task.closedAt = nowTs();
    for (const r of openItems) {
      r.open = false;
      r.resolution = "revise";
      r.resolvedAt = nowTs();
      r.resolverId = actor.id;
    }
    if (o.basis) {
      o.basis.superseded = true;
      o.basis.supersededReason = `复议修订（${comment || "依据新版本重算"}）`;
    }
    o.status = "recalculating";
    o.invalidReason = null;
    const batch = this.state.batches.find((b) => b.id === o.batchId);
    if (batch) {
      o.batchVersion = batch.version;
      o.rulerVersionId = batch.rulerVersionId;
    }

    const c = this.commit("复议修订 " + o.id, {
      action: "review.reconsider.revise",
      message: `复议修订 ${o.id}：原复核依据标记保留为历史，结论按批次 v${batch?.version} 重新计算`,
      entityType: "review",
      entityId: o.id,
      result: "ok",
      detail: { comment, items: openItems.map((r) => r.id) },
    });
    if (c.ok) this.scheduleRecalc([o.id]);
    return c.ok
      ? { ok: true, message: `${o.id} 已按新依据失效重算，完成后重新进入复核` }
      : { ok: false, message: c.detail ?? "操作失败" };
  }

  /* ------------------------------ 管理员：玻片维护 ------------------------------ */

  addSlide(input: { name: string; category: Slide["category"]; stainBatchId: string }): Outcome {
    if (this.currentUser().role !== "admin") {
      this.emit();
      return { ok: false, denied: "role", message: "仅管理员可登记玻片" };
    }
    if (!input.name.trim()) return { ok: false, message: "玻片名称必填" };
    const batch = this.state.batches.find((b) => b.id === input.stainBatchId && b.active);
    if (!batch) return { ok: false, message: "染色批次不可用" };

    const slide: Slide = {
      id: uid("SL", this.nextSeq()),
      name: input.name.trim(),
      category: input.category,
      stainBatchId: batch.id,
      preparedAt: dayOf(nowTs()),
    };
    this.state.slides.push(slide);
    const c = this.commit("登记玻片 " + slide.id, {
      action: "slide.create",
      message: `登记玻片 ${slide.id}（${slide.name}，${batch.name}）`,
      entityType: "slide",
      entityId: slide.id,
      result: "ok",
    });
    return c.ok ? { ok: true, message: `玻片 ${slide.id} 已登记` } : { ok: false, message: c.detail ?? "操作失败" };
  }

  /* ------------------------------ 导入（事务 + 去重） ------------------------------ */

  importRecords(rawText: string): Outcome {
    const actor = this.currentUser();
    if (actor.role !== "admin") {
      this.emit();
      return { ok: false, denied: "role", message: "仅管理员可导入数据" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      this.writeAudit({
        action: "import.fail",
        message: "导入失败：JSON 无法解析，未改动任何数据",
        entityType: "import",
        result: "failed",
      });
      this.emit();
      return { ok: false, message: "JSON 解析失败，导入中止" };
    }
    const rows = Array.isArray(parsed) ? parsed : (parsed as { records?: unknown[] })?.records;
    if (!Array.isArray(rows)) {
      this.writeAudit({
        action: "import.fail",
        message: "导入失败：需要观察记录数组",
        entityType: "import",
        result: "failed",
      });
      this.emit();
      return { ok: false, message: "数据格式不符，导入中止" };
    }

    interface Normalized {
      slideId: string;
      observerId: string;
      magnification: number;
      structure: string;
      description: string;
      measurementDivs: number | null;
      submittedAt: number;
    }
    const normalized: Normalized[] = [];
    const seenKeys = new Set<string>();
    let duplicateCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as Record<string, unknown>;
      const slideId = String(row.slideId ?? "");
      const observerId = String(row.observerId ?? "");
      const magnification = Number(row.magnification);
      const structure = String(row.structure ?? "").trim();
      const description = String(row.description ?? "").trim();
      if (!slideId || !observerId || !magnification || !structure || !description) {
        this.writeAudit({
          action: "import.fail",
          message: `导入失败：第 ${i + 1} 行字段不完整，整批回滚（无部分写入）`,
          entityType: "import",
          result: "failed",
          detail: { rowIndex: i + 1 },
        });
        this.emit();
        return { ok: false, message: `第 ${i + 1} 行字段不完整，整批导入回滚` };
      }
      if (!this.state.slides.some((s) => s.id === slideId)) {
        this.writeAudit({
          action: "import.fail",
          message: `导入失败：第 ${i + 1} 行引用了未知玻片 ${slideId}，整批回滚`,
          entityType: "import",
          result: "failed",
        });
        this.emit();
        return { ok: false, message: `第 ${i + 1} 行玻片编号不存在，整批导入回滚` };
      }
      const divsRaw = row.measurementDivs;
      const key = idemKeyOf(observerId, slideId, magnification, structure + description);
      if (this.state.observations.some((o) => o.idemKey === key) || seenKeys.has(key)) {
        duplicateCount += 1;
        seenKeys.add(key);
        continue;
      }
      seenKeys.add(key);
      const submittedAt = typeof row.submittedAt === "string" ? new Date(row.submittedAt).getTime() : nowTs();
      normalized.push({
        slideId,
        observerId,
        magnification,
        structure,
        description,
        measurementDivs: divsRaw == null || divsRaw === "" ? null : Number(divsRaw),
        submittedAt: Number.isFinite(submittedAt) ? submittedAt : nowTs(),
      });
    }

    if (normalized.length === 0) {
      this.writeAudit({
        action: "import.duplicate",
        message: `导入内容全部为重复记录（${duplicateCount} 条），不生成新记录`,
        entityType: "import",
        result: "duplicate",
      });
      this.emit();
      return { ok: true, duplicate: true, message: `${duplicateCount} 条均为重复提交，未新增记录` };
    }

    const importedIds: string[] = [];
    for (const n of normalized) {
      const slide = this.state.slides.find((s) => s.id === n.slideId)!;
      // 旧导入数据无法携带批次版本 → 待核
      const id = uid("O", this.nextSeq());
      const obs: Observation = {
        id,
        idemKey: idemKeyOf(n.observerId, n.slideId, n.magnification, n.structure + n.description),
        slideId: n.slideId,
        observerId: n.observerId,
        magnification: n.magnification,
        structure: n.structure,
        description: n.description,
        measurementDivs: n.measurementDivs,
        resultText: buildResultText(n.structure, null),
        computedActualUm: null,
        submittedAt: n.submittedAt,
        batchId: slide.stainBatchId,
        batchVersion: null,
        rulerVersionId: null,
        legacy: true,
        status: "pending_verify",
        invalidReason: null,
        conflictWithId: null,
        basis: null,
        reconsider: [],
      };
      this.state.observations.push(obs);
      importedIds.push(id);
    }

    // 导入走同一事务通道；若注入了导入提交失败，则整批回滚到检查点
    const crashOnce: CrashConfig = { ...this.crash, truncateStateAt: null };
    if (crashOnce.failImportCommit) this.crash.failImportCommit = false;
    const result = commitState(this.state, crashOnce);
    if (!result.ok && result.recovered) {
      this.state = result.state;
      this.lastRecovery = result.detail;
      this.writeAudit({
        action: "import.rollback",
        message: "导入提交阶段写入失败，已从最近完整检查点恢复，导入整体回滚",
        entityType: "import",
        result: "recovered",
      });
      this.emit();
      return { ok: false, message: result.detail ?? "导入失败，已回滚" };
    }
    this.writeAudit({
      action: "import.legacy",
      message: `导入 ${importedIds.length} 条记录，缺批次版本已置为待核；${duplicateCount} 条重复被跳过`,
      entityType: "import",
      result: "ok",
      detail: { imported: importedIds, duplicate: duplicateCount },
    });
    this.emit();
    return {
      ok: true,
      message: `导入 ${importedIds.length} 条（待核），跳过重复 ${duplicateCount} 条`,
      duplicate: duplicateCount > 0,
    };
  }

  /* ------------------------------ 检查点 / 故障演练 ------------------------------ */

  createCheckpoint(label: string): Outcome {
    this.state.lastCheckpoint = { at: nowTs(), label: label || "手动完整检查点", seq: (this.state.lastCheckpoint?.seq ?? 0) + 1 };
    persistCheckpoint(this.state);
    this.writeAudit({
      action: "checkpoint.create",
      message: `建立完整检查点：${this.state.lastCheckpoint.label}`,
      entityType: "system",
      result: "ok",
    });
    this.emit();
    return { ok: true, message: "完整检查点已建立" };
  }

  armWriteCrash(): Outcome {
    this.crash.truncateStateAt = 200;
    this.emit();
    return { ok: true, message: "已注入：下一次本地写入将截断失败（随后自动从检查点恢复）" };
  }

  armImportCrash(): Outcome {
    this.crash.failImportCommit = true;
    this.emit();
    return { ok: true, message: "已注入：下一次导入在提交阶段失败（整批回滚）" };
  }

  corruptAndReload(): void {
    corruptStateStorage();
    this.writeAudit({
      action: "system.corrupt",
      message: "故障演练：主存储已破坏，刷新后将从检查点恢复",
      entityType: "system",
      result: "failed",
    });
    setTimeout(() => window.location.reload(), 300);
  }

  resetAll(): Outcome {
    if (this.currentUser().role !== "admin") {
      this.emit();
      return { ok: false, denied: "role", message: "仅管理员可重置" };
    }
    localStorage.removeItem("hxwl06.state.v1");
    localStorage.removeItem("hxwl06.checkpoint.v1");
    localStorage.removeItem("hxwl06.audit.v1");
    setTimeout(() => window.location.reload(), 200);
    return { ok: true, message: "正在重置演示数据…" };
  }

  clearRecoveryNotice(): void {
    this.lastRecovery = null;
    this.emit();
  }
}

export const store = new Store();

export function useStore(): {
  state: AppState;
  audits: AuditLog[];
  currentUser: User;
  recovery: string | null;
} {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const audits = useSyncExternalStore(store.subscribe, store.getAudits);
  return {
    state,
    audits,
    currentUser: store.currentUser(),
    recovery: store.lastRecovery,
  };
}

export type { StainBatch };
