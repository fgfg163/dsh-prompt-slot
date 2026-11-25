/**
 * Process-wide budget policy.
 *
 * Declared so the Settings service builds a live form for the entry:
 * `volatileForm` only exposes fields marked `.volatile()`, and every field
 * here may change without remounting the plugin (the registry, its slots, and
 * the session projection are stateless w.r.t. these values — `apply` reads
 * them once, but a volatile update re-runs that read in place).
 *
 * A GUI form save goes through `settings.mutate`, which is path-addressed:
 * fields NOT declared here are preserved in the profile patch, so future
 * config keys can be added by hand without a schema release blocking the UI.
 *
 * 0.3.0 — `position` is gone. Placement is no longer a process-wide setting:
 * the contributor picks it when registering, with `registerBefore()` or
 * `registerAfter()` (see `lib/index.js`). Only the budget stays global.
 *
 * 0.3.1 — **the budget is unlimited by default.** `totalMaxChars` has no
 * `.default()`, so "unset" is a meaningful state that means "no ceiling".
 * Clearing the field in Settings writes an `unset` op (the form controller in
 * `dsh-client-ui-settings` exposes `unset(field)`), which removes the key from
 * the profile patch entirely. Per-slot `maxChars` still applies either way, so
 * a slot that promised a ceiling still gets one.
 */
import z from '@deepseek-ai/schemastery'

export const Config = z
  .object({
    /**
     * Optional hard ceiling for the joined body of one injection, in
     * characters. Counted separately for the before block and the after block,
     * so one channel can never starve the other.
     *
     * **Absent = unlimited.** There is deliberately no default here: a default
     * would make "unlimited" impossible to express through the form (the form
     * can only `set` a value or `unset` the key), and silently re-introducing a
     * ceiling after someone cleared the field would be worse than no ceiling.
     */
    totalMaxChars: z
      .number()
      .step(1)
      .min(1)
      .description('单轮总预算（字符）。留空 = 不限制。前注入与后注入各自独立计。')
      .volatile(),
  })
  .loose()
