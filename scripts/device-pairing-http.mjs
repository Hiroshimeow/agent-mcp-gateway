function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderVerificationPage({ pairing, accountLabel, authenticated, invalidPassword = false, approved = false }) {
  if (approved) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Device approved</title></head><body><main><h1>Device approved</h1><p>${escapeHtml(pairing.deviceName)} is approved for ${escapeHtml(accountLabel)}.</p><p>You can return to the device terminal.</p></main></body></html>`;
  }
  const password = authenticated
    ? ''
    : '<label>Password <input name="password" type="password" autocomplete="current-password" autofocus></label>';
  const error = invalidPassword ? '<p role="alert">Invalid password.</p>' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve device</title></head><body><main><h1>Approve device</h1><p>Account: ${escapeHtml(accountLabel)}</p><p>Device: ${escapeHtml(pairing.deviceName)} (${escapeHtml(pairing.deviceId)})</p><p>Code: <strong>${escapeHtml(pairing.userCode)}</strong></p>${error}<form method="post" action="/device/verify"><input type="hidden" name="user_code" value="${escapeHtml(pairing.userCode)}">${password}<button type="submit">Approve</button></form></main></body></html>`;
}

function errorPayload(error, fallback = 'invalid_request') {
  const message = String(error?.message || error || fallback);
  return { error: fallback, error_description: message.slice(0, 240) };
}

export function installDevicePairingRoutes(app, {
  pairingStore,
  authProvider,
  accountLabel = 'Local Dev MCP',
  baseUrlFromRequest
}) {
  if (!app || !pairingStore || !authProvider) throw new Error('Device pairing routes require app, pairingStore, and authProvider.');
  const account = String(accountLabel || 'Local Dev MCP').trim().slice(0, 128) || 'Local Dev MCP';
  const getBaseUrl = typeof baseUrlFromRequest === 'function'
    ? baseUrlFromRequest
    : req => `${req.protocol}://${req.get('host')}`;

  app.post('/device/start', (req, res) => {
    try {
      if (String(req.body?.code_challenge_method || '') !== 'S256') {
        res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge_method must be S256.' });
        return;
      }
      const started = pairingStore.start({
        clientId: req.body?.client_id,
        deviceId: req.body?.device_id,
        deviceName: req.body?.device_name,
        publicKeyPem: req.body?.public_key_pem,
        codeChallenge: req.body?.code_challenge
      });
      const baseUrl = String(getBaseUrl(req) || '').replace(/\/+$/, '');
      const verificationUri = `${baseUrl}/device/verify`;
      res.json({
        device_code: started.deviceCode,
        user_code: started.userCode,
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(started.userCode)}`,
        expires_in: started.expiresIn,
        interval: started.interval
      });
    } catch (error) {
      res.status(400).json(errorPayload(error));
    }
  });

  app.get('/device/verify', (req, res) => {
    try {
      const pairing = pairingStore.getStatusByUserCode(req.query?.user_code);
      if (pairing.status === 'expired') {
        res.status(410).type('html').send('<!doctype html><html><body><h1>Pairing code expired</h1></body></html>');
        return;
      }
      res.status(200).type('html').send(renderVerificationPage({
        pairing,
        accountLabel: account,
        authenticated: authProvider.hasRequestSession(req)
      }));
    } catch (error) {
      res.status(404).type('html').send(`<!doctype html><html><body><h1>Invalid pairing code</h1><p>${escapeHtml(error?.message || error)}</p></body></html>`);
    }
  });

  app.post('/device/verify', (req, res) => {
    try {
      const pairing = pairingStore.getStatusByUserCode(req.body?.user_code);
      let authenticated = authProvider.hasRequestSession(req);
      if (!authenticated) authenticated = authProvider.authenticateHumanPassword(req.body?.password, res);
      if (!authenticated) {
        res.status(200).type('html').send(renderVerificationPage({
          pairing,
          accountLabel: account,
          authenticated: false,
          invalidPassword: true
        }));
        return;
      }
      const approvedPairing = pairingStore.approve({ userCode: pairing.userCode, accountLabel: account });
      res.status(200).type('html').send(renderVerificationPage({
        pairing: approvedPairing,
        accountLabel: account,
        authenticated: true,
        approved: true
      }));
    } catch (error) {
      res.status(400).type('html').send(`<!doctype html><html><body><h1>Pairing failed</h1><p>${escapeHtml(error?.message || error)}</p></body></html>`);
    }
  });

  app.post('/device/poll', (req, res) => {
    try {
      const result = pairingStore.poll({
        deviceCode: req.body?.device_code,
        clientId: req.body?.client_id,
        codeVerifier: req.body?.code_verifier
      });
      if (result.status === 'authorization_pending') {
        res.status(400).json({ error: 'authorization_pending' });
        return;
      }
      res.json({
        enrollment_grant: result.enrollmentGrant,
        device_id: result.deviceId,
        account: result.account
      });
    } catch (error) {
      res.status(400).json(errorPayload(error, 'invalid_grant'));
    }
  });
}
