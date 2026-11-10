import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useReducer, useRef } from "react";
import { useNavigate } from "react-router";

import {
  clearTeamHubQueries,
  teamHubSessionQueryKey,
  teamHubIdentityQueryKey,
} from "@/features/rooms/room-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { announceTeamHubAuthenticated } from "@/features/teamhub/teamhub-authentication";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubSession } from "@/features/teamhub/teamhub-types";

import { authenticationOperation } from "./authentication-operation";

export interface AuthenticationResult {
  kind: "login";
  session: TeamHubSession;
}

interface AuthenticationState {
  email: string;
  error: string | null;
  isSubmitting: boolean;
  password: string;
}

type AuthenticationAction =
  | { field: "email" | "password"; type: "change-field"; value: string }
  | { error: string; type: "operation-error" }
  | { type: "submit-finished" }
  | { type: "submit-start" };

const initialAuthenticationState: AuthenticationState = {
  email: "",
  error: null,
  isSubmitting: false,
  password: "",
};

function authenticationReducer(
  state: AuthenticationState,
  action: AuthenticationAction,
): AuthenticationState {
  switch (action.type) {
    case "change-field":
      return { ...state, [action.field]: action.value };
    case "operation-error":
      return { ...state, error: action.error };
    case "submit-start":
      return { ...state, error: null, isSubmitting: true };
    case "submit-finished":
      return { ...state, isSubmitting: false };
  }
}

export function useTeamHubAuthentication(input: {
  onAuthenticated?: (result: AuthenticationResult) => Promise<void> | void;
  returnTo?: string | null;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const activeSubmit = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      activeSubmit.current?.abort();
      activeSubmit.current = null;
    },
    [],
  );
  const [state, dispatch] = useReducer(
    authenticationReducer,
    initialAuthenticationState,
  );

  async function completeAuthentication(
    result: AuthenticationResult,
    signal: AbortSignal,
  ) {
    let session: TeamHubSession;
    try {
      session = await authenticationOperation(signal, (signal) =>
        teamHubData(client.api.GET("/v0/session", { signal })),
      );
    } catch (error) {
      if (error instanceof TeamHubError && error.status === 401) {
        throw new TeamHubError({
          code: "SESSION_NOT_ESTABLISHED",
          message:
            "Linger could not establish a browser session. Use the secure workspace address or contact your workspace administrator.",
          status: 401,
        });
      }
      throw error;
    }
    signal.throwIfAborted();
    clearTeamHubQueries(queryClient);
    queryClient.setQueryData(teamHubSessionQueryKey, session);
    queryClient.setQueryData(teamHubIdentityQueryKey, session.identity);
    result = { ...result, session };
    announceTeamHubAuthenticated();
    if (input.onAuthenticated)
      await authenticationOperation(signal, async () =>
        input.onAuthenticated!(result),
      );
    else {
      const tenantId = session.identity.actors[0]?.tenant_id;
      await navigate(
        input.returnTo ??
          (tenantId ? `/t/${encodeURIComponent(tenantId)}/rooms` : "/"),
        { replace: true },
      );
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (activeSubmit.current) return;
    const email = state.email.trim().toLowerCase();
    if (!email) {
      dispatch({
        error: "Enter a valid email address.",
        type: "operation-error",
      });
      return;
    }
    const attempt = new AbortController();
    activeSubmit.current = attempt;
    dispatch({ type: "submit-start" });
    try {
      const session = await authenticationOperation(attempt.signal, (signal) =>
        teamHubData(
          client.api.POST("/v0/auth/login", {
            body: { identifier: email, password: state.password },
            signal,
          }),
        ),
      );
      attempt.signal.throwIfAborted();
      await completeAuthentication({ kind: "login", session }, attempt.signal);
    } catch (error) {
      if (activeSubmit.current === attempt)
        dispatch({
          error: readAuthenticationError(error),
          type: "operation-error",
        });
    } finally {
      if (activeSubmit.current === attempt) {
        activeSubmit.current = null;
        dispatch({ type: "submit-finished" });
      }
    }
  }

  return {
    changeField: (field: "email" | "password", value: string) =>
      dispatch({ field, type: "change-field", value }),
    handleSubmit,
    state,
  };
}

function readAuthenticationError(error: unknown) {
  if (error instanceof TeamHubError) return error.message;
  return "TeamHub could not be reached. Try again.";
}
