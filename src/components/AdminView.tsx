import { useState } from "react";
import type { AppState, SlideCategory, User } from "../types";
import { fmtTime } from "../domain";
import { store } from "../store";
import { Empty, Panel, Toast } from "./ui";
import { ObservationCard } from "./ObservationCard";

const IMPORT_SAMPLE = JSON.stringify(
  [
    {
      slideId: "SL-04",
      observerId: "U-002",
      magnification: 400,
      structure: "细胞膜",
      description: "导入示例：边界清晰，未记录批次版本",
      measurementDivs: 4,
      submittedAt: "2026-09-25 10:00",
    },
  ],
  null,
  2
);

export function AdminView({
  state,
  currentUser,
  recovery,
}: {
  state: AppState;
  currentUser: User;
  recovery: string | null;
}) {
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "err" | "info" } | null>(null);
  const [importText, setImportText] = useState(IMPORT_SAMPLE);
  const [newSlide, setNewSlide] = useState<{ name: string; category: SlideCategory; stainBatchId: string }>({
    name: "",
    category: "植物组织",
    stainBatchId: state.batches[0]?.id ?? "",
  });

  function show(message: string, ok = true) {
    setToast({ text: message, tone: ok ? "ok" : "err" });
    window.setTimeout(() => setToast(null), 5000);
  }

  if (currentUser.role !== "admin") {
    return (
      <Panel title="管理员维护" sub="管理入口">
        <div className="alert danger">当前身份无管理员权限，请切换到管理员身份。</div>
      </Panel>
    );
  }

  const pending = state.observations.filter((o) => o.status === "pending_verify");

  return (
    <div className="view-stack">
      {toast ? <Toast text={toast.text} tone={toast.tone} onClose={() => setToast(null)} /> : null}
      {recovery ? (
        <div className="alert recovered">
          <strong>恢复提示：</strong>{recovery}
          <button className="link-btn" onClick={() => store.clearRecoveryNotice()}>
            知道了
          </button>
        </div>
      ) : null}

      <Panel title="旧数据补核" sub={`${pending.length} 条缺少染色批次版本`}>
        {pending.length === 0 ? (
          <Empty text="待核队列已清空" />
        ) : (
          <div className="obs-grid">
            {pending.map((o) => (
              <div key={o.id} className="verify-wrap">
                <ObservationCard state={state} obs={o} />
                <div className="review-action">
                  <p className="form-note">
                    将按玻片关联的当前批次补齐版本号与标尺，随后进入「待复核」（与新数据同一处理口径）。
                  </p>
                  <button
                    className="primary-action"
                    onClick={() => show(store.verifyLegacy(o.id).message)}
                  >
                    核对并补齐批次版本
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="染色批次与标尺" sub="调整将触发级联失效/复议">
        <div className="batch-stack">
          {state.batches.map((b) => (
            <BatchEditor key={b.id} state={state} batchId={b.id} onResult={show} />
          ))}
        </div>
        <div className="ruler-list">
          <h3>标尺版本库</h3>
          {state.rulers.map((r) => (
            <div key={r.id} className="ruler-card">
              <strong>{r.id} · {r.name}</strong>
              <p>{r.note}</p>
              <div className="obs-tags">
                {[100, 200, 400, 1000].map((m) => (
                  <span key={m}>{m}x：{r.scaleByMag[m]} μm/格</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="玻片登记" sub="样本维护">
        <div className="filter-row">
          <input
            placeholder="玻片名称"
            value={newSlide.name}
            onChange={(e) => setNewSlide((v) => ({ ...v, name: e.target.value }))}
          />
          <select
            value={newSlide.category}
            onChange={(e) => setNewSlide((v) => ({ ...v, category: e.target.value as SlideCategory }))}
          >
            {["植物组织", "动物组织", "微生物", "血液涂片"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select
            value={newSlide.stainBatchId}
            onChange={(e) => setNewSlide((v) => ({ ...v, stainBatchId: e.target.value }))}
          >
            {state.batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button
            className="primary-action"
            onClick={() => {
              const r = store.addSlide(newSlide);
              show(r.message, r.ok);
              if (r.ok) setNewSlide((v) => ({ ...v, name: "" }));
            }}
          >
            登记玻片
          </button>
        </div>
        <div className="slide-grid">
          {state.slides.map((s) => {
            const b = state.batches.find((x) => x.id === s.stainBatchId);
            return (
              <div key={s.id} className="slide-card">
                <strong>{s.id} · {s.name}</strong>
                <span>{s.category} · 制片 {s.preparedAt}</span>
                <span>染色：{b ? `${b.name} v${b.version}` : s.stainBatchId}</span>
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel
        title="导入观察记录"
        sub="事务导入：失败整批回滚；重复按幂等跳过；缺批次版本置待核"
      >
        <textarea
          className="import-box"
          rows={9}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
        />
        <div className="button-row">
          <button className="primary-action" onClick={() => {
            const r = store.importRecords(importText);
            show(r.message, r.ok);
          }}>
            导入
          </button>
          <button onClick={() => setImportText(IMPORT_SAMPLE)}>填入示例</button>
        </div>
      </Panel>

      <Panel title="检查点与故障演练" sub="本地写入可靠性">
        <div className="checkpoint-info">
          {state.lastCheckpoint ? (
            <p>
              最近完整检查点：<strong>#{state.lastCheckpoint.seq} {state.lastCheckpoint.label}</strong>
              （{fmtTime(state.lastCheckpoint.at)}）
            </p>
          ) : (
            <p>尚无检查点</p>
          )}
          <p className="form-note">
            每次成功提交都会先刷新完整检查点；主存储写入被截断或导入提交失败时，整体回滚到检查点，留痕不抹除。
          </p>
        </div>
        <div className="button-row wrap">
          <button onClick={() => show(store.createCheckpoint("手动完整检查点").message)}>
            立即建立完整检查点
          </button>
          <button className="warn-btn" onClick={() => show(store.armWriteCrash().message, false)}>
            注入：下次写入截断失败
          </button>
          <button className="warn-btn" onClick={() => show(store.armImportCrash().message, false)}>
            注入：下次导入提交失败
          </button>
          <button className="warn-btn" onClick={() => store.corruptAndReload()}>
            破坏主存储并刷新（验证自动恢复）
          </button>
          <button className="danger-btn" onClick={() => store.resetAll()}>
            重置全部演示数据
          </button>
        </div>
      </Panel>
    </div>
  );
}

function BatchEditor({
  state,
  batchId,
  onResult,
}: {
  state: AppState;
  batchId: string;
  onResult: (message: string, ok?: boolean) => void;
}) {
  const batch = state.batches.find((b) => b.id === batchId)!;
  const [validUntil, setValidUntil] = useState(batch.validUntil);
  const [rulerVersionId, setRulerVersionId] = useState(batch.rulerVersionId);
  const affected = state.observations.filter((o) => o.batchId === batchId);

  return (
    <div className="batch-card">
      <header>
        <strong>{batch.name}</strong>
        <span className="badge tone-info">v{batch.version}</span>
        <span>{batch.method}</span>
        <span className={batch.active ? "text-ok" : "muted"}>{batch.active ? "启用中" : "停用"}</span>
      </header>
      <div className="batch-edit-row">
        <label>
          <span>有效期</span>
          <div className="date-range">
            <input value={batch.validFrom} disabled />
            <i>~</i>
            <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </div>
        </label>
        <label>
          <span>标尺版本</span>
          <select value={rulerVersionId} onChange={(e) => setRulerVersionId(e.target.value)}>
            {state.rulers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id} · {r.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary-action"
          onClick={() => {
            const r = store.updateBatch(batchId, { validUntil, rulerVersionId });
            onResult(r.message, r.ok);
          }}
        >
          保存并级联
        </button>
      </div>
      <div className="batch-impact">
        <span>关联观察 {affected.length} 条：</span>
        <span className="text-ok">已复核 {affected.filter((o) => o.status === "approved").length}</span>
        <span>待复核 {affected.filter((o) => o.status === "pending_review").length}</span>
        <span className="text-pink">重算中 {affected.filter((o) => o.status === "recalculating").length}</span>
        <span className="text-warn">待核 {affected.filter((o) => o.status === "pending_verify").length}</span>
      </div>
      <p className="form-note">
        保存即升版本：未复核结论立即失效重算（不通过则置「已失效」）；已复核结论保留当时依据并生成复议项。
      </p>
    </div>
  );
}
