"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Chessboard } from "@/components/board/Chessboard";
import { useSettings } from "@/components/providers/SettingsProvider";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Toggle } from "@/components/ui/Toggle";
import { useToast } from "@/components/ui/Toast";
import { authClient, signOut } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { BOARD_THEMES, PIECE_SETS, type BoardThemeId, type PieceSetId } from "@/lib/settings";

const PREVIEW_FEN = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";

export function SettingsScreen({ profile, email }: { profile: { username: string; bio: string | null; country: string | null; profileVisibility: "PUBLIC" | "FRIENDS" | "PRIVATE"; image: string | null; emailVerified: boolean }; email: string }) {
  const { settings, update, saving } = useSettings();
  const { toast } = useToast();
  const router = useRouter();
  const [bio, setBio] = React.useState(profile.bio ?? "");
  const [country, setCountry] = React.useState(profile.country ?? "");
  const [image, setImage] = React.useState(profile.image ?? "");
  const [visibility, setVisibility] = React.useState(profile.profileVisibility);
  const [profileBusy, setProfileBusy] = React.useState(false);
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [pwBusy, setPwBusy] = React.useState(false);

  const saveProfile = async () => {
    setProfileBusy(true);
    const res = await fetch("/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ bio, country, image, profileVisibility: visibility }) });
    setProfileBusy(false);
    toast(res.ok ? { title: "Profile saved", tone: "success" } : { title: "Could not save profile", tone: "danger" });
    router.refresh();
  };

  const changePassword = async () => {
    setPwBusy(true);
    const r = await authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true });
    setPwBusy(false);
    if (r.error) toast({ title: r.error.message ?? "Could not change password", tone: "danger" });
    else {
      toast({ title: "Password updated", tone: "success" });
      setCurrentPassword("");
      setNewPassword("");
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-6 lg:col-span-3">
        <Card>
          <CardHeader title="Board" subtitle="Colours, pieces and what the board shows you." />
          <CardBody className="space-y-4">
            <div>
              <p className="mb-2 text-sm font-medium text-fg-muted">Board colours</p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {(Object.keys(BOARD_THEMES) as BoardThemeId[]).map((id) => (
                  <button key={id} onClick={() => update({ boardTheme: id })} className={cn("rounded-xl border p-1.5 text-xs", settings.boardTheme === id ? "border-accent" : "border-border")}>
                    <span className="grid aspect-square grid-cols-2 overflow-hidden rounded-md">
                      <span style={{ background: BOARD_THEMES[id].light }} />
                      <span style={{ background: BOARD_THEMES[id].dark }} />
                      <span style={{ background: BOARD_THEMES[id].dark }} />
                      <span style={{ background: BOARD_THEMES[id].light }} />
                    </span>
                    <span className="mt-1 block">{BOARD_THEMES[id].name}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium text-fg-muted">Piece style</p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {(Object.keys(PIECE_SETS) as PieceSetId[]).map((id) => (
                  <button key={id} onClick={() => update({ pieceSet: id })} className={cn("rounded-xl border p-2 text-xs", settings.pieceSet === id ? "border-accent" : "border-border")} title={PIECE_SETS[id].credit}>
                    <span className="flex justify-center gap-0.5">
                      <span className="h-9 w-9 bg-contain bg-center bg-no-repeat" style={{ backgroundImage: `url(/pieces/${id}/wN.svg)` }} />
                      <span className="h-9 w-9 bg-contain bg-center bg-no-repeat" style={{ backgroundImage: `url(/pieces/${id}/bQ.svg)` }} />
                    </span>
                    <span className="mt-1 block">{PIECE_SETS[id].name}</span>
                  </button>
                ))}
              </div>
            </div>
            <Toggle label="Show legal moves" description="Dots on the squares a selected piece can move to." checked={settings.showLegalMoves} onChange={(v) => update({ showLegalMoves: v })} />
            <Toggle label="Highlight last move" checked={settings.showLastMove} onChange={(v) => update({ showLastMove: v })} />
            <Toggle label="Show coordinates" checked={settings.showCoordinates} onChange={(v) => update({ showCoordinates: v })} />
            <div>
              <p className="mb-2 text-sm font-medium text-fg-muted">Piece animation</p>
              <Segmented value={String(settings.animationMs)} onChange={(v) => update({ animationMs: Number(v) })} options={[{ value: "0", label: "Off" }, { value: "120", label: "Fast" }, { value: "180", label: "Normal" }, { value: "300", label: "Slow" }]} size="sm" />
            </div>
            <div>
              <p className="mb-2 text-sm font-medium text-fg-muted">Arrow colour</p>
              <div className="flex gap-2">
                {["#f59e0b", "#22c55e", "#3b82f6", "#ef4444", "#a855f7"].map((c) => (
                  <button key={c} onClick={() => update({ arrowColor: c })} className={cn("h-9 w-9 rounded-full border-2", settings.arrowColor === c ? "border-fg" : "border-transparent")} style={{ background: c }} aria-label={c} />
                ))}
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Game" />
          <CardBody className="divide-y divide-border">
            <Toggle label="Enable premoves" description="Queue a move while your opponent is thinking." checked={settings.premovesEnabled} onChange={(v) => update({ premovesEnabled: v })} />
            <Toggle label="Always promote to queen" description="Skip the promotion menu." checked={settings.autoQueen} onChange={(v) => update({ autoQueen: v })} />
            <div className="py-3">
              <Select label="Default promotion piece (premoves and auto-promote)" value={settings.defaultPromotion} onChange={(e) => update({ defaultPromotion: e.target.value as "q" | "r" | "b" | "n" })}>
                <option value="q">Queen</option>
                <option value="n">Knight</option>
                <option value="r">Rook</option>
                <option value="b">Bishop</option>
              </Select>
            </div>
            <Toggle label="Confirm resignation" checked={settings.confirmResign} onChange={(v) => update({ confirmResign: v })} />
            <Toggle label="Play sounds" checked={settings.soundEnabled} onChange={(v) => update({ soundEnabled: v })} />
            <div className="py-3">
              <label className="block text-sm font-medium">Sound volume: {settings.soundVolume}%</label>
              <input type="range" min={0} max={100} value={settings.soundVolume} onChange={(e) => update({ soundVolume: Number(e.target.value) })} className="mt-2 w-full accent-[var(--accent)]" />
            </div>
            <Toggle label="Show opponent rating" checked={settings.showOpponentRating} onChange={(v) => update({ showOpponentRating: v })} />
            <Toggle label="In-game chat" checked={settings.chatEnabled} onChange={(v) => update({ chatEnabled: v })} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Appearance" />
          <CardBody className="space-y-4">
            <Segmented value={settings.theme} onChange={(v) => update({ theme: v })} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
            <Toggle label="Reduce motion" description="Minimise animations across the app." checked={settings.reducedMotion} onChange={(v) => update({ reducedMotion: v })} />
          </CardBody>
        </Card>
      </div>

      <div className="space-y-6 lg:col-span-2">
        <Card>
          <CardHeader title="Preview" subtitle={saving ? "Saving…" : "Changes save automatically."} />
          <CardBody>
            <Chessboard fen={PREVIEW_FEN} orientation="white" movable={null} dests={new Map()} onMove={() => undefined} lastMove={{ from: "f1", to: "c4" }} theme={settings.boardTheme} pieceSet={settings.pieceSet} showCoordinates={settings.showCoordinates} showLastMove={settings.showLastMove} animationMs={settings.animationMs} viewOnly />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Profile" subtitle={`@${profile.username}`} />
          <CardBody className="space-y-3">
            <Input label="Bio" value={bio} onChange={(e) => setBio(e.target.value)} maxLength={280} placeholder="Say something about your chess" />
            <Input label="Country code" value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))} placeholder="US" maxLength={2} />
            <Input label="Avatar image URL" value={image} onChange={(e) => setImage(e.target.value)} placeholder="https://…" />
            <Select label="Profile visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)}>
              <option value="PUBLIC">Public</option>
              <option value="FRIENDS">Friends only</option>
              <option value="PRIVATE">Private</option>
            </Select>
            <Toggle label="Allow friend requests" checked={settings.allowFriendRequests} onChange={(v) => update({ allowFriendRequests: v })} />
            <Select label="Who can challenge me" value={settings.allowChallenges} onChange={(e) => update({ allowChallenges: e.target.value as "everyone" | "friends" | "nobody" })}>
              <option value="everyone">Everyone</option>
              <option value="friends">Friends only</option>
              <option value="nobody">Nobody</option>
            </Select>
            <Button onClick={saveProfile} loading={profileBusy} fullWidth>
              Save profile
            </Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Account" subtitle={email} />
          <CardBody className="space-y-3">
            {!profile.emailVerified ? (
              <p className="rounded-xl bg-info-soft px-3 py-2 text-sm text-info">
                Your email is not verified.{" "}
                <a href="/verify-email" className="font-medium underline">
                  Resend verification
                </a>
              </p>
            ) : null}
            <Input label="Current password" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
            <Input label="New password" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} />
            <Button variant="secondary" fullWidth onClick={changePassword} loading={pwBusy} disabled={!currentPassword || newPassword.length < 8}>
              Change password
            </Button>
            <Button variant="outline" fullWidth onClick={() => void signOut().then(() => (window.location.href = "/"))}>
              Log out
            </Button>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
