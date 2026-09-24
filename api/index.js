export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido." });
  }

  let b = req.body;
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      return res.status(400).json({ error: "JSON inválido." });
    }
  }
  b = b || {};

  try {
    const server = String(b.server || "").replace(/\/+$/, "");
    const u = String(b.user || "");
    const p = String(b.pass || "");
    const base = `${server}/player_api.php?username=${encodeURIComponent(u)}&password=${encodeURIComponent(p)}`;

    const userAgents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "IPTVSmartersPro/1.0.0",
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
          // tentar próximo UA
        }
      }
      // Se todos falharem com 403, retorna última tentativa padrão
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
        return res.status(400).json({ error: "Servidor, usuário e senha são obrigatórios." });
      }

      const authR = await smartFetch(base);

      if (!authR.ok) {
        const errText = await authR.text().catch(() => "");
        return res.status(502).json({
          error: `Servidor respondeu HTTP ${authR.status} ao validar o acesso.`,
          serverHeader: authR.headers.get("server"),
          cfRay: authR.headers.get("cf-ray"),
          preview: errText.substring(0, 200)
        });
      }

      const auth = await authR.json();
      if (Number(auth?.user_info?.auth) !== 1) {
        return res.status(401).json({ auth: false, error: auth?.user_info?.message || "Usuário ou senha inválidos." });
      }

      const [liveCats, vodCats, seriesCats] = await Promise.all([
        fetchXtream("action=get_live_categories"),
        fetchXtream("action=get_vod_categories"),
        fetchXtream("action=get_series_categories")
      ]);

      return res.status(200).json({
        auth: true,
        userInfo: auth.user_info,
        serverInfo: auth.server_info,
        categories: {
          live: Array.isArray(liveCats) ? liveCats : [],
          movies: Array.isArray(vodCats) ? vodCats : [],
          series: Array.isArray(seriesCats) ? seriesCats : []
        }
      });
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

      return res.status(200).json({ success: true, items: formatted });
    }

    // 3. DETALHES DE UMA SÉRIE
    if (b.action === "get_series_info") {
      const seriesId = b.seriesId;
      if (!seriesId) return res.status(400).json({ error: "ID da série é obrigatório." });

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

      return res.status(200).json({
        success: true,
        info: info.info || {},
        seasons: seasonsData,
        episodes: formattedEpisodes
      });
    }

    // 4. M3U PLAYLIST PROXY
    if (b.action === "m3u") {
      const url = String(b.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "URL M3U inválida." });
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);
        const r = await fetch(url, {
          signal: controller.signal,
          redirect: "follow",
          headers: {
            "user-agent": "IPTVSmartersPro/1.0.0",
            "accept": "*/*"
          }
        });
        clearTimeout(timeoutId);
        if (!r.ok) return res.status(502).json({ error: `O servidor respondeu HTTP ${r.status} ao solicitar a playlist.` });
        const text = await r.text();
        return res.status(200).json({ text });
      } catch (fetchErr) {
        if (fetchErr.name === "AbortError") {
          return res.status(504).json({ error: "Tempo esgotado ao baixar a lista M3U." });
        }
        throw fetchErr;
      }
    }

    return res.status(400).json({ error: "Ação inválida." });
  } catch (e) {
    return res.status(502).json({ error: "Falha de rede: " + (e?.message || "erro") });
  }
}
