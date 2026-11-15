/**
 * Process-wide budget and placement policy.
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
 */
import z from '@deepseek-ai/schemastery'

export const Config = z
  .object({
    /**
     * Where the joined injection block lands relative to this turn's user
     * prompt: `before` (OpenClaw's prependContext shape) or `after` (behind
     * everything else, matching time-context and agentmemory).
     */
    position: z.union([z.const('before'), z.const('after')]).default('before').volatile(),
    /**
     * Hard ceiling for the joined body of one injection, in characters.
     */
    totalMaxChars: z.number().step(1).min(1).default(8000).volatile(),
  })
  .loose()
