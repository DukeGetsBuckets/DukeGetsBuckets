import { useEffect, useState } from "react";
import type { ProfileDTO } from "../../shared/types";
import { ChangePasswordForm } from "../components/ChangePassword";
import { SellBy } from "../components/Nav";
import { api, ApiError, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Link, navigate } from "../lib/router";
import { ago, joined, left, useTick } from "../lib/time";

export function Profile({ username }: { username: string }) {
  const { me, logout } = useAuth();
  const now = useTick(60_000);
  const [profile, setProfile] = useState<ProfileDTO | null>(null);
  const [error, setError] = useState("");
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setProfile(null);
    setError("");
    api
      .get<{ profile: ProfileDTO }>(`/api/users/${encodeURIComponent(username)}`, ctrl.signal)
      .then(({ profile }) => setProfile(profile))
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        setError(err instanceof ApiError && err.status === 404 ? "No one goes by that name." : errorMessage(err));
      });
    return () => ctrl.abort();
  }, [username]);

  const isMe = me?.username === username.toLowerCase();

  if (error) {
    return (
      <main className="page narrow">
        <div className="empty-card">
          <h1>{error}</h1>
          <Link to="/" className="btn btn-outline">Back to the feed</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="page narrow">
      <header className="profile-head">
        <div className="avatar" aria-hidden>{(profile?.username ?? username).slice(0, 1).toUpperCase()}</div>
        <div>
          <h1 className="profile-name">@{profile?.username ?? username}</h1>
          <p className="muted small">{profile ? `Joined ${joined(profile.joinedAt)}` : " "}</p>
        </div>
        {isMe && (
          <button
            className="btn btn-ghost btn-sm profile-logout"
            onClick={async () => {
              await logout();
              navigate("/", { replace: true });
            }}
          >
            Log out
          </button>
        )}
      </header>

      <section className="profile-section">
        <h2 className="section-title">Live photos <span className="muted">{profile?.posts.length ?? ""}</span></h2>
        {!profile ? (
          <div className="grid">
            {[0, 1, 2].map((i) => <div key={i} className="sk tile-skeleton" />)}
          </div>
        ) : profile.posts.length === 0 ? (
          <p className="muted">{isMe ? "Nothing live. " : "Nothing live right now."}{isMe && <Link to="/post">Post a photo</Link>}</p>
        ) : (
          <div className="grid">
            {profile.posts.map((p) => (
              <Link key={p.id} to={`/p/${p.id}`} className="tile" aria-label={`Open photo posted ${ago(p.createdAt, now)}`}>
                <img src={p.imageUrl} alt="" loading="lazy" />
                <SellBy text={left(p.expiresAt, now)} className="tile-stamp" />
                <span className="tile-count">{p.commentCount} {p.commentCount === 1 ? "burn" : "burns"}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {isMe && (
        <section className="profile-section">
          <h2 className="section-title">Account</h2>
          {showPw ? (
            <div className="card settings-card">
              <ChangePasswordForm onDone={() => setShowPw(false)} />
              <button className="btn btn-ghost btn-sm pw-cancel" onClick={() => setShowPw(false)}>Cancel</button>
            </div>
          ) : (
            <button className="btn btn-outline btn-sm" onClick={() => setShowPw(true)}>Change password</button>
          )}
        </section>
      )}

      <section className="profile-section">
        <h2 className="section-title">Recent burns</h2>
        {profile && profile.recentComments.length === 0 && <p className="muted">No burns on live photos.</p>}
        <ul className="burn-list">
          {profile?.recentComments.map((c) => (
            <li key={c.id} className="burn">
              <div className="burn-meta">
                <time>{ago(c.createdAt, now)}</time>
                <span className="dot" aria-hidden>·</span>
                <Link to={`/p/${c.postId}`}>view photo</Link>
                <span className="dot" aria-hidden>·</span>
                <span>🔥 {c.fireCount}</span>
              </div>
              <p className="burn-body">{c.body}</p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
