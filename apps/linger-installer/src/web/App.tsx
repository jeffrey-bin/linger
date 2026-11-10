import { useEffect, useState } from "react";
import { RuntimeSignIn } from "./RuntimeSignIn.js";
import { InstallationProgress } from "./InstallationProgress.js";
import {
  SetupChoicePanel,
  type SetupReport,
  type SetupChoice,
} from "./SetupChoicePanel.js";
import {
  authenticate,
  request,
  watchJob,
  type EnvironmentReport,
  type InstallerConfig,
  type InstallationJob,
  type LoginInformation,
  type InstanceStatus,
} from "./api.js";

function Copy({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      className="button compact"
      aria-label={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => setFailed(true));
      }}
    >
      {failed ? "Select and copy" : copied ? "✓" : "Copy"}
    </button>
  );
}
// The first check that keeps the installation from starting.
const installBlocker = (environment: EnvironmentReport) =>
  environment.checks.find((check) => check.state !== "ready");
export function App() {
  const [ready, setReady] = useState(false);
  const [environment, setEnvironment] = useState<EnvironmentReport>();
  const [setup, setSetup] = useState<SetupReport>();
  const [choice, setChoice] = useState<SetupChoice>();
  const [config, setConfig] = useState<InstallerConfig>();
  const [job, setJob] = useState<InstallationJob>();
  const [login, setLogin] = useState<LoginInformation>();
  const [status, setStatus] = useState<InstanceStatus>();
  const [skipped, setSkipped] = useState(false);
  const [showPassword, setShowPassword] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Request failed. Please retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function load() {
    const plan = await authenticate();
    const [env, report, cfg, jobs] = await Promise.all([
      request<EnvironmentReport>("/environment"),
      request<SetupReport>("/setup"),
      request<InstallerConfig>("/config"),
      request<{ items: InstallationJob[] }>("/jobs"),
    ]);
    const latest = jobs.items
      .filter((item) => item.instance === cfg.instance)
      .sort(
        (a, b) =>
          Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
          b.id.localeCompare(a.id),
      )[0];
    setEnvironment(env);
    setSetup(report);
    setConfig(cfg);
    const recommended =
      report.recommendation === "local-models" ? "pi" : report.recommendation;
    setChoice(latest?.setupChoice ?? cfg.setupChoice ?? recommended);
    if (latest && !latest.preparation) {
      setJob(
        await request<InstallationJob>(
          `/jobs/${encodeURIComponent(latest.id)}`,
        ),
      );
      try {
        setSkipped(
          sessionStorage.getItem("linger.runtime-sign-in-later") === latest.id,
        );
      } catch {
        /* Optional preference. */
      }
    } else if (plan && !installBlocker(env)) {
      // The desktop client already chose; install with its plan.
      const setupChoice = report.choices.find(
        (option) => option !== "local-models" && option === plan.setupChoice,
      );
      setChoice(setupChoice ?? recommended);
      setJob(
        await request<InstallationJob>("/jobs", {
          instance: cfg.instance ?? "default",
          setupChoice: setupChoice ?? recommended,
        }),
      );
    }
    setReady(true);
  }
  useEffect(() => {
    void perform(load);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const jobId = job?.id;
  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    // Snapshots are authoritative; replayed events cannot regress progress.
    void watchJob(
      jobId,
      job?.lastSequence ?? 0,
      controller.signal,
      (event) => {
        if (controller.signal.aborted) return;
        if (event.job) {
          const snapshot = event.job;
          setJob((previous) =>
            !previous || snapshot.lastSequence >= previous.lastSequence
              ? snapshot
              : previous,
          );
        } else {
          setJob((previous) => {
            if (
              !previous ||
              previous.id !== event.jobId ||
              event.sequence <= previous.lastSequence
            )
              return previous;
            return {
              ...previous,
              lastSequence: event.sequence,
              updatedAt: event.at,
              ...(event.kind === "state" && event.state
                ? { state: event.state as InstallationJob["state"] }
                : {}),
              ...(event.stage
                ? {
                    stage: event.stage,
                    message: event.message,
                    stages: previous.stages.map((stage) =>
                      stage.id !== event.stage
                        ? stage
                        : {
                            ...stage,
                            state: (event.state ??
                              stage.state) as typeof stage.state,
                            message: event.message,
                            ...(event.progress
                              ? { progress: event.progress }
                              : {}),
                            at: event.at,
                          },
                    ),
                  }
                : {}),
            };
          });
        }
        if (event.kind === "state" || event.kind === "snapshot")
          void request<InstallationJob>(`/jobs/${encodeURIComponent(jobId)}`)
            .then((snapshot) => {
              if (!controller.signal.aborted)
                setJob((previous) =>
                  !previous || snapshot.lastSequence >= previous.lastSequence
                    ? snapshot
                    : previous,
                );
            })
            .catch(() => {});
      },
      () => {},
      () => {},
    );
    return () => controller.abort();
  }, [jobId]);
  const authPending =
    job?.state === "waiting_user" &&
    job.errorCode === "RUNTIME_AUTH_REQUIRED" &&
    Boolean(job.origin);
  const finished = job?.state === "succeeded" || authPending;
  useEffect(() => {
    if (!finished || !jobId) return;
    let active = true;
    void Promise.all([
      request<LoginInformation>(
        `/instances/${encodeURIComponent(job?.instance ?? "default")}/login`,
      ),
      request<InstanceStatus>(
        `/instances/${encodeURIComponent(job?.instance ?? "default")}/status`,
      ),
    ])
      .then(([value, current]) => {
        if (active) {
          setLogin(value);
          setStatus(current);
        }
      })
      .catch(() => {
        if (active)
          setError(
            "Could not verify local services and login. Retry to check startup.",
          );
      });
    return () => {
      active = false;
    };
  }, [finished, jobId]);
  async function install() {
    if (!choice) return;
    await perform(async () => {
      setSkipped(false);
      setJob(
        await request<InstallationJob>("/jobs", {
          instance: config?.instance ?? "default",
          setupChoice: choice,
        }),
      );
    });
  }
  async function retry() {
    if (!job) return;
    setStatus(undefined);
    await perform(async () =>
      setJob(
        await request<InstallationJob>(
          `/jobs/${encodeURIComponent(job.id)}/retry`,
          {},
        ),
      ),
    );
  }
  const sourceMode = environment?.checks.some(
    (check) => check.id === "source-native",
  );
  const blocker = environment && installBlocker(environment);
  const choosing = ready && !job;
  const servicesReady = Boolean(
    status?.services.length &&
    status.services.every((service) => service.ready),
  );
  const needsRecovery = finished && Boolean(status) && !servicesReady;
  const signingIn = finished && servicesReady && authPending && !skipped;
  const completed = finished && servicesReady && !signingIn;
  const verifying = finished && !status;
  const screen =
    !ready || verifying || needsRecovery
      ? 4
      : choosing
        ? 0
        : signingIn
          ? 4
          : completed
            ? 3
            : 2;
  return (
    <div className={`installer-shell screen-${screen}`}>
      <div className="welcome-scene" aria-hidden="true" />
      <main>
        <header className="topbar">
          <span className="installer-wordmark">Linger</span>
        </header>
        <div className="main-content">
          <div className="page-heading">
            <h1>
              {!ready
                ? "Checking your computer…"
                : choosing
                  ? "Choose your harness"
                  : signingIn
                    ? "Connect your harness"
                    : needsRecovery
                      ? "Service startup needs attention"
                      : verifying
                        ? "Checking services…"
                        : completed
                          ? "Your Linger is ready"
                          : "Installing Linger"}
            </h1>
          </div>
          {sourceMode && (
            <p className="source-mode">Source development · Native</p>
          )}
          {error && (
            <div className="notice error" role="alert">
              <p>{error}</p>
              {!ready && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void perform(load)}
                >
                  {"Retry"}
                </button>
              )}
            </div>
          )}
          {!ready && (
            <div role="status" className="connection-loading">
              <div className="installation-track is-active">
                <span className="installation-activity" />
              </div>
            </div>
          )}
          {choosing && setup && (
            <SetupChoicePanel
              report={setup}
              choice={choice}
              onChange={setChoice}
              onInstall={() => void install()}
              disabled={!choice || Boolean(blocker) || busy}
              blocker={blocker?.detail}
            />
          )}
          {ready && job && !finished && (
            <>
              <InstallationProgress job={job} now={now} />
              {["failed", "interrupted", "canceled", "waiting_user"].includes(
                job.state,
              ) && (
                <div className="notice error">
                  <p>
                    {job.message ?? "Installation paused. Retry to continue."}
                  </p>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void retry()}
                  >
                    {"Retry installation"}
                  </button>
                </div>
              )}
            </>
          )}
          {(needsRecovery || (verifying && Boolean(error))) && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void retry()}
            >
              {"Retry installation"}
            </button>
          )}
          {verifying && !error && (
            <div role="status" className="connection-loading">
              <div className="installation-track is-active">
                <span className="installation-activity" />
              </div>
            </div>
          )}
          {signingIn && job?.runtimeAuth && (
            <>
              <RuntimeSignIn
                instance={job.instance}
                runtime={job.runtimeAuth.runtime}
                nativeBrowser={
                  job.runtimeAuth.runtime === "codex" &&
                  setup?.hardware.platform === "darwin"
                }
                onReady={() => void retry()}
              />
              <button
                className="text-button skip-sign-in"
                onClick={() => {
                  setSkipped(true);
                  try {
                    sessionStorage.setItem(
                      "linger.runtime-sign-in-later",
                      job.id,
                    );
                  } catch {
                    /* Optional preference. */
                  }
                }}
              >
                {"Sign in later and continue"}
              </button>
            </>
          )}
          {completed && login && (
            <>
              <p className="completion-description">
                {"Your account is ready. Keep these details for signing in."}
              </p>
              <section className="credentials" aria-label={"Login information"}>
                <div className="credential-row">
                  <span>{"Email"}</span>
                  <code>{login.email}</code>
                  <Copy value={login.email} label={"email"} />
                </div>
                <div className="credential-row">
                  <span>{"Password"}</span>
                  <code className="password-value">
                    {showPassword ? login.password : "••••••••••••"}
                  </code>
                  <div className="inline-actions">
                    <button
                      className="text-button"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? "Hide" : "Show"}
                    </button>
                    <Copy value={login.password} label={"password"} />
                  </div>
                </div>
              </section>
              <a
                className="button primary"
                href={login.origin}
                target="_blank"
                rel="noreferrer"
              >
                {"Open Linger"} <span aria-hidden="true">→</span>
              </a>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
