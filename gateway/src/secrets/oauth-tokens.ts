/**
 * OAuth token schemas (plan §2 C1).
 *
 * `OAuthTokensSchema` MUST match the on-disk shape of `~/.claude-oauth/<provider>.json`
 * byte-for-byte so tokens written by the marketplace core-plugin's
 * `@praetorian/claude-tool-sdk` interop with the gateway and vice-versa. Source of
 * truth for the field names + optionality: `tools/claude-tool-sdk/src/oauth-manager.ts:36-46`.
 * This copy is INTENTIONAL (the gateway must not import the SDK); T1 pins the exact shape.
 */
import { z } from "zod";

/** On-disk OAuth token record. Field names + optionality MUST match the SDK's
 *  ~/.claude-oauth/<provider>.json so tokens interop with the core-plugin. */
export const OAuthTokensSchema = z.object({
  provider: z.string(),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number(), // ms epoch
  scopes: z.array(z.string()),
  createdAt: z.number(), // ms epoch
  lastRefreshedAt: z.number().optional(),
});
export type OAuthTokens = z.infer<typeof OAuthTokensSchema>;

/** Provider token-endpoint response (snake_case wire form). */
export const OAuthTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(), // seconds
});
export type OAuthTokenResponse = z.infer<typeof OAuthTokenResponseSchema>;
