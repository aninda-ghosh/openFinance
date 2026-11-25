//! Port of `apps/server/src/ai/tools/calculator.ts`: a recursive-descent
//! evaluator for `+ - * / ( )`, decimals and numbers. It never evaluates code:
//! the input is reduced to those characters before parsing.

/// Call depth (parseExpression + parseTerm + parseFactor frames) at which
/// Rust stops instead of overflowing its stack, with V8's message. V8's own
/// limit depends on its stack and JIT state: Node 24 measured ~3,000-3,650
/// nested parentheses (3 frames each) and ~11,650 unary minuses (1 frame
/// each), so 11,000 frames sits inside that range. The parser runs on its
/// own thread with a large stack so this depth is always reachable.
const MAX_DEPTH: usize = 11_000;
const PARSER_STACK: usize = 256 * 1024 * 1024;
const STACK_OVERFLOW: &str = "Maximum call stack size exceeded";

struct Parser<'a> {
    s: &'a [u8],
    index: usize,
    depth: usize,
}

impl Parser<'_> {
    /// `cleanExpr[index] ?? ""` (the input is ASCII at this point).
    fn peek(&self) -> Option<u8> {
        self.s.get(self.index).copied()
    }

    fn consume(&mut self) -> Option<u8> {
        let c = self.peek();
        self.index += 1;
        c
    }

    fn enter(&mut self) -> Result<(), String> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(STACK_OVERFLOW.into());
        }
        Ok(())
    }

    fn parse_number(&mut self) -> Result<f64, String> {
        let is_num = |c: Option<u8>| c.is_some_and(|c| c.is_ascii_digit() || c == b'.');
        if !is_num(self.peek()) {
            let found = self
                .peek()
                .map(|c| (c as char).to_string())
                .unwrap_or_default();
            return Err(format!(
                "Expected number or decimal point but found '{found}'"
            ));
        }
        let start = self.index;
        while is_num(self.peek()) {
            self.index += 1;
        }
        let text = std::str::from_utf8(&self.s[start..self.index]).unwrap_or("");
        let val = parse_float(text);
        if val.is_nan() {
            return Err(format!("Invalid number: {text}"));
        }
        Ok(val)
    }

    fn parse_factor(&mut self) -> Result<f64, String> {
        self.enter()?;
        let result = match self.peek() {
            Some(b'-') => {
                self.consume();
                self.parse_factor().map(|v| -v)
            }
            Some(b'+') => {
                self.consume();
                self.parse_factor()
            }
            Some(b'(') => {
                self.consume();
                let result = self.parse_expression()?;
                if self.consume() != Some(b')') {
                    return Err("Mismatched parentheses".into());
                }
                Ok(result)
            }
            _ => self.parse_number(),
        };
        self.depth -= 1;
        result
    }

    fn parse_term(&mut self) -> Result<f64, String> {
        self.enter()?;
        let mut result = self.parse_factor()?;
        while matches!(self.peek(), Some(b'*') | Some(b'/')) {
            let op = self.consume();
            let next = self.parse_factor()?;
            if op == Some(b'*') {
                result *= next;
            } else {
                if next == 0.0 {
                    return Err("Division by zero".into());
                }
                result /= next;
            }
        }
        self.depth -= 1;
        Ok(result)
    }

    fn parse_expression(&mut self) -> Result<f64, String> {
        self.enter()?;
        let mut result = self.parse_term()?;
        while matches!(self.peek(), Some(b'+') | Some(b'-')) {
            let op = self.consume();
            let next = self.parse_term()?;
            if op == Some(b'+') {
                result += next;
            } else {
                result -= next;
            }
        }
        self.depth -= 1;
        Ok(result)
    }
}

/// `Number.parseFloat(str)` for a string of digits and dots: the longest
/// prefix that is a decimal literal (`1.2.3` → 1.2, `.` → NaN).
fn parse_float(s: &str) -> f64 {
    let b = s.as_bytes();
    let mut end = 0;
    let mut digits = 0;
    while end < b.len() && b[end].is_ascii_digit() {
        end += 1;
        digits += 1;
    }
    if end < b.len() && b[end] == b'.' {
        let mut frac_end = end + 1;
        while frac_end < b.len() && b[frac_end].is_ascii_digit() {
            frac_end += 1;
            digits += 1;
        }
        end = frac_end;
    }
    if digits == 0 {
        return f64::NAN;
    }
    let lit = &s[..end];
    let lit = lit.strip_suffix('.').unwrap_or(lit);
    let lit = if lit.starts_with('.') {
        format!("0{lit}")
    } else {
        lit.to_string()
    };
    lit.parse::<f64>().unwrap_or(f64::NAN)
}

