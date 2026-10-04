import { expect, it } from "vitest";
import { runtimeConfig, serviceBaseUrl } from "./config.js";
it("accepts explicit authenticated LAN and hosted service bases", () => {
  for (const serviceUrl of ["http://10.1.2.3:8009/v1", "https://api.typesafe.ai/v1", "http://inference.corp/system/v1"]) {
    expect(runtimeConfig({ serviceUrl, apiKey: "test-key" })).toMatchObject({ serviceUrl, apiKey: "test-key" });
  }
});
it.each(["", "file:///server", "https://user:password@host/v1", "http://host/v1?key=value", "http://host/v1#fragment"])("rejects ambiguous service base %s", value => {
  expect(() => serviceBaseUrl(value)).toThrow();
});
it("rejects simultaneous legacy and authenticated endpoints", () => {
  expect(() => runtimeConfig({ serviceUrl: "http://corp/v1", baseUrl: "http://localhost:8009" })).toThrow();
});
