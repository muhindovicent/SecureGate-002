/** Primary file 1: accessible React application and role-specific operational workflows. */
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ShieldCheck,
  LayoutDashboard,
  ScanLine,
  Laptop,
  ArrowUpRight,
  ArrowDownLeft,
  Users,
  KeyRound,
  FileText,
  Settings,
  LogOut,
  Bell,
  ChevronRight,
  Menu,
  Activity,
  Search,
  CircleCheck,
  AlertTriangle,
  Clock3,
  DoorOpen,
  Camera,
  X,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { QRCodeSVG } from "qrcode.react";
import { BrowserQRCodeReader } from "@zxing/browser";
import "./styles.css";

type User = { id: string; name: string; email: string; role: string };
type Me = {
  user: User;
  csrf: string;
  student: any;
  institution: string;
  stage: "FULL" | "MFA_SETUP_REQUIRED" | "MFA_REQUIRED";
  mfaEnabled: boolean;
};
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});
let csrf = "";
async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch("/api/v1/" + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      "x-csrf-token": csrf,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let result;
  try {
    result = await r.json();
  } catch {
    throw new Error("Network unavailable. No movement has been confirmed.");
  }
  if (!r.ok) throw new Error(result.message || "Request failed");
  return result;
}
const date = (s: string) =>
  new Intl.DateTimeFormat("en-UG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Kampala",
  }).format(new Date(s));
const title = (s: string) =>
  s
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
const base: Record<string, string> = {
  STUDENT: "/student",
  OFFICER: "/security",
  VERIFIER: "/registration",
  REGISTRAR: "/registration",
  SUPERVISOR: "/supervisor",
  ADMIN: "/admin",
  MANAGEMENT: "/management",
  AUDITOR: "/auditor",
};
const links: Record<string, Array<[string, string, React.ElementType]>> = {
  STUDENT: [
    ["dashboard", "Overview", LayoutDashboard],
    ["profile", "My profile", Users],
    ["gadgets", "My gadgets", Laptop],
    ["visits", "Movement history", ArrowUpRight],
    ["credentials", "Student ID", KeyRound],
    ["reports", "Reports & support", FileText],
  ],
  OFFICER: [
    ["dashboard", "Gate overview", LayoutDashboard],
    ["scanner", "Scan checkpoint", ScanLine],
    ["incidents", "Incidents", AlertTriangle],
  ],
  VERIFIER: [["gadgets", "Verification queue", Laptop]],
  REGISTRAR: [
    ["students", "Student registry", Users],
    ["credentials", "ID credentials", KeyRound],
  ],
  SUPERVISOR: [
    ["dashboard", "Operations overview", LayoutDashboard],
    ["scanner", "Scan checkpoint", ScanLine],
    ["incidents", "Incident queue", AlertTriangle],
    ["overrides", "Manual reviews", FileText],
    ["terminals", "Operator assignments", DoorOpen],
  ],
  ADMIN: [
    ["dashboard", "System overview", LayoutDashboard],
    ["users", "Staff accounts", Users],
    ["roles", "Permissions", ShieldCheck],
    ["gates", "Checkpoints", DoorOpen],
    ["terminals", "Terminals", ScanLine],
    ["settings", "Configuration", Settings],
  ],
  MANAGEMENT: [
    ["dashboard", "Campus overview", LayoutDashboard],
    ["reports", "Operational reports", FileText],
  ],
  AUDITOR: [
    ["dashboard", "Audit overview", LayoutDashboard],
    ["events", "Audit trail", FileText],
  ],
};
for (const role of Object.keys(links))
  links[role].push(["account", "Account security", ShieldCheck]);
