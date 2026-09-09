import { describe, expect, it } from "vitest";

import { apiBaseUrl } from "../lib/config";

describe("apiBaseUrl", () => {
  it("returns the configured base url", () => {
    expect(apiBaseUrl({ NEXT_PUBLIC_API_BASE_URL: "http://localhost:8000" })).toBe(
      "http://localhost:8000",
    );
  });

  it("strips trailing slashes", () => {
    expect(apiBaseUrl({ NEXT_PUBLIC_API_BASE_URL: "http://localhost:8000///" })).toBe(
      "http://localhost:8000",
    );
  });

  it("throws when unset", () => {
    expect(() => apiBaseUrl({})).toThrow(/NEXT_PUBLIC_API_BASE_URL/);
  });

  it("throws when blank", () => {
    expect(() => apiBaseUrl({ NEXT_PUBLIC_API_BASE_URL: "   " })).toThrow();
  });
});
