import { escapeHtml, pageShell, quickGuide } from './enduser-ui.mjs';

function renderVerificationPage({ pairing, account, approved = false }) {
  if (approved) {
    return pageShell({ title: 'Device approved', body: `<section class="card"><h1>Device approved</h1><p><strong>${escapeHtml(pairing.deviceName)}</strong> is approved for ${escapeHtml(account.email)}.</p><p class="muted">Return to the device terminal. It can now finish enrollment.</p><div class="actions"><a class="button" href="/dashboard">Dashboard</a><a href="/pair">Pair another device</a></div></section>` });
  }
  return pageShell({ title: 'Approve device', body: `<section class="card"><h1>Approve device</h1><p class="muted">Confirm that this is the device you intended to pair.</p><p>Account: <strong>${escapeHtml(account.email)}</strong></p><p>Device: <strong>${escapeHtml(pairing.deviceName)}</strong><br><span class="muted">${escapeHtml(pairing.deviceId)}</span></p><p>Code: <strong>${escapeHtml(pairing.userCode)}</strong></p><form method="post" action="/device/verify"><input type="hidden" name="user_code" value="${escapeHtml(pairing.userCode)}"><button class="primary" type="submit">Approve device</button></form></section>` });
}

function pairingStatePage(title, message, { status = 200, baseUrl = '' } = {}) {
  return { status, html: pageShell({ title, body: `<section class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><div class="actions"><a class="button primary" href="/pair">Enter a code</a><a href="/help">Pairing help</a></div></section>${quickGuide(baseUrl)}` }) };
}

function errorPayload(error, fallback = 'invalid_request') {
  const message = String(error?.message || error || fallback);
  return { error: fallback, error_description: message.slice(0, 240) };
}

function verificationReturnTo(_req, userCode) {
  const code = encodeURIComponent(String(userCode || '').trim());
  return `/device/verify?user_code=${code}`;
}

export function installDevicePairingRoutes(app, { pairingStore, accountFromRequest, baseUrlFromRequest }) {
  if (!app || !pairingStore || typeof accountFromRequest !== 'function') {
    throw new Error('Device pairing routes require app, pairingStore, and accountFromRequest.');
  }
  const getBaseUrl = typeof baseUrlFromRequest === 'function' ? baseUrlFromRequest : req => `${req.protocol}://${req.get('host')}`;

  app.get('/pair', (req, res) => {
    const baseUrl = String(getBaseUrl(req) || '').replace(/\/+$/, '');
    res.status(200).type('html').send(pageShell({ title: 'Pair a device', body: `<section class="card"><h1>Pair a device</h1><p class="muted">Start pairing on your device, then enter the code it shows.</p><form class="inline" method="get" action="/device/verify"><input name="user_code" autocomplete="one-time-code" placeholder="ABCD-EFGH" maxlength="9" required><button class="primary" type="submit">Continue</button></form></section>${quickGuide(baseUrl)}` }));
  });

  app.get('/help', (req, res) => {
    const baseUrl = String(getBaseUrl(req) || '').replace(/\/+$/, '');
    res.status(200).type('html').send(pageShell({ title: 'Help', body: `<section class="card"><h1>Device setup</h1><p>Point the device CLI at this gateway, sign in, approve the browser pairing code, then install the background service.</p><p class="muted">If a code expires, restart <code>mcp-device login</code> to get a new one.</p></section>${quickGuide(baseUrl)}` }));
  });

  app.post('/device/start', (req, res) => {
    try {
      if (String(req.body?.code_challenge_method || '') !== 'S256') {
        res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge_method must be S256.' });
        return;
      }
      const started = pairingStore.start({ clientId: req.body?.client_id, deviceId: req.body?.device_id, deviceName: req.body?.device_name, publicKeyPem: req.body?.public_key_pem, codeChallenge: req.body?.code_challenge });
      const baseUrl = String(getBaseUrl(req) || '').replace(/\/+$/, '');
      const verificationUri = `${baseUrl}/device/verify`;
      res.json({ device_code: started.deviceCode, user_code: started.userCode, verification_uri: verificationUri, verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(started.userCode)}`, expires_in: started.expiresIn, interval: started.interval });
    } catch (error) {
      res.status(400).json(errorPayload(error));
    }
  });

  app.get('/device/verify', (req, res) => {
    const rawCode = String(req.query?.user_code || '').trim();
    const baseUrl = String(getBaseUrl(req) || '').replace(/\/+$/, '');
    if (!rawCode) {
      const state = pairingStatePage('Enter the code from your device', 'Start pairing on your device first, then enter the code shown in its terminal.', { baseUrl });
      res.status(state.status).type('html').send(state.html);
      return;
    }
    try {
      const pairing = pairingStore.getStatusByUserCode(rawCode);
      if (pairing.status === 'expired') {
        const state = pairingStatePage('Pairing code expired', 'Restart device login to create a fresh pairing code.', { status: 410, baseUrl });
        res.status(state.status).type('html').send(state.html);
        return;
      }
      const account = accountFromRequest(req);
      if (!account) {
        res.redirect(302, `/login?return_to=${encodeURIComponent(verificationReturnTo(req, pairing.userCode))}`);
        return;
      }
      res.status(200).type('html').send(renderVerificationPage({ pairing, account }));
    } catch {
      const state = pairingStatePage('Invalid pairing code', 'Check the code and try again, or restart device login to create a new code.', { status: 404, baseUrl });
      res.status(state.status).type('html').send(state.html);
    }
  });

  app.post('/device/verify', (req, res) => {
    try {
      const pairing = pairingStore.getStatusByUserCode(req.body?.user_code);
      const account = accountFromRequest(req);
      if (!account) {
        res.redirect(302, `/login?return_to=${encodeURIComponent(verificationReturnTo(req, pairing.userCode))}`);
        return;
      }
      const approvedPairing = pairingStore.approve({ userCode: pairing.userCode, accountId: account.accountId, accountLabel: account.email });
      res.status(200).type('html').send(renderVerificationPage({ pairing: approvedPairing, account, approved: true }));
    } catch (error) {
      res.status(400).type('html').send(pageShell({ title: 'Pairing failed', body: `<section class="card"><h1>Pairing failed</h1><p>${escapeHtml(error?.message || error)}</p><a href="/pair">Try again</a></section>` }));
    }
  });

  app.post('/device/poll', (req, res) => {
    try {
      const result = pairingStore.poll({ deviceCode: req.body?.device_code, clientId: req.body?.client_id, codeVerifier: req.body?.code_verifier });
      if (result.status === 'authorization_pending') {
        res.status(400).json({ error: 'authorization_pending' });
        return;
      }
      res.json({ enrollment_grant: result.enrollmentGrant, device_id: result.deviceId, account: result.account });
    } catch (error) {
      res.status(400).json(errorPayload(error, 'invalid_grant'));
    }
  });
}