/// `safeEvaluate(expression)`: the value, or the message Node throws.
pub fn safe_evaluate(expression: &str) -> Result<f64, String> {
    // expression.replace(/\s+/g, "")
    let clean: String = expression
        .chars()
        .filter(|c| !crate::js::is_js_whitespace(*c))
        .collect();
    if clean
        .chars()
        .any(|c| !matches!(c, '0'..='9' | '+' | '-' | '*' | '/' | '(' | ')' | '.'))
    {
        return Err("Invalid character in mathematical expression. Only numbers and operators +, -, *, /, (, ) are allowed.".into());
    }
    let run = move || {
        let mut p = Parser {
            s: clean.as_bytes(),
            index: 0,
            depth: 0,
        };
        let value = p.parse_expression()?;
        if p.index < p.s.len() {
            return Err(format!(
                "Unexpected character at the end of expression: '{}'",
                p.s[p.index] as char
            ));
        }
        Ok(value)
    };
    std::thread::Builder::new()
        .name("ai-calculator".into())
        .stack_size(PARSER_STACK)
        .spawn(run)
        .map_err(|_| STACK_OVERFLOW.to_string())?
        .join()
        .unwrap_or_else(|_| Err(STACK_OVERFLOW.to_string()))
}

#[cfg(test)]
mod tests {
    //! Port of `calculator.test.ts`, plus edge cases checked against Node.
    use super::*;

    fn eval(s: &str) -> f64 {
        safe_evaluate(s).expect(s)
    }

    fn err(s: &str) -> String {
        safe_evaluate(s).expect_err(s)
    }

    #[test]
    fn simple_addition_and_subtraction() {
        assert_eq!(eval("1 + 2"), 3.0);
        assert_eq!(eval("10 - 4"), 6.0);
        assert_eq!(eval("100 + 200 - 50"), 250.0);
    }

    #[test]
    fn simple_multiplication_and_division() {
        assert_eq!(eval("6 * 7"), 42.0);
        assert_eq!(eval("100 / 4"), 25.0);
        assert_eq!(eval("2.5 * 4"), 10.0);
    }

    #[test]
    fn operator_precedence() {
        assert_eq!(eval("1 + 2 * 3"), 7.0);
        assert_eq!(eval("10 - 20 / 4"), 5.0);
        assert_eq!(eval("2 * 3 + 4 * 5"), 26.0);
    }

    #[test]
    fn parentheses() {
        assert_eq!(eval("(1 + 2) * 3"), 9.0);
        assert_eq!(eval("10 * (2 + 3) / 2"), 25.0);
        assert_eq!(eval("2 * (3 + 4 * (5 - 3))"), 22.0);
    }

    #[test]
    fn negative_numbers() {
        assert_eq!(eval("-5 + 10"), 5.0);
        assert_eq!(eval("10 + -5"), 5.0);
        assert_eq!(eval("10 - -5"), 15.0);
        assert_eq!(eval("-(5 + 5)"), -10.0);
    }

    #[test]
    fn decimal_numbers() {
        assert!((eval("0.1 + 0.2") - 0.3).abs() < 0.005);
        assert_eq!(eval("10.5 * 2"), 21.0);
        assert_eq!(eval("1.25 / 0.5"), 2.5);
    }

    #[test]
    fn division_by_zero() {
        assert!(err("10 / 0").contains("Division by zero"));
        assert!(err("5 / (2 - 2)").contains("Division by zero"));
    }

    #[test]
    fn invalid_characters() {
        for s in ["1 + 2; console.log(3)", "1 + 2x", "Math.sqrt(4)"] {
            assert!(
                err(s).contains("Invalid character in mathematical expression"),
                "{s}"
            );
        }
    }

    #[test]
    fn mismatched_parentheses() {
        assert!(safe_evaluate("(1 + 2").is_err());
        assert!(safe_evaluate("1 + 2)").is_err());
    }

    /// Outputs of the Node implementation for the same inputs.
    #[test]
    fn edge_cases_match_node() {
        assert_eq!(eval("0.1 + 0.2"), 0.30000000000000004);
        assert_eq!(eval("1.2.3"), 1.2);
        assert_eq!(eval("5."), 5.0);
        assert_eq!(eval(".5"), 0.5);
        assert_eq!(eval("--5"), 5.0);
        assert_eq!(eval("+-+5"), -5.0);
        assert_eq!(eval("1\u{a0}+\u{feff}2"), 3.0);
        assert_eq!(err("."), "Invalid number: .");
        assert_eq!(err("..5"), "Invalid number: ..5");
        assert_eq!(err(""), "Expected number or decimal point but found ''");
        assert_eq!(err("1+"), "Expected number or decimal point but found ''");
        assert_eq!(err("*2"), "Expected number or decimal point but found '*'");
        assert_eq!(err("(1+2"), "Mismatched parentheses");
        assert_eq!(
            err("1+2)"),
            "Unexpected character at the end of expression: ')'"
        );
        assert_eq!(
            err("2(3)"),
            "Unexpected character at the end of expression: '('"
        );
        assert_eq!(eval(&"9".repeat(400)), f64::INFINITY);
        assert_eq!(err(&"(".repeat(100_000)), STACK_OVERFLOW);
        let deep = format!("{}1{}", "(".repeat(2_000), ")".repeat(2_000));
        assert_eq!(eval(&deep), 1.0);
        assert_eq!(eval(&format!("{}1", "-".repeat(3_000))), 1.0);
        assert!(eval("-0").is_sign_negative());
    }
}
