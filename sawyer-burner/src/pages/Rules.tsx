import { Wordmark } from "../components/Nav";
import { useAuth } from "../lib/auth";
import { Link } from "../lib/router";

const RULES: Array<{ title: string; body: string }> = [
  { title: "Roasts are jokes, not attacks.", body: "Go after the haircut, the fit, the questionable decor. Don't go after someone's safety, body in a sexual way, or identity. If the only point is to hurt someone, it's not a roast." },
  { title: "Only post photos you have permission to post.", body: "Post yourself, or people who agreed to be roasted. No screenshots of strangers, no exes, no classmates who didn't sign up for this. If someone asks for a photo of them to come down, it comes down." },
  { title: "No private information. Ever.", body: "No names people didn't share themselves, phone numbers, addresses, schools, workplaces, schedules, license plates, passwords or account details. Doxxing gets you banned immediately." },
  { title: "No threats or violence.", body: "No threats, no telling people to hurt themselves, no \"I know where you live\", no encouraging anyone to go after someone. Not even as a joke." },
  { title: "No sexual content, and nothing sexual about minors.", body: "No nudity or sexual photos. Any sexual comment about a minor is a permanent ban and gets reported." },
  { title: "No slurs or hate.", body: "Racist, homophobic, transphobic or other discriminatory slurs aren't edgy, they're lazy. Be clever instead." },
  { title: "No spam.", body: "No links, ads, or copy-pasted burns. Uploads and burns are rate limited." },
];

export function Rules() {
  const { me } = useAuth();
  return (
    <main className={`page narrow rules${me ? "" : " rules-public"}`}>
      {!me && (
        <Link to="/" className="auth-brand">
          <Wordmark />
        </Link>
      )}
      <h1 className="page-title">Community rules</h1>
      <p className="page-sub">
        Sawyer Burner is for consensual, funny roasting. Everything disappears after 24 hours, but that's not a license to be vile. Break the rules and your content gets pulled and your account suspended or deleted.
      </p>

      <ol className="rules-list">
        {RULES.map((r) => (
          <li key={r.title}>
            <h2>{r.title}</h2>
            <p>{r.body}</p>
          </li>
        ))}
      </ol>

      <section className="card rules-card">
        <h2>Is a photo of you on here?</h2>
        <p>
          Open it, tap <strong>Report</strong> and choose <strong>“This is me — take it down”</strong>. The photo is pulled from the feed the moment you submit, and an admin reviews it. You can also report any burn that crosses the line.
        </p>
      </section>

      <section className="rules-fine">
        <h2>Terms, briefly</h2>
        <ul>
          <li>You're responsible for what you post, and you confirm you have permission for every photo you upload.</li>
          <li>Photos, their burns and reactions are permanently deleted 24 hours after posting. Location data is stripped from photos on upload.</li>
          <li>
            Exception: if a photo or burn is <strong>reported</strong>, a private text record of it (who posted it, the burn text or caption, and
            the reports) is kept after it's deleted so moderators can review it. Reported photos' images are still deleted.
          </li>
          <li>You can delete your own photos and burns at any time. You can also delete burns left on your own photos.</li>
          <li>Admins can remove any content and suspend or delete any account that breaks these rules.</li>
          <li>We don't collect your email or phone number. We store your username, a securely hashed password, and what you post.</li>
        </ul>
      </section>

      {!me && (
        <div className="row gap center-row">
          <Link to="/signup" className="btn btn-primary">Create account</Link>
          <Link to="/login" className="btn btn-outline">Log in</Link>
        </div>
      )}
    </main>
  );
}
