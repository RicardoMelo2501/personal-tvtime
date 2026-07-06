(function () {
  "use strict";

  var SUPABASE_CONFIG = window.SUPABASE_CONFIG || null;
  var REST_PAGE_SIZE = 1000;

  var TODAY = new Date();
  var OVERRIDES_KEY = "tvtime_clone_overrides_v1";
  var PAGE_SIZE = 8;

  var state = {
    seriesRaw: [],
    moviesRaw: [],
    listsRaw: [],
    minhaLista: [],
    emBreve: [],
    assistidos: [],
    activeTab: "minha-lista",
    gridView: false,
    renderedCount: 0,
    loadingMore: false
  };

  // ---------- Overrides (localStorage) ----------
  function loadOverrides() {
    try {
      var raw = localStorage.getItem(OVERRIDES_KEY);
      return raw ? JSON.parse(raw) : { episodes: {}, movies: {} };
    } catch (e) {
      return { episodes: {}, movies: {} };
    }
  }
  function saveOverrides(ov) {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(ov));
  }
  var overrides = loadOverrides();

  function episodeKey(seriesUuid, season, number) {
    return seriesUuid + "|" + season + "|" + number;
  }

  function applyOverridesToSeries(seriesArr) {
    seriesArr.forEach(function (s) {
      (s.seasons || []).forEach(function (season) {
        (season.episodes || []).forEach(function (ep) {
          var key = episodeKey(s.uuid, season.number, ep.number);
          var ov = overrides.episodes[key];
          if (!ov) return;
          if (typeof ov === "string") {
            // legacy format: plain ISO date string means "marked watched"
            ep.is_watched = true;
            ep.watched_at = ov;
          } else if (ov.watched === false) {
            ep.is_watched = false;
            ep.watched_at = null;
          } else {
            ep.is_watched = true;
            ep.watched_at = ov.at || ep.watched_at;
          }
        });
      });
    });
  }
  function markEpisodeWatched(seriesUuid, season, number) {
    var key = episodeKey(seriesUuid, season, number);
    overrides.episodes[key] = { watched: true, at: new Date().toISOString() };
    saveOverrides(overrides);
  }
  function unmarkEpisodeWatched(seriesUuid, season, number) {
    var key = episodeKey(seriesUuid, season, number);
    overrides.episodes[key] = { watched: false };
    saveOverrides(overrides);
  }
  function applyOverridesToMovies(moviesArr) {
    moviesArr.forEach(function (m) {
      var ov = overrides.movies[m.uuid];
      if (ov) {
        m.is_watched = true;
        m.watched_at = ov;
      }
    });
  }

  // ---------- Helpers ----------
  function colorSeed(title) {
    var h = 0;
    for (var i = 0; i < title.length; i++) {
      h = (h * 31 + title.charCodeAt(i)) >>> 0;
    }
    var hue1 = h % 360;
    var hue2 = (hue1 + 40) % 360;
    return [hue1, hue2];
  }
  function posterStyle(hue1, hue2) {
    return "background: linear-gradient(160deg, hsl(" + hue1 + ",55%,52%), hsl(" + hue2 + ",55%,38%));";
  }
  function initials(title) {
    var words = title.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }
  function daysSince(dateStr) {
    if (!dateStr) return Infinity;
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return Infinity;
    return Math.floor((TODAY - d) / 86400000);
  }
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function showToast(msg, action) {
    var t = document.getElementById("toast");
    t.innerHTML =
      '<span class="toast-msg">' + escapeHtml(msg) + '</span>' +
      (action ? '<button class="toast-action">' + escapeHtml(action.label) + '</button>' : '');
    t.classList.add("show");

    if (action) {
      var btn = t.querySelector(".toast-action");
      btn.addEventListener("click", function () {
        action.onClick();
        t.classList.remove("show");
        clearTimeout(showToast._timer);
      });
    }

    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function () {
      t.classList.remove("show");
    }, action ? 4000 : 1800);
  }

  // ---------- Data processing ----------
  function buildEntries(seriesArr) {
    var minhaLista = [];
    var emBreve = [];

    seriesArr.forEach(function (s) {
      var title = s.title || "Sem título";
      var seasons = (s.seasons || [])
        .filter(function (se) { return !se.is_specials; })
        .slice()
        .sort(function (a, b) { return (a.number || 0) - (b.number || 0); });

      var flat = [];
      seasons.forEach(function (season) {
        var eps = (season.episodes || []).slice().sort(function (a, b) {
          return (a.number || 0) - (b.number || 0);
        });
        eps.forEach(function (ep) {
          flat.push({
            season: season.number,
            number: ep.number,
            name: ep.name || ("Episódio " + ep.number),
            is_watched: !!ep.is_watched,
            watched_at: ep.watched_at
          });
        });
      });
      if (!flat.length) return;

      var watchedEps = flat.filter(function (e) { return e.is_watched; });
      var unwatchedEps = flat.filter(function (e) { return !e.is_watched; });

      var lastWatchedAt = null;
      watchedEps.forEach(function (e) {
        if (e.watched_at && (!lastWatchedAt || e.watched_at > lastWatchedAt)) {
          lastWatchedAt = e.watched_at;
        }
      });

      var seed = colorSeed(title);

      if (!watchedEps.length) {
        var firstEp = flat[0];
        emBreve.push({
          id: s.uuid,
          title: title,
          season: firstEp.season,
          episode: firstEp.number,
          episodeName: firstEp.name,
          addedAt: s.created_at,
          hue1: seed[0],
          hue2: seed[1]
        });
        return;
      }

      if (!unwatchedEps.length) return; // fully watched, nothing pending

      var nextEp = unwatchedEps[0];
      var isPremiere = nextEp.season === flat[0].season && nextEp.number === 1;
      var last = flat[flat.length - 1];
      var isLatest = nextEp.season === last.season && nextEp.number === last.number;

      var tags = [];
      if (isPremiere) tags.push("PREMIERE");
      else if (isLatest) tags.push("MAIS RECENTE");

      var stale = daysSince(lastWatchedAt) > 120;

      minhaLista.push({
        id: s.uuid,
        title: title,
        season: nextEp.season,
        episode: nextEp.number,
        episodeName: nextEp.name,
        tags: tags,
        stale: stale,
        lastActivity: lastWatchedAt || s.created_at,
        hue1: seed[0],
        hue2: seed[1]
      });
    });

    minhaLista.sort(function (a, b) {
      return (b.lastActivity || "").localeCompare(a.lastActivity || "");
    });
    emBreve.sort(function (a, b) {
      return (b.addedAt || "").localeCompare(a.addedAt || "");
    });

    return { minhaLista: minhaLista, emBreve: emBreve, assistidos: buildAssistidos(seriesArr) };
  }

  function buildAssistidos(seriesArr) {
    var assistidos = [];
    seriesArr.forEach(function (s) {
      var title = s.title || "Sem título";
      var seed = colorSeed(title);
      (s.seasons || []).forEach(function (season) {
        (season.episodes || []).forEach(function (ep) {
          if (!ep.is_watched) return;
          assistidos.push({
            id: s.uuid,
            title: title,
            season: season.number,
            episode: ep.number,
            episodeName: ep.name || ("Episódio " + ep.number),
            watchedAt: ep.watched_at,
            hue1: seed[0],
            hue2: seed[1]
          });
        });
      });
    });
    assistidos.sort(function (a, b) {
      return (b.watchedAt || "").localeCompare(a.watchedAt || "");
    });
    return assistidos;
  }

  // ---------- Rendering: cards ----------
  function iconTv() {
    return '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line></svg>';
  }
  function iconCheck() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  }
  function iconUndo() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 14 4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"></path></svg>';
  }
  function formatWatchedAt(dateStr) {
    if (!dateStr) return "Data desconhecida";
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return "Data desconhecida";
    return "Assistido em " + pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + "/" + d.getFullYear();
  }

  function renderCard(item, kind) {
    var wrap = document.createElement("div");
    wrap.className = "card-wrap";

    var staleHtml = (kind === "minha-lista" && item.stale)
      ? '<div class="stale-flag">Sem assistir há algum tempo</div>'
      : "";

    var tagsHtml = (item.tags && item.tags.length)
      ? '<div class="tags-row">' + item.tags.map(function (t) {
          return '<span class="tag-badge">' + escapeHtml(t) + '</span>';
        }).join("") + '</div>'
      : "";

    var watchedNow = kind === "em-breve"
      ? overrides.episodes[episodeKey(item.id, item.season, item.episode)]
      : false;

    var subLineHtml = kind === "assistidos"
      ? '<div class="watched-meta">' + escapeHtml(formatWatchedAt(item.watchedAt)) + '</div>'
      : '<div class="episode-title">' + escapeHtml(item.episodeName) + '</div>';

    var actionHtml = kind === "assistidos"
      ? '<button class="undo-btn" title="Corrigir: marcar como não assistido">' + iconUndo() + '</button>'
      : '<button class="check-btn' + (watchedNow ? ' watched' : '') + '" title="Marcar como assistido">' + iconCheck() + '</button>';

    wrap.innerHTML =
      staleHtml +
      '<div class="card" data-id="' + item.id + '" data-season="' + item.season + '" data-episode="' + item.episode + '" data-kind="' + kind + '">' +
        '<div class="card-poster" style="' + posterStyle(item.hue1, item.hue2) + '">' + escapeHtml(initials(item.title)) + '</div>' +
        '<div class="card-info">' +
          '<span class="pill">( ' + escapeHtml(item.title.toUpperCase()) + ' )</span>' +
          '<div class="episode-line">' + iconTv() + ' T' + pad2(item.season) + ' | E' + pad2(item.episode) + '</div>' +
          subLineHtml +
          tagsHtml +
        '</div>' +
        '<div class="card-action">' + actionHtml + '</div>' +
      '</div>';

    return wrap;
  }

  function getActiveList() {
    if (state.activeTab === "minha-lista") return state.minhaLista;
    if (state.activeTab === "assistidos") return state.assistidos;
    return state.emBreve;
  }

  function renderList(reset) {
    var container = document.getElementById("list-container");
    if (reset) {
      container.innerHTML = "";
      state.renderedCount = 0;
    }
    var list = getActiveList();

    if (!list.length) {
      var emptyMsg = state.activeTab === "assistidos"
        ? "Nenhum episódio assistido ainda."
        : "Nada por aqui ainda.";
      container.innerHTML = '<div class="empty-state">' + emptyMsg + '</div>';
      return;
    }

    var next = list.slice(state.renderedCount, state.renderedCount + PAGE_SIZE);
    next.forEach(function (item) {
      container.appendChild(renderCard(item, state.activeTab));
    });
    state.renderedCount += next.length;

    var oldIndicator = container.querySelector(".loading-indicator");
    if (oldIndicator) oldIndicator.remove();
    if (state.renderedCount < list.length) {
      var ind = document.createElement("div");
      ind.className = "loading-indicator";
      ind.textContent = "Carregando";
      container.appendChild(ind);
    }
  }

  function handleScroll() {
    var container = document.getElementById("list-container");
    if (state.loadingMore) return;
    var list = getActiveList();
    if (state.renderedCount >= list.length) return;

    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 80) {
      state.loadingMore = true;
      setTimeout(function () {
        renderList(false);
        state.loadingMore = false;
      }, 500);
    }
  }

  function rebuildLists() {
    applyOverridesToSeries(state.seriesRaw);
    var rebuilt = buildEntries(state.seriesRaw);
    state.minhaLista = rebuilt.minhaLista;
    state.emBreve = rebuilt.emBreve;
    state.assistidos = rebuilt.assistidos;
  }

  function handleCardClick(e) {
    var checkBtn = e.target.closest(".check-btn");
    var undoBtn = e.target.closest(".undo-btn");
    if (!checkBtn && !undoBtn) return;

    var card = e.target.closest(".card");
    var id = card.getAttribute("data-id");
    var season = parseInt(card.getAttribute("data-season"), 10);
    var episode = parseInt(card.getAttribute("data-episode"), 10);

    if (checkBtn) {
      checkBtn.classList.add("confirming");
      setTimeout(function () { checkBtn.classList.remove("confirming"); }, 500);

      markEpisodeWatched(id, season, episode);
      rebuildLists();
      renderList(true);

      showToast("Episódio marcado como assistido", {
        label: "Desfazer",
        onClick: function () {
          unmarkEpisodeWatched(id, season, episode);
          rebuildLists();
          renderList(true);
        }
      });
      return;
    }

    unmarkEpisodeWatched(id, season, episode);
    rebuildLists();
    renderList(true);

    showToast("Marcação corrigida: episódio não assistido", {
      label: "Desfazer",
      onClick: function () {
        markEpisodeWatched(id, season, episode);
        rebuildLists();
        renderList(true);
      }
    });
  }

  // ---------- Tabs / view toggle ----------
  function setupHomeControls() {
    document.querySelectorAll(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
        tab.classList.add("active");
        state.activeTab = tab.getAttribute("data-tab");
        renderList(true);
      });
    });

    document.getElementById("view-toggle").addEventListener("click", function () {
      state.gridView = !state.gridView;
      var container = document.getElementById("list-container");
      container.classList.toggle("grid-view", state.gridView);
      this.classList.toggle("active", state.gridView);
    });

    document.getElementById("list-container").addEventListener("click", handleCardClick);
    document.getElementById("list-container").addEventListener("scroll", handleScroll);
  }

  // ---------- Bottom nav ----------
  function setupBottomNav() {
    document.querySelectorAll(".nav-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll(".nav-btn").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        var target = btn.getAttribute("data-screen");
        document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); });
        document.getElementById("screen-" + target).classList.add("active");
      });
    });
  }

  // ---------- Lists screen ----------
  function renderLists() {
    var container = document.getElementById("lists-container");
    if (!state.listsRaw.length) {
      container.innerHTML = '<div class="empty-state">Nenhuma lista encontrada.</div>';
      return;
    }
    container.innerHTML = state.listsRaw.map(function (l) {
      var items = (l.items || []).slice(0, 6).map(function (it) { return it.name; }).join(" · ");
      return '<div class="list-card">' +
        '<div class="list-card-title">' + escapeHtml(l.name || "Sem nome") + '</div>' +
        '<div class="list-card-count">' + (l.items ? l.items.length : 0) + ' itens</div>' +
        '<div class="list-card-items">' + escapeHtml(items) + (l.items && l.items.length > 6 ? "…" : "") + '</div>' +
      '</div>';
    }).join("");
  }

  // ---------- Search screen ----------
  function renderSearchResults(query) {
    var container = document.getElementById("search-results");
    query = (query || "").trim().toLowerCase();
    if (!query) {
      container.innerHTML = '<div class="empty-state">Digite para buscar em filmes e séries.</div>';
      return;
    }

    var seriesMatches = state.seriesRaw
      .filter(function (s) { return (s.title || "").toLowerCase().indexOf(query) !== -1; })
      .slice(0, 25)
      .map(function (s) {
        var seed = colorSeed(s.title || "?");
        var totalEps = 0, watchedEps = 0;
        (s.seasons || []).forEach(function (se) {
          (se.episodes || []).forEach(function (ep) {
            totalEps++;
            if (ep.is_watched) watchedEps++;
          });
        });
        return {
          type: "Série", title: s.title || "Sem título",
          sub: watchedEps + "/" + totalEps + " episódios assistidos",
          hue1: seed[0], hue2: seed[1]
        };
      });

    var movieMatches = state.moviesRaw
      .filter(function (m) { return (m.title || "").toLowerCase().indexOf(query) !== -1; })
      .slice(0, 25)
      .map(function (m) {
        var seed = colorSeed(m.title || "?");
        return {
          type: "Filme", title: m.title || "Sem título",
          sub: (m.year || "—") + (m.is_watched ? " · Assistido" : " · Não assistido"),
          hue1: seed[0], hue2: seed[1]
        };
      });

    var all = seriesMatches.concat(movieMatches);
    if (!all.length) {
      container.innerHTML = '<div class="empty-state">Nada encontrado para "' + escapeHtml(query) + '".</div>';
      return;
    }

    container.innerHTML = all.map(function (item) {
      return '<div class="search-row">' +
        '<div class="search-avatar" style="' + posterStyle(item.hue1, item.hue2) + '">' + escapeHtml(initials(item.title)) + '</div>' +
        '<div class="search-meta">' +
          '<div class="search-title">' + escapeHtml(item.title) + '</div>' +
          '<div class="search-sub">' + escapeHtml(item.sub) + '</div>' +
        '</div>' +
        '<span class="search-type-badge">' + item.type + '</span>' +
      '</div>';
    }).join("");
  }

  function setupSearch() {
    var input = document.getElementById("search-input");
    input.addEventListener("input", function () {
      renderSearchResults(input.value);
    });
    renderSearchResults("");
  }

  // ---------- Profile / stats screen ----------
  function computeStats() {
    var series = state.seriesRaw, movies = state.moviesRaw;
    var episodesWatched = 0;
    series.forEach(function (s) {
      (s.seasons || []).forEach(function (se) {
        (se.episodes || []).forEach(function (ep) {
          if (ep.is_watched) episodesWatched++;
        });
      });
    });
    return {
      totalSeries: series.length,
      totalMovies: movies.length,
      moviesWatched: movies.filter(function (m) { return m.is_watched; }).length,
      episodesWatched: episodesWatched,
      seriesUpToDate: series.filter(function (s) { return s.status === "up_to_date"; }).length,
      seriesContinuing: series.filter(function (s) { return s.status === "continuing"; }).length,
      seriesStopped: series.filter(function (s) { return s.status === "stopped"; }).length,
      seriesNotStarted: series.filter(function (s) { return s.status === "not_started_yet"; }).length
    };
  }

  function renderProfile() {
    var stats = computeStats();
    var container = document.getElementById("profile-container");
    container.innerHTML =
      '<div class="stats-grid">' +
        statCard(stats.totalSeries, "Séries") +
        statCard(stats.totalMovies, "Filmes") +
        statCard(stats.episodesWatched, "Episódios vistos") +
        statCard(stats.moviesWatched, "Filmes assistidos") +
        statCard(stats.seriesUpToDate, "Em dia") +
        statCard(stats.seriesContinuing, "Em andamento") +
        statCard(stats.seriesStopped, "Paradas") +
        statCard(stats.seriesNotStarted, "Não iniciadas") +
      '</div>' +
      '<div class="export-section">' +
        '<button id="export-btn" class="export-btn">Exportar dados atualizados (.json)</button>' +
        '<div class="export-hint">Baixa os arquivos JSON com suas marcações mais recentes.</div>' +
      '</div>';

    document.getElementById("export-btn").addEventListener("click", exportData);
  }

  function statCard(value, label) {
    return '<div class="stat-card"><div class="stat-value">' + value + '</div><div class="stat-label">' + escapeHtml(label) + '</div></div>';
  }

  function downloadJson(obj, filename) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportData() {
    downloadJson(state.seriesRaw, "tvtime-series-updated.json");
    downloadJson(state.moviesRaw, "tvtime-movies-updated.json");
    showToast("Arquivos atualizados baixados");
  }

  // ---------- Supabase data fetching ----------
  function fetchAllRows(table, query) {
    var all = [];
    function fetchPage(from) {
      var url = SUPABASE_CONFIG.url + "/rest/v1/" + table + "?" + query;
      return fetch(url, {
        headers: {
          apikey: SUPABASE_CONFIG.anonKey,
          Authorization: "Bearer " + SUPABASE_CONFIG.anonKey,
          Range: from + "-" + (from + REST_PAGE_SIZE - 1)
        }
      }).then(function (r) {
        if (!r.ok) throw new Error("Falha ao carregar " + table);
        return r.json();
      }).then(function (chunk) {
        all = all.concat(chunk);
        if (chunk.length === REST_PAGE_SIZE) {
          return fetchPage(from + REST_PAGE_SIZE);
        }
        return all;
      });
    }
    return fetchPage(0);
  }

  function assembleSeries(seriesRows, seasonRows, episodeRows) {
    var seasonsBySeries = {};
    seasonRows.forEach(function (se) {
      if (!seasonsBySeries[se.series_uuid]) seasonsBySeries[se.series_uuid] = {};
      seasonsBySeries[se.series_uuid][se.number] = {
        number: se.number,
        is_specials: se.is_specials,
        episodes: []
      };
    });
    episodeRows.forEach(function (ep) {
      var seasons = seasonsBySeries[ep.series_uuid];
      var season = seasons && seasons[ep.season_number];
      if (!season) return;
      season.episodes.push({
        number: ep.number,
        name: ep.name,
        special: ep.special,
        is_watched: ep.is_watched,
        watched_at: ep.watched_at,
        rewatch_count: ep.rewatch_count,
        watched_count: ep.watched_count
      });
    });
    return seriesRows.map(function (s) {
      var seasonsMap = seasonsBySeries[s.uuid] || {};
      var seasons = Object.keys(seasonsMap).map(function (n) { return seasonsMap[n]; });
      return {
        uuid: s.uuid,
        title: s.title,
        status: s.status,
        is_favorite: s.is_favorite,
        _noEpisodeData: s.no_episode_data,
        created_at: s.created_at,
        seasons: seasons
      };
    });
  }

  function loadFromSupabase() {
    return Promise.all([
      fetchAllRows("movies", "select=*&order=uuid"),
      fetchAllRows("series", "select=*&order=uuid"),
      fetchAllRows("seasons", "select=*&order=series_uuid,number"),
      fetchAllRows("episodes", "select=*&order=id"),
      fetchAllRows("lists", "select=*,items:list_items(type,tvdb_id,name,custom_order)&order=id")
    ]).then(function (results) {
      return {
        movies: results[0],
        series: assembleSeries(results[1], results[2], results[3]),
        lists: results[4]
      };
    });
  }

  // ---------- Boot ----------
  function init() {
    setupHomeControls();
    setupBottomNav();
    setupSearch();

    if (!SUPABASE_CONFIG || !SUPABASE_CONFIG.url || !SUPABASE_CONFIG.anonKey) {
      document.getElementById("list-container").innerHTML =
        '<div class="empty-state">Configuração do Supabase não encontrada.' +
        '<br><br>Copie ".env.example" para ".env", preencha as credenciais e rode ' +
        '<code>node scripts/generate-config.js</code> para gerar o config.js.</div>';
      return;
    }

    document.getElementById("list-container").innerHTML =
      '<div class="empty-state">Carregando dados…</div>';

    loadFromSupabase().then(function (data) {
      state.seriesRaw = data.series;
      state.moviesRaw = data.movies;
      state.listsRaw = data.lists;

      applyOverridesToSeries(state.seriesRaw);
      applyOverridesToMovies(state.moviesRaw);

      var built = buildEntries(state.seriesRaw);
      state.minhaLista = built.minhaLista;
      state.emBreve = built.emBreve;
      state.assistidos = built.assistidos;

      renderList(true);
      renderLists();
      renderProfile();
    }).catch(function (err) {
      document.getElementById("list-container").innerHTML =
        '<div class="empty-state">Erro ao carregar dados do Supabase: ' + escapeHtml(err.message) +
        '<br><br>Verifique sua conexão com a internet e se o projeto Supabase está acessível.</div>';
      console.error(err);
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
