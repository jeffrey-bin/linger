import {
  ArrowRight02Icon,
  ComputerIcon,
  Mail01Icon,
  SquareLock02Icon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons";
import { useState } from "react";
import { useSearchParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";

import { AuthShell } from "./auth-shell";
import { safeAuthenticationReturnTo } from "./authentication-return-to";
import {
  type DesktopLocalAccount,
  useDesktopLocalAccount,
} from "./desktop-local-account";
import {
  type AuthenticationResult,
  useTeamHubAuthentication,
} from "./teamhub-authentication";

type AuthenticationController = ReturnType<typeof useTeamHubAuthentication>;

export function TeamHubLoginPage({
  onAuthenticated,
}: {
  onAuthenticated?: (result: AuthenticationResult) => Promise<void> | void;
}) {
  const [searchParams] = useSearchParams();
  const returnTo = safeAuthenticationReturnTo(searchParams.get("return_to"));
  const authentication = useTeamHubAuthentication({
    onAuthenticated,
    returnTo,
  });
  const localAccount = useDesktopLocalAccount();
  const authenticationNotice =
    searchParams.get("reason") === "session-expired"
      ? "Your session has expired. Sign in again to continue."
      : null;

  return (
    <AuthShell title="Log in">
      {authenticationNotice ? (
        <div className="mb-4">
          <FormFeedback tone="danger">{authenticationNotice}</FormFeedback>
        </div>
      ) : null}
      {localAccount ? (
        <LocalAccountSignIn
          account={localAccount}
          authentication={authentication}
        />
      ) : null}
      <AuthenticationForm authentication={authentication} />
    </AuthShell>
  );
}

function LocalAccountSignIn({
  account,
  authentication,
}: {
  account: DesktopLocalAccount;
  authentication: AuthenticationController;
}) {
  return (
    <div className="mb-4">
      <Button
        className="w-full"
        disabled={authentication.state.isSubmitting}
        onClick={() => {
          void authentication.signInWithDesktopAccount(account);
        }}
        size="large"
        tone="secondary"
        type="button"
      >
        <Icon icon={ComputerIcon} size={16} />
        <span>Sign in with this computer's account</span>
      </Button>
      <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span>or</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}

function AuthenticationForm({
  authentication,
}: {
  authentication: AuthenticationController;
}) {
  const { email, error, isSubmitting, password } = authentication.state;
  const { changeField, handleSubmit } = authentication;

  return (
    <form
      className="space-y-3"
      noValidate
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <Field
        autoComplete="email"
        label="Email"
        labelClassName="sr-only"
        onChange={(event) => changeField("email", event.target.value)}
        placeholder="Work email"
        prefix={<Icon icon={Mail01Icon} size={16} />}
        type="email"
        value={email}
      />
      <PasswordField
        autoComplete="current-password"
        label="Password"
        onChange={(value) => changeField("password", value)}
        value={password}
      />
      {error ? <FormFeedback tone="danger">{error}</FormFeedback> : null}
      <Button
        aria-label="Sign in"
        className="mt-2 w-full"
        disabled={isSubmitting}
        size="large"
        type="submit"
        tone="primary"
      >
        <span>{isSubmitting ? "Working..." : "Log in"}</span>
        {!isSubmitting ? <Icon icon={ArrowRight02Icon} size={16} /> : null}
      </Button>
    </form>
  );
}

function PasswordField({
  autoComplete,
  label,
  onChange,
  value,
}: {
  autoComplete: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <Field
      autoComplete={autoComplete}
      label={label}
      labelClassName="sr-only"
      onChange={(event) => onChange(event.target.value)}
      placeholder={label}
      prefix={<Icon icon={SquareLock02Icon} size={16} />}
      suffix={
        <button
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setVisible((current) => !current)}
          type="button"
        >
          {visible ? (
            <Icon icon={ViewOffIcon} size={16} />
          ) : (
            <Icon icon={ViewIcon} size={16} />
          )}
        </button>
      }
      type={visible ? "text" : "password"}
      value={value}
    />
  );
}
