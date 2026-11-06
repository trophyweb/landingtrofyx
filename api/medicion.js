// API de Conversiones de Meta. Recibe los eventos que manda medicion.js (solo cuando hay
// consentimiento) y los reenvía a Meta desde el servidor con el mismo event_id que el Pixel,
// para que Meta los deduplique. Los datos personales se cifran aquí con SHA-256.
// Es la misma función de trofyx.com (repo landing_trofyx_saas), con dos cambios: acepta el
// evento VerVideo y cualquier subdominio de trofyx.com (por si la landing vive en uno).
//
// Variables de entorno en Vercel (Settings → Environment Variables), las mismas de trofyx.com:
//   META_PIXEL_ID         ID del Pixel (el mismo que PIXEL_ID en medicion.js)
//   META_CAPI_TOKEN       token de Events Manager → Configuración → API de Conversiones
//   META_TEST_EVENT_CODE  opcional: código de "Probar eventos"; quitarlo al terminar las pruebas
//   META_API_VERSION      opcional: versión de la Graph API (por defecto v26.0)
const crypto = require('crypto');

const EVENTS = new Set(['PageView', 'ViewContent', 'Contact', 'ClicAgendarDemo', 'VerVideo', 'CompleteRegistration', 'InitiateCheckout']);
const ORIGINS = /^https:\/\/(([a-z0-9-]+\.)?trofyx\.com|[a-z0-9-]+\.vercel\.app)$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const sha256 = v => crypto.createHash('sha256').update(v, 'utf8').digest('hex');
const header = (req, name) => { const v = req.headers[name]; return (Array.isArray(v) ? v[0] : v) || ''; };
const lower = v => (typeof v === 'string' || typeof v === 'number') ? String(v).trim().toLowerCase() : '';

// Normalización de Meta: correo y nombres en minúscula y sin puntuación, teléfono solo
// dígitos con indicativo. external_id = sha256(minúscula(id del tenant)): el backend debe
// usar la misma fórmula al enviar Subscribe para que Meta una ambos eventos.
const userData = (req, u) => {
  const out = {
    client_ip_address: header(req, 'x-real-ip') || header(req, 'x-forwarded-for').split(',')[0].trim(),
    client_user_agent: header(req, 'user-agent')
  };
  const em = lower(u.em);
  const ph = lower(u.ph).replace(/\D/g, '');
  const fn = lower(u.fn).replace(/[\p{P}\p{S}]/gu, '');
  const ln = lower(u.ln).replace(/[\p{P}\p{S}]/gu, '');
  const externalId = lower(u.external_id);
  const country = lower(header(req, 'x-vercel-ip-country'));
  if (em) out.em = [sha256(em)];
  if (ph) out.ph = [sha256(ph)];
  if (fn) out.fn = [sha256(fn)];
  if (ln) out.ln = [sha256(ln)];
  if (externalId) out.external_id = [sha256(externalId)];
  if (/^[a-z]{2}$/.test(country)) out.country = [sha256(country)];
  if (typeof u.fbp === 'string' && u.fbp.startsWith('fb.')) out.fbp = u.fbp.slice(0, 200);
  if (typeof u.fbc === 'string' && u.fbc.startsWith('fb.')) out.fbc = u.fbc.slice(0, 500);
  Object.keys(out).forEach(k => { if (!out[k]) delete out[k]; });
  return out;
};

// Solo valores simples con nombres razonables; lo demás se descarta.
const customData = d => {
  const out = {};
  if (!d || typeof d !== 'object') return out;
  Object.entries(d).slice(0, 20).forEach(([k, v]) => {
    if (!/^[a-z_]{1,40}$/i.test(k)) return;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
  });
  return out;
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  if (!ORIGINS.test(header(req, 'origin'))) return res.status(403).end();

  const { META_PIXEL_ID: pixelId, META_CAPI_TOKEN: token } = process.env;
  if (!pixelId || !token) return res.status(204).end(); // aún sin configurar

  let body = req.body;
  if (typeof body === 'string') body = (() => { try { return JSON.parse(body); } catch (_) { return null; } })();
  if (!body || !EVENTS.has(body.event_name) || typeof body.event_id !== 'string') return res.status(400).end();

  // Meta rechaza eventos de más de 7 días o del futuro; ante la duda se usa la hora del servidor.
  const now = Math.floor(Date.now() / 1000);
  const time = Math.floor(Number(body.event_time));
  const event = {
    event_name: body.event_name,
    event_time: time > now - 7 * 86400 && time <= now + 60 ? time : now,
    event_id: body.event_id.slice(0, 100),
    action_source: 'website',
    event_source_url: typeof body.event_source_url === 'string' ? body.event_source_url.slice(0, 1000) : undefined,
    user_data: userData(req, body.user_data || {}),
    custom_data: customData(body.custom_data)
  };
  const payload = { data: [event], access_token: token };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  try {
    const r = await fetch(`https://graph.facebook.com/${process.env.META_API_VERSION || 'v26.0'}/${pixelId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      console.error('Meta CAPI', r.status, await r.text());
      return res.status(502).end();
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Meta CAPI', err);
    return res.status(502).end();
  }
};
