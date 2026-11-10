import http from "node:http";
import { expect, test } from "vitest";
import { checkModel } from "./platform.js";
test("model HTTP 200 without generated text does not claim generation verified", async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    const result = await checkModel({
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "model",
      apiKey: "private-key",
    });
    expect(result.checks.find((item) => item.id === "network")?.state).toBe(
      "ready",
    );
    expect(result.checks.find((item) => item.id === "generation")?.state).toBe(
      "failed",
    );
    expect(JSON.stringify(result).includes("private-key")).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("model check independently verifies generated content", async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    const result = await checkModel({
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "model",
      apiKey: "private-key",
    });
    expect(result.checks.every((item) => item.state === "ready")).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
