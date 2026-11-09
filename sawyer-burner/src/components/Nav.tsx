import { useAuth } from "../lib/auth";
import { Link, navigate, useLocation } from "../lib/router";
import { IconHome, IconLogout, IconPlus, IconShield, IconUser } from "./Icons";

export function Wordmark({ size = "sm" }: { size?: "sm" | "xl" }) {
  return (
    <span className={`wordmark wordmark-${size}`}>
      Sawyer <span className="wordmark-2">Burner</span>
    </span>
  );
}

/** Butcher-counter "sell by" sticker: the signature element. Photos expire like meat. */
export function SellBy({ text, urgent = false, className = "" }: { text: string; urgent?: boolean; className?: string }) {
  return (
    <span className={`sellby${urgent ? " urgent" : ""} ${className}`}>
      <span className="sellby-label">Gone in</span>
      <span className="sellby-value">{text}</span>
    </span>
  );
}

export function Nav() {
  const { me, logout } = useAuth();
  const { path } = useLocation();
  if (!me) return null;

  const active = (p: string) => (p === "/" ? path === "/" || path.startsWith("/p/") : path.startsWith(p));
  const doLogout = async () => {
    await logout();
    navigate("/", { replace: true });
  };
  const profile = `/u/${me.username}`;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand" aria-label="Sawyer Burner — feed">
            <Wordmark />
          </Link>
          <nav className="topnav" aria-label="Main">
            <Link to="/" className={active("/") ? "active" : ""} aria-current={active("/") ? "page" : undefined}>Feed</Link>
            <Link to="/post" className={`post-cta${active("/post") ? " active" : ""}`}>
              <IconPlus size={16} /> Post photo
            </Link>
            <Link to={profile} className={active(profile) ? "active" : ""}>Profile</Link>
            {me.role === "admin" && <Link to="/admin" className={active("/admin") ? "active" : ""}>Admin</Link>}
            <button className="topnav-logout" onClick={doLogout}>Logout</button>
          </nav>
          <button className="icon-btn mobile-only" onClick={doLogout} aria-label="Log out">
            <IconLogout />
          </button>
        </div>
      </header>

      <nav className="bottomnav" aria-label="Main">
        <Link to="/" className={active("/") ? "active" : ""} aria-label="Feed">
          <IconHome /> <span>Feed</span>
        </Link>
        <Link to="/post" className="bottomnav-post" aria-label="Post a photo">
          <IconPlus size={24} />
        </Link>
        <Link to={profile} className={active(profile) ? "active" : ""} aria-label="Profile">
          <IconUser /> <span>Profile</span>
        </Link>
        {me.role === "admin" && (
          <Link to="/admin" className={active("/admin") ? "active" : ""} aria-label="Admin">
            <IconShield /> <span>Admin</span>
          </Link>
        )}
      </nav>
    </>
  );
}
