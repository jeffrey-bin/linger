import type { ReactNode } from "react";

const COMPOSIO_KEYS_URL =
  "https://dashboard.composio.dev/~/project/settings/api-keys";

/** Where a provider's API key comes from, shown above the form that saves it. */
export function ProviderKeyGuide({
  href,
  note,
  steps,
}: {
  href: string;
  note?: string;
  steps: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-app-border bg-app-surface-soft p-4">
      <p className="font-medium text-foreground">Get your API key</p>
      <div className="mt-1.5 leading-5 text-muted-foreground">{steps}</div>
      {note ? <p className="mt-2 leading-5 text-foreground">{note}</p> : null}
      <a
        className="mt-2 inline-flex font-medium text-app-link hover:underline"
        href={href}
        rel="noopener noreferrer"
        target="_blank"
      >
        Get a key <span aria-hidden="true">↗</span>
      </a>
    </div>
  );
}

export function ComposioKeyGuide() {
  return (
    <ProviderKeyGuide
      href={COMPOSIO_KEYS_URL}
      note="Permissions cannot be changed after a key is created. If Write All was not selected, create a new key. Read-only keys cannot create the authorization needed to connect apps."
      steps={
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>Open Composio and sign in or create an account.</li>
          <li>
            Create a project API key and select <strong>Read All</strong> and{" "}
            <strong>Write All</strong> before creating it.
          </li>
          <li>Copy the key, paste it below, and select Save key.</li>
          <li>
            Return to your app, select Connect, and complete authorization.
          </li>
        </ol>
      }
    />
  );
}
