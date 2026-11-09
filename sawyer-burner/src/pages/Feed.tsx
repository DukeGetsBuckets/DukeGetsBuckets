import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { PostDTO } from "../../shared/types";
import { Burns } from "../components/Burns";
import { IconChat, IconFlag, IconLeft, IconPlus, IconRight, IconTrash } from "../components/Icons";
import { ConfirmDialog } from "../components/Modal";
import { SellBy } from "../components/Nav";
import { ReportDialog, type ReportTarget } from "../components/ReportDialog";
import { useToast } from "../components/Toast";
import { api, ApiError, errorMessage } from "../lib/api";
import { Link, navigate } from "../lib/router";
import { ago, left, useTick } from "../lib/time";

// ───────────── queue state (survives reloads within the tab) ─────────────

interface Queue {
  ids: string[];
  index: number;
  fetchedAt: number;
}
const KEY = "bb2.feed";
const REFRESH_MS = 3 * 60_000;
const MAX_HISTORY = 300;

function loadQueue(): Queue | null {
  try {
    const q = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Queue | null;
    return q && Array.isArray(q.ids) && typeof q.index === "number" ? q : null;
  } catch {
    return null;
  }
}
function saveQueue(q: Queue) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(q));
  } catch {
    /* storage full/blocked: queue just won't survive a reload */
  }
}
async function fetchIds(recent: string[]): Promise<string[]> {
  const { ids } = await api.get<{ ids: string[] }>(`/api/feed/queue?recent=${recent.slice(-30).join(",")}`);
  return ids;
}

// ───────────── swipe ─────────────

function useSwipe(onNext: () => void, onPrev: () => void) {
  // Gesture state lives in a ref (read synchronously on pointerup); `dx` state only drives rendering.
  const start = useRef<{ x: number; y: number; id: number; axis: "x" | "y" | null; dx: number } | null>(null);
  const [dx, setDx] = useState(0);

  const onPointerDown = (e: RPointerEvent) => {
    if (e.pointerType === "mouse") return; // desktop uses arrows / keyboard
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, axis: null, dx: 0 };
  };
  const onPointerMove = (e: RPointerEvent) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (!s.axis && Math.abs(mx) + Math.abs(my) > 8) s.axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
    if (s.axis === "x") {
      s.dx = mx;
      setDx(mx);
    }
  };
  const end = (e: RPointerEvent) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    start.current = null;
    const threshold = Math.min(90, window.innerWidth * 0.22);
    if (s.axis === "x" && s.dx < -threshold) onNext(); // swipe left = next
    else if (s.axis === "x" && s.dx > threshold) onPrev(); // swipe right = previous
    setDx(0);
  };
  return { dx, handlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end } };
}

// ───────────── page ─────────────

