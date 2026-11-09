import { useCallback, useEffect, useState } from "react";
import { REPORT_REASONS } from "../../shared/rules";
import type {
  AdminComment, AdminPost, AdminReportGroup, AdminStats, AdminUser, AdminUserDetail, ArchivedBurn, ArchivedPost, ArchivedReport,
} from "../../shared/types";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Link } from "../lib/router";
import { ago, left, useTick } from "../lib/time";

type Tab = "overview" | "reports" | "photos" | "burns" | "users" | "archive";
const TABS: Array<[Tab, string]> = [
  ["overview", "Overview"], ["reports", "Reports"], ["photos", "Photos"], ["burns", "Burns"], ["users", "Users"], ["archive", "Review archive"],
];
const DELETION_LABELS: Record<string, string> = {
  expired: "Expired after 24h",
  photo_deleted: "Photo was deleted",
  deleted_by_author: "Deleted by the author",
  deleted_by_owner: "Deleted by the poster",
  deleted_by_photo_owner: "Deleted by the photo owner",
  removed_by_admin: "Removed by an admin",
  account_deleted: "Account deleted",
};
const reasonLabel = (r: string) => REPORT_REASONS.find((x) => x.value === r)?.label ?? r;

interface Pending {
  title: string;
  body: string;
  label: string;
  danger?: boolean;
  run: () => Promise<unknown>;
  done: string;
}

export function Admin() {
  const { me } = useAuth();
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem("bb2.adminTab") as Tab) || "overview");
  const [pending, setPending] = useState<Pending | null>(null);
  const [viewUser, setViewUser] = useState<string | null>(null);
  const [tempPw, setTempPw] = useState<{ username: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const toast = useToast();

  useEffect(() => sessionStorage.setItem("bb2.adminTab", tab), [tab]);

  // UI gate only: every /api/admin route independently enforces the role server-side.
  if (me?.role !== "admin") {
    return (
      <main className="page narrow">
        <div className="empty-card"><h1>Admins only.</h1><Link to="/" className="btn btn-outline">Back to the feed</Link></div>
      </main>
    );
  }

  const confirm = (p: Pending) => setPending(p);
  async function runPending() {
    if (!pending) return;
    setBusy(true);
    try {
      await pending.run();
      toast(pending.done);
      setVersion((v) => v + 1);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <main className="page admin">
      <header className="admin-head">
        <h1 className="page-title">Admin</h1>
        <nav className="tabs" role="tablist" aria-label="Admin sections">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key && !viewUser}
              className={tab === key && !viewUser ? "on" : ""}
              onClick={() => {
                setTab(key);
                setViewUser(null);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      {viewUser ? (
        <UserDetail key={`${viewUser}:${version}`} username={viewUser} confirm={confirm} onBack={() => setViewUser(null)} onTempPassword={setTempPw} />
      ) : (
        <>
          {tab === "overview" && <Overview key={version} onJump={setTab} />}
          {tab === "reports" && <Reports key={version} confirm={confirm} />}
          {tab === "photos" && <Photos key={version} confirm={confirm} />}
          {tab === "burns" && <BurnsTab key={version} confirm={confirm} />}
          {tab === "users" && <Users key={version} confirm={confirm} onOpen={setViewUser} />}
          {tab === "archive" && <Archive onOpenUser={setViewUser} />}
        </>
      )}

      <Modal open={!!tempPw} onClose={() => setTempPw(null)} title="Temporary password">
        <p className="muted">
          Give this to <strong>@{tempPw?.username}</strong>. It works once: they&apos;ll be asked to choose their own password right after
          logging in. It won&apos;t be shown again.
        </p>
        <div className="temp-pw">
          <code>{tempPw?.password}</code>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => navigator.clipboard?.writeText(tempPw?.password ?? "").then(() => toast("Copied."))}
          >
            Copy
          </button>
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={() => setTempPw(null)}>Done</button>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!pending}
        title={pending?.title ?? ""}
        body={pending?.body}
        confirmLabel={pending?.label ?? ""}
        danger={pending?.danger ?? true}
        busy={busy}
        onConfirm={runPending}
        onClose={() => setPending(null)}
      />
    </main>
  );
}

function useAdminData<T>(path: string): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setError("");
    api.get<T>(path, ctrl.signal).then(setData).catch((e) => e.name !== "AbortError" && setError(errorMessage(e)));
    return () => ctrl.abort();
  }, [path, n]);
  return { data, error, reload: useCallback(() => setN((x) => x + 1), []) };
}

