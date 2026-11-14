/*
 * Medición de la landing de Trofyx: Meta Pixel + API de Conversiones, con consentimiento de cookies.
 * Basado en medicion.js de trofyx.com (mismo Pixel, mismo endpoint, mismas reglas).
 *
 * - El Pixel NO se carga hasta que el visitante acepta las cookies (Ley 1581 de 2012).
 *   Mientras decide, los eventos esperan en cola; si rechaza, se descartan.
 * - Cada evento sale dos veces con el mismo event_id: desde el navegador (fbq) y desde el
 *   servidor (api/medicion.js → API de Conversiones). Meta los deduplica.
 * - Cada evento lleva lp = versión de la landing (a | b | en | …), para comparar en Meta.
 *   La versión sale de <html data-lp="…"> o del parámetro ?lp= (el checkout lo recibe así).
 * - <html data-tfx-banner="scroll"> muestra el aviso de cookies al primer scroll o toque,
 *   para no tapar el botón del hero en el celular. Sin ese atributo sale al cargar.
 *
 * Desde las páginas: window.tfxPixel.track('Evento', datosDelEvento, datosDelUsuario)
 * Cualquier elemento con el atributo data-tfx-cookies reabre el aviso de cookies.
 */
(() => {
  const PIXEL_ID = '4468700866724507'; // el mismo Pixel de trofyx.com
  const ENDPOINT = '/api/medicion';
  const PRIVACY_URL = 'https://trofyx.com/privacidad.html#cookies';
  const CONSENT_KEY = 'tfx_consent'; // 'granted' | 'denied'
  const FBC_KEY = 'tfx_fbc';
  const STANDARD = new Set(['AddPaymentInfo', 'AddToCart', 'AddToWishlist', 'CompleteRegistration', 'Contact', 'CustomizeProduct', 'Donate', 'FindLocation', 'InitiateCheckout', 'Lead', 'PageView', 'Purchase', 'Schedule', 'Search', 'StartTrial', 'SubmitApplication', 'Subscribe', 'ViewContent']);

  const safe = fn => { try { return fn(); } catch (_) { return null; } };
  const onReady = fn => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn();
  const root = document.documentElement;
  const params = safe(() => new URLSearchParams(location.search)) || new URLSearchParams();
  const LP = (root.dataset.lp || params.get('lp') || '').slice(0, 10);
  let consent = safe(() => localStorage.getItem(CONSENT_KEY));

  // ---- Cookies _fbp / _fbc ----
  // Si la landing vive en un subdominio de trofyx.com, van en el dominio raíz (.trofyx.com)
  // para compartirlas con forms.trofyx.com y app.trofyx.com.
  const cookieDomain = /(^|\.)trofyx\.com$/.test(location.hostname) ? '; domain=.trofyx.com' : '';
  const getCookie = name => (document.cookie.match('(?:^|; )' + name + '=([^;]*)') || [])[1] || '';
  const setCookie = (name, value) => {
    document.cookie = name + '=' + value + '; max-age=7776000; path=/; SameSite=Lax' + cookieDomain + (location.protocol === 'https:' ? '; Secure' : '');
  };
  const deleteCookie = name => { document.cookie = name + '=; max-age=0; path=/' + cookieDomain; };

  // El fbclid del anuncio llega solo en la primera URL; se guarda en la pestaña para armar
  // _fbc cuando haya consentimiento, aunque el visitante acepte en otra página.
  const fbclid = params.get('fbclid');
  if (fbclid) safe(() => sessionStorage.setItem(FBC_KEY, 'fb.1.' + Date.now() + '.' + fbclid));
  const clickIdOf = fbc => fbc.split('.').slice(3).join('.');

  // Se crean antes de cargar el Pixel para que el primer evento del servidor ya las lleve;
  // el Pixel reutiliza las que encuentra.
  const ensureCookies = () => {
    if (!getCookie('_fbp')) setCookie('_fbp', 'fb.1.' + Date.now() + '.' + Math.floor(Math.random() * 1e10));
    const savedFbc = safe(() => sessionStorage.getItem(FBC_KEY));
    if (savedFbc && clickIdOf(getCookie('_fbc')) !== clickIdOf(savedFbc)) setCookie('_fbc', savedFbc);
  };

  // ---- Pixel ----
  let loaded = false, matched = false;
  const loadPixel = () => {
    if (loaded) return;
    loaded = true;
    // Código base oficial de Meta.
    (function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', PIXEL_ID);
  };

  // Coincidencia avanzada: correo, teléfono (con indicativo) y nombres; el Pixel los cifra.
  const pixelUser = u => {
    const out = {};
    ['em', 'ph', 'fn', 'ln'].forEach(k => { if (u[k]) out[k] = String(u[k]).trim().toLowerCase(); });
    if (out.ph) out.ph = out.ph.replace(/\D/g, '');
    return out;
  };

  const send = ev => {
    if (ev.user && !matched) {
      // El Pixel solo acepta datos de usuario en el primer re-init que los trae
      // (los siguientes los ignora como "Duplicate Pixel ID"), por eso va una sola vez.
      matched = true;
      fbq('init', PIXEL_ID, pixelUser(ev.user));
    }
    fbq(STANDARD.has(ev.name) ? 'track' : 'trackCustom', ev.name, ev.data, { eventID: ev.id });
    fetch(ENDPOINT, {
      method: 'POST',
      keepalive: true, // sobrevive a la redirección (p. ej. al checkout de Mercado Pago)
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_name: ev.name,
        event_id: ev.id,
        event_time: ev.time,
        event_source_url: ev.url,
        custom_data: ev.data,
        user_data: { ...ev.user, fbp: getCookie('_fbp'), fbc: getCookie('_fbc') }
      })
    }).catch(() => {});
  };

  const queue = [];
  const newId = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  const track = (name, data, user) => {
    if (!PIXEL_ID || consent === 'denied') return;
    const d = { ...(data || {}) };
    if (LP && !d.lp) d.lp = LP;
    const ev = { name, data: d, user: user || null, id: newId(), time: Math.floor(Date.now() / 1000), url: location.href };
    if (consent === 'granted') send(ev); else queue.push(ev);
  };

  // ---- Consentimiento ----
  const decide = value => {
    consent = value;
    safe(() => localStorage.setItem(CONSENT_KEY, value));
    if (banner) banner.hidden = true;
    if (value === 'granted') {
      ensureCookies();
      loadPixel();
      fbq('consent', 'grant');
      queue.splice(0).forEach(send);
    } else {
      queue.length = 0;
      if (loaded) fbq('consent', 'revoke');
      deleteCookie('_fbp');
      deleteCookie('_fbc');
    }
  };

  let banner;
  const showBanner = () => {
    if (banner) { banner.hidden = false; return; }
    const css = document.createElement('style');
    css.textContent = [
      '.tfx-ck{position:fixed;left:16px;bottom:16px;z-index:2147483000;box-sizing:border-box;width:calc(100% - 32px);max-width:420px;padding:14px 16px;border-radius:14px;background:#150132;color:#fff;border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 40px -12px rgba(21,1,50,.6);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;text-align:left}',
      '.tfx-ck[hidden]{display:none}',
      '.tfx-ck p{margin:0 0 10px;color:#E4E1EC}',
      '.tfx-ck a{color:#C299FF;text-decoration:underline}',
      '.tfx-ck-btns{display:flex;gap:8px}',
      '.tfx-ck button{flex:1 1 0;min-height:40px;padding:0 16px;border-radius:999px;font:inherit;font-weight:700;cursor:pointer;border:1.5px solid rgba(255,255,255,.4);background:transparent;color:#fff}',
      '.tfx-ck button[data-v="granted"]{background:#7B26FA;border-color:#7B26FA}',
      '.tfx-ck button:focus-visible{outline:2px solid #C299FF;outline-offset:2px}',
      '@media (max-width:480px){.tfx-ck{left:8px;bottom:8px;width:calc(100% - 16px);padding:12px 14px;font-size:13px}.tfx-ck p{margin-bottom:8px}.tfx-ck button{min-height:36px}}'
    ].join('');
    banner = document.createElement('div');
    banner.className = 'tfx-ck';
    banner.setAttribute('role', 'region');
    // En inglés en las páginas con <html lang="en"> (en.html y checkout-en.html).
    const T = /^en\b/i.test(root.lang || '')
      ? { label: 'Cookie notice', text: 'We use cookies and the Meta Pixel to measure visits and show you relevant Trofyx ads. Do you allow it? You can change this anytime.', privacy: 'Privacy policy (in Spanish)', deny: 'Decline', accept: 'Accept' }
      : { label: 'Aviso de cookies', text: 'Usamos cookies y el Pixel de Meta para medir las visitas y mostrarte anuncios relevantes de Trofyx. ¿Nos autorizas? Puedes cambiarlo cuando quieras.', privacy: 'Política de privacidad', deny: 'Rechazar', accept: 'Aceptar' };
    banner.setAttribute('aria-label', T.label);
    banner.innerHTML = '<p>' + T.text + ' <a href="' + PRIVACY_URL + '" target="_blank" rel="noopener">' + T.privacy + '</a></p>'
      + '<div class="tfx-ck-btns"><button type="button" data-v="denied">' + T.deny + '</button><button type="button" data-v="granted">' + T.accept + '</button></div>';
    banner.addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) decide(b.dataset.v); });
    document.head.appendChild(css);
    document.body.appendChild(banner);
  };

  // ---- Eventos automáticos ----
  // Dispara un evento la primera vez que una sección llega a la mitad de la pantalla.
  // Se busca en cada scroll (no con IntersectionObserver) porque los planes se vuelven a
  // pintar al cambiar de pestaña y un nodo observado al inicio puede dejar de existir.
  const onView = (selector, name, data) => {
    let pending = false;
    const check = () => {
      pending = false;
      const el = document.querySelector(selector);
      if (!el || el.getBoundingClientRect().top > innerHeight / 2) return;
      removeEventListener('scroll', onScroll);
      track(name, data);
    };
    const onScroll = () => { if (!pending) { pending = true; requestAnimationFrame(check); } };
    addEventListener('scroll', onScroll, { passive: true });
  };

  // Clics: WhatsApp = Contact · agendar la sesión (forms.trofyx.com) = ClicAgendarDemo ·
  // reproducir un video (VSL o testimonio) = VerVideo, para crear audiencias de retargeting.
  document.addEventListener('click', e => {
    const el = e.target.closest && e.target.closest('[data-tfx-cookies], [data-video], a[href]');
    if (!el) return;
    if (el.hasAttribute('data-tfx-cookies')) { e.preventDefault(); if (PIXEL_ID) showBanner(); return; }
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (el.hasAttribute('data-video')) {
      if (!el.dataset.tfxSeen) { el.dataset.tfxSeen = '1'; track('VerVideo', { content_name: label || el.getAttribute('data-video') }); }
      return;
    }
    const url = safe(() => new URL(el.href, location.href));
    if (!url) return;
    if (/(^|\.)(wa\.me|whatsapp\.com)$/.test(url.hostname)) track('Contact', { content_name: 'WhatsApp', cta: label });
    else if (url.hostname === 'forms.trofyx.com') track('ClicAgendarDemo', { content_name: label || 'Agenda tu sesión' });
  }, true);

  window.tfxPixel = { track, showBanner };

  if (!PIXEL_ID) return;
  if (consent === 'granted') { ensureCookies(); loadPixel(); }
  track('PageView');
  onReady(() => {
    if (!consent) {
      if (root.dataset.tfxBanner === 'scroll') {
        const first = () => { ['scroll', 'pointerdown', 'keydown'].forEach(t => removeEventListener(t, first)); showBanner(); };
        ['scroll', 'pointerdown', 'keydown'].forEach(t => addEventListener(t, first, { passive: true }));
      } else {
        showBanner();
      }
    }
    onView('#sesion, #oferta', 'ViewContent', { content_name: 'Oferta', content_category: 'SaaS' });
    onView('#precios', 'ViewContent', { content_name: 'Precios', content_category: 'SaaS' });
  });
})();
