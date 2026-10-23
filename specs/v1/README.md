# Protocol Specifications

Gameplay, map geometry, and lifecycle semantics have been approved. The user supplied successful map-validation output. Action ABI, commitment/hash encoding, event fields, and numeric enum values remain to be finalized.

The specifications cover:

- Board geometry, the fixed squad, actions, simultaneous settlement, scoring, and outcomes.
- Permissions, deadlines, timeouts, and terminal states.
- 64 explicit semantic examples, including clearly labeled pure comparator fixtures.
- [Map configuration](map.json): map 1 coordinate sets, ASCII, and 64-bit masks.

Each specification records its scope, approval, and status. Use **Decided** for confirmed product/architecture boundaries; **Candidate** for details awaiting review; **Pending validation** for unmeasured compatibility/balance/performance; and **Frozen** for precise semantics approved by an effective architecture decision.

Planned specifications cover action encoding, state hashing, public events and APIs, the threat model, gas budgets, and byte-level Golden Vectors. They must preserve the approved gameplay behavior unless a subsequent approved decision explicitly changes it.
