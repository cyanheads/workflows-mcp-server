/**
 * @fileoverview MCP Authentication Middleware for Bearer Token Validation (JWT) for Hono.
 *
 * This middleware validates JSON Web Tokens (JWT) passed via the 'Authorization' header
 * using the 'Bearer' scheme (e.g., "Authorization: Bearer <your_token>").
 * It verifies the token's signature and expiration using the secret key defined
 * in the configuration (`config.mcpAuthSecretKey`).
 *
 * If the token is valid, an object conforming to the MCP SDK's `AuthInfo` type
 * is attached to `c.env.incoming.auth`. This direct attachment to the raw Node.js
 * request object is for compatibility with the underlying SDK transport, which is
 * not Hono-context-aware.
 * If the token is missing, invalid, or expired, it returns an HTTP 401 Unauthorized response.
 *
 * @see {@link https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/authorization.mdx | MCP Authorization Specification}
 * @module src/mcp-server/transports/authentication/authMiddleware
 */

import { HttpBindings } from '@hono/node-server';
import { Context, Next } from 'hono';
import { jwtVerify, errors as joseErrors } from 'jose';
import { config, environment } from '../../../config/index.js';
import { logger, requestContextService } from '../../../utils/index.js';
import { authContext } from './authContext.js';

// --- Startup Validation & Key Preparation ---
let secretKey: Uint8Array | undefined;

if (environment === 'production' && !config.mcpAuthSecretKey) {
  logger.fatal(
    'CRITICAL: MCP_AUTH_SECRET_KEY is not set in production environment. Authentication cannot proceed securely.',
  );
  throw new Error(
    'MCP_AUTH_SECRET_KEY must be set in production environment for JWT authentication.',
  );
} else if (config.mcpAuthSecretKey) {
  secretKey = new TextEncoder().encode(config.mcpAuthSecretKey);
} else {
  logger.warning(
    'MCP_AUTH_SECRET_KEY is not set. Authentication middleware will bypass checks (DEVELOPMENT ONLY). This is insecure for production.',
  );
}

/**
 * Hono middleware for verifying JWT Bearer token authentication.
 * It attaches authentication info to `c.env.incoming.auth` for SDK compatibility with the node server.
 */
export async function mcpAuthMiddleware(
  c: Context<{ Bindings: HttpBindings }>,
  next: Next,
) {
  const context = requestContextService.createRequestContext({
    operation: 'mcpAuthMiddleware',
    method: c.req.method,
    path: c.req.path,
  });
  logger.debug(
    'Running MCP Authentication Middleware (Bearer Token Validation)...',
    context,
  );

  const reqWithAuth = c.env.incoming;

  // Development Mode Bypass
  if (!secretKey) {
    if (environment !== 'production') {
      logger.warning(
        'Bypassing JWT authentication: MCP_AUTH_SECRET_KEY is not set (DEVELOPMENT ONLY).',
        context,
      );
      reqWithAuth.auth = {
        token: 'dev-mode-placeholder-token',
        clientId: 'dev-client-id',
        scopes: ['dev-scope'],
      };
      const authInfo = reqWithAuth.auth;
      logger.debug('Dev mode auth object created.', {
        ...context,
        authDetails: authInfo,
      });
      return await authContext.run({ authInfo }, next);
    } else {
      // This case is already handled by the startup validation, but serves as a runtime safeguard.
      logger.error(
        'FATAL: MCP_AUTH_SECRET_KEY is missing in production. Cannot bypass auth.',
        context,
      );
      return c.json(
        { error: 'Server configuration error: Authentication key missing.' },
        500,
      );
    }
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warning(
      'Authentication failed: Missing or malformed Authorization header (Bearer scheme required).',
      context,
    );
    return c.json(
      {
        error: 'Unauthorized: Missing or invalid authentication token format.',
      },
      401,
    );
  }

  const rawToken = authHeader.substring(7);

  try {
    const { payload: decoded } = await jwtVerify(rawToken, secretKey);

    const clientIdFromToken =
      typeof decoded.cid === 'string'
        ? decoded.cid
        : typeof decoded.client_id === 'string'
          ? decoded.client_id
          : undefined;
    if (!clientIdFromToken) {
      logger.warning(
        "Authentication failed: JWT 'cid' or 'client_id' claim is missing or not a string.",
        { ...context, jwtPayloadKeys: Object.keys(decoded) },
      );
      return c.json(
        { error: 'Unauthorized: Invalid token, missing client identifier.' },
        401,
      );
    }

    let scopesFromToken: string[] = [];
    if (
      Array.isArray(decoded.scp) &&
      decoded.scp.every(s => typeof s === 'string')
    ) {
      scopesFromToken = decoded.scp as string[];
    } else if (
      typeof decoded.scope === 'string' &&
      decoded.scope.trim() !== ''
    ) {
      scopesFromToken = decoded.scope.split(' ').filter(s => s);
    }

    if (scopesFromToken.length === 0) {
      logger.warning(
        'Authentication failed: Token resulted in an empty scope array, and scopes are required.',
        { ...context, jwtPayloadKeys: Object.keys(decoded) },
      );
      return c.json(
        { error: 'Unauthorized: Token must contain valid, non-empty scopes.' },
        401,
      );
    }

    reqWithAuth.auth = {
      token: rawToken,
      clientId: clientIdFromToken,
      scopes: scopesFromToken,
    };

    const subClaimForLogging =
      typeof decoded.sub === 'string' ? decoded.sub : undefined;
    const authInfo = reqWithAuth.auth;
    logger.debug('JWT verified successfully. AuthInfo attached to request.', {
      ...context,
      mcpSessionIdContext: subClaimForLogging,
      clientId: authInfo.clientId,
      scopes: authInfo.scopes,
    });
    await authContext.run({ authInfo }, next);
  } catch (error: unknown) {
    let errorMessage = 'Invalid token';
    if (error instanceof joseErrors.JWTExpired) {
      errorMessage = `Token expired at ${error.payload.exp}`;
      logger.warning(`Authentication failed: ${errorMessage}`, {
        ...context,
        expiredAt: error.payload.exp,
      });
    } else if (error instanceof joseErrors.JWSInvalid) {
      errorMessage = `Invalid token signature: ${error.code}`;
      logger.warning(`Authentication failed: ${errorMessage}`, { ...context });
    } else if (error instanceof joseErrors.JWTClaimValidationFailed) {
        errorMessage = `Token claim validation failed: ${error.message}`;
        logger.warning(`Authentication failed: ${errorMessage}`, { ...context, claim: error.claim, reason: error.reason });
    } else if (error instanceof Error) {
      errorMessage = `Verification error: ${error.message}`;
      logger.error(
        'Authentication failed: Unexpected error during token verification.',
        { ...context, error: error.message },
      );
    } else {
      errorMessage = 'Unknown verification error';
      logger.error(
        'Authentication failed: Unexpected non-error exception during token verification.',
        { ...context, error },
      );
    }
    return c.json({ error: `Unauthorized: ${errorMessage}.` }, 401);
  }
}
