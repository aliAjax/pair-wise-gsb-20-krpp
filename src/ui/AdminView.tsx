import { useMemo, useState } from "react";
import type { Actor, Command, LabState, Notice, StainBatch } from "../domain/types";
import { batchOfSlide } from "../domain/status";
import { Panel, batchLabel, slideName, StatusBadge, fmtDateTime } from "./shared";
import { store } from "../domain/useStore";

type Run = (cmd: Command) => Notice[];

const IMPORT_TEMPLATE = `洋葱表皮,400x,液泡,液泡体积较大,11
未知玻片XX,400x,测试,这一行样本不存在，应导致整批导入中止,5`;

export function AdminView({ state, actor, run }: { state: LabState; actor: Actor; run: Run }) {
  const pendingLegacy = state.observations.filter((o) => o.status === "PENDING_VERIFY");

  // —— 批次依据调整 ——
  const [batchId, setBatchId] = useState(state.batches[2].id);
  const batch = state.batches.find((b) => b.id === batchId)!;
  const [validFrom, setValidFrom] = useState(batch.validFrom);
  const [validUntil, setValidUntil] = useState(batch.validUntil);
  const [scaleVersion, setScaleVersion] = useState(batch.scaleVersion);
  const [scaleFactor, setScaleFactor] = useState(String(batch.scaleFactor));
  const [status, setStatus] = useState<StainBatch["status"]>(batch.status);
  const [note, setNote] = useState("");

  const selectBatch = (id: string) => {
    const b = state.batches.find((x) => x.id === id)!;
    setBatchId(id);
    setValidFrom(b.validFrom);
    setValidUntil(b.validUntil);
    setScaleVersion(b.scaleVersion);
    setScaleFactor(String(b.scaleFactor));
    setStatus(b.status);
  };

  const today = new Date().toISOString().slice(0, 10);
  const preview = useMemo(() => {
    let unreviewed = 0;
    let willInvalidate = 0;
    let willRecompute = 0;
    let approved = 0;
    for (const o of state.observations) {
      if (o.stainBatchId !== batchId || o.stainVersion !== batch.version) continue;
      if (o.status === "PENDING_REVIEW") {
        unreviewed += 1;
        const nowInvalid = status === "DISCONTINUED" || today < validFrom || today > validUntil;
        if (nowInvalid) willInvalidate += 1;
        else if (scaleVersion !== batch.scaleVersion) willRecompute += 1;
      }
      if (o.status === "APPROVED") approved += 1;
    }
    return { unreviewed, willInvalidate, willRecompute, approved };
  }, [state, batchId, batch, today, validFrom, validUntil, scaleVersion, status]);

  // —— 导入 ——
  const [importText, setImportText] = useState(IMPORT_TEMPLATE);
  const [failImportWrite, setFailImportWrite] = useState(false);

  const parseAndImport = () => {
    const rows = importText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [slideNameC, magnification, structure, description, rawReading, stainBatchId] = line.split(",").map((x) => x?.trim() ?? "");
        return {
          slideName: slideNameC,
          magnification,
          structure,
          description,
          rawReading: Number(rawReading),
          stainBatchId: stainBatchId || undefined,
        };
      });
    if (failImportWrite) store.armWriteFailure(1);
    return run({ type: "importObservations", actor, rows, at: new Date().toISOString() });
  };

  // —— 并发演练 ——
  const students = state.users.filter((u) => u.role === "student");
  const [drillSlide, setDrillSlide] = useState(state.slides[0].id);
  const [drillMag, setDrillMag] = useState("400x");
  const [r1, setR1] = useState("10");
  const [r2, setR2] = useState("10");

  if (actor.role !== "admin") {
    return <Panel title="管理员维护工作台" sub="权限提示"><div className="inline-note error">当前身份不是管理员，批次/导入/恢复操作不可执行。</div></Panel>;
  }

  return (
    <div className="view-grid">
      <Panel title="旧数据待核" sub={`缺批次版本先待核 · ${pendingLegacy.length} 条`}>
        <div className="card-list">
          {pendingLegacy.length === 0 && <p className="hint">没有待核旧数据。</p>}
          {pendingLegacy.map((o) => {
            const slideBatch = batchOfSlide(state, o.slideId)!;
            return (
              <article key={o.id} className="obs-card verify">
                <div className="obs-head">
                  <strong>{slideName(state, o.slideId)} · {o.magnification} · {o.observerName}</strong>
                  <StatusBadge status="PENDING_VERIFY" />
                </div>
                <p className="obs-dim">{o.description}</p>
                <div className="obs-meta"><span>{o.id}</span><span>原始读数 {o.rawReading}</span><span>批次版本缺失</span></div>
                <div className="action-row">
                  <span className="hint">补核到玻片所属批次：</span>
                  <strong className="hint">{batchLabel(slideBatch)}</strong>
                  <button
                    className="primary-action"
                    onClick={() => run({ type: "verifyLegacy", actor, observationId: o.id, batchId: slideBatch.id, at: new Date().toISOString() })}
                  >
                    补核并送入复核队列
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </Panel>

      <Panel title="染色批次依据" sub="调整有效期 / 标尺版本 / 状态，未复核结论立即级联处理">
        <div className="batch-layout">
          <ul className="batch-list">
            {state.batches.map((b) => (
              <li key={b.id}>
                <button className={b.id === batchId ? "active" : ""} onClick={() => selectBatch(b.id)}>
                  {batchLabel(b)}
                  <span className="hint">{b.status === "ACTIVE" ? "启用" : "停用"}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="form-grid">
            <label className="field">
              <span>有效期开始</span>
              <input type="date" className="input" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </label>
            <label className="field">
              <span>有效期结束</span>
              <input type="date" className="input" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </label>
            <label className="field">
              <span>标尺版本</span>
              <input className="input" value={scaleVersion} onChange={(e) => setScaleVersion(e.target.value)} />
            </label>
            <label className="field">
              <span>标尺校正系数（测量=读数×系数）</span>
              <input className="input" inputMode="decimal" value={scaleFactor} onChange={(e) => setScaleFactor(e.target.value)} />
            </label>
            <label className="field">
              <span>批次状态</span>
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value as StainBatch["status"])}>
                <option value="ACTIVE">启用</option>
                <option value="DISCONTINUED">停用</option>
              </select>
            </label>
            <label className="field wide">
              <span>变更说明（写入版本历史）</span>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如 标尺年度校准，系数下调" />
            </label>
          </div>
        </div>

        <div className="impact-preview">
          <span className="caption">影响预览（基于 v{batch.version} 挂接结论）</span>
          <ul>
            <li>未复核结论 {preview.unreviewed} 条：<b className="text-danger">{preview.willInvalidate} 条立即失效</b>，<b className="text-ok">{preview.willRecompute} 条按新标尺重算并继续待复核</b>{preview.unreviewed - preview.willInvalidate - preview.willRecompute > 0 ? `，其余 ${preview.unreviewed - preview.willInvalidate - preview.willRecompute} 条不受影响` : ""}</li>
            <li>已复核结论 <b className="text-warn">{preview.approved} 条保留原依据并生成复议项</b></li>
          </ul>
        </div>
        <div className="action-row">
          <button
            className="primary-action"
            disabled={!note.trim()}
            onClick={() =>
              run({
                type: "updateBatchBasis",
                actor,
                batchId,
                patch: { validFrom, validUntil, scaleVersion, scaleFactor: Number(scaleFactor), status, note: note.trim() },
                at: new Date().toISOString(),
              })
            }
          >
            发布新版本并级联处理
          </button>
          {!note.trim() && <span className="hint">需填写变更说明</span>}
        </div>

        <details className="history-box">
          <summary>版本历史（{batch.history.length}）</summary>
          {batch.history.map((h) => (
            <div key={h.version} className="history-row">
              <strong>v{h.version}</strong>
              <span>{h.validFrom} ~ {h.validUntil}</span>
              <span>{h.scaleVersion} ×{h.scaleFactor}</span>
              <span>{h.status === "ACTIVE" ? "启用" : "停用"}</span>
              <span>{h.changeNote}</span>
              <span className="hint">{fmtDateTime(h.changedAt)}</span>
            </div>
          ))}
        </details>
      </Panel>

      <Panel title="并发提交演练" sub="两名观察者同一玻片同时提交：先到生效，后到保留冲突">
        <div className="form-grid">
          <label className="field">
            <span>玻片</span>
            <select className="input" value={drillSlide} onChange={(e) => setDrillSlide(e.target.value)}>
              {state.slides.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>放大倍数</span>
            <select className="input" value={drillMag} onChange={(e) => setDrillMag(e.target.value)}>
              {["100x", "200x", "400x", "1000x"].map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
          <label className="field">
            <span>{students[0]?.name} 的读数</span>
            <input className="input" value={r1} onChange={(e) => setR1(e.target.value)} />
          </label>
          <label className="field">
            <span>{students[1]?.name} 的读数</span>
            <input className="input" value={r2} onChange={(e) => setR2(e.target.value)} />
          </label>
        </div>
        <div className="action-row">
          <button
            className="primary-action"
            onClick={() =>
              run({
                type: "simultaneousSubmit",
                actor,
                at: new Date().toISOString(),
                items: students.slice(0, 2).map((u, i) => ({
                  observerId: u.userId,
                  payload: {
                    slideId: drillSlide,
                    magnification: drillMag,
                    structure: "并发演练视野",
                    description: `${u.name} 在同一玻片的同刻观察（读数 ${i === 0 ? r1 : r2}）`,
                    rawReading: Number(i === 0 ? r1 : r2),
                  },
                })),
              })
            }
          >
            同刻提交两人记录
          </button>
          <span className="hint">两条以相同时间戳提交，按提交时刻（并列时按学号）确定性决出先到者。</span>
        </div>
      </Panel>

      <Panel title="批量导入与检查点恢复" sub="失败后从最近完整检查点恢复，整批事务不落半截数据">
        <p className="hint">CSV 行：样本名,倍数,结构,描述,读数[,批次id]。含未知样本的行会导致整批中止；也可模拟本地写入失败。</p>
        <textarea className="input code-input" rows={5} value={importText} onChange={(e) => setImportText(e.target.value)} />
        <div className="action-row">
          <button className="primary-action" onClick={parseAndImport}>执行导入</button>
          <label className="checkline">
            <input type="checkbox" checked={failImportWrite} onChange={(e) => setFailImportWrite(e.target.checked)} />
            模拟本次写入磁盘失败（触发回滚 + 检查点恢复）
          </label>
        </div>
        <div className="action-row">
          <button onClick={() => store.armWriteFailure(1)}>安排下一次写入失败</button>
          <button onClick={() => store.corruptStorage()}>破坏本地主数据</button>
          <button onClick={() => run({ type: "importObservations", actor, rows: [], at: new Date().toISOString() })}>空导入自检</button>
          <button onClick={() => store.reloadFromDisk().notices.forEach((n: Notice) => pushNotice(n))}>重新载入并按检查点恢复</button>
          <button className="danger" onClick={() => { if (confirm("确认清空本地数据并重置为初始建档？")) store.reset(); }}>重置全部数据</button>
        </div>
        <div className="checkpoint-list">
          <span className="caption">最近完整检查点（{store.checkpoints.length}）</span>
          {store.checkpoints.slice().reverse().map((m) => (
            <div key={m.id} className="history-row">
              <strong>{m.id}</strong>
              <span>{m.label}</span>
              <span className="hint">{fmtDateTime(m.at)}</span>
              <span className="hint mono">{m.checksum}</span>
              <button onClick={() => store.restoreCheckpoint(m.id)}>恢复到此点</button>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

// 重新载入按钮的提示直接投递到全局 toast（由 App 注入的轻量事件）
function pushNotice(n: Notice) {
  window.dispatchEvent(new CustomEvent("hxwl06-notice", { detail: n }));
}
