import { SellBy } from "../components/Nav";
import { Link } from "../lib/router";

export function Landing() {
  return (
    <main className="landing">
      <div className="landing-inner">
        <h1 className="landing-title" aria-label="Sawyer Burner">
          <span className="lt-line">Sawyer</span>
          <span className="lt-line">
            <span className="wordmark-2">Burner</span>
            <SellBy text="24H" className="landing-stamp" />
          </span>
        </h1>
        <p className="landing-tagline">24 HOURS. POST IT. IT BURNS UP TOMORROW.</p>

        <div className="landing-actions">
          <Link to="/login" className="btn btn-primary btn-lg">Log in</Link>
          <Link to="/signup" className="btn btn-outline btn-lg">Create account</Link>
        </div>

        <ol className="landing-how" aria-label="How it works">
          <li><strong>Post a photo.</strong> Yours, or one you have permission to post.</li>
          <li><strong>Take the burns.</strong> Everyone gets to roast it. Give 🔥 to the best burns.</li>
          <li><strong>It's gone.</strong> 24 hours later the photo, burns and reactions are deleted for good. Reported posts are kept privately for moderators.</li>
        </ol>

        <p className="landing-notice">
          Keep the burns funny. No threats, private information, or posting people without permission.{" "}
          <Link to="/rules">Community rules</Link>
        </p>
      </div>
    </main>
  );
}
