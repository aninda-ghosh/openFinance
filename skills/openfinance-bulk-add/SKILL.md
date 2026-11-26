---
name: openfinance-bulk-add
description: Converts bank and credit card statements (PDF, screenshot, CSV, Excel, or text copied from a bank website) into the tab-separated format that the openFinance desktop app's Bulk Add page reads, one block per account. Use whenever the user shares a statement or a list of transactions and wants it in openFinance, mentions Bulk Add, or asks to convert or clean up transactions for import.
---

# openFinance Bulk Add

openFinance's **Transactions → Bulk add** page takes pasted text for **one account at a time** and turns it into transactions the user reviews before saving. Your job is to turn whatever statement the user gives you into text that page reads with no guessing, one block per account.

## Output format

For each account, write a short heading, then one fenced code block that holds a tab-separated table with exactly this header:

```
Date	Description	Debit	Credit
2026-10-03	WHOLEFDS MKT 10234 SAN FRANCISCO CA	84.17	
2026-10-05	AMAZON MKTPLACE PMTS AMZN.COM/BILL WA	23.99	
2026-10-09	AMAZON MKTPLACE PMTS AMZN.COM/BILL WA		23.99
2026-10-15	AUTOPAY PAYMENT - THANK YOU		1250.00
```

Columns are separated by a single **tab** character. Never use commas or spaces to line columns up.

### Date
- `YYYY-MM-DD`, always. Never `03/04/2026` (the app can't tell day from month), never a month name.
- Use the **transaction date**, not the posting date, when the statement shows both.
- Statements often print dates without a year. Take the year from the statement period, and watch for periods that cross a year boundary (a "Dec 15 – Jan 14" statement has December dates in the earlier year).

### Description
- Copy the merchant text **exactly as the statement prints it**: same words, same capitals, same store numbers and city. Don't tidy it up, translate it or add a category.
  - The app recognizes a transaction it has already imported by this exact text, so a "cleaned" description makes a repeat import look new.
  - The app also uses words such as PAYMENT, AUTOPAY, THANK YOU, TRANSFER and bank names to spot card payments and transfers between accounts, so keep them.
- Put it on one line: replace line breaks and tabs inside a description with a single space, and collapse runs of spaces.
- When a statement wraps one description over two lines, join them. Extra lines that are clearly separate (foreign exchange rate details, reference numbers on their own line) can be left out.

### Debit and Credit
Seen from **this account**:
- **Debit** = money out of the account, or owed more on a card: purchases, withdrawals, fees, interest charged, transfers and payments sent.
- **Credit** = money into the account, or owed less on a card: deposits, salary, refunds, cashback and statement credits, transfers received, **payments made to a credit card**.

Rules:
- Fill exactly one of the two; leave the other **empty** (keep the tab).
- Plain positive numbers with two decimals: `1250.00`. No currency symbol, no thousands separator, no minus sign, no `CR`/`DR` suffix.
- Use the amount in the account's own currency (what was billed), even when the statement also shows a foreign amount.

### Leave out
- Running balance columns, opening and closing balances, totals and subtotals.
- Summary sections (rewards, interest calculations, payment due notices, fees year-to-date).
- Column headers repeated on every page.
- Pending or authorization-only transactions, unless the user asks for them. If there are any, say how many you left out.

### More than one account
- Give each account its own heading and block, and say which openFinance account to paste it into, using the account name plus the last four digits, e.g. "Amex Gold ••1007".
- Additional cardholders on the **same** card account go in that account's block, merged by date. They aren't separate accounts.
- Never write out a full account or card number; the last four digits are enough.

### Order
Oldest transaction first.

## Working method

1. **Read the whole statement first.** For a PDF, check every page. For CSV or Excel files, transform them with code rather than retyping values, so no amount is mistyped. For screenshots, read carefully and double-check amounts that are hard to read.
2. **Build the rows** following the rules above.
3. **Check your work** before answering. Run `scripts/check_bulk_add.py` on each block if you can run code; otherwise check by hand:
   - every row has a valid date, a description, and exactly one amount;
   - the total of Debits and the total of Credits match the statement's own totals where it prints them (for example "Purchases", "Payments and credits", "Total withdrawals" and "Total deposits"). Report each comparison as matching or not. If something doesn't match, find the missing or extra rows before answering, and if you can't, say so plainly.
4. **Answer** with, for each account:
   - the heading (account name and last four digits, statement period);
   - the code block;
   - one line: number of rows, Debit total, Credit total, and whether they match the statement.

   Then finish with these steps for the user: *In openFinance, open **Transactions → Bulk add**, choose the account, and paste the block. Review the rows (categories, transfers) and save.*

Don't add commentary inside the code block, and don't put anything other than the table in it. The user copies the whole block straight into the app.
