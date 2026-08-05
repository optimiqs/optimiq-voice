import { expect } from "chai";
import { isValidIso8601Date } from "../../src/models/evaluations/isValidIso8601Date";

describe("isValidIso8601Date", () => {
  it("returns true for valid ISO 8601 date string", () => {
    expect(isValidIso8601Date("2024-01-15")).to.be.true;
    expect(isValidIso8601Date("2024-01-15T12:00:00Z")).to.be.true;
  });

  it("returns false for non-string", () => {
    expect(isValidIso8601Date(123)).to.be.false;
    expect(isValidIso8601Date(null)).to.be.false;
  });

  it("returns false for invalid date string", () => {
    expect(isValidIso8601Date("not-a-date")).to.be.false;
    expect(isValidIso8601Date("")).to.be.false;
  });
});
