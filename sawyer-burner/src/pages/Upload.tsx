import { useEffect, useRef, useState, type DragEvent } from "react";
import { CAPTION_MAX, MAX_UPLOAD_BYTES } from "../../shared/rules";
import type { PostDTO } from "../../shared/types";
import { IconImage } from "../components/Icons";
import { SellBy } from "../components/Nav";
import { useToast } from "../components/Toast";
import { errorMessage, uploadWithProgress } from "../lib/api";
import { useAuth } from "../lib/auth";
import { compressImage } from "../lib/compress";
import { Link, navigate } from "../lib/router";

const ACCEPT = ["image/jpeg", "image/png", "image/webp"];

export function Upload() {
  const { me } = useAuth();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [consent, setConsent] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState<PostDTO | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  function pick(f: File | undefined | null) {
    setError("");
    if (!f) return;
    if (!ACCEPT.includes(f.type)) return setError("Only JPG, PNG or WEBP images.");
    if (f.size > 40 * 1024 * 1024) return setError("That file is huge. Pick something under 40 MB.");
    setFile(f);
    setPreview(URL.createObjectURL(f));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files?.[0]);
  }

  async function submit() {
    if (!file || !consent) return;
    setError("");
    setProgress(0);
    try {
      const optimized = await compressImage(file);
      if (optimized.size > MAX_UPLOAD_BYTES) throw new Error("Still over 10 MB after compressing. Try a smaller photo.");
      const form = new FormData();
      form.append("image", optimized);
      form.append("consent", "yes");
      if (caption.trim()) form.append("caption", caption.trim());
      const { post } = await uploadWithProgress<{ post: PostDTO }>("/api/posts", form, setProgress);
      setDone(post);
      sessionStorage.removeItem("bb2.feed");
      toast("Photo posted.");
    } catch (err) {
      setError(err instanceof Error && !("status" in err) ? err.message : errorMessage(err));
      setProgress(null);
    }
  }

  function reset() {
    setFile(null);
    setPreview(null);
    setCaption("");
    setConsent(false);
    setProgress(null);
    setDone(null);
  }

  if (me?.suspended) {
    return (
      <main className="page narrow">
        <div className="empty-card">
          <h1>Posting is off for your account.</h1>
          <p className="muted">Your account is suspended. You can still browse and report content.</p>
          <Link to="/" className="btn btn-outline">Back to the feed</Link>
        </div>
      </main>
    );
  }

  if (done) {
    return (
      <main className="page narrow">
        <div className="card upload-done">
          <div className="done-photo">
            <img src={preview ?? done.imageUrl} alt="Your posted photo" />
            <SellBy text="24H" className="photo-stamp" />
          </div>
          <h1 className="upload-title">It's live.</h1>
          <p className="done-note">This photo will automatically disappear in 24 hours.</p>
          <div className="row gap">
            <button className="btn btn-primary" onClick={() => navigate(`/p/${done.id}`)}>See it in the feed</button>
            <button className="btn btn-ghost" onClick={reset}>Post another</button>
          </div>
        </div>
      </main>
    );
  }

  const busy = progress !== null;

  return (
    <main className="page narrow">
      <h1 className="page-title">Post a photo</h1>
      <p className="muted page-sub">Drop a photo. Everyone gets 24 hours to roast it. Then it's deleted for good.</p>

      <div className="card upload-card">
        {!preview ? (
          <button
            type="button"
            className={`dropzone${dragging ? " over" : ""}`}
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <IconImage size={40} />
            <span className="dropzone-title">Select a photo</span>
            <span className="muted small">JPG, PNG or WEBP. We resize it and strip location data before upload.</span>
          </button>
        ) : (
          <div className="preview">
            <img src={preview} alt="Preview of the photo you're about to post" />
            {!busy && (
              <button className="btn btn-ghost btn-sm preview-change" onClick={() => input.current?.click()}>
                Change photo
              </button>
            )}
          </div>
        )}
        <input ref={input} type="file" accept={ACCEPT.join(",")} hidden onChange={(e) => pick(e.target.files?.[0])} />

        {preview && (
          <>
            <label className="field">
              <span className="field-label">Caption (optional)</span>
              <input value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={CAPTION_MAX} placeholder="e.g. rate my first haircut in 4 years" disabled={busy} />
              <span className="field-hint">{CAPTION_MAX - caption.length} left · no names, handles, numbers or addresses</span>
            </label>

            <label className={`check consent${consent ? " on" : ""}`}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={busy} />
              <span>
                <strong>I have permission to post this image.</strong> It's me, or everyone in it agreed to be roasted. No minors, no private info.
              </span>
            </label>

            {error && <p className="form-error" role="alert">{error}</p>}

            {busy && (
              <div className="progress" role="progressbar" aria-valuenow={Math.round((progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div className="progress-bar" style={{ width: `${Math.max(4, (progress ?? 0) * 100)}%` }} />
              </div>
            )}

            <button className="btn btn-primary btn-lg btn-block" onClick={submit} disabled={!consent || busy}>
              {busy ? (progress && progress >= 1 ? "Finishing…" : "Uploading…") : "Post photo"}
            </button>
            <p className="muted small center">This photo will automatically disappear in 24 hours.</p>
          </>
        )}
        {!preview && error && <p className="form-error" role="alert">{error}</p>}
      </div>

      <p className="muted small center">
        Posting someone without their permission gets the photo pulled and your account suspended. <Link to="/rules">Read the rules</Link>
      </p>
    </main>
  );
}
