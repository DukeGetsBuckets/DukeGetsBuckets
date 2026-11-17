"use client";

import * as React from "react";
import { Ban, Flag, Swords, UserCheck, UserPlus } from "lucide-react";
import { emitWithAck } from "@/lib/socket";
import { useSocket } from "@/components/providers/SocketProvider";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { ChallengeDialog } from "@/components/friends/ChallengeDialog";

type Relation = "self" | "friend" | "outgoing" | "incoming" | "blocked" | "blockedBy" | "none";

export function ProfileActions({ target, initialRelation, authenticated }: { target: { id: string; username: string }; initialRelation: Relation; authenticated: boolean }) {
  const { socket, connected } = useSocket();
  const { toast } = useToast();
  const [relation, setRelation] = React.useState<Relation>(initialRelation);
  const [challenge, setChallenge] = React.useState(false);
  const [report, setReport] = React.useState(false);
  const [reason, setReason] = React.useState<"CHEATING" | "HARASSMENT" | "INAPPROPRIATE_NAME" | "SPAM" | "OTHER">("CHEATING");
  const [details, setDetails] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  if (!authenticated) return null;
  if (relation === "self") return null;

  const addFriend = async () => {
    if (!socket) return;
    setBusy(true);
    const r = await emitWithAck(socket, "friend:request", { userId: target.id });
    setBusy(false);
    if (r.ok) {
      setRelation("outgoing");
      toast({ title: "Friend request sent", tone: "success" });
    } else toast({ title: r.error.message, tone: "danger" });
  };
  const block = async () => {
    if (!socket || !confirm(`Block ${target.username}? They won't be able to challenge or message you.`)) return;
    const r = await emitWithAck(socket, relation === "blocked" ? "user:unblock" : "user:block", { userId: target.id });
    if (r.ok) setRelation(relation === "blocked" ? "none" : "blocked");
  };
  const sendReport = async () => {
    if (!socket) return;
    setBusy(true);
    const r = await emitWithAck(socket, "user:report", { userId: target.id, reason, details: details || undefined });
    setBusy(false);
    setReport(false);
    toast(r.ok ? { title: "Report submitted — thank you", tone: "success" } : { title: r.error.message, tone: "danger" });
  };

  return (
    <div className="flex flex-wrap gap-2">
      {relation === "blocked" || relation === "blockedBy" ? null : (
        <Button onClick={() => setChallenge(true)} disabled={!connected}>
          <Swords className="h-4 w-4" /> Challenge
        </Button>
      )}
      {relation === "none" ? (
        <Button variant="secondary" onClick={addFriend} loading={busy} disabled={!connected}>
          <UserPlus className="h-4 w-4" /> Add friend
        </Button>
      ) : relation === "friend" ? (
        <Button variant="secondary" disabled>
          <UserCheck className="h-4 w-4" /> Friends
        </Button>
      ) : relation === "outgoing" ? (
        <Button variant="secondary" disabled>
          Request sent
        </Button>
      ) : relation === "incoming" ? (
        <Button variant="secondary" onClick={addFriend} loading={busy}>
          Accept request
        </Button>
      ) : null}
      {relation !== "blockedBy" ? (
        <Button variant="ghost" onClick={block} title={relation === "blocked" ? "Unblock" : "Block"}>
          <Ban className="h-4 w-4" /> {relation === "blocked" ? "Unblock" : "Block"}
        </Button>
      ) : null}
      <Button variant="ghost" onClick={() => setReport(true)}>
        <Flag className="h-4 w-4" /> Report
      </Button>
      <ChallengeDialog open={challenge} onClose={() => setChallenge(false)} recipient={target} />
      <Modal open={report} onClose={() => setReport(false)} title={`Report ${target.username}`}>
        <div className="space-y-3">
          <Select label="Reason" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
            <option value="CHEATING">Cheating / engine use</option>
            <option value="HARASSMENT">Harassment or abuse</option>
            <option value="INAPPROPRIATE_NAME">Inappropriate username</option>
            <option value="SPAM">Spam</option>
            <option value="OTHER">Other</option>
          </Select>
          <textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={1000} rows={4} placeholder="Details (optional)" className="w-full rounded-xl border border-border bg-surface p-3 text-sm outline-none focus:border-accent" />
          <Button fullWidth onClick={sendReport} loading={busy}>
            Submit report
          </Button>
        </div>
      </Modal>
    </div>
  );
}