function useData(path: string, enabled = true) {
  return useQuery<any>({
    queryKey: [path],
    queryFn: () => api(path),
    enabled,
    refetchOnWindowFocus: path !== "me",
    refetchInterval: path === "reports" || path === "movements" ? 15000 : false,
  });
}
function Badge({ value }: { value: string }) {
  return (
    <span
      className={
        "badge " +
        (["ACTIVE", "APPROVED", "ENTRY", "RESOLVED", "ok"].includes(value)
          ? "good"
          : ["REVOKED", "REJECTED", "LOST", "HIGH"].includes(value)
            ? "bad"
            : "neutral")
      }
    >
      {title(value)}
    </span>
  );
}
function Empty({
  message = "No records yet. New activity will appear here.",
}: {
  message?: string;
}) {
  return (
    <div className="empty">
      <ShieldCheck size={28} />
      <p>{message}</p>
    </div>
  );
}
function Notice({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      className={"notice " + (error ? "error" : "")}
    >
      {error ? <AlertTriangle size={17} /> : <CircleCheck size={17} />}
      <span>{children}</span>
    </div>
  );
}
function DataState({
  query,
  children,
}: {
  query: any;
  children: (data: any) => React.ReactNode;
}) {
  return query.isPending ? (
    <div className="empty">Loading records…</div>
  ) : query.error ? (
    <Notice error>
      {query.error.message}
      <button className="text-button" onClick={() => query.refetch()}>
        Retry
      </button>
    </Notice>
  ) : (
    <>{children(query.data)}</>
  );
}
function Panel({
  title,
  subtitle,
  children,
  action,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
type Field = {
  name: string;
  label: string;
  type?: string;
  options?: Array<string | { value: string; label: string }>;
  required?: boolean;
  minLength?: number;
};
function Form({
  fields,
  submit,
  onSubmit,
  initial = {},
  invalidate = true,
}: {
  fields: Field[];
  submit: string;
  onSubmit: (d: any) => Promise<any>;
  initial?: any;
  invalidate?: boolean;
}) {
  const shape: Record<string, z.ZodType> = Object.fromEntries(
    fields.map((f) => [
      f.name,
      f.type === "checkbox"
        ? z
            .boolean()
            .refine((v) => f.required === false || v, "Confirmation required")
        : f.required === false
          ? z.string().optional()
          : f.type === "email"
            ? z.email()
            : z
                .string()
                .min(f.minLength || 1, "Required")
                .max(2000),
    ]),
  );
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<any>({
    resolver: zodResolver(z.object(shape)),
    defaultValues: initial,
  });
  const [feedback, setFeedback] = useState(""),
    [failed, setFailed] = useState(false);
  return (
    <form
      className="form"
      onSubmit={handleSubmit(async (d) => {
        setFeedback("");
        try {
          await onSubmit(d);
          setFailed(false);
          setFeedback("Saved successfully.");
          if (invalidate) client.invalidateQueries();
          reset(initial);
        } catch (e: any) {
          setFailed(true);
          setFeedback(e.message);
        }
      })}
    >
      {fields.map((f) => (
        <label key={f.name} className={f.type === "checkbox" ? "check" : ""}>
          {f.type !== "checkbox" && <span>{f.label}</span>}
          {f.options ? (
            <select aria-label={f.label} {...register(f.name)}>
              <option value="">Select…</option>
              {f.options.map((o) => (
                <option
                  key={typeof o === "string" ? o : o.value}
                  value={typeof o === "string" ? o : o.value}
                >
                  {typeof o === "string" ? title(o) : o.label}
                </option>
              ))}
            </select>
          ) : f.type === "textarea" ? (
            <textarea aria-label={f.label} {...register(f.name)} rows={3} />
          ) : (
            <input
              aria-label={f.label}
              type={f.type || "text"}
              {...register(f.name)}
              autoComplete={f.type === "password" ? "new-password" : "off"}
            />
          )}{" "}
          {f.type === "checkbox" && f.label}
          {errors[f.name] && (
            <small className="field-error">
              {String(errors[f.name]?.message)}
            </small>
          )}
        </label>
      ))}
      {feedback && <Notice error={failed}>{feedback}</Notice>}
      <button disabled={isSubmitting} type="submit">
        {isSubmitting ? "Saving…" : submit}
        <ChevronRight size={16} />
      </button>
    </form>
  );
}
function Login() {
  const navigate = useNavigate();
  return (
    <div className="login">
      <div className="login-story">
        <Brand />
        <div>
          <span className="eyebrow light">CAMPUS ACCESS, WITH CONFIDENCE</span>
          <h1>
            A safer campus.
            <br />A smoother day.
          </h1>
          <p>
            One connected workspace for student access, gadget accountability,
            and campus security.
          </p>
          <div className="login-feature">
            <ShieldCheck />
            Verified identities. Accountable movements.
          </div>
        </div>
        <small>SecureGate / University access management</small>
      </div>
      <main className="login-form">
        <div className="login-card">
          <span className="eyebrow">YOUR CAMPUS WORKSPACE</span>
          <h1>Welcome back</h1>
          <p>Sign in with your individual university account.</p>
          <Form
            fields={[
              { name: "email", label: "Email address", type: "email" },
              { name: "password", label: "Password", type: "password" },
            ]}
            submit="Sign in securely"
            onSubmit={async (d) => {
              const result = await api("auth/login", "POST", d);
              csrf = result.csrf;
              client.setQueryData(["me"], result);
              navigate(
                base[result.user.role] + "/" + links[result.user.role][0][0],
              );
            }}
          />
          <div className="demo-note">
            <ShieldCheck size={18} />
            <span>
              Local development uses synthetic records. Find your individually
              generated credentials in <code>.local/accounts.json</code>.
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
function RecoveryCodes({
  codes,
  onDone,
}: {
  codes: string[];
  onDone: () => void | Promise<void>;
}) {
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="recovery-sheet">
      <h2>Save your recovery codes</h2>
      <p>
        Each code works once in place of an authenticator code. Store them
        somewhere private, separate from your password. They will not be shown
        again.
      </p>
      <div className="recovery-grid">
        {codes.map((c) => (
          <code key={c}>{c}</code>
        ))}
      </div>
      {error && <Notice error>{error}</Notice>}
      <button
        className="full"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await onDone();
          } catch (e: any) {
            setError(e.message);
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? "Opening your workspace…" : "I’ve saved my recovery codes"}
      </button>
    </div>
  );
}
function MfaEnrollment({
  partial = false,
  onComplete,
}: {
  partial?: boolean;
  onComplete: (session: any) => Promise<void>;
}) {
  const [setup, setSetup] = useState<any>(null),
    [completed, setCompleted] = useState<any>(null);
  if (completed)
    return (
      <RecoveryCodes
        codes={completed.recoveryCodes}
        onDone={() => onComplete(completed)}
      />
    );
  return (
    <>
      {!setup ? (
        <Form
          invalidate={false}
          fields={
            partial
              ? []
              : [
                  {
                    name: "currentPassword",
                    label: "Current password",
                    type: "password",
                  },
                ]
          }
          submit="Set up authenticator"
          onSubmit={async (d) =>
            setSetup(await api("auth/mfa/setup", "POST", d))
          }
        />
      ) : (
        <>
          <div className="authenticator-qr">
            <QRCodeSVG value={setup.uri} size={180} />
          </div>
          <p className="body-copy">
            Scan this QR with your authenticator app. If you cannot scan it,
            enter this setup key manually:
          </p>
          <code className="setup-key" aria-label="Authenticator setup key">
            {setup.secret}
          </code>
          <Form
            invalidate={false}
            fields={[
              {
                name: "code",
                label: "Six-digit authenticator code",
                minLength: 6,
              },
            ]}
            submit="Confirm authenticator"
            onSubmit={async (d) => {
              const result = await api("auth/mfa/confirm", "POST", d);
              csrf = result.csrf;
              setSetup(null);
              setCompleted(result);
            }}
          />
        </>
      )}
    </>
  );
}
function MfaGate({ me }: { me: Me }) {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  async function done() {
    const fresh = await api("me");
    client.setQueryData(["me"], fresh);
    navigate(base[me.user.role] + "/" + links[me.user.role][0][0]);
  }
  return (
    <main className="mfa-gate">
      <div className="mfa-brand">
        <Brand />
      </div>
      <div className="mfa-card">
        <span className="eyebrow">PROTECT YOUR CAMPUS ACCOUNT</span>
        <h1>
          {me.stage === "MFA_SETUP_REQUIRED"
            ? "Set up account protection"
            : "Verify it’s you"}
        </h1>
        <p className="body-copy">
          {me.stage === "MFA_SETUP_REQUIRED"
            ? "Staff accounts require a second factor before any operational access. Use an authenticator app to continue."
            : "Enter a current authenticator code or one unused recovery code. This sign-in challenge expires after five minutes."}
        </p>
        <small className="auth-account">{me.user.email}</small>
        {error && <Notice error>{error}</Notice>}
        {me.stage === "MFA_SETUP_REQUIRED" ? (
          <MfaEnrollment partial onComplete={done} />
        ) : (
          <Form
            invalidate={false}
            fields={[
              {
                name: "code",
                label: "Authenticator or recovery code",
                minLength: 6,
              },
            ]}
            submit="Verify & continue"
            onSubmit={async (d) => {
              const r = await api("auth/mfa/verify", "POST", d);
              csrf = r.csrf;
              await done();
            }}
          />
        )}
        <button
          className="text-button"
          onClick={async () => {
            try {
              await api("auth/logout", "POST", {});
              client.clear();
              csrf = "";
              navigate("/login");
            } catch (e: any) {
              setError(e.message);
            }
          }}
        >
          Cancel sign-in
        </button>
      </div>
    </main>
  );
}
function AccountSecurity({ me }: { me: Me }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  async function refresh() {
    const fresh = await api("me");
    client.setQueryData(["me"], fresh);
  }
  return (
    <>
      <Notice>
        Keep your password private. Authenticator and recovery codes are
        accepted once. A password change signs out other sessions.
      </Notice>
      <div className="two-col">
        <Panel
          title="Multi-factor authentication"
          subtitle={
            me.mfaEnabled
              ? "Your authenticator is enrolled. All sign-ins require a second factor."
              : "Students can optionally add an authenticator. Staff enrollment is mandatory."
          }
        >
          {me.mfaEnabled ? (
            <>
              <Badge value="ACTIVE" />
              {codes ? (
                <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
              ) : (
                <Form
                  fields={[
                    {
                      name: "currentPassword",
                      label: "Current password",
                      type: "password",
                    },
                    {
                      name: "code",
                      label: "Authenticator or recovery code",
                      minLength: 6,
                    },
                  ]}
                  submit="Replace recovery codes"
                  onSubmit={async (d) =>
                    setCodes(
                      (await api("auth/mfa/recovery-codes", "POST", d))
                        .recoveryCodes,
                    )
                  }
                />
              )}
              <p className="caption">
                Replacing recovery codes invalidates all old recovery codes. You
                cannot disable staff MFA from this interface.
              </p>
            </>
          ) : (
            <MfaEnrollment onComplete={refresh} />
          )}
        </Panel>
        <Panel
          title="Change password"
          subtitle="Choose an individual passphrase of at least 14 characters."
        >
          <Form
            fields={[
              {
                name: "currentPassword",
                label: "Current password",
                type: "password",
              },
              {
                name: "newPassword",
                label: "New password",
                type: "password",
                minLength: 14,
              },
              ...(me.mfaEnabled
                ? [
                    {
                      name: "code",
                      label: "Authenticator or recovery code",
                      minLength: 6,
                    },
                  ]
                : []),
            ]}
            submit="Change password & secure sessions"
            onSubmit={async (d) => {
              const r = await api("auth/password", "POST", d);
              csrf = r.csrf;
              await refresh();
            }}
          />
        </Panel>
      </div>
    </>
  );
}

function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark">
        <ShieldCheck size={25} />
      </div>
      <span>
        Secure<span className="brand-light">Gate</span>
        <small>CAMPUS SECURITY</small>
      </span>
    </div>
  );
}
function App() {
  const me = useData("me");
  const location = useLocation();
  if (location.pathname === "/login") return <Login />;
  if (me.isPending)
    return <div className="boot">Connecting to SecureGate…</div>;
  if (me.error) return <Navigate to="/login" replace />;
  csrf = me.data.csrf;
  if (me.data.stage !== "FULL") return <MfaGate me={me.data} />;
  return <Workspace me={me.data} />;
}
function Workspace({ me }: { me: Me }) {
  const location = useLocation(),
    navigate = useNavigate();
  const [mobile, setMobile] = useState(false),
    [showNotifications, setShowNotifications] = useState(false);
  const notifications = useData("notifications");
  const allowed = links[me.user.role];
  const path = base[me.user.role];
  const item = allowed.find(
    ([route]) => location.pathname === path + "/" + route,
  );
  if (location.pathname === "/")
    return <Navigate to={path + "/" + allowed[0][0]} replace />;
  if (location.pathname === "/unauthorized" || !item)
    return (
      <div className="boot">
        <ShieldCheck />
        <h1>Access restricted</h1>
        <p>This page isn’t available for your current role.</p>
        <NavLink to={path + "/" + allowed[0][0]}>
          Return to your workspace
        </NavLink>
      </div>
    );
  const page = item[0];
  return (
    <div className="workspace">
      <aside className={"sidebar " + (mobile ? "open" : "")}>
        <Brand />
        <div className="institution">
          <span className="institution-icon">DU</span>
          <span>
            {me.institution || "Demo University"}
            <small>Synthetic development campus</small>
          </span>
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav aria-label="Main navigation">
          {allowed.map(([route, label, Icon]) => (
            <NavLink
              onClick={() => setMobile(false)}
              key={route}
              to={path + "/" + route}
            >
              <Icon size={19} />
              {label}
              {route === "scanner" && <span className="nav-live" />}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="status-dot" /> Local development environment
          <p>Assisted passage · Africa/Kampala</p>
        </div>
        <div className="account">
          <div className="avatar">{me.user.name.slice(0, 1)}</div>
          <div>
            <strong>{me.user.name.replace(" (synthetic)", "")}</strong>
            <small>{title(me.user.role)}</small>
          </div>
          <button
            aria-label="Sign out"
            className="icon-button"
            onClick={async () => {
              await api("auth/logout", "POST", {});
              csrf = "";
              client.clear();
              navigate("/login");
            }}
          >
            <LogOut size={18} />
          </button>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <div>
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobile(!mobile)}
            >
              <Menu />
            </button>
            <span className="breadcrumb">
              Workspace <ChevronRight size={13} /> <strong>{item[1]}</strong>
            </span>
          </div>
          <div className="top-actions">
            <span className="today">
              {new Intl.DateTimeFormat("en-UG", {
                dateStyle: "medium",
                timeZone: "Africa/Kampala",
              }).format(new Date())}
            </span>
            <span className="vertical-rule" />
            <button
              className="icon-button notification-button"
              aria-label="Notifications"
              onClick={() => setShowNotifications(!showNotifications)}
            >
              <Bell size={19} />
              {notifications.data?.length > 0 && <i />}
            </button>
            <div className="avatar small">{me.user.name[0]}</div>
          </div>
        </header>
        <main className="content">
          <div className="page-title">
            <div>
              <span className="eyebrow">{title(me.user.role)} WORKSPACE</span>
              <h1>{item[1]}</h1>
              <p>
                {page === "scanner"
                  ? "Verify the person. Inspect the gadgets. Confirm the passage."
                  : page === "dashboard"
                    ? "A clear view of your campus, and what needs your attention."
                    : "Manage verified campus records with a complete audit trail."}
              </p>
            </div>
            <span className="environment-pill">
              <span className="status-dot" />
              Synthetic data
            </span>
          </div>
          {showNotifications && (
            <Panel title="Your notifications">
              <DataState query={notifications}>
                {(rows) =>
                  rows.length ? (
                    rows.map((n: any) => (
                      <div className="list-row" key={n.id}>
                        {n.message}
                        <small>{date(n.createdAt)}</small>
                      </div>
                    ))
                  ) : (
                    <Empty message="You’re all caught up." />
                  )
                }
              </DataState>
            </Panel>
          )}
          {page === "account" ? (
            <AccountSecurity me={me} />
          ) : page === "scanner" ? (
            <Scanner />
          ) : me.user.role === "STUDENT" ? (
            <StudentPage me={me} page={page} />
          ) : me.user.role === "REGISTRAR" ? (
            <Registrar page={page} />
          ) : me.user.role === "VERIFIER" ? (
            <Gadgets student={false} />
          ) : page === "incidents" ? (
            <Incidents me={me} />
          ) : page === "overrides" ? (
            <Overrides />
          ) : me.user.role === "ADMIN" ? (
            <Admin page={page} />
          ) : page === "terminals" ? (
            <Assignments />
          ) : me.user.role === "AUDITOR" ? (
            <Audit />
          ) : me.user.role === "OFFICER" ? (
            <OfficerDashboard />
          ) : (
            <Analytics />
          )}
          <footer>
            SecureGate <span>Accountable access. Safer campuses.</span>
            <span>All times in Africa/Kampala · Development build 0.2</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
function Stat({
  label,
  value,
  icon: Icon,
  note,
}: {
  label: string;
  value: number | string;
  icon: React.ElementType;
  note: string;
}) {
  return (
    <div className="stat">
      <div className="stat-top">
        <span>{label}</span>
        <Icon size={19} />
      </div>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
function Analytics() {
  const reports = useData("reports");
  return (
    <DataState query={reports}>
      {(d) => (
        <>
          <div className="stats">
            <Stat
              label="Estimated on campus"
              value={d.estimatedOccupancy}
              icon={Users}
              note="Based on confirmed open visits"
            />
            <Stat
              label="Recorded entries"
              value={d.entries}
              icon={ArrowDownLeft}
              note="Officer-confirmed passage"
            />
            <Stat
              label="Recorded exits"
              value={d.exits}
              icon={ArrowUpRight}
              note="Officer-confirmed passage"
            />
            <Stat
              label="Open incidents"
              value={d.openIncidents}
              icon={AlertTriangle}
              note="Awaiting security review"
            />
          </div>
          <div className="two-col wide">
            <Panel
              title="Campus movement"
              subtitle="Confirmed transactions by hour · Africa/Kampala"
            >
              <div className="chart">
                {d.hourly.length ? (
                  <ResponsiveContainer width="100%" height={270}>
                    <BarChart data={d.hourly}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="hour"
                        tickFormatter={(s: string) => s.slice(-5)}
                        tick={{ fontSize: 11 }}
                      />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Bar
                        dataKey="count"
                        fill="#247b63"
                        radius={[5, 5, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <Empty message="Movement trends will appear after the first confirmed passage." />
                )}
              </div>
              <div className="panel-foot">
                <span className="legend-dot" /> Recorded passages{" "}
                <span>Measured activity, not simulated estimates</span>
              </div>
            </Panel>
            <Panel
              title="Operations at a glance"
              subtitle="Current persisted records"
            >
              <div className="metric-row">
                <span>
                  <ScanLine />
                  Active terminals
                </span>
                <strong>{d.activeTerminals}</strong>
              </div>
              <div className="metric-row">
                <span>
                  <Laptop />
                  Gadgets pending review
                </span>
                <strong>{d.pendingGadgets}</strong>
              </div>
              <div className="metric-row">
                <span>
                  <AlertTriangle />
                  Open incidents
                </span>
                <strong>{d.openIncidents}</strong>
              </div>
              <div className="soft-card">
                <ShieldCheck />
                <h3>Clarity over assumptions</h3>
                <p>{d.notice}</p>
              </div>
            </Panel>
          </div>
          <Capacity />
        </>
      )}
    </DataState>
  );
}
function Capacity() {
  const [arrivals, setArrivals] = useState(120),
    [share, setShare] = useState(30),
    [express, setExpress] = useState(2),
    [gadgets, setGadgets] = useState(1);
  const e = (arrivals * (1 - share / 100) * 8) / (3600 * express),
    g = (((arrivals * share) / 100) * 22) / (3600 * gadgets);
  return (
    <Panel
      title="Gate capacity planner"
      subtitle="Illustrative utilization estimate · assumes 8s express and 22s gadget service; excludes variability and exceptions"
    >
      <div className="capacity">
        {[
          ["Arrivals / hour", arrivals, setArrivals],
          ["Gadget share (%)", share, setShare],
          ["Express lanes", express, setExpress],
          ["Gadget lanes", gadgets, setGadgets],
        ].map(([label, value, set]: any) => (
          <label key={label}>
            {label}
            <input
              type="number"
              min={label.includes("share") ? 0 : 1}
              max={label.includes("share") ? 100 : 10000}
              value={value}
              onChange={(e) =>
                set(
                  Math.max(
                    label.includes("share") ? 0 : 1,
                    Math.min(
                      label.includes("share") ? 100 : 10000,
                      Number(e.target.value),
                    ),
                  ),
                )
              }
            />
          </label>
        ))}
        <div>
          <strong>
            {Math.round(e * 100)}% / {Math.round(g * 100)}%
          </strong>
          <small>Express / gadget utilization</small>
        </div>
      </div>
      {Math.max(e, g) >= 1 && (
        <Notice error>
          Demand exceeds modeled capacity. Add lanes or lower service time.
        </Notice>
      )}
      <p className="caption">
        Simulated estimate, not a measured queue-time claim. Pilot arrival and
        service distributions are still required.
      </p>
    </Panel>
  );
}
function MovementTable({ rows }: { rows: any[] }) {
  return rows.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Student / checkpoint</th>
            <th>Direction</th>
            <th>Result</th>
            <th>Time · Kampala</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <strong>{r.student?.user?.name || r.terminal?.name}</strong>
                <small>{r.student?.registration || r.terminal?.gate}</small>
              </td>
              <td>
                <Badge value={r.direction} />
              </td>
              <td>
                <Badge value={r.outcome} />
                <small>
                  {r.confirmed ? "Officer confirmed" : "Passage unconfirmed"}
                </small>
              </td>
              <td>{date(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty message="No movements recorded yet." />
  );
}
function OfficerDashboard() {
  const movements = useData("movements"),
    terminals = useData("terminals");
  return (
    <>
      <div className="callout">
        <div className="callout-icon">
          <ScanLine size={28} />
        </div>
        <div>
          <h2>Your checkpoint is ready</h2>
          <p>
            Open the scanner to verify identity and record assisted passage.
          </p>
        </div>
        <NavLink className="button" to="/security/scanner">
          Open scanner
          <ArrowUpRight size={17} />
        </NavLink>
      </div>
      <div className="two-col wide">
        <Panel
          title="Recent checkpoint activity"
          subtitle="Latest 100 authorized events"
        >
          <DataState query={movements}>
            {(rows) => <MovementTable rows={rows} />}
          </DataState>
        </Panel>
        <Panel
          title="Assigned checkpoints"
          subtitle="Browser simulator · not hardware authentication"
        >
          <DataState query={terminals}>
            {(rows) =>
              rows.map((t: any) => (
                <div className="terminal-card" key={t.id}>
                  <span className="terminal-icon">
                    <DoorOpen />
                  </span>
                  <div>
                    <strong>{t.name}</strong>
                    <small>{t.gate}</small>
                    <Badge value={t.direction} />
                  </div>
                </div>
              ))
            }
          </DataState>
        </Panel>
      </div>
    </>
  );
}
function Scanner() {
  const terminals = useData("terminals");
  const [terminalId, setTerminal] = useState(""),
    [credential, setCredential] = useState(""),
    [lookup, setLookup] = useState<any>(null),
    [selected, setSelected] = useState<string[]>([]),
    [identity, setIdentity] = useState(false),
    [physical, setPhysical] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<any>(null),
    [requestId, setRequestId] = useState(() => crypto.randomUUID()),
    [camera, setCamera] = useState(false);
  const video = useRef<HTMLVideoElement>(null),
    control = useRef<any>(null);
  const t = terminals.data?.find((t: any) => t.id === terminalId);
  useEffect(() => {
    if (!camera) return;
    let stopped = false;
    const reader = new BrowserQRCodeReader();
    reader
      .decodeFromVideoDevice(undefined, video.current!, (r) => {
        if (r) {
          setCredential(r.getText());
          setCamera(false);
        }
      })
      .then((c) => {
        if (stopped) c.stop();
        else control.current = c;
      })
      .catch(() => {
        setError(
          "Camera unavailable or permission denied. Use manual credential input.",
        );
        setCamera(false);
      });
    return () => {
      stopped = true;
      control.current?.stop();
      control.current = null;
    };
  }, [camera]);
  function clear() {
    setLookup(null);
    setSelected([]);
    setIdentity(false);
    setPhysical(false);
    setResult(null);
    setRequestId(crypto.randomUUID());
  }
  async function identify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    clear();
    try {
      setLookup(await api("scans/lookup", "POST", { credential, terminalId }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const r = await api("scans", "POST", {
        credential,
        terminalId,
        requestId,
        gadgetIds: selected,
        identityChecked: identity,
        physicalCheck: physical,
      });
      setResult(r);
      client.invalidateQueries();
    } catch (e: any) {
      setError(
        e.message +
          " Retry preserves the same request ID to prevent duplicate passage.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Notice>
        Browser-assisted simulator. A scan alone does not prove identity or
        physical passage. Never obstruct emergency egress.
      </Notice>
      <div className="two-col">
        <Panel
          title="01 / Select checkpoint"
          subtitle="Only active terminals assigned to you can process scans"
        >
          <DataState query={terminals}>
            {(rows) => (
              <form onSubmit={identify} className="form">
                <label>
                  Assigned checkpoint
                  <select
                    aria-label="Assigned checkpoint"
                    required
                    value={terminalId}
                    onChange={(e) => {
                      setTerminal(e.target.value);
                      clear();
                    }}
                  >
                    <option value="">Choose a checkpoint…</option>
                    {rows
                      .filter((r: any) => r.active)
                      .map((r: any) => (
                        <option key={r.id} value={r.id}>
                          {r.name} · {r.gate}
                        </option>
                      ))}
                  </select>
                </label>
                {t && (
                  <div className="checkpoint-detail">
                    <Badge value={t.direction} />
                    <Badge value={t.lane} />
                    <span>{title(t.mode)}</span>
                  </div>
                )}
                <div className="scanner-visual">
                  <div className="scan-corners">
                    <ScanLine size={64} />
                  </div>
                  <h3>Ready for student ID</h3>
                  <p>
                    Scan with a USB reader, camera, or paste the issued opaque
                    credential below.
                  </p>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setCamera(!camera)}
                  >
                    <Camera size={17} />
                    {camera ? "Stop camera" : "Use camera"}
                  </button>
                  {camera && <video ref={video} autoPlay muted playsInline />}
                </div>
                <label>
                  Opaque credential
                  <input
                    autoComplete="off"
                    required
                    type="password"
                    value={credential}
                    placeholder="sg1.…"
                    onChange={(e) => {
                      setCredential(e.target.value);
                      clear();
                    }}
                  />
                </label>
                <button disabled={busy || !terminalId || !credential}>
                  Look up credential
                  <ChevronRight size={17} />
                </button>
              </form>
            )}
          </DataState>
        </Panel>
        <Panel
          title="02 / Verify & confirm"
          subtitle="Complete the physical checks before recording passage"
        >
          {error && <Notice error>{error}</Notice>}
          {!lookup ? (
            <Empty message="Student identity and approved gadgets appear after a successful lookup." />
          ) : (
            <>
              <div className="identity-card">
                <div className="portrait">
                  <Users size={40} />
                </div>
                <div>
                  <span className="eyebrow">VERIFIED REGISTRY RECORD</span>
                  <h2>{lookup.student.name}</h2>
                  <p>{lookup.student.registration}</p>
                  <small>{lookup.student.program}</small>
                </div>
              </div>
              <Notice error={!lookup.student.photoUrl}>
                {lookup.student.photoUrl
                  ? "Compare the approved ID photograph with the person present."
                  : "No verified photograph on file. Simulator only: real gate use requires verified photographs."}
              </Notice>
              <div className="section-label">
                Physically presented gadgets{" "}
                <small>Select only what you inspect</small>
              </div>
              {lookup.gadgets.length ? (
                lookup.gadgets.map((g: any) => (
                  <label className="gadget-select" key={g.id}>
                    <input
                      type="checkbox"
                      disabled={!!result || t?.lane === "EXPRESS"}
                      checked={selected.includes(g.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, g.id]
                            : selected.filter((id) => id !== g.id),
                        )
                      }
                    />
                    <Laptop />
                    <span>
                      <strong>
                        {g.manufacturer} {g.model}
                      </strong>
                      <small>Serial: {g.serial}</small>
                    </span>
                    <Badge value={g.status} />
                  </label>
                ))
              ) : (
                <p className="caption">
                  No approved gadgets. Unregistered devices require review.
                </p>
              )}
              {lookup.visit && (
                <p className="caption">
                  Active visit since {date(lookup.visit.enteredAt)} ·{" "}
                  {lookup.visit.gadgets.length} recorded gadget(s)
                </p>
              )}
              <label className="check">
                <input
                  type="checkbox"
                  checked={identity}
                  onChange={(e) => setIdentity(e.target.checked)}
                  disabled={!!result}
                />
                I compared the student with their identity document.
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={physical}
                  onChange={(e) => setPhysical(e.target.checked)}
                  disabled={!!result}
                />
                I inspected presented gadgets and witnessed physical passage.
              </label>
              {!result ? (
                <button
                  className="full"
                  disabled={
                    busy || !identity || (t?.mode === "ASSISTED" && !physical)
                  }
                  onClick={confirm}
                >
                  <ShieldCheck size={18} />
                  {busy
                    ? "Recording…"
                    : `Confirm ${t?.direction.toLowerCase() || "passage"}`}
                </button>
              ) : (
                <div className="scan-result">
                  <Badge value={result.outcome} />
                  <p>{result.message}</p>
                  <small>{date(result.timestamp)}</small>
                  <button
                    className="secondary"
                    onClick={() => {
                      clear();
                      setCredential("");
                    }}
                  >
                    Next student
                  </button>
                </div>
              )}
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
function StudentPage({ me, page }: { me: Me; page: string }) {
  const movements = useData(
      "movements",
      page === "dashboard" || page === "visits",
    ),
    visits = useData("visits", page === "dashboard"),
    credentials = useData(
      "credentials",
      page === "dashboard" || page === "credentials",
    );
  const [lostError, setLostError] = useState("");
  if (page === "gadgets") return <Gadgets student />;
  if (page === "reports") return <Incidents me={me} />;
  if (page === "profile")
    return (
      <Panel
        title="University-verified profile"
        subtitle="Authoritative identity fields are maintained by the registrar."
      >
        <dl className="profile-fields">
          <dt>Full name</dt>
          <dd>{me.user.name}</dd>
          <dt>Registration</dt>
          <dd>{me.student?.registration}</dd>
          <dt>Email</dt>
          <dd>{me.user.email}</dd>
          <dt>Program</dt>
          <dd>{me.student?.program}</dd>
          <dt>Enrollment</dt>
          <dd>
            <Badge value={me.student?.enrollment || "UNCONFIRMED"} />
          </dd>
          <dt>Photograph</dt>
          <dd>Not supplied · development record</dd>
        </dl>
      </Panel>
    );
  if (page === "visits")
    return (
      <Panel
        title="Your movement history"
        subtitle="Latest 100 records. Requests for correction create a case; original events remain unchanged."
      >
        <DataState query={movements}>
          {(rows) => <MovementTable rows={rows} />}
        </DataState>
      </Panel>
    );
  if (page === "credentials")
    return (
      <div className="two-col">
        <Panel
          title="Your university ID"
          subtitle="Secret credential values are never displayed in your account."
        >
          <DataState query={credentials}>
            {(rows) =>
              rows.length ? (
                rows.map((c: any) => (
                  <div key={c.id} className="list-row">
                    <KeyRound />
                    <span>
                      <strong>University-issued credential</strong>
                      <small>Expires {date(c.expiresAt)}</small>
                    </span>
                    <Badge value={c.status} />
                  </div>
                ))
              ) : (
                <Empty message="No credential issued. Contact the registrar for verified issuance." />
              )
            }
          </DataState>
        </Panel>
        <Panel
          title="Lost your ID?"
          subtitle="Reporting immediately revokes all current credentials. Replacement requires registrar verification."
        >
          <Form
            fields={[
              {
                name: "confirm",
                label:
                  "I confirm my student ID is lost and understand that it will be revoked.",
                type: "checkbox",
              },
            ]}
            submit="Report lost ID & revoke"
            onSubmit={() => api("credentials/lost", "POST", {})}
          />
        </Panel>
      </div>
    );
  const active = visits.data?.find((v: any) => !v.exitedAt);
  return (
    <>
      <div className="callout">
        <div className="callout-icon">
          <ShieldCheck size={30} />
        </div>
        <div>
          <span className="eyebrow light">YOUR CAMPUS, CONNECTED</span>
          <h2>Welcome, {me.user.name.split(" ")[0]}.</h2>
          <p>Your identity, gadgets, and campus movements in one place.</p>
        </div>
        <NavLink className="button" to="/student/gadgets">
          Manage gadgets
          <ArrowUpRight size={17} />
        </NavLink>
      </div>
      <div className="stats three">
        <Stat
          label="Recorded campus presence"
          value={
            visits.isPending ? "…" : active ? "Inside" : "Outside / unknown"
          }
          icon={DoorOpen}
          note="Based on assisted records; may be incomplete"
        />
        <Stat
          label="Student ID status"
          value={
            credentials.isPending
              ? "…"
              : credentials.data?.some(
                    (c: any) =>
                      c.status === "ACTIVE" &&
                      new Date(c.expiresAt) > new Date(),
                  )
                ? "Active"
                : "Not active"
          }
          icon={KeyRound}
          note="Issued and verified by the registrar"
        />
        <Stat
          label="Registration number"
          value={me.student?.registration || "Unconfirmed"}
          icon={Users}
          note={me.student?.program || "Contact student records"}
        />
      </div>
      <Panel
        title="Recent campus movements"
        subtitle="Your personal record · officer confirmation shown separately"
        action={
          <NavLink className="text-link" to="/student/visits">
            View history <ArrowUpRight size={15} />
          </NavLink>
        }
      >
        <DataState query={movements}>
          {(rows) => <MovementTable rows={rows.slice(0, 6)} />}
        </DataState>
      </Panel>
      <div className="two-col">
        <Panel
          title="Bringing a new gadget?"
          subtitle="Register it before your next campus visit."
        >
          <p className="body-copy">
            Submit the device details, then visit the verification desk for a
            physical serial-number check.
          </p>
          <NavLink className="button secondary" to="/student/gadgets">
            Register a gadget
            <ChevronRight size={16} />
          </NavLink>
        </Panel>
        <Panel
          title="Something doesn’t look right?"
          subtitle="Keep your security record accurate."
        >
          <p className="body-copy">
            Report a lost ID, a missing gadget, or a movement record that needs
            review.
          </p>
          <NavLink className="button secondary" to="/student/reports">
            Contact security
            <ChevronRight size={16} />
          </NavLink>
        </Panel>
      </div>
    </>
  );
}
function Gadgets({ student }: { student: boolean }) {
  const query = useData("gadgets");
  const [current, setCurrent] = useState<any>(null);
  return (
    <div className="two-col wide">
      <Panel
        title={
          student ? "Your registered gadgets" : "Gadget verification queue"
        }
        subtitle="Registration requires independent physical inspection."
      >
        <DataState query={query}>
          {(rows) =>
            rows.length ? (
              rows.map((g: any) => (
                <div className="gadget-row" key={g.id}>
                  <div className="device-icon">
                    <Laptop />
                  </div>
                  <div className="grow">
                    <strong>
                      {g.manufacturer} {g.model}
                    </strong>
                    <small>
                      {g.category} · {g.serial}
                    </small>
                    {!student && (
                      <small>
                        {g.student.user.name} · {g.student.registration}
                      </small>
                    )}
                  </div>
                  <Badge value={g.status} />
                  {student && g.status === "APPROVED" ? (
                    <button
                      className="secondary compact"
                      onClick={() => setCurrent(g)}
                    >
                      Report lost
                    </button>
                  ) : !student && g.status === "PENDING" ? (
                    <button
                      className="secondary compact"
                      onClick={() => setCurrent(g)}
                    >
                      Inspect
                    </button>
                  ) : null}
                </div>
              ))
            ) : (
              <Empty
                message={
                  student
                    ? "No gadgets registered. Add your first device using the form."
                    : "No gadget submissions to review yet."
                }
              />
            )
          }
        </DataState>
      </Panel>
      <Panel
        title={
          current
            ? student
              ? "Report lost gadget"
              : "Physical verification"
            : student
              ? "Register a gadget"
              : "Inspection guidance"
        }
        subtitle={
          current
            ? `${current.manufacturer} ${current.model} · ${current.serial}`
            : "Only physically presented and approved devices are tracked at the gate."
        }
      >
        {current ? (
          <>
            <button className="text-button" onClick={() => setCurrent(null)}>
              Cancel selection
            </button>
            <Form
              key={current.id}
              fields={
                student
                  ? [
                      {
                        name: "confirm",
                        label: "I confirm that this gadget is lost or stolen.",
                        type: "checkbox",
                      },
                    ]
                  : [
                      {
                        name: "decision",
                        label: "Decision",
                        options: ["APPROVED", "REJECTED"],
                      },
                      {
                        name: "reason",
                        label: "Inspection findings",
                        type: "textarea",
                        minLength: 2,
                      },
                      {
                        name: "physicalCheck",
                        label:
                          "I physically inspected the device and its serial number.",
                        type: "checkbox",
                      },
                    ]
              }
              submit={
                student
                  ? "Submit lost-gadget report"
                  : "Save verification decision"
              }
              onSubmit={async (d) => {
                await api(
                  `gadgets/${current.id}/${student ? "lost" : "verify"}`,
                  "POST",
                  student
                    ? {}
                    : {
                        approved: d.decision === "APPROVED",
                        reason: d.reason,
                        physicalCheck: d.physicalCheck,
                      },
                );
                setCurrent(null);
              }}
            />
          </>
        ) : student ? (
          <Form
            fields={[
              {
                name: "category",
                label: "Category",
                options: ["Laptop", "Tablet", "Camera", "Other"],
              },
              { name: "manufacturer", label: "Manufacturer", minLength: 2 },
              { name: "model", label: "Model", minLength: 2 },
              { name: "serial", label: "Physical serial number", minLength: 3 },
            ]}
            submit="Submit for verification"
            onSubmit={(d) => api("gadgets", "POST", d)}
          />
        ) : (
          <div className="soft-card">
            <ShieldCheck />
            <h3>Verify the device, not just the label</h3>
            <p>
              Compare the physical serial number and ownership evidence.
              Matching serials require review, not an automatic accusation of
              fraud.
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}
function Registrar({ page }: { page: string }) {
  const students = useData("students");
  const [studentId, setStudent] = useState(""),
    [issued, setIssued] = useState(""),
    [issueError, setIssueError] = useState("");
  const credentials = useData(
    "credentials?studentId=" + studentId,
    !!studentId,
  );
  return (
    <div className="two-col wide">
      <Panel
        title="Student registry"
        subtitle="Synthetic records · authorized identity source"
      >
        <DataState query={students}>
          {(rows) =>
            rows.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Registration</th>
                      <th>Enrollment</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s: any) => (
                      <tr key={s.id}>
                        <td>
                          <strong>{s.user.name}</strong>
                          <small>{s.program}</small>
                        </td>
                        <td>{s.registration}</td>
                        <td>
                          <Badge value={s.enrollment} />
                        </td>
                        <td>
                          <button
                            className="secondary compact"
                            onClick={() => {
                              setStudent(s.id);
                              setIssued("");
                            }}
                          >
                            Manage ID
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty />
            )
          }
        </DataState>
      </Panel>
      <Panel
        title={
          studentId
            ? "Credential lifecycle"
            : page === "credentials"
              ? "Select a student"
              : "Enroll a verified student"
        }
        subtitle={
          studentId
            ? "Issuance revokes prior active IDs. Verify identity before continuing."
            : "Registrar-only identity management."
        }
      >
        {studentId ? (
          <>
            <button
              className="text-button"
              onClick={() => {
                setStudent("");
                setIssued("");
              }}
            >
              Clear selection
            </button>
            <Form
              key={studentId}
              fields={[
                {
                  name: "verified",
                  label:
                    "I verified this student’s identity through the approved process.",
                  type: "checkbox",
                },
              ]}
              submit="Issue replacement credential"
              onSubmit={async () => {
                const r = await api("credentials", "POST", { studentId });
                setIssued(r.credential);
              }}
            />
            {issued && (
              <div className="issuance">
                <QRCodeSVG value={issued} size={160} />
                <p>Authorized issuance output · shown once</p>
                <textarea
                  aria-label="Issued opaque QR credential"
                  readOnly
                  value={issued}
                />
                <button className="secondary" onClick={() => setIssued("")}>
                  Clear issuance output
                </button>
                <small>
                  Deliver only to the verified student through ID printing. A
                  printed QR can be copied.
                </small>
              </div>
            )}
            <DataState query={credentials}>
              {(rows) =>
                rows.map((c: any) => (
                  <div key={c.id} className="list-row">
                    <Badge value={c.status} />
                    <small>Issued {date(c.issuedAt)}</small>
                    {c.status === "ACTIVE" && (
                      <button
                        className="secondary compact"
                        onClick={async () => {
                          try {
                            await api(
                              "credentials/" + c.id + "/revoke",
                              "POST",
                              {},
                            );
                            client.invalidateQueries();
                          } catch (e: any) {
                            setIssueError(e.message);
                          }
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))
              }
            </DataState>
            {issueError && <Notice error>{issueError}</Notice>}
          </>
        ) : page === "students" ? (
          <Form
            fields={[
              { name: "name", label: "Verified full name", minLength: 2 },
              { name: "email", label: "University email", type: "email" },
              {
                name: "registration",
                label: "Registration number",
                minLength: 2,
              },
              { name: "program", label: "Academic program", minLength: 2 },
              {
                name: "password",
                label: "Initial individual password (14+ characters)",
                type: "password",
                minLength: 14,
              },
            ]}
            submit="Create student record"
            onSubmit={(d) => api("students", "POST", d)}
          />
        ) : (
          <Empty message="Choose a student from the registry to issue or revoke a credential." />
        )}
      </Panel>
    </div>
  );
}
function Incidents({ me }: { me: Me }) {
  const incidents = useData("incidents"),
    [selected, setSelected] = useState<any>(null);
  return (
    <div className="two-col wide">
      <Panel
        title={me.user.role === "STUDENT" ? "Your reports" : "Incident queue"}
        subtitle="Case history is retained with attributable decisions."
      >
        <DataState query={incidents}>
          {(rows) =>
            rows.length ? (
              rows.map((i: any) => (
                <div className="incident-row" key={i.id}>
                  <div>
                    <span className="case-number">
                      CASE {i.id.slice(0, 8).toUpperCase()}
                    </span>
                    <strong>{title(i.category)}</strong>
                    <p>{i.description}</p>
                    <small>{date(i.createdAt)}</small>
                  </div>
                  <div>
                    <Badge value={i.status} />
                    {me.user.role !== "STUDENT" && (
                      <button
                        className="text-button"
                        onClick={() => setSelected(i)}
                      >
                        Review case
                      </button>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <Empty message="No incident reports yet." />
            )
          }
        </DataState>
      </Panel>
      <Panel
        title={
          selected
            ? "Review case " + selected.id.slice(0, 8)
            : "Submit a report"
        }
        subtitle="Do not include passwords or raw QR credentials in reports."
      >
        {selected ? (
          <>
            <button className="text-button" onClick={() => setSelected(null)}>
              Back to new report
            </button>
            {me.user.role === "SUPERVISOR" && (
              <Form
                key={selected.id}
                fields={[
                  {
                    name: "status",
                    label: "Next status",
                    options: (
                      {
                        OPEN: ["UNDER_REVIEW"],
                        UNDER_REVIEW: ["RESOLVED"],
                        RESOLVED: ["CLOSED", "UNDER_REVIEW"],
                        CLOSED: ["UNDER_REVIEW"],
                      } as any
                    )[selected.status],
                  },
                  {
                    name: "note",
                    label: "Review and resolution notes",
                    type: "textarea",
                    minLength: 2,
                  },
                ]}
                submit="Record status change"
                onSubmit={async (d) => {
                  await api("incidents/" + selected.id + "/status", "POST", d);
                  setSelected(null);
                }}
              />
            )}
            <Form
              fields={[
                {
                  name: "reason",
                  label: "Reason for independent manual review",
                  type: "textarea",
                  minLength: 2,
                },
              ]}
              submit="Request supervisor review"
              onSubmit={(d) =>
                api("overrides", "POST", {
                  incidentId: selected.id,
                  reason: d.reason,
                })
              }
            />
            <p className="caption">
              Approval records a review decision; it does not bypass checkpoint
              controls or fabricate passage.
            </p>
          </>
        ) : (
          <Form
            fields={[
              {
                name: "category",
                label: "Category",
                options: [
                  "MOVEMENT_CORRECTION",
                  "LOST_GADGET",
                  "UNREGISTERED_GADGET",
                  "IDENTITY_MISMATCH",
                  "TERMINAL_FAILURE",
                  "OTHER",
                ],
              },
              {
                name: "severity",
                label: "Severity",
                options: ["LOW", "MEDIUM", "HIGH"],
              },
              {
                name: "description",
                label: "What happened?",
                type: "textarea",
                minLength: 2,
              },
            ]}
            submit="Submit report"
            onSubmit={(d) => api("incidents", "POST", d)}
          />
        )}
      </Panel>
    </div>
  );
}
function Overrides() {
  const query = useData("overrides"),
    [selected, setSelected] = useState<any>(null);
  return (
    <div className="two-col">
      <Panel
        title="Independent manual reviews"
        subtitle="Requester cannot approve their own review."
      >
        <DataState query={query}>
          {(rows) =>
            rows.length ? (
              rows.map((o: any) => (
                <div key={o.id} className="incident-row">
                  <div>
                    <strong>{title(o.incident.category)}</strong>
                    <p>{o.reason}</p>
                    <small>{date(o.createdAt)}</small>
                  </div>
                  <Badge value={o.status} />
                  {o.status === "PENDING" && (
                    <button
                      className="secondary compact"
                      onClick={() => setSelected(o)}
                    >
                      Review
                    </button>
                  )}
                </div>
              ))
            ) : (
              <Empty />
            )
          }
        </DataState>
      </Panel>
      <Panel
        title="Supervisor decision"
        subtitle="Records an accountable exception review; never bypasses life-safety rules."
      >
        {selected ? (
          <Form
            key={selected.id}
            fields={[
              {
                name: "decision",
                label: "Decision",
                options: ["APPROVED", "REJECTED"],
              },
              {
                name: "reason",
                label: "Decision rationale",
                type: "textarea",
                minLength: 2,
              },
            ]}
            submit="Record independent decision"
            onSubmit={async (d) => {
              await api("overrides/" + selected.id + "/decide", "POST", {
                approved: d.decision === "APPROVED",
                reason: d.reason,
              });
              setSelected(null);
            }}
          />
        ) : (
          <Empty message="Choose a pending review." />
        )}
      </Panel>
    </div>
  );
}
function Assignments() {
  const terminals = useData("terminals"),
    users = useData("users");
  return (
    <Panel
      title="Assign on-duty operators"
      subtitle="Only security officers and supervisors can operate checkpoints."
    >
      <Form
        fields={[
          {
            name: "terminalId",
            label: "Checkpoint",
            options:
              terminals.data?.map((t: any) => ({
                value: t.id,
                label: t.name,
              })) || [],
          },
          {
            name: "userId",
            label: "Operator",
            options:
              users.data
                ?.filter(
                  (u: any) =>
                    ["OFFICER", "SUPERVISOR"].includes(u.role) && u.active,
                )
                .map((u: any) => ({ value: u.id, label: u.name })) || [],
          },
        ]}
        submit="Assign operator"
        onSubmit={(d) =>
          api("terminals/" + d.terminalId + "/assign", "POST", {
            userId: d.userId,
          })
        }
      />
    </Panel>
  );
}
function Admin({ page }: { page: string }) {
  const health = useData("health"),
    users = useData("users", page === "users"),
    terminals = useData(
      "terminals",
      ["terminals", "gates", "dashboard"].includes(page),
    ),
    settings = useData("settings", page === "settings");
  if (page === "roles")
    return (
      <Panel
        title="Server-enforced permissions"
        subtitle="Administrative infrastructure access does not grant movement-history access."
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Permitted workspace</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(links).map(([r, items]) => (
                <tr key={r}>
                  <td>
                    <Badge value={r} />
                  </td>
                  <td>{items.map((i) => i[1]).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Notice>
          Roles are fixed in this pilot build. No self-service privilege
          elevation or administrator creation endpoint is exposed.
        </Notice>
      </Panel>
    );
  if (page === "users")
    return (
      <div className="two-col wide">
        <Panel
          title="Individual staff accounts"
          subtitle="Student enrollment is managed by the registrar."
        >
          <DataState query={users}>
            {(rows) => (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Role</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((u: any) => (
                      <tr key={u.id}>
                        <td>
                          <strong>{u.name}</strong>
                          <small>{u.email}</small>
                        </td>
                        <td>
                          <Badge value={u.role} />
                        </td>
                        <td>
                          <Badge value={u.active ? "ACTIVE" : "SUSPENDED"} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </DataState>
        </Panel>
        <Panel
          title="Provision staff account"
          subtitle="Use an individual password; never a shared campus password."
        >
          <Form
            fields={[
              { name: "name", label: "Full name", minLength: 2 },
              { name: "email", label: "Institutional email", type: "email" },
              {
                name: "role",
                label: "Role",
                options: [
                  "OFFICER",
                  "VERIFIER",
                  "SUPERVISOR",
                  "REGISTRAR",
                  "MANAGEMENT",
                  "AUDITOR",
                ],
              },
              {
                name: "password",
                label: "Initial password (14+ characters)",
                type: "password",
                minLength: 14,
              },
            ]}
            submit="Create staff account"
            onSubmit={(d) => api("users", "POST", d)}
          />
        </Panel>
      </div>
    );
  if (page === "settings")
    return (
      <div className="two-col">
        <Panel
          title="Institutional configuration"
          subtitle="Policy text is configuration, not a claim of legal compliance."
        >
          <DataState query={settings}>
            {(rows) =>
              rows.map((s: any) => (
                <div className="list-row" key={s.key}>
                  <strong>{title(s.key)}</strong>
                  <span>{String(s.value)}</span>
                </div>
              ))
            }
          </DataState>
        </Panel>
        <Panel title="Update policy text">
          <Form
            fields={[
              {
                name: "key",
                label: "Setting",
                options: [
                  "institutionName",
                  "privacyNotice",
                  "approvedRetentionPolicy",
                ],
              },
              {
                name: "value",
                label: "Approved text",
                type: "textarea",
                minLength: 2,
              },
            ]}
            submit="Save audited setting"
            onSubmit={(d) => api("settings", "POST", d)}
          />
        </Panel>
      </div>
    );
  if (page === "terminals" || page === "gates")
    return (
      <>
        <div className="two-col wide">
          <Panel
            title="Registered checkpoints"
            subtitle="Browser terminals simulate operations; managed cryptographic device enrollment remains a deployment prerequisite."
          >
            <DataState query={terminals}>
              {(rows) =>
                rows.map((t: any) => (
                  <div className="terminal-card" key={t.id}>
                    <DoorOpen />
                    <div className="grow">
                      <strong>{t.name}</strong>
                      <small>
                        {t.gate} · {title(t.mode)}
                      </small>
                    </div>
                    <Badge value={t.direction} />
                    <Badge value={t.active ? "ACTIVE" : "REVOKED"} />
                  </div>
                ))
              }
            </DataState>
          </Panel>
          <Panel title="Register checkpoint">
            <Form
              fields={[
                { name: "name", label: "Terminal name", minLength: 2 },
                { name: "gate", label: "Physical gate", minLength: 2 },
                {
                  name: "direction",
                  label: "Direction",
                  options: ["ENTRY", "EXIT"],
                },
                { name: "lane", label: "Lane", options: ["EXPRESS", "GADGET"] },
                {
                  name: "mode",
                  label: "Passage confirmation",
                  options: ["ASSISTED", "REGISTRATION_ONLY"],
                },
              ]}
              submit="Register terminal"
              onSubmit={(d) => api("terminals", "POST", d)}
            />
          </Panel>
        </div>
        <Assignments />
      </>
    );
  return (
    <>
      <DataState query={health}>
        {(d) => (
          <div className="stats three">
            <Stat
              label="API health"
              value={d.status === "ok" ? "Operational" : "Unavailable"}
              icon={Activity}
              note="Live database connectivity check"
            />
            <Stat
              label="Database"
              value={d.database}
              icon={ShieldCheck}
              note="PostgreSQL · persistent records"
            />
            <Stat
              label="Environment"
              value="Development"
              icon={Settings}
              note="Production startup intentionally blocked"
            />
          </div>
        )}
      </DataState>
      <Panel
        title="Deployment readiness"
        subtitle="Development capabilities are separate from institutional approval."
      >
        <Notice>
          Before a real pilot: verified photographs, institutional account
          recovery, managed device identity, approved retention policy, backup
          restoration exercise, privacy review and independent security
          assessment.
        </Notice>
        <p className="body-copy">
          Administrator accounts can configure infrastructure and provision
          staff. Movement histories and audit investigations use separate
          server-enforced permissions.
        </p>
      </Panel>
    </>
  );
}
function Audit() {
  const query = useData("audit-events"),
    [filter, setFilter] = useState("");
  return (
    <Panel
      title="Attributable audit trail"
      subtitle="Latest 100 records · database triggers reject updates and deletes"
      action={
        <div className="search">
          <Search size={16} />
          <input
            aria-label="Filter audit records"
            placeholder="Filter loaded events…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      }
    >
      <DataState query={query}>
        {(rows) =>
          rows.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Resource</th>
                    <th>Timestamp · Kampala</th>
                  </tr>
                </thead>
                <tbody>
                  {rows
                    .filter((r: any) =>
                      (r.action + " " + r.actorId + " " + r.resourceId)
                        .toLowerCase()
                        .includes(filter.toLowerCase()),
                    )
                    .map((r: any) => (
                      <tr key={r.id}>
                        <td>
                          <strong>{title(r.action)}</strong>
                        </td>
                        <td>
                          <code>{r.actorId?.slice(0, 8) || "System"}</code>
                        </td>
                        <td>
                          <code>{r.resourceId?.slice(0, 16) || "—"}</code>
                        </td>
                        <td>{date(r.createdAt)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty />
          )
        }
      </DataState>
    </Panel>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Routes>
          <Route path="*" element={<App />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
