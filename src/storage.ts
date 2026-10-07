import type { AppState, AuditLog } from "./types";
import { SEED_AUDITS, SEED_STATE } from "./seed";
import { hashText } from "./domain";

export const STATE_KEY = "hxwl06.state.v1";
export const CHECKPOINT_KEY = "hxwl06.checkpoint.v1";
export const AUDIT_KEY = "hxwl06.audit.v1";

export interface Envelope<T> {
  v: 1;
  kind: string;
  checksum: string;
  data: T;
}

export interface CrashConfig {
  /** 写入主存储时截断到 N 字节，模拟本地写入失败 */
  truncateStateAt: number | null;
  /** 导入流程在提交阶段失败 */
  failImportCommit: boolean;
}

export const DEFAULT_CRASH: CrashConfig = {
  truncateStateAt: null,
  failImportCommit: false,
};

function pack<T>(kind: string, data: T): Envelope<T> {
  const body = JSON.stringify(data);
  return { v: 1, kind, checksum: hashText(kind + "::" + body), data };
}

function unpack<T>(raw: string | null, kind: string): T | null {
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as Envelope<T>;
    if (env.v !== 1 || env.kind !== kind) return null;
    const body = JSON.stringify(env.data);
    if (env.checksum !== hashText(kind + "::" + body)) return null;
    return env.data;
  } catch {
    return null;
  }
}

export function basicValidate(state: unknown): state is AppState {
  if (!state || typeof state !== "object") return false;
  const s = state as AppState;
  return (
    typeof s.seq === "number" &&
    Array.isArray(s.users) &&
    Array.isArray(s.slides) &&
    Array.isArray(s.batches) &&
    Array.isArray(s.rulers) &&
    Array.isArray(s.observations) &&
    Array.isArray(s.tasks)
  );
}

export function readState(): AppState | null {
  return unpack<AppState>(localStorage.getItem(STATE_KEY), "state");
}

export function readCheckpoint(): AppState | null {
  return unpack<AppState>(localStorage.getItem(CHECKPOINT_KEY), "checkpoint");
}

export function readAudits(): AuditLog[] {
  return unpack<AuditLog[]>(localStorage.getItem(AUDIT_KEY), "audits") ?? [];
}

/** 读取启动状态：主存储损坏时从最近完整检查点恢复 */
export function loadInitial(): { state: AppState; recovered: boolean; detail: string | null } {
  const live = readState();
  if (live) return { state: live, recovered: false, detail: null };

  const checkpoint = readCheckpoint();
  if (checkpoint) {
    return {
      state: checkpoint,
      recovered: true,
      detail: "主存储缺失或校验未通过，已从最近完整检查点恢复",
    };
  }

  // 首次运行（或检查点也损坏）：以种子数据为基线建立检查点
  saveRaw(CHECKPOINT_KEY, JSON.stringify(pack("checkpoint", SEED_STATE)));
  return { state: SEED_STATE, recovered: false, detail: null };
}

export function loadInitialAudits(): AuditLog[] {
  const stored = readAudits();
  if (stored.length > 0) return stored;
  const seeded = [...SEED_AUDITS];
  saveRaw(AUDIT_KEY, JSON.stringify(pack("audits", seeded)));
  return seeded;
}

function saveRaw(key: string, value: string): void {
  localStorage.setItem(key, value);
}

export interface CommitResult {
  ok: boolean;
  recovered: boolean;
  detail: string | null;
  state: AppState;
}

/**
 * 事务式提交：写主存储 → 回读校验 → 通过后才刷新完整检查点。
 * 检查点始终代表「最近一次完整成功状态」：
 * 主存储写入截断/校验失败时，用既有检查点回滚主存储，本次提交整体撤销。
 */
export function commitState(state: AppState, crash: CrashConfig): CommitResult {
  // 1. 记住最近完整检查点（本次写入前的已知良好状态）
  const lastGood = readCheckpoint();

  // 2. 主存储写入（可注入截断故障）
  let full = JSON.stringify(pack("state", state));
  if (crash.truncateStateAt != null) {
    full = full.slice(0, Math.max(0, crash.truncateStateAt));
  }
  saveRaw(STATE_KEY, full);

  // 3. 回读校验（导入提交故障也走同一恢复通道）
  const reread = crash.failImportCommit ? null : readState();
  if (!reread) {
    if (!lastGood) {
      return { ok: false, recovered: false, detail: "写入失败且检查点不可用", state: SEED_STATE };
    }
    // 用最近完整检查点回滚主存储
    saveRaw(STATE_KEY, JSON.stringify(pack("state", lastGood)));
    return {
      ok: false,
      recovered: true,
      detail:
        "本地写入/导入未通过完整性校验，已从最近完整检查点恢复（本次提交整体回滚）",
      state: lastGood,
    };
  }

  // 4. 主存储完整落盘后，再推进完整检查点
  saveRaw(CHECKPOINT_KEY, JSON.stringify(pack("checkpoint", state)));
  return { ok: true, recovered: false, detail: null, state: reread };
}

export function persistCheckpoint(state: AppState): void {
  saveRaw(CHECKPOINT_KEY, JSON.stringify(pack("checkpoint", state)));
}

/** 只追加写操作留痕，独立于业务事务；回滚业务不抹除留痕 */
export function appendAudit(log: AuditLog): void {
  const list = readAudits();
  list.unshift(log);
  // 仅保留最近 300 条
  saveRaw(AUDIT_KEY, JSON.stringify(pack("audits", list.slice(0, 300))));
}

/** 故障演练：直接破坏主存储 */
export function corruptStateStorage(): void {
  saveRaw(STATE_KEY, '{"v":1,"kind":"state","checksum":"x","data":{"seq"');
}
