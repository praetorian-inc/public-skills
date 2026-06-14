/**
 * OAuth provider registry (plan §2 C5, design §3.2/§4).
 *
 * `OAuthProviderConfigSchema` describes one row of `secrets.oauth.<name>`.
 * `DEFAULT_OAUTH_PROVIDERS` ships the ported `linear` row so an empty config
 * materializes it (parity with how `onepassword.services` defaults).
 *
 * The linear `clientId` is PUBLIC + committable (ported from
 * `praetorian-core-plugin/tools/linear/config.ts:28-35`); a `LINEAR_CLIENT_ID`
 * env override is applied in the OAuth manager (Cycle 2), keeping config declarative.
 */
import { z } from "zod";

/** One OAuth provider's registry row (design §4 `secrets.oauth.<name>`). */
export const OAuthProviderConfigSchema = z.object({
  authorizeUrl: z.string().url(),
  tokenUrl: z.string().url(),
  clientId: z.string(),
  pkce: z.boolean().default(true),
  scopes: z.array(z.string()),
  actor: z.enum(["user"]).default("user"),
  redirect: z.string().url(),
  /** How the resolved access token is presented. `{token}` is substituted. */
  header: z.string().default("Bearer {token}"),
});
export type OAuthProviderConfig = z.infer<typeof OAuthProviderConfigSchema>;

/** Ported default `linear` row (design §3.2). client_id is PUBLIC + committable;
 *  LINEAR_CLIENT_ID env overrides it in the manager (config stays declarative). */
export const DEFAULT_OAUTH_PROVIDERS = {
  linear: {
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    clientId: "c22fe7e6dfa9be091c5ea19f6121307f",
    pkce: true,
    scopes: ["read", "write", "issues:create"],
    actor: "user",
    redirect: "http://localhost:14881/oauth/callback",
    header: "Bearer {token}",
  },
} as const;
