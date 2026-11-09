import { useEffect } from "react";
import { ForcedPasswordChange } from "./components/ChangePassword";
import { Nav, Wordmark } from "./components/Nav";
import { ToastProvider } from "./components/Toast";
import { AuthProvider, useAuth } from "./lib/auth";
import { match, navigate, RouterProvider, useLocation } from "./lib/router";
import { Admin } from "./pages/Admin";
import { AuthPage } from "./pages/Auth";
import { Feed } from "./pages/Feed";
import { Landing } from "./pages/Landing";
import { Profile } from "./pages/Profile";
import { Rules } from "./pages/Rules";
import { Upload } from "./pages/Upload";
import { Link } from "./lib/router";

function Routes() {
  const { me, loading } = useAuth();
  const { path } = useLocation();

  const publicOnly = path === "/login" || path === "/signup";
  useEffect(() => {
    if (!loading && me && publicOnly) navigate("/", { replace: true });
  }, [loading, me, publicOnly]);

  if (loading) {
    return (
      <div className="boot" aria-busy="true">
        <Wordmark />
      </div>
    );
  }

  if (me?.mustChangePassword) return <ForcedPasswordChange />;
  if (path === "/rules") return <Rules />;

  if (!me) {
    if (path === "/login") return <AuthPage mode="login" />;
    if (path === "/signup") return <AuthPage mode="signup" />;
    return <Landing />;
  }

  const post = match("/p/:id", path);
  const user = match("/u/:username", path);
  if (path === "/" || post) return <Feed deepLinkId={post?.id} />;
  if (path === "/post") return <Upload />;
  if (user) return <Profile username={user.username} />;
  if (path === "/admin") return <Admin />;
  if (publicOnly) return null;
  return (
    <main className="page narrow">
      <div className="empty-card">
        <h1>Nothing here.</h1>
        <p className="muted">Like every photo on this site, it's gone.</p>
        <Link to="/" className="btn btn-outline">Back to the feed</Link>
      </div>
    </main>
  );
}

function Shell() {
  const { me } = useAuth();
  return (
    <div className={`app${me && !me.mustChangePassword ? " authed" : ""}`}>
      {!me?.mustChangePassword && <Nav />}
      <Routes />
    </div>
  );
}

export function App() {
  return (
    <RouterProvider>
      <ToastProvider>
        <AuthProvider>
          <Shell />
        </AuthProvider>
      </ToastProvider>
    </RouterProvider>
  );
}
