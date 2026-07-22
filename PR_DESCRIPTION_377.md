# feat(contracts): implement TWAP (Time-Weighted Average Price) Oracle

**Closes #377**

---

## Summary

Replaces the arithmetic-mean price aggregation in `get_price()` with a **Time-Weighted Average Price (TWAP)**. Each observation is now weighted by the number of ledgers it persisted before being replaced, making flash-loan and single-block price manipulation economically infeasible.

Previously, the oracle computed a simple arithmetic mean of the newest 10 observations. An attacker controlling even one reporter could skew the mean by submitting an extreme value — a flash-loan of one block could manipulate the USDC→XLM conversion rate by up to 10%. TWAP eliminates this vector: an extreme value submitted at the current ledger has weight ≈ 1, so its effect on the average is negligible.

---

## Problem Statement

The oracle is the sole on-chain price source for USDC→XLM conversion in `donate_usdc()`. A manipulated price means donors get incorrect conversion rates — either over-paying or under-paying relative to the true market rate.

**Arithmetic mean vulnerability:**
| Ledger | Reporter | Price (XLM/USDC) | Arithmetic Mean (window=10) |
|--------|----------|-------------------|-----------------------------|
| 100 | Honest | 10 | — |
| 200 | Attacker | 1000 | — |
| 201 (current) | — | — | (10 + 1000) / 2 = **505** ❌ |

A single malicious report swings the mean from 10 to 505 — a 50× error.

**TWAP resistance:**
| Ledger | Price | Weight | Contribution |
|--------|-------|--------|-------------|
| 100 | 10 | 10 | 100 |
| 200 | 1000 | 1 | 1000 |
| 201 (current) | — | — | — |

TWAP = (10×100 + 1000×1) / 101 = **19** ✅ — 90% closer to the true price.

---

## Solution Architecture

### TWAP Formula

```
TWAP = Σ(price_i × weight_i) / (Σ(weight_i) × PRICE_SCALE)

where:
  weight_i = next_observation.ledger - current_observation.ledger
  (newest observation: current_ledger - newest.ledger)
```

### Time-Weighting Walkthrough

Given two observations at ledgers 100 and 150, and `get_price()` called at ledger 200:

```
Ledger 100 ──── 50 ledgers ──── Ledger 150 ──── 50 ledgers ──── Ledger 200
    │                                │                              │
    ▼                                ▼                              ▼
 price=10                        price=20                      get_price()
 weight=150-100=50               weight=200-150=50

TWAP = (10×50 + 20×50) / (100 × PRICE_SCALE) = 1500 / (100 × 10_000_000) = 15
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| **Same-ledger observations** | Each receives minimum weight of 1 → equivalent to arithmetic mean |
| **Single observation** | Weight = `current_ledger - obs.ledger` (with min 1). TWAP = observation price |
| **Zero total weight** | Falls back to configured fallback price (defensive safety net) |
| **Stale observation** (>720 ledgers) | Falls back to fallback (freshness check unchanged) |
| **No observations** | Returns fallback or panics (unchanged behavior) |
| **Integer overflow** | Uses `checked_mul`/`checked_add` throughout — panics with clear message |

### Why `PRICE_SCALE` multiplication before division

The formula computes `weighted_sum / (total_weight × PRICE_SCALE)` rather than `(weighted_sum / total_weight) / PRICE_SCALE`. This performs one integer division instead of two, preserving more precision. Since `total_weight ≤ 7200` (10 obs × 720 ledgers max), multiplying by `PRICE_SCALE` (10^7) produces at most ~7×10^10 — well within `i128` range.

---

## Changes

### File Modified

| File | Lines | Change |
|------|-------|--------|
| `contracts/oracle-contract/src/lib.rs` | +105, −35 | TWAP logic, `recorded_at`→`ledger` rename, `Vec` import, 4 new tests, 1 test expectation update |

### File Updated

| File | Purpose |
|------|---------|
| `contracts/indigopay-contract/ORACLE.md` | Updated "Reporting and Aggregation" section from arithmetic mean to TWAP with formula, edge cases table, and flash-loan resistance example |

### Code Changes in Detail

**1. `PriceObservation.recorded_at` → `PriceObservation.ledger`**

The field is renamed to match the TWAP terminology used throughout the issue. Backward compatibility: no production oracle contract is deployed with existing observations, so this is a clean rename.

**2. Core TWAP in `get_price()`**

```rust
// Collect observations from oldest to newest
let mut observations = Vec::new(&env);
// ... (circular buffer iteration) ...

