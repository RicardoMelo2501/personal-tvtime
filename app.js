(function () {
  "use strict";

  var SUPABASE_CONFIG = window.SUPABASE_CONFIG || null;
  var TVDB_CONFIG = window.TVDB_CONFIG || null;
  var REST_PAGE_SIZE = 1000;

  var TVDB_API_BASE = "https://api4.thetvdb.com/v4";
  var TVDB_TOKEN_KEY = "tvtime_clone_tvdb_token_v1";

  var TODAY = new Date();
  var OVERRIDES_KEY = "tvtime_clone_overrides_v1";
  var PAGE_SIZE = 8;

  var state = {
    seriesProgress: [],
    seriesSearchStats: [],
    moviesRaw: [],
    listsRaw: [],
    profileStats: null,
    seriesDetailCache: {},
    minhaLista: [],
    emBreve: [],
    assistidos: [],
    assistidosOffset: 0,
    assistidosHasMore: true,
    assistidosLoading: false,
    activeTab: "minha-lista",
    gridView: false,
    renderedCount: 0,
    loadingMore: false
  };

  // ---------- Overrides (localStorage) ----------
  // Overrides store local corrections that never get written back to
  // Supabase (the anon key is read-only by design). They carry enough
  // display metadata (title/name) so the "Assistidos" tab can render
  // freshly-marked episodes without an extra round trip.
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
  function seriesUuidFromKey(key) {
    return key.split("|")[0];
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
  function markEpisodeWatched(seriesUuid, season, number, title, name, tvdbId) {
    var key = episodeKey(seriesUuid, season, number);
    overrides.episodes[key] = {
      watched: true,
      at: new Date().toISOString(),
      title: title,
      season: season,
      number: number,
      name: name,
      tvdbId: tvdbId
    };
    saveOverrides(overrides);
  }
  function unmarkEpisodeWatched(seriesUuid, season, number) {
    var key = episodeKey(seriesUuid, season, number);
    overrides.episodes[key] = { watched: false };
    saveOverrides(overrides);
  }
  function getOverriddenSeriesUuids() {
    var set = {};
    Object.keys(overrides.episodes).forEach(function (key) {
      set[seriesUuidFromKey(key)] = true;
    });
    return Object.keys(set);
  }
  function getLocallyWatchedExtras() {
    var arr = [];
    Object.keys(overrides.episodes).forEach(function (key) {
      var ov = overrides.episodes[key];
      if (ov && typeof ov === "object" && ov.watched === true && ov.title) {
        var seed = colorSeed(ov.title);
        arr.push({
          id: seriesUuidFromKey(key),
          title: ov.title,
          tvdbId: ov.tvdbId,
          season: ov.season,
          episode: ov.number,
          episodeName: ov.name || ("Episódio " + ov.number),
          watchedAt: ov.at,
          hue1: seed[0],
          hue2: seed[1]
        });
      }
    });
    return arr;
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

  // ---------- Data processing: home tabs from the lean series_progress view ----------
  function buildHomeListsFromProgress(rows) {
    var minhaLista = [];
    var emBreve = [];

    rows.forEach(function (s) {
      if (s.first_season == null) return; // series with no episode data at all
      var title = s.title || "Sem título";
      var seed = colorSeed(title);

      if (!s.watched_count) {
        emBreve.push({
          id: s.uuid,
          title: title,
          tvdbId: s.tvdb_id,
          season: s.first_season,
          episode: s.first_number,
          episodeName: s.first_name || ("Episódio " + s.first_number),
          addedAt: s.created_at,
          hue1: seed[0],
          hue2: seed[1]
        });
        return;
      }

      if (s.next_season == null) return; // fully watched, nothing pending

      var isPremiere = s.next_season === s.first_season && s.next_number === s.first_number;
      var isLatest = s.next_season === s.last_season && s.next_number === s.last_number;
      var tags = [];
      if (isPremiere) tags.push("PREMIERE");
      else if (isLatest) tags.push("MAIS RECENTE");

      minhaLista.push({
        id: s.uuid,
        title: title,
        tvdbId: s.tvdb_id,
        season: s.next_season,
        episode: s.next_number,
        episodeName: s.next_name || ("Episódio " + s.next_number),
        tags: tags,
        stale: daysSince(s.last_watched_at) > 120,
        lastActivity: s.last_watched_at || s.created_at,
        hue1: seed[0],
        hue2: seed[1]
      });
    });

    minhaLista.sort(function (a, b) { return (b.lastActivity || "").localeCompare(a.lastActivity || ""); });
    emBreve.sort(function (a, b) { return (b.addedAt || "").localeCompare(a.addedAt || ""); });
    return { minhaLista: minhaLista, emBreve: emBreve };
  }

  // Per-series recomputation, used only for series touched by local overrides
  // (the series_progress view reflects the database, not localStorage corrections).
  function computeSeriesEntry(s) {
    var title = s.title || "Sem título";
    var seasons = (s.seasons || [])
      .filter(function (se) { return !se.is_specials; })
      .slice()
      .sort(function (a, b) { return (a.number || 0) - (b.number || 0); });

    var flat = [];
    seasons.forEach(function (season) {
      var eps = (season.episodes || []).slice().sort(function (a, b) { return (a.number || 0) - (b.number || 0); });
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
    if (!flat.length) return null;

    var watchedEps = flat.filter(function (e) { return e.is_watched; });
    var unwatchedEps = flat.filter(function (e) { return !e.is_watched; });
    var lastWatchedAt = null;
    watchedEps.forEach(function (e) {
      if (e.watched_at && (!lastWatchedAt || e.watched_at > lastWatchedAt)) lastWatchedAt = e.watched_at;
    });
    var seed = colorSeed(title);

    if (!watchedEps.length) {
      var firstEp = flat[0];
      return {
        type: "em-breve",
        item: {
          id: s.uuid, title: title, tvdbId: s.tvdb_id, season: firstEp.season, episode: firstEp.number,
          episodeName: firstEp.name, addedAt: s.created_at, hue1: seed[0], hue2: seed[1]
        }
      };
    }
    if (!unwatchedEps.length) return null;

    var nextEp = unwatchedEps[0];
    var isPremiere = nextEp.season === flat[0].season && nextEp.number === 1;
    var last = flat[flat.length - 1];
    var isLatest = nextEp.season === last.season && nextEp.number === last.number;
    var tags = [];
    if (isPremiere) tags.push("PREMIERE");
    else if (isLatest) tags.push("MAIS RECENTE");

    return {
      type: "minha-lista",
      item: {
        id: s.uuid, title: title, tvdbId: s.tvdb_id, season: nextEp.season, episode: nextEp.number,
        episodeName: nextEp.name, tags: tags, stale: daysSince(lastWatchedAt) > 120,
        lastActivity: lastWatchedAt || s.created_at, hue1: seed[0], hue2: seed[1]
      }
    };
  }

  function applyOverriddenSeriesToLists(lists) {
    var uuids = getOverriddenSeriesUuids();
    if (!uuids.length) return Promise.resolve(lists);
    return Promise.all(uuids.map(fetchSeriesDetail)).then(function (details) {
      details.forEach(function (detail) {
        if (!detail) return;
        applyOverridesToSeries([detail]);
        lists.minhaLista = lists.minhaLista.filter(function (i) { return i.id !== detail.uuid; });
        lists.emBreve = lists.emBreve.filter(function (i) { return i.id !== detail.uuid; });
        var entry = computeSeriesEntry(detail);
        if (entry) {
          if (entry.type === "minha-lista") lists.minhaLista.push(entry.item);
          else lists.emBreve.push(entry.item);
        }
      });
      lists.minhaLista.sort(function (a, b) { return (b.lastActivity || "").localeCompare(a.lastActivity || ""); });
      lists.emBreve.sort(function (a, b) { return (b.addedAt || "").localeCompare(a.addedAt || ""); });
      return lists;
    });
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

    applyPosterArtwork(wrap.querySelector(".card-poster"), item.tvdbId);

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

    var hasMoreLocally = state.renderedCount < list.length;
    var hasMoreRemote = state.activeTab === "assistidos" && state.assistidosHasMore;
    if (hasMoreLocally || hasMoreRemote) {
      var ind = document.createElement("div");
      ind.className = "loading-indicator";
      ind.textContent = "Carregando";
      container.appendChild(ind);
    }
  }

  function handleScroll() {
    var container = document.getElementById("list-container");
    if (state.loadingMore) return;

    if (container.scrollTop + container.clientHeight < container.scrollHeight - 80) return;

    var list = getActiveList();
    if (state.renderedCount < list.length) {
      state.loadingMore = true;
      setTimeout(function () {
        renderList(false);
        state.loadingMore = false;
      }, 300);
      return;
    }

    if (state.activeTab === "assistidos" && state.assistidosHasMore && !state.assistidosLoading) {
      loadAssistidosPage(false).then(function () {
        renderList(false);
      });
    }
  }

  // ---------- Interactive mark / undo ----------
  function refreshSeriesInLists(uuid) {
    return fetchSeriesDetail(uuid).then(function (detail) {
      applyOverridesToSeries([detail]);
      state.minhaLista = state.minhaLista.filter(function (i) { return i.id !== uuid; });
      state.emBreve = state.emBreve.filter(function (i) { return i.id !== uuid; });
      var entry = computeSeriesEntry(detail);
      if (entry) {
        if (entry.type === "minha-lista") state.minhaLista.push(entry.item);
        else state.emBreve.push(entry.item);
      }
      state.minhaLista.sort(function (a, b) { return (b.lastActivity || "").localeCompare(a.lastActivity || ""); });
      state.emBreve.sort(function (a, b) { return (b.addedAt || "").localeCompare(a.addedAt || ""); });
    });
  }

  function handleCardClick(e) {
    var checkBtn = e.target.closest(".check-btn");
    var undoBtn = e.target.closest(".undo-btn");
    if (!checkBtn && !undoBtn) return;

    var card = e.target.closest(".card");
    var id = card.getAttribute("data-id");
    var season = parseInt(card.getAttribute("data-season"), 10);
    var episode = parseInt(card.getAttribute("data-episode"), 10);
    var list = getActiveList();
    var item = list.filter(function (i) { return i.id === id && i.season === season && i.episode === episode; })[0];

    if (checkBtn) {
      checkBtn.classList.add("confirming");
      setTimeout(function () { checkBtn.classList.remove("confirming"); }, 500);

      var title = item ? item.title : "";
      var episodeName = item ? item.episodeName : "";
      var tvdbId = item ? item.tvdbId : null;

      markEpisodeWatched(id, season, episode, title, episodeName, tvdbId);
      state.assistidos.unshift({
        id: id, title: title, tvdbId: tvdbId, season: season, episode: episode, episodeName: episodeName,
        watchedAt: new Date().toISOString(), hue1: item ? item.hue1 : 0, hue2: item ? item.hue2 : 40
      });

      refreshSeriesInLists(id).then(function () { renderList(true); });

      showToast("Episódio marcado como assistido", {
        label: "Desfazer",
        onClick: function () {
          unmarkEpisodeWatched(id, season, episode);
          state.assistidos = state.assistidos.filter(function (i) {
            return !(i.id === id && i.season === season && i.episode === episode);
          });
          refreshSeriesInLists(id).then(function () { renderList(true); });
        }
      });
      return;
    }

    unmarkEpisodeWatched(id, season, episode);
    state.assistidos = state.assistidos.filter(function (i) {
      return !(i.id === id && i.season === season && i.episode === episode);
    });
    renderList(true);
    refreshSeriesInLists(id);

    showToast("Marcação corrigida: episódio não assistido", {
      label: "Desfazer",
      onClick: function () {
        markEpisodeWatched(id, season, episode, item ? item.title : "", item ? item.episodeName : "", item ? item.tvdbId : null);
        state.assistidos.unshift(item || { id: id, title: "", season: season, episode: episode, episodeName: "", watchedAt: new Date().toISOString(), hue1: 0, hue2: 40 });
        refreshSeriesInLists(id).then(function () { renderList(true); });
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

    var seriesMatches = state.seriesSearchStats
      .filter(function (s) { return (s.title || "").toLowerCase().indexOf(query) !== -1; })
      .slice(0, 25)
      .map(function (s) {
        var seed = colorSeed(s.title || "?");
        return {
          type: "Série", title: s.title || "Sem título",
          sub: s.watched_episodes + "/" + s.total_episodes + " episódios assistidos",
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
  function renderProfile() {
    var stats = state.profileStats || {
      total_series: 0, total_movies: 0, movies_watched: 0, episodes_watched: 0,
      series_up_to_date: 0, series_continuing: 0, series_stopped: 0, series_not_started: 0
    };
    var container = document.getElementById("profile-container");
    container.innerHTML =
      '<div class="stats-grid">' +
        statCard(stats.total_series, "Séries") +
        statCard(stats.total_movies, "Filmes") +
        statCard(stats.episodes_watched, "Episódios vistos") +
        statCard(stats.movies_watched, "Filmes assistidos") +
        statCard(stats.series_up_to_date, "Em dia") +
        statCard(stats.series_continuing, "Em andamento") +
        statCard(stats.series_stopped, "Paradas") +
        statCard(stats.series_not_started, "Não iniciadas") +
      '</div>';
  }

  function statCard(value, label) {
    return '<div class="stat-card"><div class="stat-value">' + value + '</div><div class="stat-label">' + escapeHtml(label) + '</div></div>';
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

  function fetchOne(table, query) {
    var url = SUPABASE_CONFIG.url + "/rest/v1/" + table + "?" + query;
    return fetch(url, {
      headers: {
        apikey: SUPABASE_CONFIG.anonKey,
        Authorization: "Bearer " + SUPABASE_CONFIG.anonKey
      }
    }).then(function (r) {
      if (!r.ok) throw new Error("Falha ao carregar " + table);
      return r.json();
    });
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
        created_at: s.created_at,
        tvdb_id: s.tvdb_id,
        seasons: seasons
      };
    });
  }

  // ---------- TheTVDB artwork ----------
  // Login exchanges the long-lived API key for a bearer token valid ~1 month;
  // we cache it in localStorage and only re-login when it's missing/near expiry.
  var tvdbLoginPromise = null;
  function getTvdbToken() {
    if (!TVDB_CONFIG || !TVDB_CONFIG.apiKey) return Promise.resolve(null);

    try {
      var cached = JSON.parse(localStorage.getItem(TVDB_TOKEN_KEY) || "null");
      if (cached && cached.token && cached.expiresAt > Date.now()) {
        return Promise.resolve(cached.token);
      }
    } catch (e) { /* ignore corrupt cache */ }

    if (tvdbLoginPromise) return tvdbLoginPromise;

    tvdbLoginPromise = fetch(TVDB_API_BASE + "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apikey: TVDB_CONFIG.apiKey })
    }).then(function (r) {
      if (!r.ok) throw new Error("Falha no login da TheTVDB");
      return r.json();
    }).then(function (json) {
      var token = json.data && json.data.token;
      if (!token) throw new Error("Login da TheTVDB não retornou token");
      localStorage.setItem(TVDB_TOKEN_KEY, JSON.stringify({
        token: token,
        expiresAt: Date.now() + 25 * 24 * 60 * 60 * 1000 // token lives ~1 month, refresh a bit early
      }));
      tvdbLoginPromise = null;
      return token;
    }).catch(function (err) {
      tvdbLoginPromise = null;
      throw err;
    });
    return tvdbLoginPromise;
  }

  var tvdbImageCache = {};
  function fetchSeriesArtwork(tvdbId) {
    if (!tvdbId || !TVDB_CONFIG || !TVDB_CONFIG.apiKey) return Promise.resolve(null);
    if (tvdbImageCache[tvdbId]) return tvdbImageCache[tvdbId];

    tvdbImageCache[tvdbId] = getTvdbToken().then(function (token) {
      if (!token) return null;
      return fetch(TVDB_API_BASE + "/series/" + tvdbId + "/extended", {
        headers: { Authorization: "Bearer " + token }
      }).then(function (r) {
        if (!r.ok) throw new Error("Falha ao buscar série " + tvdbId + " na TheTVDB");
        return r.json();
      }).then(function (json) {
        return (json.data && json.data.image) || null;
      });
    }).catch(function (err) {
      console.error(err);
      return null;
    });
    return tvdbImageCache[tvdbId];
  }

  // Progressively upgrades a card's gradient/initials poster to the real
  // cover once it loads, without blocking the initial render.
  function applyPosterArtwork(posterEl, tvdbId) {
    if (!tvdbId) return;
    fetchSeriesArtwork(tvdbId).then(function (url) {
      if (!url || !document.body.contains(posterEl)) return;
      var preload = new Image();
      preload.onload = function () {
        if (!document.body.contains(posterEl)) return;
        // The gradient placeholder was set via the "background" shorthand,
        // which implicitly resets background-size/position to "auto" inline
        // (beating the stylesheet's "cover"). Set them explicitly here too.
        posterEl.style.backgroundImage = "url('" + url.replace(/'/g, "\\'") + "')";
        posterEl.style.backgroundSize = "cover";
        posterEl.style.backgroundPosition = "center";
        posterEl.style.backgroundRepeat = "no-repeat";
        posterEl.classList.add("has-image");
      };
      preload.src = url;
    });
  }

  // Full episode-level detail for a single series, fetched on demand only
  // when the user interacts with that series (mark/undo). Cached per session
  // so repeated corrections on the same series don't re-fetch.
  function fetchSeriesDetail(uuid) {
    if (state.seriesDetailCache[uuid]) return Promise.resolve(state.seriesDetailCache[uuid]);
    var meta = state.seriesProgress.filter(function (s) { return s.uuid === uuid; })[0];
    return Promise.all([
      fetchAllRows("seasons", "select=*&series_uuid=eq." + uuid + "&order=number"),
      fetchAllRows("episodes", "select=*&series_uuid=eq." + uuid + "&order=season_number,number")
    ]).then(function (results) {
      var assembled = assembleSeries(
        [{ uuid: uuid, title: meta ? meta.title : "?", status: meta ? meta.status : null, is_favorite: meta ? meta.is_favorite : false, created_at: meta ? meta.created_at : null, tvdb_id: meta ? meta.tvdb_id : null }],
        results[0],
        results[1]
      )[0];
      state.seriesDetailCache[uuid] = assembled;
      return assembled;
    });
  }

  function loadAssistidosPage(reset) {
    if (reset) {
      state.assistidosOffset = 0;
      state.assistidosHasMore = true;
      state.assistidos = getLocallyWatchedExtras();
    }
    if (!state.assistidosHasMore) return Promise.resolve();

    state.assistidosLoading = true;
    var from = state.assistidosOffset;
    var to = from + PAGE_SIZE * 3 - 1; // overfetch a bit to absorb locally-unmarked corrections
    return fetch(
      SUPABASE_CONFIG.url + "/rest/v1/episodes_watched_feed?select=*",
      {
        headers: {
          apikey: SUPABASE_CONFIG.anonKey,
          Authorization: "Bearer " + SUPABASE_CONFIG.anonKey,
          Range: from + "-" + to
        }
      }
    ).then(function (r) {
      if (!r.ok) throw new Error("Falha ao carregar episódios assistidos");
      return r.json();
    }).then(function (rows) {
      state.assistidosHasMore = rows.length === (to - from + 1);
      state.assistidosOffset = from + rows.length;

      var existingKeys = {};
      state.assistidos.forEach(function (i) { existingKeys[episodeKey(i.id, i.season, i.episode)] = true; });

      rows.forEach(function (row) {
        var key = episodeKey(row.series_uuid, row.season_number, row.number);
        if (existingKeys[key]) return;
        var ov = overrides.episodes[key];
        if (ov && typeof ov === "object" && ov.watched === false) return; // locally corrected to unwatched

        var seed = colorSeed(row.series_title || "?");
        state.assistidos.push({
          id: row.series_uuid,
          title: row.series_title || "Sem título",
          tvdbId: row.tvdb_id,
          season: row.season_number,
          episode: row.number,
          episodeName: row.name || ("Episódio " + row.number),
          watchedAt: row.watched_at,
          hue1: seed[0],
          hue2: seed[1]
        });
        existingKeys[key] = true;
      });

      state.assistidos.sort(function (a, b) { return (b.watchedAt || "").localeCompare(a.watchedAt || ""); });
      state.assistidosLoading = false;
    }).catch(function (err) {
      state.assistidosLoading = false;
      throw err;
    });
  }

  function loadFromSupabase() {
    return Promise.all([
      fetchAllRows("movies", "select=*&order=uuid"),
      fetchAllRows("series_progress", "select=*&order=uuid"),
      fetchAllRows("series_search_stats", "select=*&order=uuid"),
      fetchAllRows("lists", "select=*,items:list_items(type,tvdb_id,name,custom_order)&order=id"),
      fetchOne("profile_stats", "select=*")
    ]).then(function (results) {
      return {
        movies: results[0],
        seriesProgress: results[1],
        seriesSearchStats: results[2],
        lists: results[3],
        profileStats: results[4][0] || null
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
      state.moviesRaw = data.movies;
      state.seriesProgress = data.seriesProgress;
      state.seriesSearchStats = data.seriesSearchStats;
      state.listsRaw = data.lists;
      state.profileStats = data.profileStats;

      applyOverridesToMovies(state.moviesRaw);

      var built = buildHomeListsFromProgress(state.seriesProgress);
      state.minhaLista = built.minhaLista;
      state.emBreve = built.emBreve;

      return applyOverriddenSeriesToLists(built).then(function (finalLists) {
        state.minhaLista = finalLists.minhaLista;
        state.emBreve = finalLists.emBreve;
        return loadAssistidosPage(true);
      });
    }).then(function () {
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
