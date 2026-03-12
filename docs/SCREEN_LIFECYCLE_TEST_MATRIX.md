# Screen Lifecycle Test Matrix

| Scenario | Current test files | Test level | Gap status |
| --- | --- | --- | --- |
| First-time pairing | `test/integration/pairing-flow.test.ts`, `test/unit/services/player-flow.test.ts` | integration, unit | Covered |
| Already-paired boot | `test/unit/services/player-flow.test.ts` | unit | Covered |
| Same-device recovery | `test/unit/services/player-flow.test.ts`, `test/integration/pairing-flow.test.ts` | unit, integration | Covered |
| Stale heartbeat handling | `test/unit/services/player-flow.test.ts` | unit | Partial |
| Deleted screen | `test/unit/services/player-flow.test.ts` | unit | Covered |
| Expired/revoked credentials | `test/unit/services/player-flow.test.ts` | unit | Covered |
| Transient network failure | `test/fault-injection/network-failures.test.ts`, `test/unit/services/player-flow.test.ts` | fault, unit | Covered |
| Unsupported codec targeting | Backend responsibility | N/A | Out of scope |
| Realtime dashboard update | N/A in player scope | N/A | Out of scope |
| Proof-of-play backlog replay | `test/unit/services/pop-service.test.ts` | unit | Covered |
| Screenshot failure | `test/unit/services/screenshot-service.test.ts` | unit | Covered |
| Command dedupe | `test/unit/services/command-processor.test.ts` | unit | Covered |
| Invalid CSR / expired code / device-id mismatch | `test/integration/pairing-flow.test.ts` | integration | Partial |

## Standard validation commands
- `npm run build`
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:fault`
