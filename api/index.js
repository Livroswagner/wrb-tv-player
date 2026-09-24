export const config = {
  runtime: 'edge', // Vercel Edge Serverless Function (Ultra-rápido, sem cold starts)
};

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return Response.json({ error: "Método não permitido." }, { status: 405 });
  }

  let b;
  try {
    b = await req.json();
  } catch {
    return Response.json({ error: "JSON inválido." }, { status: 400 });
  }

  const jsonHeaders = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  };

  try {
    const server = String(b.server || "").replace(/\/+$/, "");
    const u = String(b.user || "");
    const p = String(b.pass || "");
    const base = `${server}/player_api.php?username=${encodeURIComponent(u)}&password=${encodeURIComponent(p)}`;

    async function fetchXtream(query) {
      const url = `${base}&${query}`;
      const r = await fetch(url, {
        redirect: "follow",
        headers: {
          "user-agent": "IPTVSmartersPro/1.0.0",
          "accept": "application/json"
        }
      });
      if (!r.ok) return [];
      try {
        return await r.json();
      } catch {
        return [];
      }
    }

    // 1. LOGIN & INICIALIZAÇÃO RÁPIDA (Retorna categorias instantaneamente)
    if (b.action === "login") {
      if (!/^https?:\/\//i.test(server) || !u || !p) {
        return Response.json({ error: "Servidor, usuário e senha são obrigatórios." }, { status: 400 });
      }

      const authR = await fetch(base, {
        redirect: "follow",
        headers: { "user-agent": "IPTVSmartersPro/1.0.0", "accept": "application/json" }
      });

      if (!authR.ok) {
        return Response.json({ error: `Servidor respondeu HTTP ${authR.status} ao validar o acesso.` }, { status: 502 });
      }

      const auth = await authR.json();
      if (Number(auth?.user_info?.auth) !== 1) {
        return Response.json({ auth: false, error: auth?.user_info?.message || "Usuário ou senha inválidos." }, { status: 401 });
      }

      // Baixa apenas as categorias de cada tipo em paralelo (Super Rápido!)
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

    // 2. BUSCAR ITENS DE UMA CATEGORIA ESPECÍFICA (Lazy Loading)
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

    // 3. DETALHES DE UMA SÉRIE (Temporadas e Episódios)
    if (b.action === "get_series_info") {
      const seriesId = b.seriesId;
      if (!seriesId) return Response.json({ error: "ID da série é obrigatório." }, { status: 400 });

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
      if (!/^https?:\/\//i.test(url)) return Response.json({ error: "URL M3U inválida." }, { status: 400 });
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
        if (!r.ok) return Response.json({ error: `O servidor respondeu HTTP ${r.status} ao solicitar a playlist.` }, { status: 502 });
        const text = await r.text();
        return Response.json({ text }, { headers: jsonHeaders });
      } catch (fetchErr) {
        if (fetchErr.name === "AbortError") {
          return Response.json({ error: "Tempo esgotado ao baixar a lista M3U (servidor remoto muito lento ou offline)." }, { status: 504 });
        }
        throw fetchErr;
      }
    }

    return Response.json({ error: "Ação inválida." }, { status: 400 });
  } catch (e) {
    return Response.json({ error: "Falha de rede: " + (e?.message || "erro") }, { status: 502 });
  }
};
