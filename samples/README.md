# Test materials (SYNTHETIC / DEMO ONLY)

Everything under `samples/` is **fictional**, created for testing TradeProof.

- Company names, people, addresses, emails, prices and order numbers are invented.
- No real supplier, buyer, contract or bank detail is included.
- Do not add real customer documents, real invoices or personal data to this folder.

Every file name contains `synthetic` and every file starts with a `SYNTHETIC / DEMO` banner.

| File | Purpose |
| --- | --- |
| `synthetic/purchase-request.synthetic.json` | Buyer's purchase request (the "truth" to compare against) |
| `synthetic/supplier-quote-zh.synthetic.md` | Supplier quote in Chinese, with deliberate discrepancies |
| `synthetic/supplier-quote-en.synthetic.md` | Supplier's English summary, which disagrees with the Chinese quote in places |
| `synthetic/expected-discrepancies.synthetic.json` | Expected findings, checked by `tests/quote.test.ts` |
| `synthetic/extracted-quote-zh.synthetic.json`, `synthetic/extracted-quote-en.synthetic.json` | Hand-written reference extractions of the two quotes (every `source` is verbatim document text); expected output for the AI extraction step |
