import crypto from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  OAuthClientMetadataSchema,
  OAuthTokenRevocationRequestSchema
} from '@modelcontextprotocol/core';
import { mcpAuthMetadataRouter } from '@modelcontextprotocol/express';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';

const DEFAULT_CLIENT_SECRET_EXPIRY_SECONDS = 30 * 24 * 60 * 60;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const OAUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

function oauthError(code, message, errorUri) {
  return new OAuthError(code, message, errorUri);
}

function oauthErrorStatus(error) {
  if (!(error instanceof OAuthError)) return 500;
  if (error.code === OAuthErrorCode.ServerError) return 500;
  if (error.code === OAuthErrorCode.TemporarilyUnavailable) return 503;
  if (error.code === OAuthErrorCode.TooManyRequests) return 429;
  return 400;
}

function sendOAuthError(res, error) {
  const normalized = error instanceof OAuthError
    ? error
    : oauthError(OAuthErrorCode.ServerError, 'Internal Server Error');
  res.status(oauthErrorStatus(normalized)).json(normalized.toResponseObject());
}

function allowedMethods(allowed) {
  return (req, res, next) => {
    if (allowed.includes(req.method)) {
      next();
      return;
    }

    const error = oauthError(
      OAuthErrorCode.MethodNotAllowed,
      `The method ${req.method} is not allowed for this endpoint`
    );
    res.status(405).set('Allow', allowed.join(', ')).json(error.toResponseObject());
  };
}

function asString(value, name, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    throw oauthError(OAuthErrorCode.InvalidRequest, `${name} is required`);
  }
  if (typeof value !== 'string') {
    throw oauthError(OAuthErrorCode.InvalidRequest, `${name} must be a string`);
  }
  return value;
}

function asOptionalUrl(value, name) {
  const text = asString(value, name, { optional: true });
  if (text === undefined) return undefined;
  try {
    return new URL(text);
  } catch {
    throw oauthError(OAuthErrorCode.InvalidRequest, `${name} must be a valid URL`);
  }
}

function requestParams(req) {
  return req.method === 'POST' ? req.body : req.query;
}

export function redirectUriMatches(requested, registered) {
  if (requested === registered) return true;

  let reqUrl;
  let registeredUrl;
  try {
    reqUrl = new URL(requested);
    registeredUrl = new URL(registered);
  } catch {
    return false;
  }

  if (!LOOPBACK_HOSTS.has(reqUrl.hostname) || !LOOPBACK_HOSTS.has(registeredUrl.hostname)) {
    return false;
  }

  return reqUrl.protocol === registeredUrl.protocol
    && reqUrl.hostname === registeredUrl.hostname
    && reqUrl.pathname === registeredUrl.pathname
    && reqUrl.search === registeredUrl.search;
}

function addIssuerToCallback(res, redirectUri, issuer) {
  const callback = new URL(redirectUri);
  const originalRedirect = res.redirect.bind(res);

  const withIssuer = value => {
    let target;
    try {
      target = new URL(String(value));
    } catch {
      return value;
    }

    if (
      target.origin === callback.origin
      && target.pathname === callback.pathname
      && !target.searchParams.has('iss')
    ) {
      target.searchParams.set('iss', issuer);
      return target.href;
    }

    return value;
  };

  res.redirect = (statusOrUrl, maybeUrl) => {
    if (typeof statusOrUrl === 'number') {
      return originalRedirect(statusOrUrl, withIssuer(maybeUrl));
    }
    if (typeof maybeUrl === 'number') {
      return originalRedirect(withIssuer(statusOrUrl), maybeUrl);
    }
    return originalRedirect(withIssuer(statusOrUrl));
  };

  return res;
}

function errorRedirect(redirectUri, error, state, issuer) {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error.code);
  target.searchParams.set('error_description', error.message);
  if (error.errorUri) target.searchParams.set('error_uri', error.errorUri);
  if (state) target.searchParams.set('state', state);
  if (issuer) target.searchParams.set('iss', issuer);
  return target.href;
}

function makeRateLimit({ windowMs, max, message, config }) {
  if (config === false) return null;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: oauthError(OAuthErrorCode.TooManyRequests, message).toResponseObject(),
    ...config
  });
}

