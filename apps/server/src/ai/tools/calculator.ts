/**
 * Safely evaluates a simple mathematical expression containing +, -, *, /, (, ), decimals, and numbers.
 * This is a highly secure parser with NO eval or Function calls, preventing any remote code execution.
 */
export function safeEvaluate(expression: string): number {
  // Normalize string: remove whitespace and allow only safe characters
  const cleanExpr = expression.replace(/\s+/g, "");

  if (/[^0-9+\-*/().]/.test(cleanExpr)) {
    throw new Error(
      "Invalid character in mathematical expression. Only numbers and operators +, -, *, /, (, ) are allowed."
    );
  }

  let index = 0;

  function peek(): string {
    return cleanExpr[index] ?? "";
  }

  function consume(): string {
    return cleanExpr[index++] ?? "";
  }

  function parseNumber(): number {
    let str = "";
    // We must have at least one digit or a decimal point
    if (!/[0-9.]/.test(peek())) {
      throw new Error(`Expected number or decimal point but found '${peek()}'`);
    }

    while (/[0-9.]/.test(peek())) {
      str += consume();
    }

    const val = Number.parseFloat(str);
    if (Number.isNaN(val)) {
      throw new Error(`Invalid number: ${str}`);
    }
    return val;
  }

  function parseFactor(): number {
    if (peek() === "-") {
      consume(); // consume '-'
      return -parseFactor();
    }
    if (peek() === "+") {
      consume(); // consume '+'
      return parseFactor();
    }
    if (peek() === "(") {
      consume(); // consume '('
      const result = parseExpression();
      if (consume() !== ")") {
        throw new Error("Mismatched parentheses");
      }
      return result;
    }
    return parseNumber();
  }

  function parseTerm(): number {
    let result = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const op = consume();
      const nextFactor = parseFactor();
      if (op === "*") {
        result *= nextFactor;
      } else {
        if (nextFactor === 0) {
          throw new Error("Division by zero");
        }
        result /= nextFactor;
      }
    }
    return result;
  }

  function parseExpression(): number {
    let result = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = consume();
      const nextTerm = parseTerm();
      if (op === "+") {
        result += nextTerm;
      } else {
        result -= nextTerm;
      }
    }
    return result;
  }

  const finalValue = parseExpression();
  if (index < cleanExpr.length) {
    throw new Error(
      `Unexpected character at the end of expression: '${cleanExpr[index]}'`
    );
  }
  return finalValue;
}
