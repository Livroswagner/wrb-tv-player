export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
      "access-control-allow-headers": "Range, Content-Type, Accept, Authorization",
      "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
      "access-control-max-age": "86400",
    },
  });
}

export async function onRequestPost(context) {
  const { request } = context;

  const jsonHeaders = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
  };

  let b;
  try {
    b = await request.json();
  } catch {
    return Response.json({ error: "JSON inválido." }, { status: 400, headers: jsonHeaders });
  }

  try {
    const server = String(b.server || "").replace(/\/+$/, "");
    const u = String(b.user || "");
    const p = String(b.pass || "");
    const base = `${server}/player_api.php?username=${encodeURIComponent(u)}&password=${encodeURIComponent(p)}`;

    const userAgents = [
      "IPTVSmartersPro/1.0.0",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "VLC/3.0.18 LibVLC/3.0.18"
    ];

    async function smartFetch(url) {
      for (const ua of userAgents) {
        try {
          const r = await fetch(url, {
            redirect: "follow",
            headers: {
              "user-agent": ua,
              "accept": "application/json, text/plain, */*",
              "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
            }
          });
          if (r.ok || r.status !== 403) return r;
        } catch {
          // continuar tentando
        }
      }
      return fetch(url, {
        redirect: "follow",
        headers: { "user-agent": userAgents[0], "accept": "*/*" }
      });
    }

    async function fetchXtream(query) {
      const url = `${base}&${query}`;
      try {
        const r = await smartFetch(url);
        if (!r.ok) return [];
        return await r.json();
      } catch {
        return [];
      }
    }

    // 1. LOGIN & CATEGORIAS RÁPIDAS
    if (b.action === "login") {
      if (!/^https?:\/\//i.test(server) || !u || !p) {
        return Response.json({ error: "Servidor, usuário e senha são obrigatórios." }, { status: 400, headers: jsonHeaders });
      }

      const authR = await smartFetch(base);

      if (!authR.ok) {
        return Response.json({ error: `Servidor respondeu HTTP ${authR.status} ao validar o acesso.` }, { status: 502, headers: jsonHeaders });
      }

      const auth = await authR.json();
      if (Number(auth?.user_info?.auth) !== 1) {
        return Response.json({ auth: false, error: auth?.user_info?.message || "Usuário ou senha inválidos." }, { status: 401, headers: jsonHeaders });
      }

      const [liveCats, vodCats, seriesCats] = await Promise.all([
        fetchXtream("action=get_live_categories"),
        fetchXtream("action=get_vod_categories"),
        fetchXtream("action=get_series_categories")
      ]);

      return Response.json({
        auth: true,
        userInfo: auth.user_info,
        serverInfo: auth.server_info,
        categories: {
          live: Array.isArray(liveCats) ? liveCats : [],
          movies: Array.isArray(vodCats) ? vodCats : [],
          series: Array.isArray(seriesCats) ? seriesCats : []
        }
      }, { headers: jsonHeaders });
    }

    // 2. BUSCAR CONTEÚDO DE UMA CATEGORIA
    if (b.action === "get_category_streams") {
      const catId = b.categoryId != null ? String(b.categoryId) : "";
      const type = b.type || "live";
      let actionName = "get_live_streams";
      if (type === "movies") actionName = "get_vod_streams";
      else if (type === "series") actionName = "get_series";

      const query = catId && catId !== "*" ? `action=${actionName}&category_id=${encodeURIComponent(catId)}` : `action=${actionName}`;
      const items = await fetchXtream(query);

      let formatted = [];
      if (Array.isArray(items)) {
        if (type === "live") {
          formatted = items.map(x => ({
            id: x.stream_id,
            name: x.name,
            categoryId: String(x.category_id ?? ""),
            logo: x.stream_icon || "",
            url: `${server}/live/${encodeURIComponent(u)}/${encodeURIComponent(p)}/${x.stream_id}.m3u8`,
            urlTs: `${server}/live/${encodeURIComponent(u)}/${encodeURIComponent(p)}/${x.stream_id}.ts`,
            epgId: x.epg_channel_id || "",
            type: "live"
          }));
        } else if (type === "movies") {
          formatted = items.map(x => ({
            id: x.stream_id,
            name: x.name,
            categoryId: String(x.category_id ?? ""),
            logo: x.stream_icon || "",
            rating: x.rating || x.rating_5based || "",
            year: x.year || "",
            url: `${server}/movie/${encodeURIComponent(u)}/${encodeURIComponent(p)}/${x.stream_id}.${x.container_extension || "mp4"}`,
            containerExtension: x.container_extension || "mp4",
            type: "movies"
          }));
        } else if (type === "series") {
          formatted = items.map(x => ({
            id: x.series_id,
            seriesId: x.series_id,
            name: x.name,
            categoryId: String(x.category_id ?? ""),
            logo: x.cover || "",
            rating: x.rating || "",
            plot: x.plot || "",
            genre: x.genre || "",
            releaseDate: x.releaseDate || "",
            type: "series"
          }));
        }
      }

      return Response.json({ success: true, items: formatted }, { headers: jsonHeaders });
    }

    // 3. DETALHES DE UMA SÉRIE
    if (b.action === "get_series_info") {
      const seriesId = b.seriesId;
      if (!seriesId) return Response.json({ error: "ID da série é obrigatório." }, { status: 400, headers: jsonHeaders });

      const info = await fetchXtream(`action=get_series_info&series_id=${encodeURIComponent(seriesId)}`);
      const seasonsData = info.seasons || [];
      const episodesData = info.episodes || {};
      const formattedEpisodes = {};

      for (const [seasonNum, epList] of Object.entries(episodesData)) {
        if (Array.isArray(epList)) {
          formattedEpisodes[seasonNum] = epList.map(ep => ({
            id: ep.id,
            episodeNum: ep.episode_num,
            title: ep.title || `Episódio ${ep.episode_num}`,
            containerExtension: ep.container_extension || "mp4",
            info: ep.info || {},
            url: `${server}/series/${encodeURIComponent(u)}/${encodeURIComponent(p)}/${ep.id}.${ep.container_extension || "mp4"}`
          }));
        }
      }

      return Response.json({
        success: true,
        info: info.info || {},
        seasons: seasonsData,
        episodes: formattedEpisodes
      }, { headers: jsonHeaders });
    }

    // 4. M3U PLAYLIST PROXY
    if (b.action === "m3u") {
      const url = String(b.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return Response.json({ error: "URL M3U inválida." }, { status: 400, headers: jsonHeaders });
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);
        const r = await fetch(url, {
          signal: controller.signal,
          redirect: "follow",
          headers: {
            "user-agent": "IPTVSmartersPro/1.0.0",
            "accept": "*/*"
          }
        });
        clearTimeout(timeoutId);
        if (!r.ok) return Response.json({ error: `O servidor respondeu HTTP ${r.status} ao solicitar a playlist.` }, { status: 502, headers: jsonHeaders });
        const text = await r.text();
        return Response.json({ text }, { headers: jsonHeaders });
      } catch (fetchErr) {
        if (fetchErr.name === "AbortError") {
          return Response.json({ error: "Tempo esgotado ao baixar a lista M3U." }, { status: 504, headers: jsonHeaders });
        }
        throw fetchErr;
      }
    }

    return Response.json({ error: "Ação inválida." }, { status: 400, headers: jsonHeaders });
  } catch (e) {
    return Response.json({ error: "Falha de rede: " + (e?.message || "erro") }, { status: 502, headers: jsonHeaders });
  }
}

