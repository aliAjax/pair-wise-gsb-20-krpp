import { useMemo, useState } from "react";
import type { AppState, User } from "../types";
import { MAGNIFICATIONS, computeActualUm, buildResultText, effectiveOnSlide } from "../domain";
import { store } from "../store";
import { Panel, Toast } from "./ui";
import { ObservationCard } from "./ObservationCard";

export function SubmitView({ state, currentUser }: { state: AppState; currentUser: User }) {
  const [slideId, setSlideId] = useState(state.slides[0]?.id ?? "");
  const [mag, setMag] = useState<number>(400);
  const [structure, setStructure] = useState("");
  const [description, setDescription] = useState("");
  const [divs, setDivs] = useState<string>("");
  const [claimedObserver, setClaimedObserver] = useState(currentUser.id);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "err" | "info" } | null>(null);

  const slide = state.slides.find((s) => s.id === slideId);
  const batch = slide ? state.batches.find((b) => b.id === slide.stainBatchId) : undefined;
  const divsNum = divs === "" ? null : Number(divs);
  const previewActual = useMemo(
    () => (batch ? computeActualUm(state, batch.rulerVersionId, mag, divsNum) : null),
    [state, batch, mag, divsNum]
  );
  const currentWinner = slide ? effectiveOnSlide(state.observations, slide.id) : null;
  const isStudent = currentUser.role === "student";
  const isGhostwrite = isStudent && claimedObserver !== currentUser.id;

  function show(message: string, ok = true) {
    setToast({ text: message, tone: ok ? "ok" : "err" });
    window.setTimeout(() => setToast(null), 4200);
  }

  function submit(simultaneous = false) {
    const result = store.submitObservation({
      slideId,
      magnification: mag,
      structure: structure || (simultaneous ? "（后到提交）结构记录" : ""),
      description:
        description ||
        (simultaneous
          ? `后到提交演示 #${Math.random().toString(36).slice(2, 6)}：同一玻片已有先生效记录，本条应内容保留并标记冲突`
          : ""),
      measurementDivs: divsNum,
      observerId: claimedObserver,
      submittedAt: simultaneous ? Date.now() : undefined,
    });
    if (result.ok && !result.duplicate) {
      setStructure("");
      setDescription("");
      setDivs("");
    }
    show(result.message, result.ok);
  }

  if (!isStudent) {
    return (
      <Panel title="提交观察结论" sub="学生入口">
        <div className="alert danger">
          当前身份为「{currentUser.name}（{roleLabel(currentUser.role)}）」，没有学生观察结论录入权限。请切换到学生身份。
        </div>
      </Panel>
    );
  }

  return (
    <div className="view-stack">
      {toast ? <Toast text={toast.text} tone={toast.tone} onClose={() => setToast(null)} /> : null}

      <Panel title="提交观察结论" sub={`${currentUser.name} · ${currentUser.className ?? ""}`}>
        <div className={`form-grid ${isGhostwrite ? "ghostwrite-armed" : ""}`}>
          <label>
            <span>以谁的名义提交（学号）</span>
            <select value={claimedObserver} onChange={(e) => setClaimedObserver(e.target.value)}>
              {state.users
                .filter((u) => u.role === "student")
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}（{u.id}）{u.id === currentUser.id ? "· 本人" : "· 他人"}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span>玻片样本</span>
            <select value={slideId} onChange={(e) => setSlideId(e.target.value)}>
              {state.slides
                .filter((s) => !s.archived)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} · {s.name}（{s.category}）
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span>放大倍数</span>
            <select value={mag} onChange={(e) => setMag(Number(e.target.value))}>
              {MAGNIFICATIONS.map((m) => (
                <option key={m} value={m}>
                  {m}x
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>测微尺格数（可空）</span>
            <input
              type="number"
              step="0.5"
              min="0"
              value={divs}
              placeholder="如 6"
              onChange={(e) => setDivs(e.target.value)}
            />
          </label>
          <label className="wide">
            <span>观察结构</span>
            <input value={structure} onChange={(e) => setStructure(e.target.value)} placeholder="如 细胞壁与细胞核" />
          </label>
          <label className="wide">
            <span>视野描述</span>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="描述视野中可见结构、染色情况、运动等"
            />
          </label>
        </div>

        {isGhostwrite ? (
          <div className="alert danger ghostwrite-banner">
            已选择以他人（{state.users.find((u) => u.id === claimedObserver)?.name}）名义提交：系统将
            <strong>拒绝越权代写</strong>，且本次拒绝会写入操作留痕。
          </div>
        ) : null}

        {batch ? (
          <div className="preview-box">
            <span>
              提交时快照依据：{batch.name} <strong>v{batch.version}</strong> · 有效期 {batch.validFrom} ~{" "}
              {batch.validUntil} · 标尺 {batch.rulerVersionId}
            </span>
            <span>
              实时换算预览：{buildResultText(structure || "（待填写结构）", previewActual)}
            </span>
            {currentWinner ? (
              <span className="conflict-preview">
                ⚠ 该玻片当前已有先生效记录 {currentWinner.id}（
                {state.users.find((u) => u.id === currentWinner.observerId)?.name}），新提交将
                <strong>内容保留并标记冲突</strong>。
              </span>
            ) : (
              <span className="ok-preview">该玻片尚无生效记录，提交后结论生效并进入复核。</span>
            )}
          </div>
        ) : (
          <div className="alert danger">该玻片未关联有效染色批次，无法提交。</div>
        )}

        <div className="button-row">
          <button className="primary-action" onClick={() => submit(false)} disabled={isGhostwrite}>
            提交观察
          </button>
          <button onClick={() => submit(true)} disabled={isGhostwrite} title="同玻片已有生效记录时，后到内容保留并显示冲突">
            模拟后到提交（验证冲突保留）
          </button>
        </div>
        <p className="form-note">
          相同观察者+玻片+倍数+内容的重复提交按幂等处理，不生成第二条记录。
        </p>
      </Panel>

      <Panel title="我的观察记录" sub={currentUser.name}>
        {state.observations.filter((o) => o.observerId === currentUser.id).length === 0 ? (
          <div className="empty-state">还没有提交过观察记录</div>
        ) : (
          <div className="obs-grid">
            {state.observations
              .filter((o) => o.observerId === currentUser.id)
              .sort((a, b) => b.submittedAt - a.submittedAt)
              .map((o) => (
                <ObservationCard key={o.id} state={state} obs={o} />
              ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function roleLabel(role: User["role"]): string {
  return role === "teacher" ? "教师" : role === "admin" ? "管理员" : "学生";
}
