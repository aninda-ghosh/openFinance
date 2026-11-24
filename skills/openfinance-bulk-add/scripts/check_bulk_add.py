#!/usr/bin/env python3
"""Checks one openFinance Bulk Add block and prints its totals.

Usage:
    python3 check_bulk_add.py block.tsv
    python3 check_bulk_add.py block.tsv --debits 1234.56 --credits 1250.00

The file holds the block exactly as it will be pasted: a header line
"Date<TAB>Description<TAB>Debit<TAB>Credit", then one transaction per line.
Pass the statement's printed totals to compare against them.
Exits non-zero when anything needs fixing.
"""

import argparse
import re
import sys
from datetime import date
from decimal import Decimal, InvalidOperation

HEADER = ["Date", "Description", "Debit", "Credit"]
AMOUNT_RE = re.compile(r"^\d+\.\d{2}$")


def check(path, expected_debits=None, expected_credits=None):
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    while lines and not lines[-1].strip():
        lines.pop()

    problems = []
    if not lines:
        return ["The block is empty."], 0, Decimal(0), Decimal(0)
    if lines[0].split("\t") != HEADER:
        problems.append(
            "Line 1: header must be Date, Description, Debit, Credit separated by tabs."
        )

    debits = credits = Decimal(0)
    rows = 0
    previous = None
    for n, line in enumerate(lines[1:], start=2):
        cells = line.split("\t")
        if len(cells) != 4:
            problems.append(f"Line {n}: needs exactly 4 tab-separated columns, found {len(cells)}.")
            continue
        rows += 1
        when, desc, debit, credit = cells

        try:
            parsed = date.fromisoformat(when)
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", when):
                raise ValueError
            if previous and parsed < previous:
                problems.append(f"Line {n}: dates should run oldest first.")
            previous = parsed
        except ValueError:
            problems.append(f"Line {n}: date {when!r} isn't YYYY-MM-DD.")

        if not desc.strip():
            problems.append(f"Line {n}: description is empty.")
        elif desc != desc.strip() or "  " in desc:
            problems.append(f"Line {n}: description has extra spaces.")

        filled = [(name, v) for name, v in (("Debit", debit), ("Credit", credit)) if v != ""]
        if len(filled) != 1:
            problems.append(f"Line {n}: fill exactly one of Debit or Credit.")
            continue
        name, value = filled[0]
        if not AMOUNT_RE.match(value):
            problems.append(
                f"Line {n}: {name} {value!r} must be a plain positive number with two decimals, e.g. 1250.00."
            )
            continue
        try:
            amount = Decimal(value)
        except InvalidOperation:
            problems.append(f"Line {n}: {name} {value!r} isn't a number.")
            continue
        if amount == 0:
            problems.append(f"Line {n}: amount is zero.")
        if name == "Debit":
            debits += amount
        else:
            credits += amount

    for label, actual, expected in (
        ("Debit", debits, expected_debits),
        ("Credit", credits, expected_credits),
    ):
        if expected is not None and actual != Decimal(expected):
            problems.append(
                f"{label} total {actual:.2f} doesn't match the statement's {Decimal(expected):.2f} "
                f"(off by {actual - Decimal(expected):.2f})."
            )
    return problems, rows, debits, credits


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("path")
    parser.add_argument("--debits", help="statement's total of money out / charges")
    parser.add_argument("--credits", help="statement's total of money in / payments and credits")
    args = parser.parse_args()

    problems, rows, debits, credits = check(args.path, args.debits, args.credits)
    print(f"{rows} rows · Debit total {debits:.2f} · Credit total {credits:.2f}")
    if problems:
        print("Fix before answering:")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    main()
