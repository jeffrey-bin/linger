import { useEffect, useRef, useState } from "react";
import type { components } from "@linger/wire-contracts/linger-installer/types";
import { request } from "./api.js";
type State = components["schemas"]["RuntimeLogin"];
export function RuntimeSignIn({
  instance,
  runtime,
  nativeBrowser = false,
  onReady,
}: {
  instance: string;
  runtime: string;
  nativeBrowser?: boolean;
  onReady: () => void;
}) {
  const completed = useRef(false);
  const signInWindow = useRef<Window | null>(null);
  const openedUrl = useRef("");
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [state, setState] = useState<State>({ state: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [useKey, setUseKey] = useState(runtime === "pi");
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const compatible = runtime === "pi" && provider === "openai-compatible";
  async function connectKey() {
    setBusy(true);
    setError(false);
    const key = apiKey || (compatible ? "local" : "");
    setApiKey("");
    try {
      setState(
        await request<State>("/runtime-login", {
          instance,
          apiKey: key,
          ...(compatible ? { baseUrl, model } : {}),
          provider:
            runtime === "pi"
              ? provider
              : runtime === "codex"
                ? "openai"
                : "anthropic",
        }),
      );
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await request<State>(
          `/runtime-login?instance=${encodeURIComponent(instance)}`,
        );
        if (!active) return;
        setState(next);
      } catch {
        /* Keep the available skip action while restoring the control connection. */
      }
      if (active) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [instance]);
  useEffect(() => {
    if (state.state === "ready" && !completed.current) {
      completed.current = true;
      onReady();
    }
  }, [state.state, onReady]);
  useEffect(() => {
    const popup = signInWindow.current;
    if (!state.url || !popup || popup.closed || openedUrl.current === state.url)
      return;
    const url = new URL(state.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      ![
        "auth.openai.com",
        "claude.ai",
        "claude.com",
        "platform.claude.com",
        "console.anthropic.com",
      ].includes(url.hostname)
    )
      return;
    popup.location.replace(url.href);
    openedUrl.current = state.url;
  }, [state.url, busy]);
  async function start(submitCode = false) {
    if (!submitCode && nativeBrowser) {
      // Native Mac Codex opens the system browser itself. Avoid a second popup.
      if (state.url) window.open(state.url, "_blank", "noopener");
    } else if (!submitCode) {
      // Reserve the window synchronously inside the click so browser popup
      // protection does not block the later native CLI authorization response.
      const popup = window.open("about:blank", "_blank");
      signInWindow.current = popup;
      openedUrl.current = "";
      setPopupBlocked(!popup);
      if (popup) {
        popup.opener = null;
        popup.document.title = "Preparing sign-in…";
        if (popup.document.body)
          popup.document.body.textContent =
            "Preparing the official sign-in page. Please wait.";
      }
    }
    setBusy(true);
    setError(false);
    try {
      setState(
        await request<State>("/runtime-login", {
          instance,
          ...(submitCode ? { code } : {}),
        }),
      );
      setCode("");
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  const waiting = ["starting", "waiting_user"].includes(state.state);
  return (
    <div className="runtime-sign-in">
      <p>
        {
          "Business services are ready. Connect your harness, or skip to continue."
        }
      </p>
      {!useKey && (
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void start()}
        >
          {waiting ? "Continue sign-in" : "Start sign-in"}
        </button>
      )}
      {useKey ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void connectKey();
          }}
        >
          {runtime === "pi" && (
            <label>
              {"Provider"}
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="openai-compatible">
                  {"Local / OpenAI-compatible model"}
                </option>
              </select>
            </label>
          )}
          {compatible && (
            <>
              <label>
                {"API base URL"}
                <input
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  required
                  maxLength={2048}
                  placeholder="http://127.0.0.1:18100/v1"
                />
              </label>
              <label>
                {"Model ID"}
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  required
                  maxLength={256}
                />
              </label>
              <p className="hint">
                {
                  "Connect an existing model without installing or stopping model services. Enter a key only if required. HTTP is limited to loopback; other hosts require HTTPS."
                }
              </p>
            </>
          )}
          <label>
            {"API key"}
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              maxLength={4096}
              required={!compatible}
            />
          </label>
          <button
            className="button primary"
            disabled={
              busy ||
              (compatible ? !baseUrl.trim() || !model.trim() : !apiKey.trim())
            }
          >
            {"Connect"}
          </button>
        </form>
      ) : (
        <button className="text-button" onClick={() => setUseKey(true)}>
          {"Use an API key instead"}
        </button>
      )}
      {useKey && runtime !== "pi" && (
        <button className="text-button" onClick={() => setUseKey(false)}>
          {"Use account sign-in"}
        </button>
      )}
      {!useKey && popupBlocked && (
        <p role="status">
          {
            "Your browser blocked the sign-in window. Use the backup link below."
          }
        </p>
      )}
      {!useKey && state.url && (
        <p>
          <a
            className="button"
            href={state.url}
            target="_blank"
            rel="noreferrer"
          >
            {"Open sign-in page"}
          </a>
        </p>
      )}
      {!useKey && state.deviceCode && (
        <p>
          {"Enter this device code on the official page:"}{" "}
          <code>{state.deviceCode}</code>
        </p>
      )}
      {!useKey && state.acceptsCode && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void start(true);
          }}
        >
          <label>
            {"Authorization code from the official page"}
            <input
              autoComplete="off"
              type="password"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              maxLength={4096}
            />
          </label>
          <button className="button" disabled={busy || !code}>
            {"Complete sign-in"}
          </button>
        </form>
      )}
      {(error || state.state === "failed") && (
        <p role="status">
          {
            "Sign-in is not complete. Retry, or sign in later and use Linger now."
          }
        </p>
      )}
      {runtime === "codex" && state.deviceCode && (
        <p className="hint">
          {
            "If your account does not allow device-code sign-in, you can skip for now. Linger does not change account security settings."
          }
        </p>
      )}
    </div>
  );
}
