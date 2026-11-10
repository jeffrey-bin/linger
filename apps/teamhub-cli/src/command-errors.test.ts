import { expect, it } from "vitest";
import { formatCommandError, renderCommandError } from "./command-errors.js";
import { CliError } from "./errors.js";

const rejected = new CliError(
  "team_md_document_invalid",
  "team.md document is invalid",
  {
    http_status: 400,
    request_id: "request_example",
    internal_route: "room:secret",
    issues: [
      {
        path: "members[0].id",
        code: "team_md_actor_not_room_member",
        message:
          'Team Member "actor_bob" is not an active member of this Room.',
      },
      {
        path: "pattern",
        code: "team_md_pattern_invalid",
        message: "Use\none of the five values.",
      },
    ],
  },
);

it("keeps server field-level issues in JSON errors without exposing other details", () => {
  const formatted = formatCommandError(rejected, {
    command: "room collaborate",
    remote: true,
  });
  expect(formatted.details).toEqual({
    http_status: 400,
    request_id: "request_example",
    issues: rejected.details.issues,
  });
});

it("renders one text line per server issue with path, code and message", () => {
  const text = renderCommandError(
    formatCommandError(rejected, { command: "room collaborate", remote: true }),
  );
  expect(text).toContain(
    'Issue: members[0].id: team_md_actor_not_room_member: Team Member "actor_bob" is not an active member of this Room.',
  );
  expect(text).toContain(
    "Issue: pattern: team_md_pattern_invalid: Use one of the five values.",
  );
  expect(text).not.toContain("room:secret");
});

it("keeps version-conflict guidance specific to the attempted resource", () => {
  const error = new CliError("version_conflict", "internal conflict", {
    http_status: 409,
  });
  const task = formatCommandError(error, {
    command: "task create",
    remote: true,
  });
  expect(task.message).not.toContain("Document");
  expect(task.message).toContain("resource state");
  const document = formatCommandError(error, {
    command: "docs replace",
    remote: true,
  });
  expect(document.message).toContain("Preserve local changes");
});

it("tells personal-profile write to reread and merge after a revision conflict", () => {
  const formatted = formatCommandError(
    new CliError("profile_revision_conflict", "server prose", {
      http_status: 409,
    }),
    { command: "personal-profile write", remote: true },
  );
  expect(formatted.code).toBe("profile_revision_conflict");
  expect(formatted.message).toContain("teamhub personal-profile show");
});

it("exposes only bare Document IDs as ambiguous-name candidates", () => {
  const error = formatCommandError(
    new CliError("ambiguous_name", "internal routing prose", {
      candidates: [
        "document_first",
        "room:secret",
        "document_bad\nInjected",
        { token: "secret" },
      ],
    }),
    { command: "docs get", remote: true },
  );
  expect(error.details).toEqual({ candidates: ["document_first"] });
  expect(renderCommandError(error)).toContain("Candidates: document_first");
  expect(JSON.stringify(error)).not.toMatch(/secret|Injected|internal routing/);
});

it("tells every command to retry an unknown outcome with its operation ID", () => {
  const error = new CliError("outcome_unknown", "backend prose", {
    operation_id: "operation-one",
  });
  for (const command of ["message send", "task create"]) {
    const formatted = formatCommandError(error, { command, remote: true });
    expect(formatted.message).toContain("--operation-id");
    expect(formatted.details).toEqual({ operation_id: "operation-one" });
  }
});

it("exposes no ambiguous-name candidates when none is a bare Document ID", () => {
  const error = formatCommandError(
    new CliError("ambiguous_name", "internal routing prose", {
      candidates: [
        "room:secret",
        "document_bad\nInjected",
        { token: "secret" },
      ],
    }),
    { command: "docs get", remote: true },
  );
  expect(error.details).toBeUndefined();
  expect(JSON.stringify(error)).not.toMatch(/secret|Injected|room:/);
  const text = renderCommandError(error);
  expect(text).not.toMatch(/secret|Injected|Candidates/);
  expect(text.split("\n").some((line) => line.startsWith("Injected"))).toBe(
    false,
  );
});

it("renders string candidates on one line", () => {
  const text = renderCommandError({
    code: "ambiguous_name",
    message: "m",
    details: { candidates: ["document_a\nForged: line"] },
  });
  expect(text.split("\n").filter((line) => line.startsWith("Forged"))).toEqual(
    [],
  );
  expect(text).toContain("Candidates: document_a Forged: line");
});

it("renders a configured Context without a flag and a flag target as a flag", () => {
  expect(
    renderCommandError({
      code: "forbidden",
      message: "m",
      target: { type: "room", id: "room_one" },
    }),
  ).toContain("Context: room:room_one");
  expect(
    renderCommandError({
      code: "forbidden",
      message: "m",
      target: { type: "thread", id: "thread_one" },
    }),
  ).toContain("Target: --thread thread_one");
});
