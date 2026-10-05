/**
 * Bloom & Buzz event token bounds.
 *
 * Browser-safe and pure — no fs, no server imports — because the Events tab
 * clamps the number as it is typed and the zod schema in `studio-api.ts` is
 * bundled for the browser. `src/lib/server/township/events.server.ts`
 * re-exports both so the writer and the UI can never disagree, the same
 * arrangement `src/lib/regatta.ts` has with the Regatta tab.
 *
 * The event's own id in game data is `TrainJourney`; the token item is
 * `TrainJourneyToken` (`TJ_Token`).
 */

/** Default for the Events tab's token field, and the server-side fallback. */
export const BLOOM_TOKENS_DEFAULT = 100;

/**
 * Typo guard, not a game rule. No readable config states a ceiling for this
 * wallet — `maxAmount` appears in no APK config that can be decoded, and
 * `balanceVersion` / `LastTransferTransactionId` live outside the wallet
 * entirely — so this only stops a stray digit asking the writer to emit a
 * twenty-digit number and hang the session. The server clamps the value again
 * regardless of what arrives.
 */
export const BLOOM_TOKENS_MAX = 100_000;
