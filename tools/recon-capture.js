/**
 * Fase 0 — captura de fixture.
 *
 * Cole no console do DevTools, NA PÁGINA JÁ ABERTA E LOGADA. Ele só lê o DOM que o
 * seu navegador já baixou: não faz requisição, não clica em nada, não toca em cookie.
 * O resultado é baixado como arquivo para você salvar em tests/fixtures/.
 *
 *   __gcRecon()            -> baixa o HTML da página + um relatório de pistas
 *   __gcRecon('lobby')     -> mesma coisa, nomeando o fixture
 *
 * Para capturar JSON interno: aba Network -> filtro Fetch/XHR -> botão direito na
 * requisição -> "Copy response" -> salvar à mão em tests/fixtures/<nome>.json.
 */
(function () {
  function collectPlayerLinks() {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/jogador/"], a[href*="/player/"]')) {
      const m = a.getAttribute('href').match(/\/(?:jogador|player)\/(\d+)/);
      if (!m) continue;
      out.push({
        gcId: Number(m[1]),
        text: a.textContent.trim().slice(0, 40),
        selector: cssPath(a),
      });
    }
    return out;
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`${part}#${node.id}`);
        break;
      }
      const cls = (node.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 3);
      if (cls.length) part += '.' + cls.join('.');
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function collectMatchLinks() {
    const ids = new Set();
    for (const a of document.querySelectorAll('a[href*="/partida/"], a[href*="/match/"]')) {
      const m = a.getAttribute('href').match(/\/(?:partida|match)\/([\w-]+)/);
      if (m) ids.add(m[1]);
    }
    return [...ids];
  }

  function collectDataAttrs() {
    const seen = new Map();
    for (const el of document.querySelectorAll('*')) {
      for (const name of el.getAttributeNames()) {
        if (!name.startsWith('data-')) continue;
        if (!seen.has(name)) seen.set(name, el.getAttribute(name));
      }
    }
    return Object.fromEntries(seen);
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.__gcRecon = function (label) {
    const name = (label || location.pathname.replace(/[^\w-]+/g, '-')).replace(/^-|-$/g, '');
    const stamp = new Date().toISOString().slice(0, 10);
    const report = {
      capturedAt: new Date().toISOString(),
      url: location.href,
      title: document.title,
      playerLinks: collectPlayerLinks(),
      matchLinks: collectMatchLinks(),
      dataAttributes: collectDataAttrs(),
      hasNextData: Boolean(document.getElementById('__NEXT_DATA__')),
      scriptJsonBlocks: [...document.querySelectorAll('script[type="application/json"]')].map(
        (s) => ({ id: s.id, bytes: s.textContent.length }),
      ),
    };
    console.log('[recon]', report);
    download(`${name}-${stamp}.html`, document.documentElement.outerHTML, 'text/html');
    download(`${name}-${stamp}.recon.json`, JSON.stringify(report, null, 2), 'application/json');
    return report;
  };

  console.log('recon pronto. rode: __gcRecon("match") | __gcRecon("lobby") | __gcRecon("my-matches")');
})();
