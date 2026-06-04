import { describe, expect, it } from "vitest";
import { safeEvaluate } from "./calculator";

describe("safeEvaluate", () => {
  it("should evaluate simple addition and subtraction", () => {
    expect(safeEvaluate("1 + 2")).toBe(3);
    expect(safeEvaluate("10 - 4")).toBe(6);
    expect(safeEvaluate("100 + 200 - 50")).toBe(250);
  });

  it("should evaluate simple multiplication and division", () => {
    expect(safeEvaluate("6 * 7")).toBe(42);
    expect(safeEvaluate("100 / 4")).toBe(25);
    expect(safeEvaluate("2.5 * 4")).toBe(10);
  });

  it("should respect operator precedence (PEMDAS)", () => {
    expect(safeEvaluate("1 + 2 * 3")).toBe(7);
    expect(safeEvaluate("10 - 20 / 4")).toBe(5);
    expect(safeEvaluate("2 * 3 + 4 * 5")).toBe(26);
  });

  it("should support parentheses", () => {
    expect(safeEvaluate("(1 + 2) * 3")).toBe(9);
    expect(safeEvaluate("10 * (2 + 3) / 2")).toBe(25);
    expect(safeEvaluate("2 * (3 + 4 * (5 - 3))")).toBe(22);
  });

  it("should handle negative numbers", () => {
    expect(safeEvaluate("-5 + 10")).toBe(5);
    expect(safeEvaluate("10 + -5")).toBe(5);
    expect(safeEvaluate("10 - -5")).toBe(15);
    expect(safeEvaluate("-(5 + 5)")).toBe(-10);
  });

  it("should handle decimal numbers", () => {
    expect(safeEvaluate("0.1 + 0.2")).toBeCloseTo(0.3);
    expect(safeEvaluate("10.5 * 2")).toBe(21);
    expect(safeEvaluate("1.25 / 0.5")).toBe(2.5);
  });

  it("should throw an error on division by zero", () => {
    expect(() => safeEvaluate("10 / 0")).toThrow("Division by zero");
    expect(() => safeEvaluate("5 / (2 - 2)")).toThrow("Division by zero");
  });

  it("should throw an error on invalid characters", () => {
    expect(() => safeEvaluate("1 + 2; console.log(3)")).toThrow(
      "Invalid character in mathematical expression"
    );
    expect(() => safeEvaluate("1 + 2x")).toThrow(
      "Invalid character in mathematical expression"
    );
    expect(() => safeEvaluate("Math.sqrt(4)")).toThrow(
      "Invalid character in mathematical expression"
    );
  });

  it("should throw on mismatched parentheses", () => {
    expect(() => safeEvaluate("(1 + 2")).toThrow();
    expect(() => safeEvaluate("1 + 2)")).toThrow();
  });
});
