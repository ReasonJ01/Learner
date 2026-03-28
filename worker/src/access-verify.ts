import * as jose from "jose"

/** Header Cloudflare Access adds after a user passes the Access login. */
export const CF_ACCESS_JWT_HEADER = "cf-access-jwt-assertion"

/**
 * When `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` are unset, returns `null` (verification skipped — normal for `wrangler dev`).
 * When set, returns a 401 `Response` if the JWT is missing or invalid; otherwise `null` (allow).
 */
export async function enforceCloudflareAccess(
  request: Request,
  env: { ACCESS_AUD?: string; ACCESS_TEAM_DOMAIN?: string },
): Promise<Response | null> {
  const aud = env.ACCESS_AUD?.trim()
  const team = env.ACCESS_TEAM_DOMAIN?.trim()?.replace(/^https?:\/\//i, "").replace(/\/$/, "")
  if (!aud || !team) return null

  const token = request.headers.get(CF_ACCESS_JWT_HEADER)
  if (!token) {
    return new Response("Unauthorized", { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" } })
  }

  try {
    const issuer = `https://${team}`
    const JWKS = jose.createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))
    await jose.jwtVerify(token, JWKS, {
      issuer,
      audience: aud,
      clockTolerance: 60,
    })
    return null
  } catch {
    return new Response("Unauthorized", { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" } })
  }
}
