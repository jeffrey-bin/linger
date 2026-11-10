import { openWindowsTarget } from "@linger/local-installation/windows-open";
import { spawn } from "node:child_process";
import type { components } from "@linger/wire-contracts/linger-installer/types";
export async function openLocalTarget(target: string) {
  if (process.platform === "win32") return await openWindowsTarget(target);
  const executable = process.platform === "darwin" ? "open" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [target], {
      shell: false,
      stdio: "ignore",
    });
    child.once("error", () =>
      reject(new Error("Could not open it. Open it manually.")),
    );
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Could not open it. Open it manually.")),
    );
  });
}
export async function checkModel(
  model: components["schemas"]["ModelConfiguration"],
): Promise<components["schemas"]["ModelCheckReport"]> {
  const checks: components["schemas"]["CheckResult"][] = [];
  let response: Response;
  try {
    response = await fetch(
      `${model.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${model.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model.model,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 8,
          stream: false,
        }),
        signal: AbortSignal.timeout(20000),
      },
    );
  } catch {
    return {
      checks: [
        {
          id: "network",
          title: "Network connection",
          state: "failed",
          detail:
            "Could not connect to the model service. Check the URL and network.",
        },
        {
          id: "authentication",
          title: "Authentication",
          state: "action_required",
          detail: "Not yet verified.",
        },
        {
          id: "generation",
          title: "Model generation",
          state: "action_required",
          detail: "Not yet verified.",
        },
      ],
    };
  }
  checks.push({
    id: "network",
    title: "Network connection",
    state: "ready",
    detail: "The model service responded.",
  });
  const authorized = response.status !== 401 && response.status !== 403;
  checks.push({
    id: "authentication",
    title: "Authentication",
    state: authorized && response.ok ? "ready" : "failed",
    detail:
      authorized && response.ok
        ? "Authentication passed."
        : "Authentication or the service request failed. Check the key and permissions.",
  });
  let generated = false;
  try {
    if (response.ok) {
      const result = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      generated =
        typeof result.choices?.[0]?.message?.content === "string" &&
        Boolean(result.choices[0].message.content.trim());
    } else await response.body?.cancel();
  } catch {
    /* Provider bodies may contain private material; never expose them. */
  }
  checks.push({
    id: "generation",
    title: "Model generation",
    state: generated ? "ready" : "failed",
    detail: generated
      ? "The selected model returned text."
      : "No valid generation result was received from the selected model.",
  });
  return { checks };
}