// TWAP calculation
let mut weighted_sum = 0_i128;
let mut total_weight = 0_i128;

for i in 0..window {
    let obs = observations.get(i).unwrap();
    let next_ledger = if i + 1 < window {
        observations.get(i + 1).unwrap().ledger
    } else {
        current_ledger
    };
    let mut weight = next_ledger.saturating_sub(obs.ledger) as i128;
    if weight == 0 {
        weight = 1; // Minimum weight for same-ledger observations
    }
    weighted_sum = weighted_sum
        .checked_add(obs.price.checked_mul(weight).expect("TWAP mul overflow"))
        .expect("TWAP overflow");
    total_weight = total_weight.checked_add(weight).expect("Total weight overflow");
}

weighted_sum / (total_weight * PRICE_SCALE)
```

**Key design decisions:**
- **Minimum weight of 1**: Ensures same-ledger observations (common in tests, possible in rapid reporting) don't cause division-by-zero
- **`saturating_sub`**: Defensive against misordered ledger values in the circular buffer
- **`checked_mul`/`checked_add`**: Catch overflow, matching existing safety pattern
- **Freshness check unchanged**: Still uses the newest observation's ledger — a stale observation always triggers fallback regardless of TWAP weights

**3. Updated test: `newest_observation_controls_freshness`**

Expected value changed from `6` (arithmetic mean) to `2` (TWAP).

Rationale: Observation at ledger 1 (price=2, weight=999) dominates the newest observation at ledger 1000 (price=10, weight=1). TWAP = (2×999 + 10×1) / 1000 = 2008/1000 = 2. This correctly demonstrates that older observations with higher time-weight dominate the TWAP.

---

## Tests Added (4)

| Test | Description | Acceptance Criteria |
|------|-------------|-------------------|
| `test_twap_single_observation` | One observation at price 10, advanced 100 ledgers → TWAP = 10 | "TWAP of a single observation at price 10 over 100 ledgers = 10" ✅ |
| `test_twap_multiple_observations` | Two observations at ledgers 100/150, price 10/20, current 200 → TWAP = 15 | "(10×50 + 20×50) / 100 = 15" ✅ |
| `test_twap_freshness_expiry` | Stale observation (>720 ledgers) returns fallback | Freshness check preserved ✅ |
| `test_twap_flash_loan_resistance` | Attacker at ledger 200 with price 1000, current 201 → TWAP = 19 | "attack negligible" ✅ |

### Test Coverage Matrix

| Test | Obs Count | Ledger Spread | Attack | Expected |
|------|-----------|---------------|--------|----------|
| `test_twap_single_observation` | 1 | 100 ledgers | No | 10 |
| `test_twap_multiple_observations` | 2 | 50 ledgers each | No | 15 |
| `test_twap_freshness_expiry` | 1 | >720 ledgers | No | fallback |
| `test_twap_flash_loan_resistance` | 2 | 100 + 1 ledgers | Yes (1000×) | 19 |

All 25 oracle tests pass (21 existing + 4 new).

---

## CI Verification

| Check | Command | Result |
|-------|---------|--------|
| Format | `cargo fmt --all -- --check` | ✅ PASS |
| Clippy | `cargo clippy --workspace -- -D warnings` | ✅ PASS |
| Oracle Tests | `cargo test --features testutils -p oracle-contract` | ✅ 25/25 PASS |
| All Tests | `cargo test --features testutils --workspace -- --skip fuzz` | ✅ PASS |
| WASM Size | `cargo build --wasm32v1-none --release --no-default-features` + wasm-opt | ✅ Oracle: 12KB, IndigoPay: 65,459B (under 64KB) |

---

## Acceptance Criteria Checklist

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | TWAP of a single observation at price 10 over 100 ledgers = 10 | ✅ | `test_twap_single_observation` |
| 2 | TWAP of two observations: 10 at ledger 100, 20 at ledger 150, current 200 → 15 | ✅ | `test_twap_multiple_observations` |
| 3 | Flash manipulation: attacker price 1000 at ledger 200, current 201 → 19 (attack negligible) | ✅ | `test_twap_flash_loan_resistance` |
| 4 | Freshness expiry returns fallback | ✅ | `test_twap_freshness_expiry` |
| 5 | Maintains backward compatibility with `OracleInterface` trait | ✅ | Signature unchanged: `fn get_price(env: Env) -> i128` |
| 6 | Existing oracle tests pass (updated for TWAP) | ✅ | One test expectation updated, 21 existing + 4 new = 25 pass |
| 7 | `donate_usdc()` integration unaffected | ✅ | Calls `get_price()` through `OracleInterface` — transparent to TWAP change |
| 8 | ORACLE.md updated | ✅ | TWAP formula, edge cases table, flash-loan example |

---

## Scope

### In Scope
- TWAP calculation in `get_price()` with time-weighted ledger observations
- `recorded_at` → `ledger` field rename for clarity
- Minimum weight of 1 for same-ledger observations (backward-compatible with arithmetic mean)
- Freshness check preserved (newest observation must be within 720 ledgers)
- Fallback behavior preserved (stale → fallback, no obs → fallback, no fallback → panic)
- 4 new TWAP tests
- Updated ORACLE.md documentation

### Out of Scope (per issue specification)
- Changing the reporter management system
- Adding volatility metrics or confidence intervals
- Cross-oracle aggregation (multiple oracle contracts)
- Changing the `MAX_OBSERVATIONS`, `TWAP_WINDOW`, or `STALENESS_THRESHOLD` constants

---

## Backward Compatibility

- **`OracleInterface` trait**: Signature unchanged — `fn get_price(env: Env) -> i128`. All callers (`donate_usdc`, `donate_usdc_batch`) work unchanged.
- **`report_price` API**: Signature unchanged. The `ledger` field rename only affects the `PriceObservation` struct — callers never construct this struct directly; only `report_price()` does.
- **`set_fallback_price`**: Unchanged.
- **Reporter management**: `add_reporter`/`remove_reporter` unchanged.
- **Storage layout**: `PriceObservation` field rename from `recorded_at` to `ledger` changes the XDR serialization. No production oracle deployments exist with historical data, so no migration is needed.
- **`donate_usdc` behavior**: The function calls `get_price()` through the `OracleInterface`. With TWAP, the returned price is more manipulation-resistant but semantically equivalent — it's still a market rate for XLM/USDC conversion.

---

## Files Changed

| File | Lines | Description |
|------|-------|-------------|
| `contracts/oracle-contract/src/lib.rs` | +105, −35 | TWAP in `get_price()`, `recorded_at`→`ledger`, 4 new tests, 1 updated test |
| `contracts/indigopay-contract/ORACLE.md` | +40, −8 | Updated aggregation docs from arithmetic mean to TWAP |

---

## References

- **Issue**: [#377 — Implement TWAP Oracle](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/377)
- **Oracle contract**: `contracts/oracle-contract/src/lib.rs`
- **IndigoPay OracleInterface**: `contracts/indigopay-contract/src/lib.rs` (`OracleInterface` trait)
- **Oracle documentation**: `contracts/indigopay-contract/ORACLE.md`
- **CI workflow**: `.github/workflows/contracts.yml`