function Loading({ error }: { error: string }) {
  return error ? <p className="form-error">{error}</p> : <div className="admin-loading"><div className="sk sk-block" /><div className="sk sk-block" /></div>;
}

// ───────────── overview ─────────────

function Overview({ onJump }: { onJump: (t: Tab) => void }) {
  const { data, error } = useAdminData<{ stats: AdminStats }>("/api/admin/stats");
  if (!data) return <Loading error={error} />;
  const s = data.stats;
  const cards: Array<[string, number, string, Tab]> = [
    ["Live photos", s.activePhotos, s.hiddenPhotos ? `${s.hiddenPhotos} hidden for review` : "all visible", "photos"],
    ["Users", s.users, s.suspendedUsers ? `${s.suspendedUsers} suspended` : "none suspended", "users"],
    ["Burns", s.comments, "on live photos", "burns"],
    ["Open reports", s.openReports, s.openReports ? "needs review" : "queue is clear", "reports"],
    ["Uploads, last 24h", s.uploads24h, "every one expires in 24h", "photos"],
  ];
  return (
    <div className="stat-grid">
      {cards.map(([label, value, sub, tab]) => (
        <button key={label} className={`stat-card${label === "Open reports" && value > 0 ? " alert" : ""}`} onClick={() => onJump(tab)}>
          <span className="stat-label">{label}</span>
          <span className="stat-value">{value.toLocaleString()}</span>
          <span className="stat-sub">{sub}</span>
        </button>
      ))}
    </div>
  );
}

// ───────────── reports queue ─────────────

