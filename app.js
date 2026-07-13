(function () {
  "use strict";

  var SUPABASE_CONFIG = window.SUPABASE_CONFIG || null;
  var TVDB_CONFIG = window.TVDB_CONFIG || null;
  var REST_PAGE_SIZE = 1000;

  var TVDB_API_BASE = "https://api4.thetvdb.com/v4";
  var TVDB_TOKEN_KEY = "tvtime_clone_tvdb_token_v1";
  var AUTH_SESSION_KEY = "tvtime_clone_auth_session_v1";

  var PAGE_SIZE = 8;

  var state = {
    authSession: null,
    seriesProgress: [],
    seriesSearchStats: [],
    moviesRaw: [],
    listsRaw: [],
    profileStats: null,
    seriesDetailCache: {},
    minhaLista: [],
    emBreve: [],
    emBreveUpcoming: [],
    emBreveLoaded: false,
    emBreveLoading: false,
    assistidos: [],
    assistidosOffset: 0,
    assistidosHasMore: true,
    assistidosLoading: false,
    activeTab: "minha-lista",
    activeProgressStatus: "all",
    gridView: false,
    renderedCount: 0,
    loadingMore: false
  };

  // ---------- Supabase Auth ----------
  // Data access requires an authenticated session now (RLS denies the anon
  // key entirely). The user/password pair lives in Supabase Auth, not in
  // our own tables — we just exchange them for a session via the GoTrue
  // REST API, same approach used for the raw PostgREST calls elsewhere.
  function loadAuthSession() {
    try {
      return JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || "null");
    } catch (e) { return null; }
  }
  function saveAuthSession(session) {
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
  }
  function clearAuthSession() {
    localStorage.removeItem(AUTH_SESSION_KEY);
  }

  function authRequest(path, body) {
    return fetch(SUPABASE_CONFIG.url + path, {
      method: "POST",
      headers: {
        apikey: SUPABASE_CONFIG.anonKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (json) {
        if (!r.ok) {
          throw new Error(json.error_description || json.msg || "Falha na autenticação");
        }
        return json;
      });
    });
  }

  function toSession(json) {
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + json.expires_in * 1000
    };
  }

  function loginWithPassword(email, password) {
    return authRequest("/auth/v1/token?grant_type=password", { email: email, password: password })
      .then(function (json) {
        var session = toSession(json);
        saveAuthSession(session);
        return session;
      });
  }

  function refreshAuthSession(session) {
    return authRequest("/auth/v1/token?grant_type=refresh_token", { refresh_token: session.refreshToken })
      .then(function (json) {
        var refreshed = toSession(json);
        saveAuthSession(refreshed);
        return refreshed;
      });
  }

  // Resolves to a valid session, refreshing a near-expired one, or null if
  // the user needs to log in (no session, or refresh failed/was revoked).
  function ensureAuthSession() {
    var session = loadAuthSession();
    if (!session) return Promise.resolve(null);
    if (session.expiresAt - 60000 > Date.now()) return Promise.resolve(session);
    return refreshAuthSession(session).catch(function () {
      clearAuthSession();
      return null;
    });
  }

  function logout() {
    clearAuthSession();
    location.reload();
  }

  // ---------- Watched-status writes ----------
  // Marking/unmarking writes straight to Postgres (RLS grants authenticated
  // users UPDATE on episodes/movies). This makes series_progress and
  // episodes_watched_feed immediately correct with zero client-side
  // reconciliation — earlier this was a localStorage "overrides" layer that
  // required re-fetching every previously-touched series on every load.
  function episodeKey(seriesUuid, season, number) {
    return seriesUuid + "|" + season + "|" + number;
  }

  function patchEpisodeWatched(seriesUuid, season, number, watched) {
    var body = watched
      ? { is_watched: true, watched_at: new Date().toISOString() }
      : { is_watched: false, watched_at: null };
    return fetch(
      SUPABASE_CONFIG.url + "/rest/v1/episodes?series_uuid=eq." + seriesUuid +
        "&season_number=eq." + season + "&number=eq." + number,
      { method: "PATCH", headers: authHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }), body: JSON.stringify(body) }
    ).then(function (r) {
      handleAuthFailure(r);
      if (!r.ok) return r.text().then(function (t) { throw new Error("Falha ao atualizar episódio: " + t); });
    });
  }

  function patchSeriesStatus(uuid, status) {
    return fetch(SUPABASE_CONFIG.url + "/rest/v1/series?uuid=eq." + uuid, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify({ status: status })
    }).then(function (r) {
      handleAuthFailure(r);
      if (!r.ok) return r.text().then(function (t) { throw new Error("Falha ao atualizar status: " + t); });
    });
  }

  function patchMovieWatched(uuid, watched) {
    var body = watched
      ? { is_watched: true, watched_at: new Date().toISOString() }
      : { is_watched: false, watched_at: null };
    return fetch(SUPABASE_CONFIG.url + "/rest/v1/movies?uuid=eq." + uuid, {
      method: "PATCH", headers: authHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }), body: JSON.stringify(body)
    }).then(function (r) {
      handleAuthFailure(r);
      if (!r.ok) return r.text().then(function (t) { throw new Error("Falha ao atualizar filme: " + t); });
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
          episodeTvdbId: s.first_episode_tvdb_id,
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
      if (s.status !== "continuing") return; // only actively-watched series belong here

      var isPremiere = s.next_season === s.first_season && s.next_number === s.first_number;
      var isLatest = s.next_season === s.last_season && s.next_number === s.last_number;
      var tags = [];
      if (isPremiere) tags.push("PREMIERE");
      else if (isLatest) tags.push("MAIS RECENTE");

      minhaLista.push({
        id: s.uuid,
        title: title,
        tvdbId: s.tvdb_id,
        episodeTvdbId: s.next_episode_tvdb_id,
        season: s.next_season,
        episode: s.next_number,
        episodeName: s.next_name || ("Episódio " + s.next_number),
        tags: tags,
        lastActivity: s.last_watched_at || s.created_at,
        hue1: seed[0],
        hue2: seed[1]
      });
    });

    minhaLista.sort(function (a, b) { return (b.lastActivity || "").localeCompare(a.lastActivity || ""); });
    emBreve.sort(function (a, b) { return (b.addedAt || "").localeCompare(a.addedAt || ""); });
    return { minhaLista: minhaLista, emBreve: emBreve };
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

  var WEEKDAYS_PT = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
  function historyDayKey(dateStr) {
    var d = new Date(dateStr || "");
    if (isNaN(d.getTime())) return "unknown";
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function historyDayLabel(dateStr) {
    var d = new Date(dateStr || "");
    if (isNaN(d.getTime())) return "Data desconhecida";
    var day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var diffDays = Math.round((today - day) / 86400000);
    if (diffDays === 0) return "Hoje";
    if (diffDays === 1) return "Ontem";
    if (diffDays > 1 && diffDays < 7) return WEEKDAYS_PT[day.getDay()];
    return pad2(day.getDate()) + "/" + pad2(day.getMonth() + 1) + "/" + day.getFullYear();
  }

  function renderCard(item, kind) {
    var wrap = document.createElement("div");
    wrap.className = "card-wrap";

    var tagsHtml = (item.tags && item.tags.length)
      ? '<div class="tags-row">' + item.tags.map(function (t) {
          return '<span class="tag-badge">' + escapeHtml(t) + '</span>';
        }).join("") + '</div>'
      : "";

    var subLineHtml = kind === "assistidos"
      ? '<div class="watched-meta">' + escapeHtml(formatWatchedAt(item.watchedAt)) + '</div>'
      : item.renewalOnly
      ? '<div class="episode-title">Nova temporada a caminho</div>'
      : '<div class="episode-title">' + escapeHtml(item.episodeName) + '</div>';

    var releaseDateHtml = (kind === "em-breve" && item.airedLabel)
      ? '<div class="release-date-badge"><span class="release-date">' + escapeHtml(item.airedLabel) + '</span>' +
          '<span class="release-countdown">' + escapeHtml(item.countdownLabel) + '</span></div>'
      : "";

    var episodeLineHtml = item.renewalOnly
      ? ""
      : '<div class="episode-line">' + iconTv() + ' T' + pad2(item.season) + ' | E' + pad2(item.episode) + '</div>';

    var actionHtml = (item.renewalOnly || item.noAction)
      ? ""
      : kind === "assistidos"
      ? '<button class="undo-btn" title="Corrigir: marcar como não assistido">' + iconUndo() + '</button>'
      : '<button class="check-btn" title="Marcar como assistido">' + iconCheck() + '</button>';

    var cardActionHtml = (item.renewalOnly || item.noAction) ? "" : '<div class="card-action">' + actionHtml + '</div>';

    wrap.innerHTML =
      '<div class="card" data-id="' + item.id + '"' +
        (item.renewalOnly ? ' data-renewal="1"' : ' data-season="' + item.season + '" data-episode="' + item.episode + '"') +
        ' data-kind="' + kind + '">' +
        '<div class="card-poster" style="' + posterStyle(item.hue1, item.hue2) + '">' + escapeHtml(initials(item.title)) + '</div>' +
        '<div class="card-info">' +
          '<span class="pill">( ' + escapeHtml(item.title.toUpperCase()) + ' )</span>' +
          releaseDateHtml +
          episodeLineHtml +
          subLineHtml +
          tagsHtml +
        '</div>' +
        cardActionHtml +
      '</div>';

    applyPosterArtwork(wrap.querySelector(".card-poster"), item.tvdbId);

    return wrap;
  }

  function getActiveList() {
    if (state.activeTab === "minha-lista") return state.minhaLista;
    if (state.activeTab === "assistidos") return state.assistidos;
    return state.emBreveUpcoming;
  }

  function renderList(reset) {
    var container = document.getElementById("list-container");
    if (reset) {
      container.innerHTML = "";
      state.renderedCount = 0;
      delete container.dataset.lastHistoryDay;
    }

    // Always clear a stale indicator up front — if a previous batch threw
    // partway through rendering, this is what keeps "Carregando" from
    // getting stuck at the bottom forever.
    var staleIndicator = container.querySelector(".loading-indicator");
    if (staleIndicator) staleIndicator.remove();

    var list = getActiveList();

    if (!list.length) {
      var emptyMsg = state.activeTab === "assistidos"
        ? "Nenhum episódio assistido ainda."
        : state.activeTab === "em-breve"
        ? "Nenhum episódio previsto para lançamento em breve."
        : "Nada por aqui ainda.";
      container.innerHTML = '<div class="empty-state">' + emptyMsg + '</div>';
      return;
    }

    var next = list.slice(state.renderedCount, state.renderedCount + PAGE_SIZE);
    next.forEach(function (item) {
      try {
        if (state.activeTab === "assistidos" || state.activeTab === "em-breve") {
          var dayKey = state.activeTab === "assistidos" ? historyDayKey(item.watchedAt) : (item.airedRaw || "unknown");
          if (container.dataset.lastHistoryDay !== dayKey) {
            var heading = document.createElement("div");
            heading.className = "history-date-heading";
            heading.textContent = state.activeTab === "assistidos" ? historyDayLabel(item.watchedAt) : emBreveDayLabel(item.airedRaw);
            container.appendChild(heading);
            container.dataset.lastHistoryDay = dayKey;
          }
        }
        container.appendChild(renderCard(item, state.activeTab));
      } catch (err) {
        console.error("Falha ao renderizar item da lista", item, err);
      }
    });
    state.renderedCount += next.length;

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
  // Re-derives just this series' home-tab entry from the series_progress
  // view (a single lightweight row, computed live by Postgres from the
  // write we just made) instead of re-fetching/recomputing from scratch.
  function refreshSeriesInLists(uuid) {
    return fetchOne("series_progress", "select=*&uuid=eq." + uuid).then(function (rows) {
      var row = rows && rows[0];
      state.minhaLista = state.minhaLista.filter(function (i) { return i.id !== uuid; });
      state.emBreve = state.emBreve.filter(function (i) { return i.id !== uuid; });
      if (row) {
        var built = buildHomeListsFromProgress([row]);
        if (built.minhaLista.length) state.minhaLista.push(built.minhaLista[0]);
        else if (built.emBreve.length) state.emBreve.push(built.emBreve[0]);
        state.seriesProgress = state.seriesProgress.filter(function (s) { return s.uuid !== uuid; }).concat([row]);
      }
      state.emBreveLoaded = false;
      state.emBreveUpcoming = [];
      state.minhaLista.sort(function (a, b) { return (b.lastActivity || "").localeCompare(a.lastActivity || ""); });
      state.emBreve.sort(function (a, b) { return (b.addedAt || "").localeCompare(a.addedAt || ""); });
    });
  }

  function handleCardClick(e) {
    var checkBtn = e.target.closest(".check-btn");
    var undoBtn = e.target.closest(".undo-btn");
    var card = e.target.closest(".card");
    if (!card) return;
    if (card.getAttribute("data-renewal") === "1") return;

    var id = card.getAttribute("data-id");
    var season = parseInt(card.getAttribute("data-season"), 10);
    var episode = parseInt(card.getAttribute("data-episode"), 10);
    var list = getActiveList();
    var item = list.filter(function (i) { return i.id === id && i.season === season && i.episode === episode; })[0];

    // Marking/undoing watched state only ever happens via the right-side
    // button. Clicking anywhere else on the card opens episode details.
    if (!checkBtn && !undoBtn) {
      openEpisodeModal(item || { id: id, season: season, episode: episode, title: "", episodeName: "" });
      return;
    }

    if (checkBtn) {
      checkBtn.classList.add("confirming");
      setTimeout(function () { checkBtn.classList.remove("confirming"); }, 500);

      var title = item ? item.title : "";
      var episodeName = item ? item.episodeName : "";
      var tvdbId = item ? item.tvdbId : null;
      var episodeTvdbId = item ? item.episodeTvdbId : null;

      state.assistidos.unshift({
        id: id, title: title, tvdbId: tvdbId, episodeTvdbId: episodeTvdbId, season: season, episode: episode, episodeName: episodeName,
        watchedAt: new Date().toISOString(), hue1: item ? item.hue1 : 0, hue2: item ? item.hue2 : 40
      });

      patchEpisodeWatched(id, season, episode, true)
        .then(function () { return refreshSeriesInLists(id); })
        .then(function () { renderList(true); })
        .catch(function (err) {
          state.assistidos.shift();
          renderList(true);
          showToast("Erro ao marcar episódio");
          console.error(err);
        });

      showToast("Episódio marcado como assistido", {
        label: "Desfazer",
        onClick: function () {
          state.assistidos = state.assistidos.filter(function (i) {
            return !(i.id === id && i.season === season && i.episode === episode);
          });
          patchEpisodeWatched(id, season, episode, false)
            .then(function () { return refreshSeriesInLists(id); })
            .then(function () { renderList(true); });
        }
      });
      return;
    }

    state.assistidos = state.assistidos.filter(function (i) {
      return !(i.id === id && i.season === season && i.episode === episode);
    });
    renderList(true);
    patchEpisodeWatched(id, season, episode, false).then(function () { return refreshSeriesInLists(id); });

    showToast("Marcação corrigida: episódio não assistido", {
      label: "Desfazer",
      onClick: function () {
        state.assistidos.unshift(item || { id: id, title: "", season: season, episode: episode, episodeName: "", watchedAt: new Date().toISOString(), hue1: 0, hue2: 40 });
        patchEpisodeWatched(id, season, episode, true)
          .then(function () { return refreshSeriesInLists(id); })
          .then(function () { renderList(true); });
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

        if (state.activeTab === "em-breve" && !state.emBreveLoaded) {
          document.getElementById("list-container").innerHTML = '<div class="empty-state">Carregando…</div>';
          loadEmBreveUpcoming().then(function () { renderList(true); });
          return;
        }

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

    document.getElementById("episode-modal-close").addEventListener("click", closeEpisodeModal);
    document.querySelector("#episode-modal .episode-modal-backdrop").addEventListener("click", closeEpisodeModal);
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
  function buildSearchRow(item) {
    var row = document.createElement("div");
    row.className = "search-row";
    row.setAttribute("data-kind", item.kind);
    if (item.id) row.setAttribute("data-id", item.id);
    if (item.tvdbId) row.setAttribute("data-tvdb-id", item.tvdbId);
    if (item.name) row.setAttribute("data-name", item.name);
    if (item.year) row.setAttribute("data-year", item.year);
    row.innerHTML =
      '<div class="search-avatar" style="' + posterStyle(item.hue1, item.hue2) + '">' + escapeHtml(initials(item.title)) + '</div>' +
      '<div class="search-meta">' +
        '<div class="search-title">' + escapeHtml(item.title) + '</div>' +
        '<div class="search-sub">' + escapeHtml(item.sub) + '</div>' +
      '</div>' +
      (item.badge ? '<span class="search-add-badge">' + escapeHtml(item.badge) + '</span>' : '<span class="search-type-badge">' + escapeHtml(item.type) + '</span>');
    if (item.imageUrl) setElementImage(row.querySelector(".search-avatar"), item.imageUrl);
    else if (item.tvdbId && item.kind === "series") applyPosterArtwork(row.querySelector(".search-avatar"), item.tvdbId);
    else if (item.tvdbId && item.kind === "movie") applyMoviePosterArtwork(row.querySelector(".search-avatar"), item.tvdbId);
    return row;
  }

  function renderSearchResults(query) {
    var container = document.getElementById("search-results");
    query = (query || "").trim();
    var qLower = query.toLowerCase();
    if (!qLower) {
      container.innerHTML = '<div class="empty-state">Digite para buscar em filmes e séries.</div>';
      return;
    }

    var localTvdbIds = {};
    var seriesMatches = state.seriesSearchStats
      .filter(function (s) { return (s.title || "").toLowerCase().indexOf(qLower) !== -1; })
      .slice(0, 25)
      .map(function (s) {
        if (s.tvdb_id) localTvdbIds[s.tvdb_id] = true;
        var seed = colorSeed(s.title || "?");
        return {
          kind: "series", id: s.uuid, tvdbId: s.tvdb_id,
          type: "Série", title: s.title || "Sem título",
          sub: s.watched_episodes + "/" + s.total_episodes + " episódios assistidos",
          hue1: seed[0], hue2: seed[1]
        };
      });

    var movieMatches = state.moviesRaw
      .filter(function (m) { return (m.title || "").toLowerCase().indexOf(qLower) !== -1; })
      .slice(0, 25)
      .map(function (m) {
        if (m.tvdb_id) localTvdbIds[m.tvdb_id] = true;
        var seed = colorSeed(m.title || "?");
        return {
          kind: "movie", id: m.uuid, tvdbId: m.tvdb_id,
          type: "Filme", title: m.title || "Sem título",
          sub: (m.year || "—") + " · " + movieWatchedLabel(m) + (m.is_favorite ? " · ★ Favorito" : ""),
          hue1: seed[0], hue2: seed[1]
        };
      });

    var all = seriesMatches.concat(movieMatches);
    container.innerHTML = "";
    if (all.length) {
      all.forEach(function (item) { container.appendChild(buildSearchRow(item)); });
    } else {
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = 'Nada na sua lista para "' + query + '".';
      container.appendChild(empty);
    }

    // Online TheTVDB search for titles not yet in the library, debounced so
    // we don't fire a network+login round trip on every keystroke.
    clearTimeout(renderSearchResults._timer);
    renderSearchResults._timer = setTimeout(function () {
      if (document.getElementById("search-input").value.trim() !== query) return;
      tvdbSearchOnline(query).then(function (results) {
        if (document.getElementById("search-input").value.trim() !== query) return;
        var newOnes = results.filter(function (r) { return !localTvdbIds[r.tvdb_id]; }).slice(0, 8);
        if (!newOnes.length) return;

        var heading = document.createElement("div");
        heading.className = "search-section-heading";
        heading.textContent = "Adicionar da TheTVDB";
        container.appendChild(heading);

        newOnes.forEach(function (r) {
          var seed = colorSeed(r.name || "?");
          container.appendChild(buildSearchRow({
            kind: r.type === "series" ? "add-series" : "add-movie",
            tvdbId: r.tvdb_id, name: r.name, year: r.year,
            title: r.name || "Sem título",
            sub: r.year || (r.type === "series" ? "Série" : "Filme"),
            badge: "+ Adicionar",
            imageUrl: r.image_url,
            hue1: seed[0], hue2: seed[1]
          }));
        });
      });
    }, 400);
  }

  function handleSearchResultClick(e) {
    var row = e.target.closest(".search-row");
    if (!row) return;
    var kind = row.getAttribute("data-kind");
    if (kind === "series") openSeriesDetail(row.getAttribute("data-id"));
    else if (kind === "movie") openMovieDetail(row.getAttribute("data-id"));
    else openAddPreview(
      kind === "add-series" ? "series" : "movie",
      row.getAttribute("data-tvdb-id"),
      row.getAttribute("data-name"),
      row.getAttribute("data-year")
    );
  }

  function setupSearch() {
    var input = document.getElementById("search-input");
    input.addEventListener("input", function () {
      renderSearchResults(input.value);
    });
    document.getElementById("search-results").addEventListener("click", handleSearchResultClick);
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
      '</div>' +
      '<button id="logout-btn" class="logout-btn">Sair</button>';

    document.getElementById("logout-btn").addEventListener("click", logout);
  }

  function statCard(value, label) {
    return '<div class="stat-card"><div class="stat-value">' + value + '</div><div class="stat-label">' + escapeHtml(label) + '</div></div>';
  }

  // ---------- Progress screen ----------
  function buildProgressList(statusFilter) {
    var statsByUuid = {};
    state.seriesSearchStats.forEach(function (s) { statsByUuid[s.uuid] = s; });

    var list = [];
    state.seriesProgress.forEach(function (s) {
      if (s.status === "not_started_yet") return;
      if (statusFilter !== "all" && s.status !== statusFilter) return;

      var stats = statsByUuid[s.uuid];
      var total = stats ? stats.total_episodes : 0;
      var watched = stats ? stats.watched_episodes : 0;
      if (!total) return;

      var seed = colorSeed(s.title || "?");
      list.push({
        id: s.uuid,
        title: s.title || "Sem título",
        tvdbId: s.tvdb_id,
        status: s.status,
        watched: watched,
        total: total,
        pct: Math.round((watched / total) * 100),
        lastActivity: s.last_watched_at || s.created_at,
        hue1: seed[0],
        hue2: seed[1]
      });
    });

    list.sort(function (a, b) { return (b.lastActivity || "").localeCompare(a.lastActivity || ""); });
    return list;
  }

  function progressStatusLabel(status) {
    if (status === "continuing") return "Assistindo";
    if (status === "stopped") return "Parada";
    if (status === "up_to_date") return "Completa";
    if (status === "not_started_yet") return "Não iniciada";
    return "";
  }

  function statusBadgeHtml(status) {
    var label = progressStatusLabel(status);
    if (!label) return "";
    return '<span id="detail-status-badge" class="progress-status-badge progress-status-' + escapeHtml(status) + '">' + escapeHtml(label) + '</span>';
  }

  function progressCard(item) {
    var wrap = document.createElement("div");
    wrap.className = "progress-card";
    wrap.setAttribute("data-id", item.id);
    wrap.innerHTML =
      '<div class="progress-card-poster" style="' + posterStyle(item.hue1, item.hue2) + '">' + escapeHtml(initials(item.title)) + '</div>' +
      '<div class="progress-card-info">' +
        '<div class="progress-card-title">' + escapeHtml(item.title) + '</div>' +
        '<div class="progress-card-meta">' +
          '<span class="progress-status-badge progress-status-' + escapeHtml(item.status) + '">' + escapeHtml(progressStatusLabel(item.status)) + '</span>' +
          '<span class="progress-count">' + item.watched + '/' + item.total + ' episódios</span>' +
        '</div>' +
        '<div class="progress-bar-track"><div class="progress-bar-fill" style="width:' + item.pct + '%"></div></div>' +
      '</div>';
    applyPosterArtwork(wrap.querySelector(".progress-card-poster"), item.tvdbId);
    return wrap;
  }

  // Movies don't have episode progress — the "Filmes" tab reuses the data
  // already loaded in state.moviesRaw (is_watched, watched_at, is_favorite,
  // year) to show a collection-level summary plus one card per movie.
  function movieWatchedLabel(m) {
    if (!m.is_watched) return "Não assistido";
    return m.watched_at ? formatWatchedAt(m.watched_at) : "Assistido";
  }

  function movieProgressCard(m) {
    var title = m.title || "Sem título";
    var seed = colorSeed(title);
    var wrap = document.createElement("div");
    wrap.className = "progress-card";
    wrap.setAttribute("data-movie-id", m.uuid);
    var metaLine = (m.year ? m.year + " · " : "") + movieWatchedLabel(m);
    wrap.innerHTML =
      '<div class="progress-card-poster" style="' + posterStyle(seed[0], seed[1]) + '">' + escapeHtml(initials(title)) + '</div>' +
      '<div class="progress-card-info">' +
        '<div class="progress-card-title">' + escapeHtml(title) +
          (m.is_favorite ? ' <span class="progress-fav-star" title="Favorito">★</span>' : '') + '</div>' +
        '<div class="progress-card-meta">' +
          '<span class="progress-status-badge progress-status-' + (m.is_watched ? 'movie_watched' : 'movie_unwatched') + '">' +
            (m.is_watched ? 'Assistido' : 'Pendente') + '</span>' +
          '<span class="progress-count">' + escapeHtml(metaLine) + '</span>' +
        '</div>' +
      '</div>';
    return wrap;
  }

  function renderMoviesProgress(container) {
    var movies = state.moviesRaw.slice();
    if (!movies.length) {
      container.innerHTML = '<div class="empty-state">Nenhum filme na sua lista.</div>';
      return;
    }

    var watched = movies.filter(function (m) { return m.is_watched; }).length;
    var favorites = movies.filter(function (m) { return m.is_favorite; }).length;
    var pct = Math.round((watched / movies.length) * 100);

    var summary = document.createElement("div");
    summary.className = "movies-progress-summary";
    summary.innerHTML =
      '<div class="progress-card-meta">' +
        '<span class="progress-count">' + watched + '/' + movies.length + ' filmes assistidos (' + pct + '%)' +
          (favorites ? ' · ★ ' + favorites + ' favoritos' : '') + '</span>' +
      '</div>' +
      '<div class="progress-bar-track"><div class="progress-bar-fill" style="width:' + pct + '%"></div></div>';
    container.appendChild(summary);

    // Pending movies first (that's the actionable part of "progress"),
    // then watched ones by most recent watch date.
    movies.sort(function (a, b) {
      if (!a.is_watched !== !b.is_watched) return a.is_watched ? 1 : -1;
      if (a.is_watched) {
        var cmp = (b.watched_at || "").localeCompare(a.watched_at || "");
        if (cmp !== 0) return cmp;
      }
      return (a.title || "").localeCompare(b.title || "");
    });
    movies.forEach(function (m) { container.appendChild(movieProgressCard(m)); });
  }

  function renderProgressList() {
    var container = document.getElementById("progress-container");
    container.innerHTML = "";

    if (state.activeProgressStatus === "movies") {
      renderMoviesProgress(container);
      return;
    }

    var list = buildProgressList(state.activeProgressStatus);
    if (!list.length) {
      container.innerHTML = '<div class="empty-state">Nenhuma série encontrada.</div>';
      return;
    }
    list.forEach(function (item) { container.appendChild(progressCard(item)); });
  }

  function setupProgressControls() {
    document.querySelectorAll(".progress-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        document.querySelectorAll(".progress-tab").forEach(function (t) { t.classList.remove("active"); });
        tab.classList.add("active");
        state.activeProgressStatus = tab.getAttribute("data-status");
        renderProgressList();
      });
    });

    document.getElementById("progress-container").addEventListener("click", function (e) {
      var card = e.target.closest(".progress-card");
      if (!card) return;
      var movieId = card.getAttribute("data-movie-id");
      if (movieId) openMovieDetail(movieId);
      else openSeriesDetail(card.getAttribute("data-id"));
    });
  }

  // ---------- Supabase data fetching ----------
  function authHeaders(extra) {
    var token = (state.authSession && state.authSession.accessToken) || SUPABASE_CONFIG.anonKey;
    var headers = { apikey: SUPABASE_CONFIG.anonKey, Authorization: "Bearer " + token };
    if (extra) for (var k in extra) headers[k] = extra[k];
    return headers;
  }

  function handleAuthFailure(r) {
    if (r.status === 401 || r.status === 403) {
      clearAuthSession();
      location.reload();
      throw new Error("Sessão expirada, faça login novamente.");
    }
    return r;
  }

  function fetchAllRows(table, query) {
    var all = [];
    function fetchPage(from) {
      var url = SUPABASE_CONFIG.url + "/rest/v1/" + table + "?" + query;
      return fetch(url, {
        headers: authHeaders({ Range: from + "-" + (from + REST_PAGE_SIZE - 1) })
      }).then(function (r) {
        handleAuthFailure(r);
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
    return fetch(url, { headers: authHeaders() }).then(function (r) {
      handleAuthFailure(r);
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
        tvdb_id: ep.tvdb_id,
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

  // Swaps a poster/avatar element's gradient placeholder for a real cover
  // once it loads, without blocking the initial render.
  function setElementImage(el, url) {
    if (!url) return;
    var preload = new Image();
    preload.onload = function () {
      if (!document.body.contains(el)) return;
      // The gradient placeholder was set via the "background" shorthand,
      // which implicitly resets background-size/position to "auto" inline
      // (beating the stylesheet's "cover"). Set them explicitly here too.
      el.style.backgroundImage = "url('" + url.replace(/'/g, "\\'") + "')";
      el.style.backgroundSize = "cover";
      el.style.backgroundPosition = "center";
      el.style.backgroundRepeat = "no-repeat";
      el.classList.add("has-image");
    };
    preload.src = url;
  }

  function applyPosterArtwork(posterEl, tvdbId) {
    if (!tvdbId) return;
    fetchSeriesArtwork(tvdbId).then(function (url) { setElementImage(posterEl, url); });
  }

  // Movie covers come from the movies/{id}/extended endpoint, which the
  // detail screen already fetches and caches — search rows just reuse it.
  function applyMoviePosterArtwork(posterEl, tvdbId) {
    if (!tvdbId) return;
    fetchMovieExtendedInfo(tvdbId).then(function (info) {
      if (info && info.image) setElementImage(posterEl, info.image);
    });
  }

  // Single-request upcoming-episode lookup for the "Em breve" calendar:
  // /series/{id}/extended?meta=episodes returns the series' full episode
  // list (with air dates) in one call, so each non-stopped series costs one
  // request and yields its entire upcoming sequence — not just the next one.
  var tvdbUpcomingCache = {};
  function fetchSeriesUpcomingEpisodes(tvdbId) {
    if (!tvdbId || !TVDB_CONFIG || !TVDB_CONFIG.apiKey) return Promise.resolve([]);
    if (tvdbUpcomingCache[tvdbId]) return tvdbUpcomingCache[tvdbId];
    tvdbUpcomingCache[tvdbId] = getTvdbToken().then(function (token) {
      if (!token) return [];
      return fetch(TVDB_API_BASE + "/series/" + tvdbId + "/extended?meta=episodes&short=true", { headers: { Authorization: "Bearer " + token } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (json) {
          var eps = (json && json.data && json.data.episodes) || [];
          return eps.filter(function (e) { return e.aired && e.seasonNumber > 0; });
        })
        .catch(function () { return []; });
    }).catch(function () { return []; });
    return tvdbUpcomingCache[tvdbId];
  }

  var tvdbEpisodeCache = {};
  function fetchEpisodeDetails(episodeTvdbId) {
    if (!episodeTvdbId || !TVDB_CONFIG || !TVDB_CONFIG.apiKey) return Promise.resolve(null);
    if (tvdbEpisodeCache[episodeTvdbId]) return tvdbEpisodeCache[episodeTvdbId];

    tvdbEpisodeCache[episodeTvdbId] = getTvdbToken().then(function (token) {
      if (!token) return null;
      var headers = { Authorization: "Bearer " + token };
      // Never trust the base "extended" name/overview alone — for shows
      // whose original language isn't Portuguese or English, it comes back
      // in that original language. Always prefer the por/eng translations.
      return Promise.all([
        fetch(TVDB_API_BASE + "/episodes/" + episodeTvdbId + "/extended", { headers: headers })
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; }),
        fetch(TVDB_API_BASE + "/episodes/" + episodeTvdbId + "/translations/por", { headers: headers })
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; }),
        fetch(TVDB_API_BASE + "/episodes/" + episodeTvdbId + "/translations/eng", { headers: headers })
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; })
      ]).then(function (results) {
        var base = results[0] && results[0].data;
        var pt = results[1] && results[1].data;
        var en = results[2] && results[2].data;
        if (!base) return null;
        return {
          name: (pt && pt.name) || (en && en.name) || null,
          overview: (pt && pt.overview) || (en && en.overview) || null,
          image: base.image || null,
          aired: base.aired || null,
          runtime: base.runtime || null
        };
      });
    }).catch(function (err) {
      console.error(err);
      return null;
    });
    return tvdbEpisodeCache[episodeTvdbId];
  }

  function formatAiredDate(dateStr) {
    if (!dateStr) return null;
    var d = new Date(dateStr + "T00:00:00");
    if (isNaN(d.getTime())) return null;
    return pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + "/" + d.getFullYear();
  }

  function daysUntil(dateStr) {
    var d = new Date(dateStr + "T00:00:00");
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((d - today) / 86400000);
  }
  function formatCountdown(diffDays) {
    if (diffDays <= 0) return "Hoje";
    if (diffDays === 1) return "Amanhã";
    return "Em " + diffDays + " dias";
  }

  // dateStr is a plain "YYYY-MM-DD" from TheTVDB, so it doubles as a stable
  // group key across series — no Date parsing needed to compare days.
  function emBreveDayLabel(dateStr) {
    var day = new Date(dateStr + "T00:00:00");
    if (isNaN(day.getTime())) return "Data desconhecida";
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var diffDays = Math.round((day - today) / 86400000);
    if (diffDays === 0) return "Hoje";
    if (diffDays === 1) return "Amanhã";
    if (diffDays > 1 && diffDays < 7) return WEEKDAYS_PT[day.getDay()];
    return pad2(day.getDate()) + "/" + pad2(day.getMonth() + 1) + "/" + day.getFullYear();
  }

  var EM_BREVE_WINDOW_DAYS = 100;

  // "Em breve" is a release calendar: every series except the ones marked
  // "stopped" gets its full episode list checked against TheTVDB, keeping
  // every episode that airs within the next 100 days — the whole upcoming
  // sequence per series (e.g. each weekly episode of an airing season), not
  // just the next one.
  function loadEmBreveUpcoming() {
    if (state.emBreveLoaded || state.emBreveLoading) return Promise.resolve();
    state.emBreveLoading = true;

    var eligible = state.seriesProgress.filter(function (s) {
      return s.status !== "stopped" && s.tvdb_id;
    });

    var upcoming = [];
    return Promise.all(eligible.map(function (s) {
      return fetchSeriesUpcomingEpisodes(s.tvdb_id).then(function (eps) {
        var seed = colorSeed(s.title || "?");
        eps.forEach(function (ep) {
          var diff = daysUntil(ep.aired);
          if (diff < 0 || diff > EM_BREVE_WINDOW_DAYS) return;
          upcoming.push({
            id: s.uuid, title: s.title || "Sem título", tvdbId: s.tvdb_id,
            episodeTvdbId: ep.id,
            season: ep.seasonNumber,
            episode: ep.number,
            episodeName: (ep.name && ep.name !== "TBA") ? ep.name : ("Episódio " + ep.number),
            airedRaw: ep.aired,
            airedLabel: formatAiredDate(ep.aired),
            countdownLabel: formatCountdown(diff),
            noAction: true,
            hue1: seed[0], hue2: seed[1]
          });
        });
      });
    })).then(function () {
      upcoming.sort(function (a, b) {
        var cmp = a.airedRaw.localeCompare(b.airedRaw);
        if (cmp !== 0) return cmp;
        cmp = (a.title || "").localeCompare(b.title || "");
        if (cmp !== 0) return cmp;
        return (a.season - b.season) || (a.episode - b.episode);
      });
      state.emBreveUpcoming = upcoming;
      state.emBreveLoaded = true;
      state.emBreveLoading = false;
    }).catch(function (err) {
      state.emBreveLoading = false;
      console.error(err);
    });
  }

  // ---------- Series / movie detail screen ----------
  var tvdbExtendedCache = {};
  function fetchExtendedInfo(kind, tvdbId) {
    if (!tvdbId || !TVDB_CONFIG || !TVDB_CONFIG.apiKey) return Promise.resolve(null);
    var cacheKey = kind + ":" + tvdbId;
    if (tvdbExtendedCache[cacheKey]) return tvdbExtendedCache[cacheKey];

    tvdbExtendedCache[cacheKey] = getTvdbToken().then(function (token) {
      if (!token) return null;
      var headers = { Authorization: "Bearer " + token };
      return Promise.all([
        fetch(TVDB_API_BASE + "/" + kind + "/" + tvdbId + "/extended", { headers: headers })
          .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
        fetch(TVDB_API_BASE + "/" + kind + "/" + tvdbId + "/translations/por", { headers: headers })
          .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
        fetch(TVDB_API_BASE + "/" + kind + "/" + tvdbId + "/translations/eng", { headers: headers })
          .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
      ]).then(function (results) {
        var base = results[0] && results[0].data;
        var pt = results[1] && results[1].data;
        var en = results[2] && results[2].data;
        if (!base) return null;

        var studio = null;
        if (base.companies && !Array.isArray(base.companies)) {
          var pool = (base.companies.studio || []).concat(base.companies.production || []);
          studio = pool.length ? pool[0].name : null;
        } else if (Array.isArray(base.companies) && base.companies.length) {
          studio = base.companies[0].name;
        }

        return {
          // Title falls back to the base name as a last resort (better than
          // nothing), but the synopsis is strictly PT/EN — never the show's
          // original-language overview.
          name: (pt && pt.name) || (en && en.name) || base.name || null,
          overview: (pt && pt.overview) || (en && en.overview) || null,
          image: base.image || null,
          status: base.status && base.status.name,
          year: base.year || null,
          genres: (base.genres || []).map(function (g) { return g.name; }),
          runtime: base.averageRuntime || base.runtime || null,
          studio: studio,
          nextAired: base.nextAired || null
        };
      });
    }).catch(function (err) {
      console.error(err);
      return null;
    });
    return tvdbExtendedCache[cacheKey];
  }
  function fetchSeriesExtendedInfo(tvdbId) { return fetchExtendedInfo("series", tvdbId); }
  function fetchMovieExtendedInfo(tvdbId) { return fetchExtendedInfo("movies", tvdbId); }

  function detailBadgesHtml(badges) {
    return badges.length
      ? '<div class="detail-meta-row">' + badges.map(function (b) { return '<span class="detail-badge">' + escapeHtml(b) + '</span>'; }).join("") + '</div>'
      : "";
  }

  function closeDetailScreen() {
    document.getElementById("detail-screen").classList.remove("show");
  }

  function openSeriesDetail(uuid) {
    var screen = document.getElementById("detail-screen");
    var body = document.getElementById("detail-body");
    var meta = state.seriesSearchStats.filter(function (s) { return s.uuid === uuid; })[0];

    body.innerHTML = '<div class="detail-loading">Carregando…</div>';
    screen.classList.add("show");
    screen.setAttribute("data-kind", "series");
    screen.setAttribute("data-id", uuid);

    Promise.all([
      fetchSeriesDetail(uuid),
      meta && meta.tvdb_id ? fetchSeriesExtendedInfo(meta.tvdb_id) : Promise.resolve(null)
    ]).then(function (results) {
      if (screen.getAttribute("data-id") !== uuid) return; // user navigated away meanwhile
      renderSeriesDetail(uuid, results[0], results[1]);
    }).catch(function (err) {
      body.innerHTML = '<div class="detail-empty">Erro ao carregar detalhes desta série.</div>';
      console.error(err);
    });
  }

  function renderSeriesDetail(uuid, detail, extended) {
    var body = document.getElementById("detail-body");
    var title = detail.title || "Sem título";
    var seed = colorSeed(title);

    var seasons = (detail.seasons || []).slice().sort(function (a, b) { return (a.number || 0) - (b.number || 0); });
    var totalEps = 0, watchedEps = 0;
    seasons.forEach(function (se) {
      if (se.is_specials) return;
      (se.episodes || []).forEach(function (ep) { totalEps++; if (ep.is_watched) watchedEps++; });
    });

    var badges = [];
    if (extended) {
      if (extended.status) badges.push(extended.status);
      if (extended.year) badges.push(String(extended.year));
      if (extended.runtime) badges.push(extended.runtime + " min/ep");
      badges = badges.concat((extended.genres || []).slice(0, 3));
    }

    var heroImage = extended && extended.image;
    var overview = (extended && extended.overview) || "Sinopse não disponível.";
    var studioLine = extended && extended.studio;

    var seasonsHtml = seasons.map(function (se) {
      var heading = se.is_specials ? "Especiais" : "Temporada " + se.number;
      var eps = (se.episodes || []).slice().sort(function (a, b) { return (a.number || 0) - (b.number || 0); });
      var rowsHtml = eps.map(function (ep) {
        return '<div class="episode-row' + (ep.is_watched ? ' watched' : '') + (se.is_specials ? ' special-row' : '') + '" data-season="' + se.number + '" data-episode="' + ep.number + '">' +
          '<div class="episode-row-number">' + pad2(ep.number) + '</div>' +
          '<div class="episode-row-name">' + escapeHtml(ep.name || ("Episódio " + ep.number)) + '</div>' +
          '<div class="episode-row-check">' + iconCheck() + '</div>' +
        '</div>';
      }).join("");
      if (se.is_specials) {
        return '<div class="season-heading season-heading-toggle" data-toggle-specials="1">' + escapeHtml(heading) +
          ' <span class="specials-count">(' + eps.length + ')</span></div>' +
          '<div class="episode-row-list specials-list">' + rowsHtml + '</div>';
      }
      return '<div class="season-heading">' + escapeHtml(heading) + '</div><div class="episode-row-list">' + rowsHtml + '</div>';
    }).join("");

    var progressRow = state.seriesProgress.filter(function (s) { return s.uuid === uuid; })[0];
    var libraryStatus = progressRow && progressRow.status;

    body.innerHTML =
      '<div class="detail-hero" style="' + (heroImage ? "background-image:url('" + heroImage.replace(/'/g, "\\'") + "')" : posterStyle(seed[0], seed[1])) + '">' +
        '<div class="detail-hero-fade"></div>' +
        '<div class="detail-hero-info">' +
          '<div class="detail-title">' + escapeHtml(title) + '</div>' +
          detailBadgesHtml(badges) +
          '<div class="detail-progress">' + statusBadgeHtml(libraryStatus) +
            '<span id="detail-progress-count">' + watchedEps + '/' + totalEps + ' episódios assistidos</span>' +
            (studioLine ? ' · ' + escapeHtml(studioLine) : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-section">' +
        '<div class="detail-overview">' + escapeHtml(overview) + '</div>' +
        // Watching/stopped is the user's call; completed/not-started are
        // derived from episode data by the DB trigger, so only offer the
        // toggle in the two manual states.
        ((libraryStatus === "continuing" || libraryStatus === "stopped")
          ? '<button id="toggle-status-btn" class="toggle-status-btn">' +
              (libraryStatus === "continuing" ? "Parar de assistir" : "Voltar a assistir") + '</button>'
          : '') +
        '<button id="remove-from-library-btn" class="remove-from-library-btn">Remover da minha lista</button>' +
      '</div>' +
      seasonsHtml;

    var toggleBtn = document.getElementById("toggle-status-btn");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", function () {
        handleStatusToggle(toggleBtn, uuid);
      });
    }

    document.getElementById("remove-from-library-btn").addEventListener("click", function () {
      handleRemoveClick(this, "series", uuid, title);
    });
  }

  function handleStatusToggle(btn, uuid) {
    var progressRow = state.seriesProgress.filter(function (s) { return s.uuid === uuid; })[0];
    if (!progressRow) return;
    var newStatus = progressRow.status === "continuing" ? "stopped" : "continuing";

    btn.disabled = true;
    patchSeriesStatus(uuid, newStatus).then(function () {
      return refreshSeriesInLists(uuid);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = newStatus === "continuing" ? "Parar de assistir" : "Voltar a assistir";
      var badge = document.getElementById("detail-status-badge");
      if (badge) {
        badge.className = "progress-status-badge progress-status-" + newStatus;
        badge.textContent = progressStatusLabel(newStatus);
      }
      renderList(true);
      renderProgressList();
      showToast(newStatus === "continuing" ? "Série marcada como assistindo" : "Série marcada como parada");
    }).catch(function (err) {
      btn.disabled = false;
      showToast("Erro ao alterar status da série");
      console.error(err);
    });
  }

  function handleDetailBodyClick(e) {
    var screen = document.getElementById("detail-screen");
    if (screen.getAttribute("data-kind") !== "series") return;

    var toggle = e.target.closest(".season-heading-toggle");
    if (toggle) {
      toggle.classList.toggle("expanded");
      var list = toggle.nextElementSibling;
      if (list) list.classList.toggle("expanded");
      return;
    }

    var row = e.target.closest(".episode-row");
    if (!row) return;

    var uuid = screen.getAttribute("data-id");
    var season = parseInt(row.getAttribute("data-season"), 10);
    var episode = parseInt(row.getAttribute("data-episode"), 10);
    var nowWatched = !row.classList.contains("watched");

    var detail = state.seriesDetailCache[uuid];
    var epObj = null;
    (detail.seasons || []).forEach(function (se) {
      if (se.number !== season) return;
      (se.episodes || []).forEach(function (ep) { if (ep.number === episode) epObj = ep; });
    });

    var seriesMeta = state.seriesSearchStats.filter(function (s) { return s.uuid === uuid; })[0];
    var title = (seriesMeta && seriesMeta.title) || detail.title || "";
    var episodeName = epObj ? (epObj.name || ("Episódio " + episode)) : ("Episódio " + episode);
    var seed = colorSeed(title);

    row.classList.toggle("watched", nowWatched);
    var countEl = document.getElementById("detail-progress-count");
    if (countEl) {
      var total = document.querySelectorAll(".episode-row:not(.special-row)").length;
      var watched = document.querySelectorAll(".episode-row.watched:not(.special-row)").length;
      countEl.textContent = watched + "/" + total + " episódios assistidos";
    }

    if (nowWatched) {
      state.assistidos.unshift({
        id: uuid, title: title, tvdbId: detail.tvdb_id, episodeTvdbId: epObj ? epObj.tvdb_id : null,
        season: season, episode: episode, episodeName: episodeName,
        watchedAt: new Date().toISOString(), hue1: seed[0], hue2: seed[1]
      });
    } else {
      state.assistidos = state.assistidos.filter(function (i) {
        return !(i.id === uuid && i.season === season && i.episode === episode);
      });
    }
    if (epObj) {
      epObj.is_watched = nowWatched;
      epObj.watched_at = nowWatched ? new Date().toISOString() : null;
    }
    if (seriesMeta) seriesMeta.watched_episodes += nowWatched ? 1 : -1;

    patchEpisodeWatched(uuid, season, episode, nowWatched)
      .then(function () { return refreshSeriesInLists(uuid); })
      .then(function () {
        // The DB trigger may have flipped the series' status — reflect it
        // on the badge without re-rendering the whole detail screen.
        var badge = document.getElementById("detail-status-badge");
        var rowNow = state.seriesProgress.filter(function (s) { return s.uuid === uuid; })[0];
        if (badge && rowNow && rowNow.status) {
          badge.className = "progress-status-badge progress-status-" + rowNow.status;
          badge.textContent = progressStatusLabel(rowNow.status);
        }
      })
      .catch(function (err) {
        // revert the optimistic UI if the write actually failed
        row.classList.toggle("watched", !nowWatched);
        if (epObj) { epObj.is_watched = !nowWatched; epObj.watched_at = nowWatched ? null : epObj.watched_at; }
        if (seriesMeta) seriesMeta.watched_episodes += nowWatched ? -1 : 1;
        showToast("Erro ao atualizar episódio");
        console.error(err);
      });
  }

  function openMovieDetail(uuid) {
    var screen = document.getElementById("detail-screen");
    var body = document.getElementById("detail-body");
    var movie = state.moviesRaw.filter(function (m) { return m.uuid === uuid; })[0];
    if (!movie) return;

    body.innerHTML = '<div class="detail-loading">Carregando…</div>';
    screen.classList.add("show");
    screen.setAttribute("data-kind", "movie");
    screen.setAttribute("data-id", uuid);

    (movie.tvdb_id ? fetchMovieExtendedInfo(movie.tvdb_id) : Promise.resolve(null)).then(function (extended) {
      if (screen.getAttribute("data-id") !== uuid) return;
      renderMovieDetail(movie, extended);
    }).catch(function (err) {
      body.innerHTML = '<div class="detail-empty">Erro ao carregar detalhes deste filme.</div>';
      console.error(err);
    });
  }

  function renderMovieDetail(movie, extended) {
    var body = document.getElementById("detail-body");
    var title = movie.title || "Sem título";
    var seed = colorSeed(title);

    var badges = [];
    if (extended && extended.status) badges.push(extended.status);
    if (extended && extended.year) badges.push(String(extended.year));
    else if (movie.year) badges.push(String(movie.year));
    if (extended && extended.runtime) badges.push(extended.runtime + " min");
    if (extended) badges = badges.concat((extended.genres || []).slice(0, 3));

    var heroImage = extended && extended.image;
    var overview = (extended && extended.overview) || "Sinopse não disponível.";
    var studioLine = extended && extended.studio;

    body.innerHTML =
      '<div class="detail-hero" style="' + (heroImage ? "background-image:url('" + heroImage.replace(/'/g, "\\'") + "')" : posterStyle(seed[0], seed[1])) + '">' +
        '<div class="detail-hero-fade"></div>' +
        '<div class="detail-hero-info">' +
          '<div class="detail-title">' + escapeHtml(title) + '</div>' +
          detailBadgesHtml(badges) +
          (studioLine ? '<div class="detail-progress">' + escapeHtml(studioLine) + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="detail-section">' +
        '<div class="detail-overview">' + escapeHtml(overview) + '</div>' +
        '<button id="movie-watch-toggle" class="movie-watch-btn' + (movie.is_watched ? ' watched' : '') + '">' +
          (movie.is_watched ? "Assistido ✓" : "Marcar como assistido") +
        '</button>' +
        '<button id="remove-from-library-btn" class="remove-from-library-btn">Remover da minha lista</button>' +
      '</div>';

    document.getElementById("movie-watch-toggle").addEventListener("click", function () {
      var btn = this;
      var nowWatched = !movie.is_watched;
      movie.is_watched = nowWatched;
      movie.watched_at = nowWatched ? new Date().toISOString() : null;
      btn.classList.toggle("watched", nowWatched);
      btn.textContent = nowWatched ? "Assistido ✓" : "Marcar como assistido";
      renderProgressList();

      patchMovieWatched(movie.uuid, nowWatched).catch(function (err) {
        movie.is_watched = !nowWatched;
        movie.watched_at = nowWatched ? null : movie.watched_at;
        btn.classList.toggle("watched", !nowWatched);
        btn.textContent = !nowWatched ? "Assistido ✓" : "Marcar como assistido";
        renderProgressList();
        showToast("Erro ao atualizar filme");
        console.error(err);
      });
    });

    document.getElementById("remove-from-library-btn").addEventListener("click", function () {
      handleRemoveClick(this, "movie", movie.uuid, title);
    });
  }

  function setupDetailScreen() {
    document.getElementById("detail-back").addEventListener("click", closeDetailScreen);
    document.getElementById("detail-body").addEventListener("click", handleDetailBodyClick);
  }

  // ---------- Remove a title from the library ----------
  function deleteRow(table, uuid) {
    return fetch(SUPABASE_CONFIG.url + "/rest/v1/" + table + "?uuid=eq." + uuid, {
      method: "DELETE",
      headers: authHeaders({ Prefer: "return=minimal" })
    }).then(function (r) {
      handleAuthFailure(r);
      if (!r.ok) return r.text().then(function (t) { throw new Error("Falha ao remover: " + t); });
    });
  }

  function removeSeriesFromState(uuid) {
    state.seriesProgress = state.seriesProgress.filter(function (s) { return s.uuid !== uuid; });
    state.seriesSearchStats = state.seriesSearchStats.filter(function (s) { return s.uuid !== uuid; });
    state.minhaLista = state.minhaLista.filter(function (i) { return i.id !== uuid; });
    state.emBreve = state.emBreve.filter(function (i) { return i.id !== uuid; });
    state.emBreveUpcoming = state.emBreveUpcoming.filter(function (i) { return i.id !== uuid; });
    state.assistidos = state.assistidos.filter(function (i) { return i.id !== uuid; });
    delete state.seriesDetailCache[uuid];
  }

  function removeMovieFromState(uuid) {
    state.moviesRaw = state.moviesRaw.filter(function (m) { return m.uuid !== uuid; });
  }

  function handleRemoveClick(btn, kind, uuid, title) {
    var confirmed = window.confirm(
      'Remover "' + title + '" da sua lista?\nIsso apaga o título e ' +
      (kind === "series" ? "todos os episódios marcados" : "o registro") +
      " permanentemente. Essa ação não pode ser desfeita."
    );
    if (!confirmed) return;

    btn.disabled = true;
    btn.textContent = "Removendo…";

    deleteRow(kind === "series" ? "series" : "movies", uuid).then(function () {
      if (kind === "series") removeSeriesFromState(uuid);
      else removeMovieFromState(uuid);

      closeDetailScreen();
      renderList(true);
      renderProgressList();
      renderSearchResults(document.getElementById("search-input").value);
      showToast('"' + title + '" removido da sua lista');
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = "Remover da minha lista";
      showToast("Erro ao remover título");
      console.error(err);
    });
  }

  // ---------- Add new titles from TheTVDB ----------
  function tvdbSearchOnline(query) {
    if (!TVDB_CONFIG || !TVDB_CONFIG.apiKey) return Promise.resolve([]);
    return getTvdbToken().then(function (token) {
      if (!token) return [];
      return fetch(TVDB_API_BASE + "/search?query=" + encodeURIComponent(query) + "&limit=12", {
        headers: { Authorization: "Bearer " + token }
      }).then(function (r) { return r.ok ? r.json() : { data: [] }; });
    }).then(function (json) {
      return (json.data || []).filter(function (r) { return r.type === "series" || r.type === "movie"; });
    }).catch(function (err) {
      console.error(err);
      return [];
    });
  }

  function generateUuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function insertRows(table, rows) {
    if (!rows.length) return Promise.resolve();
    return fetch(SUPABASE_CONFIG.url + "/rest/v1/" + table, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify(rows)
    }).then(function (r) {
      handleAuthFailure(r);
      if (!r.ok) return r.text().then(function (t) { throw new Error("Falha ao inserir em " + table + ": " + t); });
    });
  }

  // The plain "/episodes/default" list returns names/overviews in the
  // show's original language. Fetch the Portuguese and English localized
  // variants instead (same episodes, just localized names) and merge,
  // so nothing in another language ever gets written to our tables.
  function fetchTvdbEpisodesLang(tvdbId, lang) {
    var all = [];
    function fetchPage(page) {
      return getTvdbToken().then(function (token) {
        return fetch(TVDB_API_BASE + "/series/" + tvdbId + "/episodes/default/" + lang + "?page=" + page, {
          headers: { Authorization: "Bearer " + token }
        }).then(function (r) { return r.ok ? r.json() : { data: { episodes: [] } }; });
      }).then(function (json) {
        all = all.concat((json.data && json.data.episodes) || []);
        if (json.links && json.links.next) return fetchPage(page + 1);
        return all;
      }).catch(function () { return all; });
    }
    return fetchPage(0);
  }

  function fetchTvdbSeriesEpisodes(tvdbId) {
    return Promise.all([
      fetchTvdbEpisodesLang(tvdbId, "por"),
      fetchTvdbEpisodesLang(tvdbId, "eng")
    ]).then(function (results) {
      var ptList = results[0], enList = results[1];
      var enById = {};
      enList.forEach(function (ep) { enById[ep.id] = ep; });
      var base = ptList.length ? ptList : enList;
      return base.map(function (ep) {
        var en = enById[ep.id];
        return {
          id: ep.id,
          seasonNumber: ep.seasonNumber,
          number: ep.number,
          name: ep.name || (en && en.name) || null
        };
      });
    });
  }

  // Adds a series (with all its seasons/episodes) discovered via TheTVDB
  // search into our own tables, so it behaves exactly like an imported title
  // from then on. No-ops and reuses the existing row if already present.
  function addSeriesFromTvdb(tvdbId, name) {
    return fetchOne("series", "select=uuid&tvdb_id=eq." + tvdbId).then(function (existing) {
      if (existing && existing.length) return existing[0].uuid;

      return fetchTvdbSeriesEpisodes(tvdbId).then(function (episodes) {
        var uuid = generateUuid();
        var seasonNumbers = {};
        episodes.forEach(function (ep) { seasonNumbers[ep.seasonNumber] = true; });
        var seasonRows = Object.keys(seasonNumbers).map(function (n) {
          return { series_uuid: uuid, number: parseInt(n, 10), is_specials: parseInt(n, 10) === 0 };
        });
        var episodeRows = episodes.map(function (ep) {
          return {
            series_uuid: uuid,
            season_number: ep.seasonNumber,
            tvdb_id: ep.id,
            number: ep.number,
            name: ep.name,
            special: ep.seasonNumber === 0,
            is_watched: false,
            watched_at: null,
            rewatch_count: 0,
            watched_count: 0
          };
        });

        return insertRows("series", [{
          uuid: uuid, tvdb_id: parseInt(tvdbId, 10), title: name, status: null,
          is_favorite: false, created_at: new Date().toISOString()
        }])
          .then(function () { return insertRows("seasons", seasonRows); })
          .then(function () { return insertRows("episodes", episodeRows); })
          .then(function () { return uuid; });
      });
    });
  }

  function addMovieFromTvdb(tvdbId, name, year) {
    return fetchOne("movies", "select=uuid&tvdb_id=eq." + tvdbId).then(function (existing) {
      if (existing && existing.length) return existing[0].uuid;
      var uuid = generateUuid();
      return insertRows("movies", [{
        uuid: uuid, tvdb_id: parseInt(tvdbId, 10), title: name, year: year ? parseInt(year, 10) : null,
        created_at: new Date().toISOString(), watched_at: null, is_watched: false,
        is_favorite: false, rewatch_count: 0
      }]).then(function () { return uuid; });
    });
  }

  function refreshLibraryAfterAdd(kind, uuid, title, tvdbId) {
    if (kind === "series") {
      return refreshSeriesInLists(uuid).then(function () {
        return fetchOne("series_search_stats", "select=*&uuid=eq." + uuid);
      }).then(function (rows) {
        if (rows && rows[0]) state.seriesSearchStats.push(rows[0]);
      });
    }
    return fetchOne("movies", "select=*&uuid=eq." + uuid).then(function (rows) {
      if (rows && rows[0]) state.moviesRaw.push(rows[0]);
    });
  }

  function openAddPreview(kind, tvdbId, name, year) {
    var screen = document.getElementById("detail-screen");
    var body = document.getElementById("detail-body");

    body.innerHTML = '<div class="detail-loading">Carregando…</div>';
    screen.classList.add("show");
    screen.setAttribute("data-kind", "add-" + kind);
    screen.setAttribute("data-tvdb-id", tvdbId);

    var fetchFn = kind === "series" ? fetchSeriesExtendedInfo : fetchMovieExtendedInfo;
    fetchFn(tvdbId).then(function (extended) {
      if (screen.getAttribute("data-tvdb-id") !== String(tvdbId)) return;
      renderAddPreview(kind, tvdbId, name, year, extended);
    }).catch(function (err) {
      body.innerHTML = '<div class="detail-empty">Erro ao carregar informações.</div>';
      console.error(err);
    });
  }

  function renderAddPreview(kind, tvdbId, name, year, extended) {
    var body = document.getElementById("detail-body");
    var title = (extended && extended.name) || name || "Sem título";
    var seed = colorSeed(title);

    var badges = [];
    if (extended && extended.status) badges.push(extended.status);
    if (extended && extended.year) badges.push(String(extended.year));
    else if (year) badges.push(String(year));
    if (extended && extended.runtime) badges.push(extended.runtime + (kind === "series" ? " min/ep" : " min"));
    if (extended) badges = badges.concat((extended.genres || []).slice(0, 3));

    var heroImage = extended && extended.image;
    var overview = (extended && extended.overview) || "Sinopse não disponível.";
    var studioLine = extended && extended.studio;

    body.innerHTML =
      '<div class="detail-hero" style="' + (heroImage ? "background-image:url('" + heroImage.replace(/'/g, "\\'") + "')" : posterStyle(seed[0], seed[1])) + '">' +
        '<div class="detail-hero-fade"></div>' +
        '<div class="detail-hero-info">' +
          '<div class="detail-title">' + escapeHtml(title) + '</div>' +
          detailBadgesHtml(badges) +
          (studioLine ? '<div class="detail-progress">' + escapeHtml(studioLine) + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="detail-section">' +
        '<div class="detail-overview">' + escapeHtml(overview) + '</div>' +
        '<button id="add-to-library-btn" class="movie-watch-btn">+ Adicionar à minha lista</button>' +
      '</div>';

    document.getElementById("add-to-library-btn").addEventListener("click", function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = "Adicionando…";

      var addPromise = kind === "series"
        ? addSeriesFromTvdb(tvdbId, title)
        : addMovieFromTvdb(tvdbId, title, (extended && extended.year) || year);

      addPromise.then(function (uuid) {
        return refreshLibraryAfterAdd(kind, uuid, title, tvdbId).then(function () {
          renderList(true);
          if (kind === "series") openSeriesDetail(uuid);
          else openMovieDetail(uuid);
        });
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = "+ Adicionar à minha lista";
        showToast("Erro ao adicionar título");
        console.error(err);
      });
    });
  }

  function closeEpisodeModal() {
    var modal = document.getElementById("episode-modal");
    modal.classList.remove("show");
  }

  function openEpisodeModal(item) {
    var modal = document.getElementById("episode-modal");
    var body = document.getElementById("episode-modal-body");

    body.innerHTML =
      '<div class="episode-modal-header">' +
        '<span class="pill">( ' + escapeHtml((item.title || "").toUpperCase()) + ' )</span>' +
        '<div class="episode-line">' + iconTv() + ' T' + pad2(item.season) + ' | E' + pad2(item.episode) + '</div>' +
        '<div class="episode-modal-title">' + escapeHtml(item.episodeName || "") + '</div>' +
      '</div>' +
      '<div class="episode-modal-loading">Carregando informações…</div>';

    modal.classList.add("show");

    if (!item.episodeTvdbId) {
      document.querySelector("#episode-modal .episode-modal-loading").textContent =
        "Sem informações adicionais disponíveis para este episódio.";
      return;
    }

    fetchEpisodeDetails(item.episodeTvdbId).then(function (details) {
      if (!modal.classList.contains("show")) return; // user closed it meanwhile
      var loadingEl = body.querySelector(".episode-modal-loading");
      if (!details) {
        if (loadingEl) loadingEl.textContent = "Não foi possível carregar informações deste episódio.";
        return;
      }

      var airedLine = formatAiredDate(details.aired);
      var metaParts = [];
      if (airedLine) metaParts.push(airedLine);
      if (details.runtime) metaParts.push(details.runtime + " min");

      var extra = document.createElement("div");
      extra.className = "episode-modal-extra";
      extra.innerHTML =
        (details.image ? '<img class="episode-modal-image" src="' + details.image.replace(/"/g, "&quot;") + '" alt="">' : "") +
        (metaParts.length ? '<div class="episode-modal-meta">' + escapeHtml(metaParts.join(" · ")) + '</div>' : "") +
        '<div class="episode-modal-overview">' + escapeHtml(details.overview || "Sinopse não disponível.") + '</div>';

      if (loadingEl) loadingEl.replaceWith(extra);
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
      state.assistidos = [];
    }
    if (!state.assistidosHasMore) return Promise.resolve();

    state.assistidosLoading = true;
    var from = state.assistidosOffset;
    var to = from + PAGE_SIZE - 1;
    return fetch(
      SUPABASE_CONFIG.url + "/rest/v1/episodes_watched_feed?select=*",
      { headers: authHeaders({ Range: from + "-" + to }) }
    ).then(function (r) {
      handleAuthFailure(r);
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

        var seed = colorSeed(row.series_title || "?");
        state.assistidos.push({
          id: row.series_uuid,
          title: row.series_title || "Sem título",
          tvdbId: row.tvdb_id,
          episodeTvdbId: row.episode_tvdb_id,
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
  function showLoginScreen() {
    document.getElementById("login-screen").style.display = "flex";
    document.querySelector(".phone").style.display = "none";
  }
  function showApp() {
    document.getElementById("login-screen").style.display = "none";
    document.querySelector(".phone").style.display = "flex";
  }

  function setupLoginForm() {
    document.getElementById("login-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var email = document.getElementById("login-email").value.trim();
      var password = document.getElementById("login-password").value;
      var errorEl = document.getElementById("login-error");
      var btn = e.target.querySelector(".login-submit");

      errorEl.textContent = "";
      btn.disabled = true;
      btn.textContent = "Entrando…";

      loginWithPassword(email, password).then(function (session) {
        state.authSession = session;
        showApp();
        startApp();
      }).catch(function (err) {
        errorEl.textContent = "E-mail ou senha inválidos.";
        console.error(err);
      }).then(function () {
        btn.disabled = false;
        btn.textContent = "Entrar";
      });
    });
  }

  function startApp() {
    document.getElementById("list-container").innerHTML =
      '<div class="empty-state">Carregando dados…</div>';

    loadFromSupabase().then(function (data) {
      state.moviesRaw = data.movies;
      state.seriesProgress = data.seriesProgress;
      state.seriesSearchStats = data.seriesSearchStats;
      state.listsRaw = data.lists;
      state.profileStats = data.profileStats;

      var built = buildHomeListsFromProgress(state.seriesProgress);
      state.minhaLista = built.minhaLista;
      state.emBreve = built.emBreve;

      return loadAssistidosPage(true);
    }).then(function () {
      renderList(true);
      renderLists();
      renderProfile();
      renderProgressList();
    }).catch(function (err) {
      document.getElementById("list-container").innerHTML =
        '<div class="empty-state">Erro ao carregar dados do Supabase: ' + escapeHtml(err.message) +
        '<br><br>Verifique sua conexão com a internet e se o projeto Supabase está acessível.</div>';
      console.error(err);
    });
  }

  function init() {
    setupHomeControls();
    setupBottomNav();
    setupSearch();
    setupDetailScreen();
    setupProgressControls();
    setupLoginForm();

    if (!SUPABASE_CONFIG || !SUPABASE_CONFIG.url || !SUPABASE_CONFIG.anonKey) {
      document.getElementById("login-error").textContent =
        "Configuração do Supabase não encontrada. Copie .env.example para .env, preencha as credenciais e rode node scripts/generate-config.js.";
      showLoginScreen();
      return;
    }

    ensureAuthSession().then(function (session) {
      if (!session) {
        showLoginScreen();
        return;
      }
      state.authSession = session;
      showApp();
      startApp();
    });
  }

  document.addEventListener("DOMContentLoaded", init);

  // ---------- PWA install support ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function (err) {
        console.error("Falha ao registrar service worker:", err);
      });
    });
  }
})();
