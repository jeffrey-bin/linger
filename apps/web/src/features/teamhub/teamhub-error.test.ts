import { describe, expect, it } from "vitest";

import { readTeamHubError } from "./teamhub-error";

describe("readTeamHubError", () => {
  it("keeps the TeamHub error message when the body is a TeamHub error", async () => {
    const error = await readTeamHubError(
      Response.json(
        {
          error: {
            code: "ROOM_LEFT",
            message: "Rejoin this Room before sending messages.",
            request_id: "req-1",
          },
        },
        { status: 403 },
      ),
    );

    expect(error.code).toBe("ROOM_LEFT");
    expect(error.message).toBe("Rejoin this Room before sending messages.");
  });

  it("explains a refusal from a layer in front of TeamHub without the raw status", async () => {
    const error = await readTeamHubError(
      new Response("<html>Forbidden</html>", { status: 403 }),
    );

    expect(error.code).toBe("HTTP_403");
    expect(error.status).toBe(403);
    expect(error.message).toBe(
      "The server refused this request. Reload the page and try again.",
    );
  });
});
