import { useState } from "react";
import { REPORT_DETAILS_MAX, REPORT_REASONS } from "../../shared/rules";
import { api, errorMessage } from "../lib/api";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

export interface ReportTarget {
  type: "post" | "comment";
  id: string;
}

export function ReportDialog({ target, onClose, onHidden }: { target: ReportTarget | null; onClose: () => void; onHidden?: (t: ReportTarget) => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);

  const reasons = REPORT_REASONS.filter((r) => target?.type === "post" || r.value !== "its_me");
  const close = () => {
    setReason("");
    setDetails("");
    onClose();
  };

  async function submit() {
    if (!target || !reason) return;
    setBusy(true);
    try {
      const res = await api.post<{ alreadyReported: boolean; hidden: boolean }>("/api/reports", {
        targetType: target.type,
        targetId: target.id,
        reason,
        details,
      });
      if (res.alreadyReported) toast("You already reported this. Mods have it.", "info");
      else if (reason === "its_me") toast("Pulled from the feed. An admin will review it.");
      else toast("Reported. Thanks for keeping it clean.");
      if (res.hidden) onHidden?.(target);
      close();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={!!target} onClose={close} title={target?.type === "post" ? "Report photo" : "Report burn"}>
      <p className="muted small">Reports are anonymous to the poster. Admins review every one.</p>
      <fieldset className="reasons">
        <legend className="sr-only">Reason</legend>
        {reasons.map((r) => (
          <label key={r.value} className={`reason${reason === r.value ? " selected" : ""}${r.value === "its_me" ? " its-me" : ""}`}>
            <input type="radio" name="reason" value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)} />
            <span>{r.label}</span>
          </label>
        ))}
      </fieldset>
      {reason === "its_me" && (
        <p className="notice small">This photo is pulled from the feed as soon as you submit, until an admin reviews it.</p>
      )}
      <label className="field">
        <span className="field-label">Details (optional)</span>
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={REPORT_DETAILS_MAX} rows={3} placeholder="Anything that helps us act faster" />
      </label>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={close}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={!reason || busy}>
          {busy ? "Sending…" : "Send report"}
        </button>
      </div>
    </Modal>
  );
}
