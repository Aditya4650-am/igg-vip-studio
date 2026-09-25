import { useCallback, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  Ban,
  Copy,
  Check,
  Database,
  Inbox,
  KeyRound,
  Layers,
  Lock,
  Monitor,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Dict, Lang } from "@/lib/i18n";
import { deleteKey, issueKey, listInbox, listKeys, publishUpdate, restoreKey } from "@/lib/admin-api";
import { getRelease } from "@/lib/studio-api";

type HubTab = "arch" | "keys" | "update" | "mail";
type Plan = "trial" | "week" | "month" | "year" | "lifetime" | "custom";
type KeyRow = Awaited<ReturnType<typeof listKeys>>[number];
type MailRow = Awaited<ReturnType<typeof listInbox>>[number];
type Release = Awaited<ReturnType<typeof getRelease>>;

const PLANS: Plan[] = ["trial", "week", "month", "year", "lifetime", "custom"];
const PLAN_KEY: Record<Plan, keyof Dict> = {
  trial: "planTrial",
  week: "planWeek",
  month: "planMonth",
  year: "planYear",
  lifetime: "planLifetime",
  custom: "planCustom",
};

const LESSONS: { n: string; tab: HubTab; title: keyof Dict; body: keyof Dict }[] = [
  { n: "01", tab: "keys", title: "schoolIssue", body: "schoolIssueD" },
  { n: "02", tab: "keys", title: "schoolBind", body: "schoolBindD" },
  { n: "03", tab: "keys", title: "schoolRestore", body: "schoolRestoreD" },
  { n: "04", tab: "update", title: "schoolPublish", body: "schoolPublishD" },
  { n: "05", tab: "mail", title: "schoolMail", body: "schoolMailD" },
  { n: "06", tab: "arch", title: "schoolSecure", body: "schoolSecureD" },
];