function authorizationHandler({ provider, issuerUrl, rateLimit: rateLimitConfig }) {
  const issuer = issuerUrl?.href;
  const router = express.Router();
  router.use(allowedMethods(['GET', 'POST']));
  router.use(express.urlencoded({ extended: false }));

  const limiter = makeRateLimit({
    windowMs: OAUTH_RATE_LIMIT_WINDOW_MS,
    max: 100,
    message: 'You have exceeded the rate limit for authorization requests',
    config: rateLimitConfig
  });
  if (limiter) router.use(limiter);

  router.all('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    const params = requestParams(req);
    let client;
    let redirectUri;

    try {
      const clientId = asString(params.client_id, 'client_id');
      redirectUri = asString(params.redirect_uri, 'redirect_uri', { optional: true });
      client = await provider.clientsStore.getClient(clientId);

      if (!client) {
        throw oauthError(OAuthErrorCode.InvalidClient, 'Invalid client_id');
      }

      const registeredRedirects = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
      if (redirectUri !== undefined) {
        if (!registeredRedirects.some(registered => redirectUriMatches(redirectUri, registered))) {
          throw oauthError(OAuthErrorCode.InvalidRequest, 'Unregistered redirect_uri');
        }
      } else if (registeredRedirects.length === 1) {
        [redirectUri] = registeredRedirects;
      } else {
        throw oauthError(
          OAuthErrorCode.InvalidRequest,
          'redirect_uri must be specified when client has multiple registered URIs'
        );
      }
    } catch (error) {
      sendOAuthError(res, error);
      return;
    }

    let state;
    try {
      const responseType = asString(params.response_type, 'response_type');
      if (responseType !== 'code') {
        throw oauthError(
          OAuthErrorCode.UnsupportedResponseType,
          'Only response_type=code is supported'
        );
      }

      const codeChallenge = asString(params.code_challenge, 'code_challenge');
      const codeChallengeMethod = asString(params.code_challenge_method, 'code_challenge_method');
      if (codeChallengeMethod !== 'S256') {
        throw oauthError(
          OAuthErrorCode.InvalidRequest,
          'code_challenge_method must be S256'
        );
      }

      const scope = asString(params.scope, 'scope', { optional: true });
      state = asString(params.state, 'state', { optional: true });
      const resource = asOptionalUrl(params.resource, 'resource');
      const scopes = scope ? scope.split(' ').filter(Boolean) : [];

      await provider.authorize(client, {
        state,
        scopes,
        redirectUri,
        codeChallenge,
        resource,
        issuer
      }, issuer ? addIssuerToCallback(res, redirectUri, issuer) : res);
    } catch (error) {
      const normalized = error instanceof OAuthError
        ? error
        : oauthError(OAuthErrorCode.ServerError, 'Internal Server Error');
      res.redirect(302, errorRedirect(redirectUri, normalized, state, issuer));
    }
  });

  return router;
}

