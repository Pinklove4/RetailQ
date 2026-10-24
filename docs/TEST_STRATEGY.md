# Test strategy
- Unit: integer-cent totals, discount-before-tax, rounding.
- HTTP: health, authentication boundary, schema rejection.
- E2E: catalog filtering, cart math, invalid login in Chromium and Firefox.
- Performance: k6 5 virtual users, 20 seconds, p95 latency <750 ms and error rate <1%.
- Future critical cases: simultaneous purchases of last unit, user order isolation, replay under concurrent requests, expired JWT, quantity boundaries, invalid promo, order rollback on DB error.
- Quality gate: any required test failure blocks merge; retain Playwright HTML, JSON, screenshots and traces as artifacts.
- Data: synthetic accounts only; avoid real customer or payment details.
