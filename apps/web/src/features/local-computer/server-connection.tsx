import { formatDateTime } from "@/lib/date-format";
import { sha256 } from "@noble/hashes/sha2.js";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { computerCommand } from "./computer-platform";
import { CopyValueButton } from "./computer-setup-instructions";
import { publishLocalComputerEnrollment } from "./local-computer-enrollment-events";

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export function ServerConnection({ tenantId }: { tenantId: string }) {
  const { client } = useTeamHubRuntime();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ token: string; expiresAt: string }>();
  const [failed, setFailed] = useState(false);
  const tokenRef = useRef<HTMLElement>(null);
  const commandRef = useRef<HTMLElement>(null);
  const requestPending = useRef(false);
  const command = `${computerCommand()} login --token-stdin`;

  async function generate() {
    if (requestPending.current || !name.trim()) return;
    requestPending.current = true;
    setPending(true);
    setFailed(false);
    setResult(undefined);
    try {
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const authorization = await teamHubData(
        client.api.POST("/v0/tenants/{tenantId}/local-computer-enrollments", {
          params: { path: { tenantId } },
          body: {
            display_name: name.trim(),
            code_challenge: base64url(
              sha256(new TextEncoder().encode(verifier)),
            ),
            redirect_uri: "http://127.0.0.1:9/callback",
          },
        }),
      );
      const token =
        "linger-connect-v1." +
        base64url(
          new TextEncoder().encode(
            JSON.stringify({
              origin: window.location.origin,
              display_name: name.trim(),
              enrollment_id: authorization.enrollment_id,
              computer_id: authorization.computer_id,
              tenant_id: tenantId,
              authorization_code: authorization.authorization_code,
              code_verifier: verifier,
              expires_at: authorization.expires_at,
            }),
          ),
        );
      setResult({ token, expiresAt: authorization.expires_at });
      publishLocalComputerEnrollment({
        computerId: authorization.computer_id,
        tenantId,
      });
    } catch {
      setFailed(true);
    } finally {
      requestPending.current = false;
      setPending(false);
    }
  }

  return (
    <details className="mt-4 rounded-xl border border-border bg-muted/40 p-4">
      <summary className="cursor-pointer text-sm font-medium text-foreground">
        Connect a server · No browser on this computer?
      </summary>
      <div className="mt-4 space-y-3 text-sm">
        <p className="text-muted-foreground">
          Install the CLI using step 1, then use a temporary token instead of
          browser sign-in. The server only needs an outbound connection.
        </p>
        <label className="block text-foreground">
          Server name
          <input
            className="ui-field-control mt-1 block w-full"
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={pending || Boolean(result)}
            placeholder="My server"
          />
        </label>
        {!result && (
          <Button
            disabled={pending || !name.trim()}
            onClick={() => void generate()}
          >
            {pending ? "Generating…" : "Generate connection token"}
          </Button>
        )}
        {failed && (
          <p role="alert" className="text-app-danger">
            Could not generate a token. Check your connection and try again.
          </p>
        )}
        {result && (
          <>
            <p className="text-muted-foreground">
              Run the command on the server, paste this token at the prompt,
              then press Enter. Expires at{" "}
              {formatDateTime(result.expiresAt, { timeStyle: "short" })}. Keep
              it private.
            </p>
            <div className="flex gap-2 rounded-lg border border-border bg-card p-3">
              <code
                ref={tokenRef}
                className="max-h-28 min-w-0 flex-1 overflow-auto break-all text-xs"
                aria-label="Server connection token"
              >
                {result.token}
              </code>
              <CopyValueButton
                value={result.token}
                selectionTargetRef={tokenRef}
              />
            </div>
            <div className="flex gap-2 rounded-lg border border-border bg-card p-3">
              <code
                ref={commandRef}
                className="min-w-0 flex-1 break-all text-xs"
              >
                {command}
              </code>
              <CopyValueButton
                value={command}
                selectionTargetRef={commandRef}
              />
            </div>
            <p className="text-muted-foreground">
              Waiting for the server to connect. If exchange is interrupted,
              retry the same token before it expires.
            </p>
            <Button onClick={() => setResult(undefined)}>
              Generate another token
            </Button>
          </>
        )}
      </div>
    </details>
  );
}
