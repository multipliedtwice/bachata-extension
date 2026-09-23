# Ledger rules

- An entry is `{ type, amount }`. `amount` is a decimal string with exactly two fraction
  digits, for example `"19.00"` or `"-1.00"`. Negative amounts are refunds.
- `type` is one of the keys of `FEE_BPS` in `src/fees.js`. Fees are in basis points.
- Fee per entry = amount × bps / 10000, rounded to a whole cent, half away from zero.
  A refund carries a negative fee: the fee is returned with it.
- Balance = sum of amounts − sum of fees. All arithmetic is exact to the cent.
- `balance` returns the balance as a decimal string with two fraction digits, `-` for negative.
