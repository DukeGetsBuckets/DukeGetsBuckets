import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { COMMENT_MAX } from "../../shared/rules";
import type { CommentDTO } from "../../shared/types";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Link } from "../lib/router";
import { ago, useTick } from "../lib/time";
import { IconFlag, IconTrash } from "./Icons";
import { ConfirmDialog } from "./Modal";
import type { ReportTarget } from "./ReportDialog";
import { useToast } from "./Toast";

type Sort = "hot" | "new";

export function Burns({ postId, locked, onCount, onReport }: { postId: string; locked: boolean; onCount: (n: number) => void; onReport: (t: ReportTarget) => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const now = useTick(30_000);
  const [sort, setSort] = useState<Sort>("hot");
  const [comments, setComments] = useState<CommentDTO[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<CommentDTO | null>(null);
  const [justFired, setJustFired] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await api.get<{ comments: CommentDTO[]; commentCount: number }>(`/api/posts/${postId}/comments?sort=${sort}`, signal);
        setComments(res.comments);
        onCount(res.commentCount);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setComments((c) => c ?? []);
      }
    },
    [postId, sort, onCount],
  );

  // Initial load + live refresh every 10s while the tab is visible.
  useEffect(() => {
    setComments(null);
    const ctrl = new AbortController();
    load(ctrl.signal);
    const id = setInterval(() => !document.hidden && load(), 10_000);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const { comment } = await api.post<{ comment: CommentDTO }>(`/api/posts/${postId}/comments`, { body });
      setComments((c) => [comment, ...(c ?? []).filter((x) => x.id !== comment.id)]);
      onCount((comments?.length ?? 0) + 1);
      setText("");
      toast("Burn landed.");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleFire(c: CommentDTO) {
    if (me?.suspended) return toast("Suspended accounts can't react.", "error");
    const optimistic = { ...c, firedByMe: !c.firedByMe, fireCount: c.fireCount + (c.firedByMe ? -1 : 1) };
    if (!c.firedByMe) {
      setJustFired(c.id);
      setTimeout(() => setJustFired((id) => (id === c.id ? null : id)), 700);
    }
    setComments((list) => list?.map((x) => (x.id === c.id ? optimistic : x)) ?? null);
    try {
      const res = c.firedByMe
        ? await api.del<{ fireCount: number; firedByMe: boolean }>(`/api/comments/${c.id}/fire`)
        : await api.post<{ fireCount: number; firedByMe: boolean }>(`/api/comments/${c.id}/fire`);
      setComments((list) => list?.map((x) => (x.id === c.id ? { ...x, ...res } : x)) ?? null);
    } catch (err) {
      setComments((list) => list?.map((x) => (x.id === c.id ? c : x)) ?? null);
      toast(errorMessage(err), "error");
    }
  }

  async function doDelete() {
    const c = confirmDelete;
    if (!c) return;
    try {
      await api.del(`/api/comments/${c.id}`);
      setComments((list) => list?.filter((x) => x.id !== c.id) ?? null);
      onCount(Math.max(0, (comments?.length ?? 1) - 1));
      toast("Burn deleted.");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setConfirmDelete(null);
    }
  }

  const remaining = COMMENT_MAX - [...text].length;

  return (
    <section className="burns" aria-labelledby="burns-title">
      <header className="burns-head">
        <h2 id="burns-title" className="burns-title">
          The Burns <span className="burns-count">{comments?.length ?? "–"}</span>
        </h2>
        <div className="seg" role="tablist" aria-label="Sort burns">
          {(["hot", "new"] as const).map((s) => (
            <button key={s} role="tab" aria-selected={sort === s} className={sort === s ? "on" : ""} onClick={() => setSort(s)}>
              {s === "hot" ? "Hottest" : "Newest"}
            </button>
          ))}
        </div>
      </header>

      {me?.suspended ? (
        <p className="notice">Your account is suspended, so you can read burns but not post them.</p>
      ) : locked ? (
        <p className="notice">This photo is under review. Burns are paused.</p>
      ) : (
        <form className="composer" onSubmit={submit}>
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Drop a burn. Funny, not personal."
            maxLength={COMMENT_MAX * 2}
            rows={2}
            aria-label="Write a burn"
          />
          <div className="composer-row">
            <span className={`counter${remaining < 0 ? " bad" : remaining < 30 ? " warn" : ""}`}>{remaining}</span>
            <button className="btn btn-burn" disabled={busy || !text.trim() || remaining < 0}>
              {busy ? "Burning…" : "Burn 🔥"}
            </button>
          </div>
        </form>
      )}

      {!!comments?.length && (
        <p className="fire-hint">
          Tap <span className="fire-hint-chip">🔥 Fire</span> on the burns that hit hardest. The most-fired burns rise to the top.
        </p>
      )}

      <ul className="burn-list">
        {comments === null &&
          [0, 1, 2].map((i) => (
            <li key={i} className="burn skeleton-burn" aria-hidden>
              <div className="sk sk-line w30" />
              <div className="sk sk-line w80" />
            </li>
          ))}
        {comments?.length === 0 && (
          <li className="burns-empty">
            <span className="burns-empty-emoji" aria-hidden>🔥</span>
            No burns yet. First one gets the glory.
          </li>
        )}
        {comments?.map((c) => (
          <li key={c.id} className={`burn${c.firedByMe ? " burn-fired" : ""}`}>
            <div className="burn-meta">
              <Link to={`/u/${c.author}`} className="handle">@{c.author}</Link>
              <span className="dot" aria-hidden>·</span>
              <time dateTime={new Date(c.createdAt).toISOString()}>{ago(c.createdAt, now)}</time>
            </div>
            <p className="burn-body">{c.body}</p>
            <div className="burn-actions">
              <button
                className={`fire${c.firedByMe ? " on" : ""}${justFired === c.id ? " burst" : ""}`}
                onClick={() => toggleFire(c)}
                aria-pressed={c.firedByMe}
                aria-label={`${c.firedByMe ? "Remove your fire" : "Give this burn fire"}. ${c.fireCount} so far`}
                title={c.firedByMe ? "Tap to take back your 🔥" : "Tap to give this burn 🔥"}
              >
                <span className="fire-emoji" aria-hidden>🔥</span>
                <span className="fire-label">{c.firedByMe ? "Fired" : "Fire"}</span>
                <span className="fire-count">{c.fireCount}</span>
              </button>
              {!c.isMine && (
                <button className="ghost-action" onClick={() => onReport({ type: "comment", id: c.id })}>
                  <IconFlag size={14} /> Report
                </button>
              )}
              {c.canDelete && (
                <button className="ghost-action" onClick={() => setConfirmDelete(c)}>
                  <IconTrash size={14} /> Delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete this burn?"
        body={confirmDelete?.isMine ? "It'll be gone for good, along with its 🔥." : "You're removing someone else's burn from your photo."}
        confirmLabel="Delete burn"
        onConfirm={doDelete}
        onClose={() => setConfirmDelete(null)}
      />
    </section>
  );
}
