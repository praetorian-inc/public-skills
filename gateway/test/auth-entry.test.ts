/**
 * Unit tests for the shared auth-entry parser seam (plan §6).
 *
 * `parseAuthEntry` is the single place the secret `auth` contract is interpreted.
 * Under Option B the entry IS the flat key; the parser trims surrounding whitespace
 * and returns `{ flatKey }`. This keeps both providers honest and makes adding a
 * future `service:logicalKey` form (Option A) a localized change here.
 */
import { describe, it, expect } from "vitest";
import { parseAuthEntry } from "../src/secrets/auth-entry.js";

describe("parseAuthEntry (Option B — flat-key contract)", () => {
  it("returns the entry as the flatKey", () => {
    expect(parseAuthEntry("PERPLEXITY_API_KEY")).toEqual({ flatKey: "PERPLEXITY_API_KEY" });
  });

  it("trims leading whitespace", () => {
    expect(parseAuthEntry("  PERPLEXITY_API_KEY")).toEqual({ flatKey: "PERPLEXITY_API_KEY" });
  });

  it("trims trailing whitespace", () => {
    expect(parseAuthEntry("PERPLEXITY_API_KEY  ")).toEqual({ flatKey: "PERPLEXITY_API_KEY" });
  });

  it("trims both leading and trailing whitespace", () => {
    expect(parseAuthEntry("  LINEAR_API_KEY  ")).toEqual({ flatKey: "LINEAR_API_KEY" });
  });

  it("trims newline characters", () => {
    expect(parseAuthEntry("\nFEATUREBASE_API_KEY\n")).toEqual({ flatKey: "FEATUREBASE_API_KEY" });
  });

  it("preserves internal structure of the key unchanged", () => {
    expect(parseAuthEntry("SIIT_API_KEY")).toEqual({ flatKey: "SIIT_API_KEY" });
  });

  it("handles an empty string after trim (edge case)", () => {
    // An empty entry trims to empty; providers handle unmapped/empty keys downstream.
    expect(parseAuthEntry("   ")).toEqual({ flatKey: "" });
  });

  // Future Option A placeholder: a `service:logicalKey` form is NOT parsed here yet.
  // When Option A is adopted, add tests for parseAuthEntry("perplexity:apiKey") here.
});
