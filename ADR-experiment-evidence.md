# What a climb can prove

## Context

An absent latency field could parse as zero. Old failure-count checks also used an absent failure summary to mean zero after a successful test command. Numeric observations and failure counts therefore need separate parsing rules.

## Decision

New numeric measurements require a successful command and an explicit finite value. Failure-count mode keeps the absent-summary convention for successful checks. Persist the measurement mode with the card and carry it through kit reuse. Existing cards retain their recorded interpretation. Keep baseline attainment, improvement and final proof separately visible. Bind new scoped receipts to the criteria selected for the verifier.

## Consequences

Existing failure-count command lines used for a new climb must specify failure-count mode. A missing observation interrupts measurement. The repository remains the execution environment for arbitrary project commands; Hill Climb reads results and publishes scoped evidence. Benchmark kits and strategy reports reuse the existing setup and CLI.

## Alternatives

Changing every missing field to zero preserves legacy commands but makes a missing latency reading indistinguishable from an instantaneous request. Making every absent field an error also breaks already-issued failure-count cards. Requiring an additional research service for all runs adds a dependency without improving a deterministic local check.