export async function handleStreamProxy(request) {
  if (request.method === "OPTIONS") {
    return onRequestOptions();
  }

  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");
  if (!target || !/^https?:\/\//i.test(target)) {
    return new Response("Parâmetro 'url' ausente ou inválido.", {
      status: 400,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "access-control-allow-origin": "*"
      }
    });
  }

  const upstreamHeaders = {
    "user-agent": "IPTVSmartersPro/1.0.0",
    "accept": "*/*",
  };

  const range = request.headers.get("range");
  if (range) {
    upstreamHeaders["range"] = range;
  }

  try {
    const upstream = await fetch(target, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: upstreamHeaders,
      redirect: "follow",
    });

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
    const isM3u8 = target.toLowerCase().includes(".m3u8") || 
                   contentType.includes("mpegurl") || 
                   contentType.includes("application/x-mpegurl");

    if (isM3u8 && request.method !== "HEAD") {
      const text = await upstream.text();
      const baseUrl = upstream.url || target;
      const origin = reqUrl.origin;
      const proxyBase = `${origin}/api/stream?url=`;

      const lines = text.split(/\r?\n/);
      const rewrittenLines = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        // Diretivas com URI="..." (#EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, etc.)
        if (trimmed.startsWith("#")) {
          return line.replace(/URI="([^"]+)"/g, (match, p1) => {
            try {
              const abs = new URL(p1, baseUrl).href;
              return `URI="${proxyBase}${encodeURIComponent(abs)}"`;
            } catch {
              return match;
            }
          });
        }

        // Linha de segmento ou de playlist variante
        try {
          const abs = new URL(trimmed, baseUrl).href;
          return `${proxyBase}${encodeURIComponent(abs)}`;
        } catch {
          return line;
        }
      });

      return new Response(rewrittenLines.join("\n"), {
        status: upstream.status,
        headers: {
          "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "*",
          "cache-control": "no-cache, no-store",
        }
      });
    }

    // Fluxo binário (.ts, .mp4, .mkv, etc.)
    const respHeaders = new Headers();
    respHeaders.set("access-control-allow-origin", "*");
    respHeaders.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
    respHeaders.set("access-control-allow-headers", "*");
    respHeaders.set("access-control-expose-headers", "Content-Range, Content-Length, Accept-Ranges");

    const passHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control',
      'last-modified',
      'etag'
    ];
    for (const h of passHeaders) {
      const val = upstream.headers.get(h);
      if (val) respHeaders.set(h, val);
    }

    if (!respHeaders.has("content-type")) {
      if (/\.ts($|\?)/i.test(target)) {
        respHeaders.set("content-type", "video/mp2t");
      } else if (/\.mp4($|\?)/i.test(target)) {
        respHeaders.set("content-type", "video/mp4");
      } else {
        respHeaders.set("content-type", "application/octet-stream");
      }
    }

    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers: respHeaders
    });
  } catch (err) {
    return new Response(`Erro ao transmitir fluxo: ${err.message}`, {
      status: 502,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "access-control-allow-origin": "*"
      }
    });
  }
}

export async function onRequestGet(context) {
  return handleStreamProxy(context.request);
}

export async function onRequestHead(context) {
  return handleStreamProxy(context.request);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Stream proxy
    if (url.pathname === "/api/stream" || url.pathname === "/stream" || (url.pathname.startsWith("/api") && url.searchParams.has("url"))) {
      if (request.method === "OPTIONS") return onRequestOptions();
      return handleStreamProxy(request);
    }

    // Xtream Codes / M3U API
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return onRequestOptions();
      if (request.method === "POST") return onRequestPost({ request });
      if (request.method === "GET") return handleStreamProxy(request);
      return new Response("Method not allowed", { status: 405 });
    }

    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
};