function Reports({ confirm }: { confirm: (p: Pending) => void }) {
  const now = useTick();
  const { data, error } = useAdminData<{ groups: AdminReportGroup[] }>("/api/admin/reports");
  if (!data) return <Loading error={error} />;
  if (!data.groups.length) return <p className="empty-line">Queue is clear. Nothing reported. 🔥</p>;
  return (
    <ul className="report-list">
      {data.groups.map((g) => (
        <li key={`${g.targetType}:${g.targetId}`} className={`card report-card${g.hasItsMe ? " priority" : ""}`}>
          <div className="report-content">
            {g.content.imageUrl && <img src={g.content.imageUrl} alt="" className="report-thumb" loading="lazy" />}
            <div>
              <div className="report-badges">
                <span className="badge">{g.targetType === "post" ? "Photo" : "Burn"}</span>
                <span className="badge badge-strong">{g.reportCount} {g.reportCount === 1 ? "report" : "reports"}</span>
                {g.hasItsMe && <span className="badge badge-alert">“This is me” takedown</span>}
                {g.targetStatus === "hidden" && <span className="badge">Hidden</span>}
                {g.targetStatus === "gone" && <span className="badge">Already gone</span>}
              </div>
              {g.content.body && <p className="report-body">“{g.content.body}”</p>}
              {g.content.caption && <p className="report-body muted">Caption: {g.content.caption}</p>}
              <p className="muted small">
                by {g.content.author ? <Link to={`/u/${g.content.author}`}>@{g.content.author}</Link> : "deleted user"} · first reported {ago(g.firstReportedAt, now)}
                {g.content.postId && <> · <Link to={`/p/${g.content.postId}`}>open photo</Link></>}
              </p>
            </div>
          </div>
          <ul className="report-reasons">
            {g.reports.map((r) => (
              <li key={r.id}>
                <strong>{reasonLabel(r.reason)}</strong> <span className="muted">— {r.reporter ? `@${r.reporter}` : "deleted user"}, {ago(r.createdAt, now)}</span>
                {r.details && <p className="report-details">{r.details}</p>}
              </li>
            ))}
          </ul>
          <div className="row gap">
            <button
              className="btn btn-danger btn-sm"
              onClick={() => confirm({
                title: `Remove this ${g.targetType === "post" ? "photo" : "burn"}?`,
                body: g.targetType === "post" ? "Deletes the photo, its burns, 🔥 and the stored image immediately." : "Deletes the burn and its 🔥 immediately.",
                label: "Remove content",
                done: "Removed.",
                run: () => api.post("/api/admin/reports/resolve", { targetType: g.targetType, targetId: g.targetId, action: "remove" }),
              })}
            >
              Remove content
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => confirm({
                title: "Dismiss these reports?",
                body: "The content stays up (and is restored if it was hidden).",
                label: "Dismiss reports",
                danger: false,
                done: "Reports dismissed.",
                run: () => api.post("/api/admin/reports/resolve", { targetType: g.targetType, targetId: g.targetId, action: "dismiss" }),
              })}
            >
              Dismiss report
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ───────────── photos ─────────────

function Photos({ confirm }: { confirm: (p: Pending) => void }) {
  const now = useTick();
  const [sort, setSort] = useState<"new" | "reports">("new");
  const [offset, setOffset] = useState(0);
  const { data, error } = useAdminData<{ posts: AdminPost[]; hasMore: boolean }>(`/api/admin/posts?sort=${sort}&offset=${offset}`);
  return (
    <>
      <SortBar sort={sort} setSort={(s) => { setSort(s); setOffset(0); }} />
      {!data ? <Loading error={error} /> : !data.posts.length ? <p className="empty-line">No live photos.</p> : (
        <div className="admin-photo-grid">
          {data.posts.map((p) => (
            <div key={p.id} className="card admin-photo">
              <Link to={`/p/${p.id}`} className="admin-photo-img"><img src={p.imageUrl} alt="" loading="lazy" /></Link>
              <div className="admin-photo-meta">
                <Link to={`/u/${p.uploader}`} className="handle">@{p.uploader}</Link>
                <dl>
                  <dt>Posted</dt><dd>{ago(p.createdAt, now)}</dd>
                  <dt>Expires</dt><dd>in {left(p.expiresAt, now)}</dd>
                  <dt>Burns</dt><dd>{p.commentCount}</dd>
                  <dt>Reports</dt><dd className={p.reportCount ? "hot" : ""}>{p.reportCount}</dd>
                </dl>
                {p.status === "hidden" && <span className="badge">Hidden</span>}
                <button
                  className="btn btn-danger btn-sm btn-block"
                  onClick={() => confirm({
                    title: "Delete this photo?",
                    body: `Photo by @${p.uploader} and its ${p.commentCount} burns will be deleted from the database and storage now.`,
                    label: "Delete photo",
                    done: "Photo deleted.",
                    run: () => api.del(`/api/admin/posts/${p.id}`),
                  })}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Pager offset={offset} setOffset={setOffset} hasMore={!!data?.hasMore} />
    </>
  );
}

// ───────────── burns ─────────────

function BurnsTab({ confirm }: { confirm: (p: Pending) => void }) {
  const now = useTick();
  const [sort, setSort] = useState<"new" | "reports">("new");
  const [offset, setOffset] = useState(0);
  const { data, error } = useAdminData<{ comments: AdminComment[]; hasMore: boolean }>(`/api/admin/comments?sort=${sort}&offset=${offset}`);
  return (
    <>
      <SortBar sort={sort} setSort={(s) => { setSort(s); setOffset(0); }} />
      {!data ? <Loading error={error} /> : !data.comments.length ? <p className="empty-line">No burns on live photos.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Burn</th><th>Author</th><th>Photo</th><th>When</th><th>Reports</th><th><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {data.comments.map((c) => (
                <tr key={c.id}>
                  <td className="cell-body">{c.body}{c.status === "hidden" && <span className="badge">Hidden</span>}</td>
                  <td><Link to={`/u/${c.author}`}>@{c.author}</Link></td>
                  <td><Link to={`/p/${c.postId}`}><img src={c.postImageUrl} alt="View photo" className="table-thumb" loading="lazy" /></Link></td>
                  <td className="nowrap">{ago(c.createdAt, now)}</td>
                  <td className={c.reportCount ? "hot" : ""}>{c.reportCount}</td>
                  <td>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => confirm({ title: "Delete this burn?", body: `“${c.body.slice(0, 120)}” by @${c.author}`, label: "Delete burn", done: "Burn deleted.", run: () => api.del(`/api/admin/comments/${c.id}`) })}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager offset={offset} setOffset={setOffset} hasMore={!!data?.hasMore} />
    </>
  );
}

// ───────────── users ─────────────

function Users({ confirm, onOpen }: { confirm: (p: Pending) => void; onOpen: (username: string) => void }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"new" | "reports">("new");
  const [offset, setOffset] = useState(0);
  const { data, error } = useAdminData<{ users: AdminUser[]; hasMore: boolean }>(`/api/admin/users?q=${encodeURIComponent(query)}&sort=${sort}&offset=${offset}`);

  useEffect(() => {
    const t = setTimeout(() => { setQuery(q); setOffset(0); }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <>
      <div className="row gap wrap admin-toolbar">
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search usernames" aria-label="Search usernames" />
        <SortBar sort={sort} setSort={(s) => { setSort(s); setOffset(0); }} labels={["Newest", "Most reported"]} />
      </div>
      {!data ? <Loading error={error} /> : !data.users.length ? <p className="empty-line">No users match.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>User</th><th>Joined</th><th>Live posts</th><th>Burns</th><th>Reports received</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.username}>
                  <td>
                    <button className="user-link" onClick={() => onOpen(u.username)}>@{u.username}</button>
                    {u.role === "admin" && <span className="badge">Admin</span>}
                  </td>
                  <td className="nowrap">{new Date(u.createdAt).toLocaleDateString()}</td>
                  <td>{u.postCount}</td>
                  <td>{u.commentCount}</td>
                  <td className={u.reportsReceived ? "hot" : ""}>{u.reportsReceived}</td>
                  <td>{u.status === "suspended" ? <span className="badge badge-alert">Suspended</span> : <span className="muted">Active</span>}</td>
                  <td className="nowrap">
                    {u.role !== "admin" && (
                      <div className="row gap-sm">
                        {u.status === "suspended" ? (
                          <button className="btn btn-ghost btn-sm" onClick={() => confirm({ title: `Unsuspend @${u.username}?`, body: "They'll be able to post, burn and react again.", label: "Unsuspend", danger: false, done: `@${u.username} unsuspended.`, run: () => api.post(`/api/admin/users/${u.username}/unsuspend`) })}>Unsuspend</button>
                        ) : (
                          <button className="btn btn-outline btn-sm" onClick={() => confirm({ title: `Suspend @${u.username}?`, body: "They can still log in and browse, but can't post photos, burn or react.", label: "Suspend", done: `@${u.username} suspended.`, run: () => api.post(`/api/admin/users/${u.username}/suspend`) })}>Suspend</button>
                        )}
                        <button className="btn btn-danger btn-sm" onClick={() => confirm({ title: `Delete @${u.username}?`, body: "Deletes the account, every photo (including stored images), every burn and every reaction they made. Can't be undone.", label: "Delete user", done: `@${u.username} deleted.`, run: () => api.del(`/api/admin/users/${u.username}`) })}>Delete</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager offset={offset} setOffset={setOffset} hasMore={!!data?.hasMore} />
    </>
  );
}

// ───────────── bits ─────────────

function SortBar({ sort, setSort, labels = ["Newest", "Most reported"] }: { sort: "new" | "reports"; setSort: (s: "new" | "reports") => void; labels?: [string, string] }) {
  return (
    <div className="seg" role="tablist" aria-label="Sort">
      <button role="tab" aria-selected={sort === "new"} className={sort === "new" ? "on" : ""} onClick={() => setSort("new")}>{labels[0]}</button>
      <button role="tab" aria-selected={sort === "reports"} className={sort === "reports" ? "on" : ""} onClick={() => setSort("reports")}>{labels[1]}</button>
    </div>
  );
}

function Pager({ offset, setOffset, hasMore }: { offset: number; setOffset: (n: number) => void; hasMore: boolean }) {
  if (!offset && !hasMore) return null;
  return (
    <div className="row gap pager">
      <button className="btn btn-ghost btn-sm" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous page</button>
      <button className="btn btn-ghost btn-sm" disabled={!hasMore} onClick={() => setOffset(offset + 50)}>Next page</button>
    </div>
  );
}

// ───────────── review archive ─────────────

function ReportList({ reports }: { reports: ArchivedReport[] }) {
  const now = useTick();
  if (!reports.length) return null;
  return (
    <ul className="report-reasons">
      {reports.map((r, i) => (
        <li key={i}>
          <strong>{reasonLabel(r.reason)}</strong>{" "}
          <span className="muted">— {r.reporter ? `@${r.reporter}` : "deleted user"}, {ago(r.at, now)}</span>
          {r.details && <p className="report-details">{r.details}</p>}
        </li>
      ))}
    </ul>
  );
}

function ArchivedBurnCard({ b, onOpenUser }: { b: ArchivedBurn; onOpenUser?: (u: string) => void }) {
  const now = useTick();
  return (
    <li className="card report-card archive-card">
      <div className="report-badges">
        <span className="badge">Burn</span>
        <span className="badge badge-strong">{b.reports.length} {b.reports.length === 1 ? "report" : "reports"}</span>
        <span className="badge">{DELETION_LABELS[b.deletionReason] ?? b.deletionReason}</span>
      </div>
      <p className="report-body">“{b.body}”</p>
      <p className="muted small">
        by {onOpenUser ? <button className="user-link" onClick={() => onOpenUser(b.author)}>@{b.author}</button> : <>@{b.author}</>}
        {b.photoOwner && <> on @{b.photoOwner}&apos;s photo</>} · posted {ago(b.createdAt, now)} · deleted {ago(b.deletedAt, now)} · 🔥 {b.fireCount}
      </p>
      <ReportList reports={b.reports} />
    </li>
  );
}

function ArchivedPostCard({ p, onOpenUser }: { p: ArchivedPost; onOpenUser?: (u: string) => void }) {
  const now = useTick();
  return (
    <li className="card report-card archive-card">
      <div className="report-badges">
        <span className="badge">Photo</span>
        <span className="badge badge-strong">{p.reports.length} {p.reports.length === 1 ? "report" : "reports"}</span>
        <span className="badge">{DELETION_LABELS[p.deletionReason] ?? p.deletionReason}</span>
      </div>
      {p.caption && <p className="report-body">Caption: {p.caption}</p>}
      <p className="muted small">
        by {onOpenUser ? <button className="user-link" onClick={() => onOpenUser(p.owner)}>@{p.owner}</button> : <>@{p.owner}</>} · posted{" "}
        {ago(p.createdAt, now)} · deleted {ago(p.deletedAt, now)} · {p.commentCount} burns · image permanently deleted
      </p>
      <ReportList reports={p.reports} />
    </li>
  );
}

function Archive({ onOpenUser }: { onOpenUser: (u: string) => void }) {
  const [type, setType] = useState<"burns" | "photos">("burns");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const { data, error } = useAdminData<{ burns?: ArchivedBurn[]; posts?: ArchivedPost[]; hasMore: boolean }>(
    `/api/admin/archive?type=${type}&q=${encodeURIComponent(query)}&offset=${offset}`,
  );
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q);
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const items = type === "burns" ? data?.burns : data?.posts;
  return (
    <>
      <p className="muted small archive-note">
        Reported burns and photos are kept here after they leave the site so you can review them. Anything that was never reported is deleted
        completely after 24 hours. Photo images are always deleted; only the record and reports are kept.
      </p>
      <div className="row gap wrap admin-toolbar">
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search username or text" aria-label="Search archive" />
        <div className="seg" role="tablist" aria-label="Archive type">
          <button role="tab" aria-selected={type === "burns"} className={type === "burns" ? "on" : ""} onClick={() => { setType("burns"); setOffset(0); }}>Burns</button>
          <button role="tab" aria-selected={type === "photos"} className={type === "photos" ? "on" : ""} onClick={() => { setType("photos"); setOffset(0); }}>Photos</button>
        </div>
      </div>
      {!data ? (
        <Loading error={error} />
      ) : !items?.length ? (
        <p className="empty-line">Nothing reported has been deleted yet.</p>
      ) : (
        <ul className="report-list archive-list">
          {type === "burns"
            ? data.burns!.map((b) => <ArchivedBurnCard key={b.id} b={b} onOpenUser={onOpenUser} />)
            : data.posts!.map((p) => <ArchivedPostCard key={p.id} p={p} onOpenUser={onOpenUser} />)}
        </ul>
      )}
      <Pager offset={offset} setOffset={setOffset} hasMore={!!data?.hasMore} />
    </>
  );
}

// ───────────── one user's full history ─────────────

function UserDetail({
  username, confirm, onBack, onTempPassword,
}: {
  username: string;
  confirm: (p: Pending) => void;
  onBack: () => void;
  onTempPassword: (v: { username: string; password: string }) => void;
}) {
  const now = useTick();
  const { data, error } = useAdminData<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(username)}`);
  if (!data) return <><button className="btn btn-ghost btn-sm" onClick={onBack}>← All users</button><Loading error={error} /></>;
  const u = data.user;
  const isAdmin = u.role === "admin";

  return (
    <div className="user-detail">
      <button className="btn btn-ghost btn-sm" onClick={onBack}>← All users</button>

      <header className="card user-detail-head">
        <div>
          <h2 className="user-detail-name">
            @{u.username}
            {isAdmin && <span className="badge">Admin</span>}
            {u.status === "suspended" && <span className="badge badge-alert">Suspended</span>}
          </h2>
          <p className="muted small">
            Joined {new Date(u.createdAt).toLocaleDateString()} · {u.reportsReceived} reports received all time ·{" "}
            <Link to={`/u/${u.username}`}>public profile</Link>
          </p>
        </div>
        {!isAdmin && (
          <div className="row gap-sm wrap">
            {u.status === "suspended" ? (
              <button className="btn btn-ghost btn-sm" onClick={() => confirm({ title: `Unsuspend @${u.username}?`, body: "They'll be able to post, burn and react again.", label: "Unsuspend", danger: false, done: `@${u.username} unsuspended.`, run: () => api.post(`/api/admin/users/${u.username}/unsuspend`) })}>Unsuspend</button>
            ) : (
              <button className="btn btn-outline btn-sm" onClick={() => confirm({ title: `Suspend @${u.username}?`, body: "They can still log in and browse, but can't post photos, burn or react.", label: "Suspend", done: `@${u.username} suspended.`, run: () => api.post(`/api/admin/users/${u.username}/suspend`) })}>Suspend</button>
            )}
            <button
              className="btn btn-outline btn-sm"
              onClick={() => confirm({
                title: `Reset @${u.username}'s password?`,
                body: "Their current password stops working and they're signed out everywhere. You'll get a temporary password to give them.",
                label: "Reset password",
                danger: false,
                done: "Password reset.",
                run: async () => {
                  const r = await api.post<{ temporaryPassword: string }>(`/api/admin/users/${u.username}/reset-password`);
                  onTempPassword({ username: u.username, password: r.temporaryPassword });
                },
              })}
            >
              Reset password
            </button>
            <button className="btn btn-danger btn-sm" onClick={() => confirm({ title: `Delete @${u.username}?`, body: "Deletes the account, every photo (including stored images), every burn and every reaction they made. Reported items stay in the review archive.", label: "Delete user", done: `@${u.username} deleted.`, run: async () => { await api.del(`/api/admin/users/${u.username}`); onBack(); } })}>Delete</button>
          </div>
        )}
      </header>

      <section className="profile-section">
        <h3 className="section-title">Live photos <span className="muted">{data.livePosts.length}</span></h3>
        {!data.livePosts.length ? <p className="muted small">None right now.</p> : (
          <div className="admin-photo-grid">
            {data.livePosts.map((p) => (
              <div key={p.id} className="card admin-photo">
                <Link to={`/p/${p.id}`} className="admin-photo-img"><img src={p.imageUrl} alt="" loading="lazy" /></Link>
                <div className="admin-photo-meta">
                  {p.caption && <p className="small">{p.caption}</p>}
                  <dl>
                    <dt>Posted</dt><dd>{ago(p.createdAt, now)}</dd>
                    <dt>Expires</dt><dd>in {left(p.expiresAt, now)}</dd>
                    <dt>Reports</dt><dd className={p.reportCount ? "hot" : ""}>{p.reportCount}</dd>
                  </dl>
                  <button className="btn btn-danger btn-sm btn-block" onClick={() => confirm({ title: "Delete this photo?", body: "Deletes the photo, its burns and the stored image now.", label: "Delete photo", done: "Photo deleted.", run: () => api.del(`/api/admin/posts/${p.id}`) })}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="profile-section">
        <h3 className="section-title">Live burns <span className="muted">{data.liveBurns.length}</span></h3>
        {!data.liveBurns.length ? <p className="muted small">None right now.</p> : (
          <ul className="burn-list">
            {data.liveBurns.map((c) => (
              <li key={c.id} className="burn">
                <div className="burn-meta">
                  <time>{ago(c.createdAt, now)}</time>
                  <span className="dot" aria-hidden>·</span>
                  <Link to={`/p/${c.postId}`}>view photo</Link>
                  {c.reportCount > 0 && <><span className="dot" aria-hidden>·</span><span className="hot">{c.reportCount} reports</span></>}
                </div>
                <p className="burn-body">{c.body}</p>
                <div className="burn-actions">
                  <button className="ghost-action" onClick={() => confirm({ title: "Delete this burn?", body: `“${c.body.slice(0, 120)}”`, label: "Delete burn", done: "Burn deleted.", run: () => api.del(`/api/admin/comments/${c.id}`) })}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="profile-section">
        <h3 className="section-title">Reported history (deleted) <span className="muted">{data.archivedBurns.length + data.archivedPosts.length}</span></h3>
        {!data.archivedBurns.length && !data.archivedPosts.length ? (
          <p className="muted small">No reported content from this user has been deleted.</p>
        ) : (
          <ul className="report-list">
            {data.archivedPosts.map((p) => <ArchivedPostCard key={p.id} p={p} />)}
            {data.archivedBurns.map((b) => <ArchivedBurnCard key={b.id} b={b} />)}
          </ul>
        )}
      </section>
    </div>
  );
}