function safeSecretEqual(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authenticateClient({ clientsStore }) {
  return async (req, res, next) => {
    try {
      const clientId = asString(req.body?.client_id, 'client_id');
      const clientSecret = asString(req.body?.client_secret, 'client_secret', { optional: true });
      const client = await clientsStore.getClient(clientId);
      if (!client) throw oauthError(OAuthErrorCode.InvalidClient, 'Invalid client_id');

      if (client.client_secret) {
        if (!clientSecret) {
          throw oauthError(OAuthErrorCode.InvalidClient, 'Client secret is required');
        }
        if (!safeSecretEqual(clientSecret, client.client_secret)) {
          throw oauthError(OAuthErrorCode.InvalidClient, 'Invalid client_secret');
        }
        if (
          client.client_secret_expires_at
          && client.client_secret_expires_at < Math.floor(Date.now() / 1000)
        ) {
          throw oauthError(OAuthErrorCode.InvalidClient, 'Client secret has expired');
        }
      }

      req.oauthClient = client;
      next();
    } catch (error) {
      sendOAuthError(res, error);
    }
  };
}

function validPkceVerifier(value) {
  return typeof value === 'string'
    && value.length >= 43
    && value.length <= 128
    && /^[A-Za-z0-9._~-]+$/.test(value);
}

function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function pkceMatches(verifier, expectedChallenge) {
  if (!validPkceVerifier(verifier) || typeof expectedChallenge !== 'string') return false;
  return safeSecretEqual(pkceChallenge(verifier), expectedChallenge);
}

function tokenHandler({ provider, rateLimit: rateLimitConfig }) {
  const router = express.Router();
  router.use(cors());
  router.use(allowedMethods(['POST']));
  router.use(express.urlencoded({ extended: false }));

  const limiter = makeRateLimit({
    windowMs: OAUTH_RATE_LIMIT_WINDOW_MS,
    max: 50,
    message: 'You have exceeded the rate limit for token requests',
    config: rateLimitConfig
  });
  if (limiter) router.use(limiter);

  router.use(authenticateClient({ clientsStore: provider.clientsStore }));

  router.post('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    try {
      const grantType = asString(req.body?.grant_type, 'grant_type');
      const client = req.oauthClient;
      if (!client) throw oauthError(OAuthErrorCode.ServerError, 'Internal Server Error');

      if (grantType === 'authorization_code') {
        const code = asString(req.body?.code, 'code');
        const codeVerifier = asString(req.body?.code_verifier, 'code_verifier');
        const redirectUri = asString(req.body?.redirect_uri, 'redirect_uri', { optional: true });
        const resource = asOptionalUrl(req.body?.resource, 'resource');

        const expectedChallenge = await provider.challengeForAuthorizationCode(client, code);
        if (!pkceMatches(codeVerifier, expectedChallenge)) {
          throw oauthError(
            OAuthErrorCode.InvalidGrant,
            'code_verifier does not match the challenge'
          );
        }

        const tokens = await provider.exchangeAuthorizationCode(
          client,
          code,
          undefined,
          redirectUri,
          resource
        );
        res.status(200).json(tokens);
        return;
      }

      if (grantType === 'refresh_token') {
        const refreshToken = asString(req.body?.refresh_token, 'refresh_token');
        const scope = asString(req.body?.scope, 'scope', { optional: true });
        const resource = asOptionalUrl(req.body?.resource, 'resource');
        const scopes = scope ? scope.split(' ').filter(Boolean) : undefined;

        const tokens = await provider.exchangeRefreshToken(
          client,
          refreshToken,
          scopes,
          resource
        );
        res.status(200).json(tokens);
        return;
      }

      throw oauthError(
        OAuthErrorCode.UnsupportedGrantType,
        'The grant type is not supported by this authorization server.'
      );
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  return router;
}

function clientRegistrationHandler({
  clientsStore,
  clientSecretExpirySeconds = DEFAULT_CLIENT_SECRET_EXPIRY_SECONDS,
  rateLimit: rateLimitConfig,
  clientIdGeneration = true
}) {
  if (typeof clientsStore?.registerClient !== 'function') {
    throw new Error('Client registration store does not support registering clients');
  }

  const router = express.Router();
  router.use(cors());
  router.use(allowedMethods(['POST']));
  router.use(express.json());

  const limiter = makeRateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: 'You have exceeded the rate limit for client registration requests',
    config: rateLimitConfig
  });
  if (limiter) router.use(limiter);

  router.post('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    try {
      const parsed = OAuthClientMetadataSchema.safeParse(req.body);
      if (!parsed.success) {
        throw oauthError(OAuthErrorCode.InvalidClientMetadata, parsed.error.message);
      }

      const clientMetadata = parsed.data;
      const isPublicClient = clientMetadata.token_endpoint_auth_method === 'none';
      const clientIdIssuedAt = Math.floor(Date.now() / 1000);
      const secretExpiryTime = clientSecretExpirySeconds > 0
        ? clientIdIssuedAt + clientSecretExpirySeconds
        : 0;

      let clientInfo = {
        ...clientMetadata,
        client_secret: isPublicClient ? undefined : crypto.randomBytes(32).toString('hex'),
        client_secret_expires_at: isPublicClient ? undefined : secretExpiryTime
      };

      if (clientIdGeneration) {
        clientInfo = {
          ...clientInfo,
          client_id: crypto.randomUUID(),
          client_id_issued_at: clientIdIssuedAt
        };
      }

      clientInfo = await clientsStore.registerClient(clientInfo);
      res.status(201).json(clientInfo);
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  return router;
}

function revocationHandler({ provider, rateLimit: rateLimitConfig }) {
  if (typeof provider.revokeToken !== 'function') {
    throw new Error('Auth provider does not support revoking tokens');
  }

  const router = express.Router();
  router.use(cors());
  router.use(allowedMethods(['POST']));
  router.use(express.urlencoded({ extended: false }));

  const limiter = makeRateLimit({
    windowMs: OAUTH_RATE_LIMIT_WINDOW_MS,
    max: 50,
    message: 'You have exceeded the rate limit for token revocation requests',
    config: rateLimitConfig
  });
  if (limiter) router.use(limiter);

  router.use(authenticateClient({ clientsStore: provider.clientsStore }));

  router.post('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    try {
      const parsed = OAuthTokenRevocationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw oauthError(OAuthErrorCode.InvalidRequest, parsed.error.message);
      }
      await provider.revokeToken(req.oauthClient, parsed.data);
      res.status(200).json({});
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  return router;
}

function insecureIssuerAllowed(options) {
  if (options.dangerouslyAllowInsecureIssuerUrl === true) return true;
  const value = String(process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL || '').toLowerCase();
  return value === 'true' || value === '1';
}

function validateIssuerUrl(issuerUrl, options) {
  if (!(issuerUrl instanceof URL)) throw new Error('issuerUrl must be a URL');
  const allowInsecure = insecureIssuerAllowed(options);
  if (
    issuerUrl.protocol !== 'https:'
    && !LOOPBACK_HOSTS.has(issuerUrl.hostname)
    && !allowInsecure
  ) {
    throw new Error('Issuer URL must be HTTPS');
  }
  if (issuerUrl.hash) throw new Error(`Issuer URL must not have a fragment: ${issuerUrl}`);
  if (issuerUrl.search) throw new Error(`Issuer URL must not have a query string: ${issuerUrl}`);
}

export function createOAuthAuthorizationServerMetadata(options) {
  const { provider, issuerUrl } = options;
  validateIssuerUrl(issuerUrl, options);

  const baseUrl = options.baseUrl || issuerUrl;
  const registrationEndpoint = typeof provider.clientsStore?.registerClient === 'function'
    ? '/register'
    : undefined;
  const revocationEndpoint = typeof provider.revokeToken === 'function'
    ? '/revoke'
    : undefined;

  return {
    issuer: issuerUrl.href,
    service_documentation: options.serviceDocumentationUrl?.href,
    authorization_endpoint: new URL('/authorize', baseUrl).href,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint: new URL('/token', baseUrl).href,
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    scopes_supported: options.scopesSupported,
    revocation_endpoint: revocationEndpoint
      ? new URL(revocationEndpoint, baseUrl).href
      : undefined,
    revocation_endpoint_auth_methods_supported: revocationEndpoint
      ? ['client_secret_post']
      : undefined,
    registration_endpoint: registrationEndpoint
      ? new URL(registrationEndpoint, baseUrl).href
      : undefined,
    authorization_response_iss_parameter_supported:
      provider.authorizationResponseIssParameterSupported ?? true
  };
}

export function createOAuthAuthorizationServerRouter(options) {
  if (!options?.provider) throw new Error('provider is required');
  if (!(options.issuerUrl instanceof URL)) throw new Error('issuerUrl must be a URL');
  if (!(options.resourceServerUrl instanceof URL)) throw new Error('resourceServerUrl must be a URL');

  const oauthMetadata = createOAuthAuthorizationServerMetadata(options);
  const router = express.Router();

  router.use(
    new URL(oauthMetadata.authorization_endpoint).pathname,
    authorizationHandler({
      provider: options.provider,
      issuerUrl: options.issuerUrl,
      ...options.authorizationOptions
    })
  );

  router.use(
    new URL(oauthMetadata.token_endpoint).pathname,
    tokenHandler({
      provider: options.provider,
      ...options.tokenOptions
    })
  );

  router.use(mcpAuthMetadataRouter({
    oauthMetadata,
    resourceServerUrl: options.resourceServerUrl,
    serviceDocumentationUrl: options.serviceDocumentationUrl,
    scopesSupported: options.scopesSupported,
    resourceName: options.resourceName,
    dangerouslyAllowInsecureIssuerUrl: insecureIssuerAllowed(options)
  }));

  if (oauthMetadata.registration_endpoint) {
    router.use(
      new URL(oauthMetadata.registration_endpoint).pathname,
      clientRegistrationHandler({
        clientsStore: options.provider.clientsStore,
        ...options.clientRegistrationOptions
      })
    );
  }

  if (oauthMetadata.revocation_endpoint) {
    router.use(
      new URL(oauthMetadata.revocation_endpoint).pathname,
      revocationHandler({
        provider: options.provider,
        ...options.revocationOptions
      })
    );
  }

  return router;
}