function remain(ms: number, lifetime: boolean, lang: Lang) {
  if (lifetime) return lang === "vi" ? "Vĩnh viễn" : "Lifetime";
  if (ms <= 0) return lang === "vi" ? "Hết hạn" : "Expired";
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (lang === "vi") {
    if (d > 0) return `${d}n ${h}g`;
    if (h > 0) return `${h}g ${m}p`;
    return `${m}p`;
  }
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function stamp(ts: number, lang: Lang) {
  try {
    return new Date(ts).toLocaleString(lang === "vi" ? "vi-VN" : "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

export function OwnerHub({
  tr,
  lang,
  token,
  onClose,
  embedded = false,
}: {
  tr: (k: keyof Dict) => string;
  lang: Lang;
  token: string;
  onClose: () => void;
  embedded?: boolean;
}) {
  const [tab, setTab] = useState<HubTab>("arch");
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [mail, setMail] = useState<MailRow[]>([]);
  const [release, setRelease] = useState<Release | null>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Plan>("month");
  const [customKey, setCustomKey] = useState("");
  const [days, setDays] = useState("7");
  const [hours, setHours] = useState("0");
  const [group, setGroup] = useState(false);
  const [maxDev, setMaxDev] = useState("5");
  const [note, setNote] = useState("");
  const [bindDevice, setBindDevice] = useState("");
  const [restoreTarget, setRestoreTarget] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [nextVer, setNextVer] = useState("1.17.0");
  const [nextNotes, setNextNotes] = useState("");
  const [nextDownloadUrl, setNextDownloadUrl] = useState("");
  const [nextSha256, setNextSha256] = useState("");

  const refresh = useCallback(async () => {
    const [k, m, r] = await Promise.all([
      listKeys({ data: { token } }),
      listInbox({ data: { token } }),
      getRelease({ data: { token } }),
    ]);
    setKeys(k);
    setMail(m);
    setRelease(r);
  }, [token]);

  useEffect(() => {
    void refresh().catch((e) => toast.error(e instanceof Error ? e.message : "Fail"));
  }, [refresh]);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const onIssue = async () => {
    setBusy(true);
    try {
      const row = await issueKey({
        data: {
          token,
          plan,
          customKey: customKey.trim() || undefined,
          days: plan === "custom" ? Number(days) || 0 : undefined,
          hours: plan === "custom" ? Number(hours) || 0 : undefined,
          group,
          maxDevices: group ? Number(maxDev) || 5 : undefined,
          note: note.trim() || undefined,
          bindDevice: bindDevice.trim() || undefined,
        },
      });
      setIssued(row.key);
      setCustomKey("");
      setNote("");
      await refresh();
      toast.success(`${tr("licenseIssued")} · ${row.key}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Fail");
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async () => {
    if (!restoreTarget.trim()) return;
    setBusy(true);
    try {
      const row = await restoreKey({
        data: {
          token,
          key: restoreTarget.trim(),
          plan,
          days: plan === "custom" ? Number(days) || 0 : undefined,
          hours: plan === "custom" ? Number(hours) || 0 : undefined,
        },
      });
      await refresh();
      toast.success(`${tr("licenseRestored")} · ${row.key}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Fail");
    } finally {
      setBusy(false);
    }
  };

  const onPublish = async () => {
    setBusy(true);
    try {
      const r = await publishUpdate({ data: { token, version: nextVer.trim(), notes: nextNotes, downloadUrl: nextDownloadUrl.trim(), sha256: nextSha256.trim() } });
      setRelease(r);
      toast.success(`${tr("updatePublished")} · ${r.version}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Fail");
    } finally {
      setBusy(false);
    }
  };

  const onDeleteKey = async (key: string) => {
    if (!window.confirm(tr("licenseDeleteConfirm"))) return;
    setBusy(true);
    try {
      const r = await deleteKey({ data: { token, key } });
      await refresh();
      toast.success(`${tr("licenseDeleted")} · ${r.key}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Fail");
    } finally {
      setBusy(false);
    }
  };

  const TABS: { id: HubTab; label: keyof Dict; Icon: typeof Layers }[] = [
    { id: "arch", label: "hubArch", Icon: Layers },
    { id: "keys", label: "hubKeys", Icon: KeyRound },
    { id: "update", label: "hubUpdate", Icon: Sparkles },
    { id: "mail", label: "hubMail", Icon: Inbox },
  ];

  return (
    <>
      {embedded ? null : <button type="button" className="hub-scrim" aria-label="Close" onClick={onClose} />}
      <div className={cn("hub-shell", embedded && "hub-shell--page")} role="dialog" aria-labelledby="hub-title">
        <header className="owner-header flex items-center gap-3 border-b border-border px-4 py-3">
          <span className="owner-header-icon"><Server className="size-4" /></span>
          <div className="min-w-0 flex-1">
            <h2 id="hub-title" className="font-display text-base font-semibold">
              {tr("ownerTitle")}
            </h2>
            <p className="truncate text-xs text-muted">{tr("ownerHint")}</p>
          </div>
          {embedded ? null : (
          <button
            type="button"
            className="grid size-11 place-items-center rounded-md text-muted hover:text-fg"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
          )}
        </header>

        <nav className="owner-tabs grid grid-cols-4 border-b border-border px-2 pt-2">
          {TABS.map((item) => {
            const on = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "owner-tab flex min-h-11 items-center justify-center gap-1.5 rounded-t-lg px-2 text-xs font-semibold sm:text-sm",
                  on ? "owner-tab--active bg-input text-primary" : "text-muted hover:text-fg",
                )}
                onClick={() => setTab(item.id)}
                aria-current={on ? "page" : undefined}
              >
                <item.Icon className="size-3.5" />
                <span className="hidden sm:inline">{tr(item.label)}</span>
              </button>
            );
          })}
        </nav>

        <div className="owner-content min-h-0 flex-1 overflow-auto p-4 sm:p-5">
          {tab === "arch" ? (
            <div className="stagger-in space-y-4">
              <div>
                <h3 className="font-display text-lg font-semibold">{tr("schoolTitle")}</h3>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{tr("schoolLead")}</p>
              </div>

              <div className="arch-pipe">
                <article className="panel">
                  <Monitor className="size-5 text-cyan" />
                  <h3 className="mt-2 font-semibold text-cyan">{tr("archClient")}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{tr("archClientD")}</p>
                </article>
                <div className="arch-arrow" aria-hidden>
                  <ArrowDown className="size-4 lg:hidden" />
                  <ArrowRight className="hidden size-4 lg:block" />
                  <span>{tr("pipeAsk")}</span>
                  <span className="text-primary">{tr("pipeSeal")}</span>
                </div>
                <article className="panel shadow-outline">
                  <Server className="size-5 text-primary" />
                  <h3 className="mt-2 font-semibold text-primary">{tr("archServer")}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{tr("archServerD")}</p>
                </article>
                <div className="arch-arrow" aria-hidden>
                  <ArrowDown className="size-4 lg:hidden" />
                  <ArrowRight className="hidden size-4 lg:block" />
                  <span>{tr("pipeWrite")}</span>
                </div>
                <article className="panel">
                  <Database className="size-5 text-amber" />
                  <h3 className="mt-2 font-semibold text-amber">{tr("archData")}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{tr("archDataD")}</p>
                </article>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <article className="panel flex gap-3">
                  <Ban className="mt-0.5 size-4 shrink-0 text-err" />
                  <div>
                    <h3 className="font-semibold text-err">{tr("neverClient")}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted">{tr("neverClientD")}</p>
                  </div>
                </article>
                <article className="panel flex gap-3">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok" />
                  <div>
                    <h3 className="font-semibold text-ok">{tr("alwaysServer")}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted">{tr("alwaysServerD")}</p>
                  </div>
                </article>
              </div>

              <div className="space-y-2">
                {LESSONS.map((item) => (
                  <article key={item.n} className="panel flex flex-wrap items-start gap-3">
                    <span className="lesson-n">{item.n}</span>
                    <div className="min-w-0 flex-1">
                      <h3 className="font-semibold">{tr(item.title)}</h3>
                      <p className="mt-1 text-sm leading-relaxed text-muted">{tr(item.body)}</p>
                    </div>
                    {item.tab !== "arch" ? (
                      <Button size="sm" variant="outline" onClick={() => setTab(item.tab)}>
                        {tr("schoolDo")}
                        <ArrowRight className="size-3.5" />
                      </Button>
                    ) : null}
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          {tab === "keys" ? (
            <div className="stagger-in space-y-4">
              <section className="panel space-y-2">
                <h3 className="text-xs font-bold tracking-wider text-primary uppercase">{tr("keysTitle")}</h3>
                <p className="text-sm text-muted">{tr("keysHint")}</p>
                <ul className="space-y-1.5 text-sm text-muted">
                  <li className="flex gap-2">
                    <Lock className="mt-0.5 size-3.5 shrink-0 text-primary" />
                    {tr("keyRule1")}
                  </li>
                  <li className="flex gap-2">
                    <RefreshCw className="mt-0.5 size-3.5 shrink-0 text-amber" />
                    {tr("keyRule2")}
                  </li>
                  <li className="flex gap-2">
                    <KeyRound className="mt-0.5 size-3.5 shrink-0 text-purple" />
                    {tr("keyRule3")}
                  </li>
                </ul>
              </section>

              <section className="panel space-y-3">
                <h3 className="text-xs font-bold tracking-wider text-primary uppercase">{tr("licenseIssue")}</h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="kicker">{tr("licensePlan")}</span>
                    <select className="field mt-1.5" value={plan} onChange={(e) => setPlan(e.target.value as Plan)}>
                      {PLANS.map((p) => (
                        <option key={p} value={p}>
                          {tr(PLAN_KEY[p])}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="kicker">{tr("licenseCustomKey")}</span>
                    <input
                      className="field mt-1.5 font-mono"
                      placeholder={tr("licenseCustomPh")}
                      value={customKey}
                      onChange={(e) => setCustomKey(e.target.value)}
                    />
                  </label>
                  {plan === "custom" ? (
                    <>
                      <label className="block">
                        <span className="kicker">{tr("licenseDays")}</span>
                        <input
                          className="field mt-1.5"
                          inputMode="numeric"
                          value={days}
                          onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, ""))}
                        />
                      </label>
                      <label className="block">
                        <span className="kicker">{tr("licenseHours")}</span>
                        <input
                          className="field mt-1.5"
                          inputMode="numeric"
                          value={hours}
                          onChange={(e) => setHours(e.target.value.replace(/[^\d]/g, ""))}
                        />
                      </label>
                    </>
                  ) : null}
                  <label className="block sm:col-span-2">
                    <span className="kicker">{tr("licenseNote")}</span>
                    <input className="field mt-1.5" value={note} onChange={(e) => setNote(e.target.value)} />
                  </label>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} />
                    {tr("licenseGroupToggle")}
                  </label>
                  {group ? (
                    <label className="block">
                      <span className="kicker">{tr("licenseMaxDev")}</span>
                      <input
                        className="field mt-1.5"
                        inputMode="numeric"
                        value={maxDev}
                        onChange={(e) => setMaxDev(e.target.value.replace(/[^\d]/g, ""))}
                      />
                    </label>
                  ) : (
                    <label className="block">
                      <span className="kicker">{tr("licenseBound")}</span>
                      <input
                        className="field mt-1.5 font-mono"
                        placeholder={tr("bindDevicePh")}
                        value={bindDevice}
                        onChange={(e) => setBindDevice(e.target.value)}
                      />
                    </label>
                  )}
                </div>
                <Button disabled={busy} onClick={() => void onIssue()}>
                  <KeyRound className="size-4" />
                  {tr("licenseIssue")}
                </Button>
                {issued ? (
                  <div className="flex items-center gap-2 rounded-md bg-ok/15 px-3 py-2">
                    <code className="flex-1 font-mono text-sm text-ok">{issued}</code>
                    <button
                      type="button"
                      className="inline-flex h-9 items-center gap-1 text-xs text-ok"
                      onClick={() => copy(issued)}
                    >
                      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                      {copied ? tr("copied") : tr("copyKey")}
                    </button>
                  </div>
                ) : null}
              </section>

              <section className="panel space-y-3">
                <h3 className="text-xs font-bold tracking-wider text-amber uppercase">{tr("licenseRestore")}</h3>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    className="field flex-1 font-mono"
                    placeholder={tr("restoreKeyPh")}
                    value={restoreTarget}
                    onChange={(e) => setRestoreTarget(e.target.value)}
                  />
                  <Button variant="amber" disabled={busy} onClick={() => void onRestore()}>
                    <RefreshCw className="size-4" />
                    {tr("licenseRestore")}
                  </Button>
                </div>
              </section>

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-xs font-bold tracking-wider text-muted uppercase">{tr("keyList")}</h3>
                  <span className="text-xs text-muted tabular-nums">{keys.length}</span>
                </div>
                <div className="space-y-2">
                  {keys.map((k) => (
                    <article key={k.key} className="panel flex flex-wrap items-center gap-2">
                      <code className="font-mono text-sm">{k.key}</code>
                      <span className="rounded-full bg-input px-2 py-0.5 text-xs text-muted">
                        {tr(PLAN_KEY[k.plan])}
                      </span>
                      {k.group ? (
                        <span className="rounded-full bg-purple/15 px-2 py-0.5 text-xs text-purple">
                          {tr("licenseGroup")} · {k.devices.length}/{k.maxDevices}
                        </span>
                      ) : (
                        <span className="rounded-full bg-cyan/15 px-2 py-0.5 text-xs text-cyan">{tr("licenseSingle")}</span>
                      )}
                      <span className="ml-auto text-xs font-semibold text-amber tabular-nums">
                        {remain(k.remainingMs, k.lifetime, lang)}
                      </span>
                      {k.admin ? null : (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() => void onDeleteKey(k.key)}
                          aria-label={`${tr("licenseDelete")} ${k.key}`}
                        >
                          <Trash2 className="size-3.5" />
                          {tr("licenseDelete")}
                        </Button>
                      )}
                      {k.note ? <p className="w-full text-xs text-muted">{k.note}</p> : null}
                      {k.devices.length ? (
                        <p className="w-full font-mono text-xs text-muted">{k.devices.join(" · ")}</p>
                      ) : null}
                    </article>
                  ))}
                </div>
              </section>
            </div>
          ) : null}

          {tab === "update" ? (
            <div className="stagger-in space-y-4">
              <section className="panel">
                <p className="kicker">{tr("updateCurrent")}</p>
                <p className="mt-1 font-display text-3xl font-semibold text-primary">{release?.version ?? "—"}</p>
                <p className="mt-2 text-sm text-muted">{release?.notes}</p>
                {release ? (
                  <p className="mt-2 text-xs text-muted">
                    {tr("updatePublished")} · {stamp(release.publishedAt, lang)}
                  </p>
                ) : null}
              </section>
              <ol className="grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-3">
                {[tr("updateHow1"), tr("updateHow2"), tr("updateHow3")].map((text, i) => (
                  <li key={i} className="panel flex gap-3">
                    <span className="lesson-n">{String(i + 1).padStart(2, "0")}</span>
                    <p className="text-sm leading-relaxed text-muted">{text}</p>
                  </li>
                ))}
              </ol>
              <section className="panel space-y-3">
                <h3 className="text-xs font-bold tracking-wider text-primary uppercase">{tr("updatePublish")}</h3>
                <p className="text-sm text-muted">{tr("updateHint")}</p>
                <label className="block">
                  <span className="kicker">{tr("version")}</span>
                  <input
                    className="field mt-1.5 font-mono"
                    placeholder={tr("updateVerPh")}
                    value={nextVer}
                    onChange={(e) => setNextVer(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="kicker">{tr("updateNotes")}</span>
                  <textarea
                    className="field mt-1.5 h-24 py-3"
                    placeholder={tr("updateNotesPh")}
                    value={nextNotes}
                    onChange={(e) => setNextNotes(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="kicker">{tr("updateDownloadUrl")}</span>
                  <input
                    className="field mt-1.5 font-mono"
                    placeholder="https://.../IGG-VIP-TOOL-v1.16.1.exe"
                    value={nextDownloadUrl}
                    onChange={(e) => setNextDownloadUrl(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="kicker">{tr("updateSha256")}</span>
                  <input
                    className="field mt-1.5 font-mono"
                    placeholder={tr("updateSha256Ph")}
                    value={nextSha256}
                    onChange={(e) => setNextSha256(e.target.value)}
                  />
                </label>
                <Button disabled={busy} onClick={() => void onPublish()}>
                  <Sparkles className="size-4" />
                  {tr("updatePublish")}
                </Button>
              </section>
            </div>
          ) : null}

          {tab === "mail" ? (
            <div className="stagger-in space-y-2">
              {mail.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted">{tr("inboxEmpty")}</p>
              ) : (
                mail.map((m, i) => (
                  <article key={`${m.at}-${i}`} className="panel">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span className="font-mono">{m.deviceId}</span>
                      <span>
                        {tr("inboxAt")} {stamp(m.at, lang)}
                      </span>
                      <span className="ml-auto font-semibold text-amber">
                        {remain(m.remainingMs, m.lifetime, lang)}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed">{m.message}</p>
                  </article>
                ))
              )}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