export function Feed({ deepLinkId }: { deepLinkId?: string }) {
  const toast = useToast();
  const now = useTick(30_000);
  const [queue, setQueue] = useState<Queue | null>(() => loadQueue());
  const [post, setPost] = useState<PostDTO | null>(null);
  const [loadingPost, setLoadingPost] = useState(true);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [dir, setDir] = useState<"next" | "prev" | null>(null);
  const [empty, setEmpty] = useState(false);
  const [report, setReport] = useState<ReportTarget | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const cache = useRef(new Map<string, PostDTO>());
  const advancing = useRef(false);

  const update = useCallback((q: Queue) => {
    if (q.ids.length > MAX_HISTORY) {
      const drop = q.ids.length - MAX_HISTORY;
      q = { ...q, ids: q.ids.slice(drop), index: Math.max(0, q.index - drop) };
    }
    saveQueue(q);
    setQueue(q);
  }, []);

  // Boot: build a queue, and splice in a deep-linked post if there is one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let q = loadQueue();
      if (!q || !q.ids.length) {
        try {
          const ids = await fetchIds([]);
          q = { ids, index: 0, fetchedAt: Date.now() };
        } catch (err) {
          toast(errorMessage(err), "error");
          return;
        }
      }
      if (deepLinkId) {
        const at = q.ids.indexOf(deepLinkId);
        if (at >= 0 && at >= q.index) q = { ...q, index: at };
        else {
          const ids = q.ids.slice();
          ids.splice(q.ids.length ? q.index + 1 : 0, 0, deepLinkId);
          q = { ...q, ids, index: q.ids.length ? q.index + 1 : 0 };
        }
      }
      if (cancelled) return;
      setEmpty(q.ids.length === 0);
      update(q); // persist before the URL changes so the effect re-run picks it up
      if (deepLinkId) navigate("/", { replace: true });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkId]);

  const currentId = queue?.ids[queue.index];

  // Remove an id that turned out to be expired/deleted and stay in place.
  const dropId = useCallback(
    (id: string) => {
      setQueue((q) => {
        if (!q) return q;
        const at = q.ids.indexOf(id);
        if (at < 0) return q;
        const ids = q.ids.filter((x) => x !== id);
        const index = Math.min(at < q.index ? q.index - 1 : q.index, Math.max(0, ids.length - 1));
        const next = { ...q, ids, index };
        saveQueue(next);
        if (!ids.length) setEmpty(true);
        return next;
      });
    },
    [],
  );

  // Load the current post (from cache when prefetched).
  useEffect(() => {
    if (!currentId) {
      setPost(null);
      setLoadingPost(false);
      return;
    }
    const ctrl = new AbortController();
    const cached = cache.current.get(currentId);
    setImgLoaded(false);
    if (cached) {
      setPost(cached);
      setLoadingPost(false);
    } else setLoadingPost(true);
    api
      .get<{ post: PostDTO }>(`/api/posts/${currentId}`, ctrl.signal) // also records the view
      .then(({ post }) => {
        cache.current.set(post.id, post);
        setPost(post);
        setLoadingPost(false);
      })
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        if (err instanceof ApiError && err.status === 404) dropId(currentId);
        else {
          setLoadingPost(false);
          toast(errorMessage(err), "error");
        }
      });
    return () => ctrl.abort();
  }, [currentId, dropId, toast]);

  // Prefetch the next photo so swiping feels instant.
  useEffect(() => {
    if (!queue || !imgLoaded) return;
    const nextId = queue.ids[queue.index + 1];
    if (!nextId || cache.current.has(nextId)) return;
    api
      .get<{ post: PostDTO }>(`/api/posts/${nextId}`)
      .then(({ post }) => {
        cache.current.set(post.id, post);
        new Image().src = post.imageUrl;
      })
      .catch(() => {});
  }, [queue, imgLoaded]);

  const next = useCallback(async () => {
    if (!queue || advancing.current) return;
    setDir("next");
    const stale = Date.now() - queue.fetchedAt > REFRESH_MS;
    if (queue.index < queue.ids.length - 1 && !stale) return update({ ...queue, index: queue.index + 1 });

    // End of queue (or queue is stale): fetch a fresh shuffle for everything ahead.
    advancing.current = true;
    try {
      const history = queue.ids.slice(0, queue.index + 1);
      const recent = history.slice(-30);
      // The server already pushes `recent` ids to the back of the shuffle.
      const upcoming = (await fetchIds(recent)).filter((id) => id !== history.at(-1));
      if (!upcoming.length) {
        toast("You have seen every live photo. Post one yourself?", "info");
        return update({ ...queue, fetchedAt: Date.now() });
      }
      update({ ids: [...history, ...upcoming], index: queue.index + 1, fetchedAt: Date.now() });
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      advancing.current = false;
    }
  }, [queue, update, toast]);

  const prev = useCallback(() => {
    if (!queue || queue.index === 0) return;
    setDir("prev");
    update({ ...queue, index: queue.index - 1 });
  }, [queue, update]);

  // Keyboard: ← / → (ignored while typing).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, dialog, [contenteditable]")) return;
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [next, prev]);

  const { dx, handlers } = useSwipe(next, prev);
  const setCount = useCallback((n: number) => setPost((p) => (p && p.commentCount !== n ? { ...p, commentCount: n } : p)), []);

  async function deletePost() {
    if (!post) return;
    setDeleting(true);
    try {
      await api.del(`/api/posts/${post.id}`);
      cache.current.delete(post.id);
      dropId(post.id);
      toast("Deleted. It's gone for good.");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  // ───────────── render ─────────────

  if (empty && !post) {
    return (
      <main className="page feed-empty">
        <div className="empty-card">
          <span className="empty-emoji" aria-hidden>🥩</span>
          <h1>Nothing on the fire.</h1>
          <p className="muted">Nothing live right now. Every photo disappears after 24 hours, so the feed runs dry sometimes.</p>
          <Link to="/post" className="btn btn-primary btn-lg"><IconPlus size={18} /> Post photo</Link>
        </div>
      </main>
    );
  }

  const ratio = post ? post.width / post.height : 4 / 5;
  const hoursLeft = post ? (post.expiresAt - now) / 3_600_000 : 24;
  const atStart = !queue || queue.index === 0;

  return (
    <main className="page feed">
      <div className="stage-wrap">
        <button className="arrow arrow-left" onClick={prev} disabled={atStart} aria-label="Previous photo">
          <IconLeft size={28} />
        </button>

        <article
          key={currentId ?? "loading"}
          className={`photo-card${dir ? ` enter-${dir}` : ""}${dx ? " dragging" : ""}`}
          style={dx ? { transform: `translateX(${dx}px) rotate(${dx / 40}deg)` } : undefined}
          {...handlers}
          aria-label={post ? `Photo by @${post.author}` : "Loading photo"}
        >
          <div className="photo-frame" style={{ aspectRatio: String(ratio) }}>
            {(!post || !imgLoaded) && <div className="sk photo-skeleton" aria-hidden />}
            {post && (
              <img
                src={post.imageUrl}
                alt={post.caption ? `Photo by @${post.author}: ${post.caption}` : `Photo posted by @${post.author}`}
                width={post.width}
                height={post.height}
                draggable={false}
                onLoad={() => setImgLoaded(true)}
                onError={() => setImgLoaded(true)}
                className={imgLoaded ? "loaded" : ""}
              />
            )}
            {post && <SellBy text={left(post.expiresAt, now)} urgent={hoursLeft < 1} className="photo-stamp" />}
            {post?.hidden && <div className="review-banner">Under review — hidden from the feed</div>}
            {dx !== 0 && (
              <div className={`swipe-hint ${dx < 0 ? "hint-next" : "hint-prev"}`} style={{ opacity: Math.min(1, Math.abs(dx) / 90) }}>
                {dx < 0 ? "Next" : "Back"}
              </div>
            )}
          </div>

          <footer className="photo-meta">
            {post && !loadingPost ? (
              <>
                <div className="photo-meta-main">
                  <Link to={`/u/${post.author}`} className="handle handle-lg">@{post.author}</Link>
                  <p className="photo-when">
                    Posted {ago(post.createdAt, now)} <span aria-hidden>•</span> disappears in {left(post.expiresAt, now)}
                  </p>
                  {post.caption && <p className="photo-caption">{post.caption}</p>}
                </div>
                <div className="photo-meta-actions">
                  <a href="#burns-title" className="chip" aria-label={`${post.commentCount} burns`}>
                    <IconChat size={16} /> {post.commentCount}
                  </a>
                  {post.isMine ? (
                    <button className="chip" onClick={() => setConfirmDelete(true)} aria-label="Delete your photo">
                      <IconTrash size={16} /> <span className="chip-label">Delete</span>
                    </button>
                  ) : (
                    <button className="chip" onClick={() => setReport({ type: "post", id: post.id })} aria-label="Report this photo">
                      <IconFlag size={16} /> <span className="chip-label">Report</span>
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="photo-meta-main" aria-hidden>
                <div className="sk sk-line w30" />
                <div className="sk sk-line w60" />
              </div>
            )}
          </footer>
        </article>

        <button className="arrow arrow-right" onClick={next} aria-label="Next photo">
          <IconRight size={28} />
        </button>
      </div>

      <div className="mobile-pager">
        <button className="btn btn-ghost btn-sm" onClick={prev} disabled={atStart}>
          <IconLeft size={16} /> Prev
        </button>
        <span className="pager-hint">Swipe for more</span>
        <button className="btn btn-ghost btn-sm" onClick={next}>
          Next <IconRight size={16} />
        </button>
      </div>

      {post && <Burns key={post.id} postId={post.id} locked={!!post.hidden} onCount={setCount} onReport={setReport} />}

      <ReportDialog
        target={report}
        onClose={() => setReport(null)}
        onHidden={(t) => {
          if (t.type === "post") {
            cache.current.delete(t.id);
            dropId(t.id);
          }
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this photo?"
        body="The photo, its burns and all 🔥 are deleted immediately. This can't be undone."
        confirmLabel="Delete photo"
        busy={deleting}
        onConfirm={deletePost}
        onClose={() => setConfirmDelete(false)}
      />
    </main>
  );
}
