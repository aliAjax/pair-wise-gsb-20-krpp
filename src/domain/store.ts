import type { CheckpointMeta, Command, LabState, Notice } from "./types";
import { applyCommand } from "./reducer";
import { createInitialState } from "./seed";

const STATE_KEY = "hxwl06.state.v3";
const PENDING_KEY = "hxwl06.state.pending";
const CKP_INDEX_KEY = "hxwl06.checkpoints.v3";
const CKP_PREFIX = "hxwl06.ckp.v3.";
const MAX_CHECKPOINTS = 12;

/** FNV-1a 32 位校验和：读回时校验快照完整性 */
export function checksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface CommitOutcome {
  state: LabState;
  notices: Notice[];
  recovered: boolean;
  recoveryAt?: string;
}

type Listener = () => void;

class LabStore {
  state: LabState;
  checkpoints: CheckpointMeta[] = [];
  private listeners = new Set<Listener>();
  private failNext = 0;
  lastRecovery: { at: string; fromCheckpoint: string } | null = null;

  constructor() {
    const loaded = this.bootstrap();
    this.state = loaded.state;
    this.checkpoints = loaded.checkpoints;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  // ---------- 底层读写 ----------

  private readCheckpointIndex(): CheckpointMeta[] {
    try {
      return JSON.parse(localStorage.getItem(CKP_INDEX_KEY) ?? "[]") as CheckpointMeta[];
    } catch {
      return [];
    }
  }

  private writeCheckpointIndex(list: CheckpointMeta[]) {
    localStorage.setItem(CKP_INDEX_KEY, JSON.stringify(list));
  }

  private pack(state: LabState): string {
    return JSON.stringify(state);
  }

  private snapshot(state: LabState, label: string, commandId: string, at: string): CheckpointMeta {
    const body = this.pack(state);
    const meta: CheckpointMeta = {
      id: `ck-${state.seq}`,
      seq: state.seq,
      at,
      commandId,
      label,
      checksum: checksum(body),
    };
    localStorage.setItem(CKP_PREFIX + meta.id, body);
    let list = [...this.readCheckpointIndex(), meta];
    list = list.slice(-MAX_CHECKPOINTS);
    this.writeCheckpointIndex(list);
    // 清理被裁剪检查点的正文
    const alive = new Set(list.map((m) => m.id));
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(CKP_PREFIX) && !alive.has(key.slice(CKP_PREFIX.length))) {
        localStorage.removeItem(key);
      }
    }
    return meta;
  }

  /** 两阶段写入：先写 pending 并读回校验，再覆盖主状态 */
  private commitWrite(state: LabState): void {
    if (this.failNext > 0) {
      this.failNext -= 1;
      // 模拟写一半落盘损坏
      localStorage.setItem(PENDING_KEY, "{corrupted-truncated-write");
      throw new Error("本地写入失败（模拟）：磁盘故障导致快照不完整");
    }
    const body = this.pack(state);
    localStorage.setItem(PENDING_KEY, body);
    const readback = localStorage.getItem(PENDING_KEY) ?? "";
    if (checksum(readback) !== checksum(body)) {
      throw new Error("本地写入校验失败：读回内容与待写入快照不一致");
    }
    localStorage.setItem(STATE_KEY, body);
    localStorage.removeItem(PENDING_KEY);
  }

  private latestValidCheckpoint(): { state: LabState; meta: CheckpointMeta } | null {
    const list = this.readCheckpointIndex();
    for (let i = list.length - 1; i >= 0; i--) {
      const meta = list[i];
      try {
        const body = localStorage.getItem(CKP_PREFIX + meta.id);
        if (body && checksum(body) === meta.checksum) {
          return { state: JSON.parse(body) as LabState, meta };
        }
      } catch {
        // 该检查点损坏，继续向前找
      }
    }
    return null;
  }

  /** 启动加载：主状态损坏时从最近完整检查点恢复；都没有则全新建种子 */
  private bootstrap(): { state: LabState; checkpoints: CheckpointMeta[]; recovered?: CheckpointMeta } {
    const tryMain = (): LabState | null => {
      try {
        const body = localStorage.getItem(STATE_KEY);
        if (!body) return null;
        const parsed = JSON.parse(body) as LabState;
        if (checksum(JSON.stringify(parsed)) !== checksum(body)) return null;
        if (!Array.isArray(parsed.observations) || !Array.isArray(parsed.audit)) return null;
        return parsed;
      } catch {
        return null;
      }
    };

    const main = tryMain();
    if (main) return { state: main, checkpoints: this.readCheckpointIndex() };

    const ck = this.latestValidCheckpoint();
    if (ck) {
      localStorage.setItem(STATE_KEY, this.pack(ck.state));
      localStorage.removeItem(PENDING_KEY);
      this.lastRecovery = { at: new Date().toISOString(), fromCheckpoint: ck.meta.id };
      return { state: ck.state, checkpoints: this.readCheckpointIndex(), recovered: ck.meta };
    }

    const seed = createInitialState();
    localStorage.setItem(STATE_KEY, this.pack(seed));
    const meta = this.snapshot(seed, "初始建档（种子数据）", "seed", new Date().toISOString());
    return { state: seed, checkpoints: [meta] };
  }

  // ---------- 对外操作 ----------

  /** 提交一条命令；本地写入失败则整体回滚并从最近完整检查点恢复 */
  dispatch(command: Command): CommitOutcome {
    const commandId = `cmd-${this.state.seq + 1}-${Date.now().toString(36)}`;
    const result = applyCommand(this.state, { ...command, commandId });

    const label = commandLabel(command);
    try {
      this.commitWrite(result.state);
    } catch (err) {
      // 恢复：内存与主状态都回到最近完整检查点（本次命令不落库）
      const ck = this.latestValidCheckpoint();
      const recoveredState = ck ? ck.state : this.state;
      const at = new Date().toISOString();
      const reason = err instanceof Error ? err.message : String(err);
      recoveredState.audit.push({
        id: `a-${++recoveredState.seq}`,
        at,
        actorId: command.actor.userId,
        actorName: command.actor.name,
        role: command.actor.role,
        action: "checkpoint.recover",
        detail: `写入/导入失败后已从最近完整检查点 ${ck?.meta.id ?? "（无检查点，沿用上一内存状态）"} 恢复；失败原因：${reason}；未完成命令：${label}`,
        commandId,
        denied: true,
        denyReason: reason,
      });
      try {
        localStorage.setItem(STATE_KEY, this.pack(recoveredState));
        localStorage.removeItem(PENDING_KEY);
      } catch {
        // 恢复写也失败：至少内存中保留检查点状态
      }
      this.state = recoveredState;
      this.checkpoints = this.readCheckpointIndex();
      this.lastRecovery = { at, fromCheckpoint: ck?.meta.id ?? "memory" };
      this.emit();
      return {
        state: this.state,
        recovered: true,
        recoveryAt: at,
        notices: [
          { tone: "error", text: "本地写入失败，本次操作未生效" },
          { tone: "ok", text: `已从最近完整检查点 ${ck?.meta.label ?? "内存状态"} 恢复，数据回滚到一致状态` },
        ],
      };
    }

    this.state = result.state;
    const at = new Date().toISOString();
    const meta = this.snapshot(this.state, label, commandId, at);
    this.checkpoints = this.readCheckpointIndex();
    void meta;
    this.emit();
    return { state: this.state, notices: result.notices, recovered: false };
  }

  /** 演练用：让接下来的 N 次写入失败，触发检查点恢复 */
  armWriteFailure(n = 1) {
    this.failNext = n;
  }

  /** 演练用：直接破坏主状态与 pending，下次加载（点“重新载入恢复”）将走检查点恢复 */
  corruptStorage() {
    localStorage.setItem(STATE_KEY, "{broken-on-disk");
    localStorage.setItem(PENDING_KEY, "{broken-pending");
  }

  /** 不新建数据，仅重新执行启动加载流程 */
  reloadFromDisk(): CommitOutcome {
    const loaded = this.bootstrap();
    this.state = loaded.state;
    this.checkpoints = loaded.checkpoints;
    const notices: Notice[] = [];
    if (loaded.recovered) {
      notices.push({ tone: "ok", text: `检测到本地数据损坏，已从检查点 ${loaded.recovered.id} 恢复` });
    } else {
      notices.push({ tone: "info", text: "本地数据完整，无需恢复" });
    }
    this.emit();
    return { state: this.state, notices, recovered: Boolean(loaded.recovered) };
  }

  reset(): void {
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(PENDING_KEY);
    localStorage.removeItem(CKP_INDEX_KEY);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(CKP_PREFIX)) localStorage.removeItem(key);
    }
    const seed = createInitialState();
    localStorage.setItem(STATE_KEY, this.pack(seed));
    this.state = seed;
    this.checkpoints = [this.snapshot(seed, "重置为初始建档", "reset", new Date().toISOString())];
    this.lastRecovery = null;
    this.emit();
  }

  /** 手动恢复到指定检查点（管理员工具） */
  restoreCheckpoint(id: string): CommitOutcome {
    const list = this.readCheckpointIndex();
    const meta = list.find((m) => m.id === id);
    if (!meta) {
      return { state: this.state, notices: [{ tone: "error", text: "检查点不存在" }], recovered: false };
    }
    const body = localStorage.getItem(CKP_PREFIX + id);
    if (!body || checksum(body) !== meta.checksum) {
      return { state: this.state, notices: [{ tone: "error", text: "该检查点已损坏，无法恢复" }], recovered: false };
    }
    const restored = JSON.parse(body) as LabState;
    restored.audit.push({
      id: `a-${++restored.seq}`,
      at: new Date().toISOString(),
      actorId: "a01",
      actorName: "实验管理员",
      role: "admin",
      action: "checkpoint.restore",
      detail: `手动恢复到检查点 ${meta.id}（${meta.label}）`,
      commandId: "manual-restore",
    });
    localStorage.setItem(STATE_KEY, this.pack(restored));
    this.state = restored;
    this.snapshot(restored, `手动恢复自 ${meta.id}`, "manual-restore", new Date().toISOString());
    this.checkpoints = this.readCheckpointIndex();
    this.emit();
    return { state: this.state, notices: [{ tone: "ok", text: `已恢复到检查点 ${meta.label}` }], recovered: true };
  }
}

function commandLabel(command: Command): string {
  switch (command.type) {
    case "submitObservation":
      return "提交观察记录";
    case "simultaneousSubmit":
      return "并发提交演练";
    case "reviewObservation":
      return command.decision === "APPROVE" ? "复核通过" : "复核驳回";
    case "batchReview":
      return "按分组批量复核";
    case "resolveReconsideration":
      return command.resolution === "UPHELD" ? "复议维持" : "复议发回";
    case "updateBatchBasis":
      return "调整批次依据";
    case "verifyLegacy":
      return "旧数据补核";
    case "importObservations":
      return "批量导入观察记录";
  }
}

export const store = new LabStore();
