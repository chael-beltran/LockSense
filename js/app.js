/**
 * app.js
 * ------------------------------------------------------------------
 * Application entry point.
 * Responsibilities:
 *   - Hash-based routing (#/overview, #/lockers, #/lockers/<id>, #/logs)
 *   - State management (lockers, logs, filters)
 *   - 3D Digital Twin Engine lifecycle & camera controls
 *   - Re-rendering active views & per-second ticking
 * ------------------------------------------------------------------
 */

import { APP_CONFIG } from "./firebase-config.js";
import { initListeners } from "./db-listener.js";
import { Locker3DEngine } from "./three-locker.js";
import {
  renderOverview, renderLockerList, renderLockerDetail,
  renderLogs,
  setTitle, showView, setConnectionStatus, updateClock,
  resolveSessions, sessionState,
} from "./dom-updater.js";

/* ───────────────────────────────────────────────────────────────
   STATE
─────────────────────────────────────────────────────────────────*/

const state = {
  lockers: [],
  logs: [],
  prevLockerStatus: new Map(), // lockerId -> previous status (to detect 3s closing pulse)
  lockersLoaded: false,
  route: { view: "overview" },
  filter: { search: "", state: "", dateRange: "all", from: "", to: "", page: 1 },
  lockerManageFilter: { search: "", status: "ALL" },
  lockerDetailFilter: { range: "all", from: "", to: "", page: 1 },
  currentLockerDetailId: null,
  overview3D: null,
  detail3D: null,
};

/* ───────────────────────────────────────────────────────────────
   ROUTING
─────────────────────────────────────────────────────────────────*/

function parseRoute() {
  const [name, id] = location.hash.replace(/^#\/?/, "").split("/");
  if (name === "lockers" && id) return { view: "locker", id: decodeURIComponent(id) };
  if (name === "lockers")       return { view: "lockers" };
  if (name === "logs")          return { view: "logs" };
  return { view: "overview" };
}

const VIEWS = {
  overview: { title: "Dashboard Overview", nav: "nav-overview" },
  lockers:  { title: "Manage Lockers",     nav: "nav-lockers"  },
  locker:   { title: "Locker Details",     nav: "nav-lockers"  },
  logs:     { title: "Activity Logs",      nav: "nav-logs"     },
};

function applyRoute() {
  state.route = parseRoute();
  const { view, id } = state.route;
  const config = VIEWS[view] || VIEWS.overview;

  showView(view, config.nav);
  setTitle(view === "locker" ? id : config.title);
  window.scrollTo(0, 0);

  // Reset pagination if opening a new locker detail page
  if (view === "locker" && state.currentLockerDetailId !== id) {
    state.currentLockerDetailId = id;
    state.lockerDetailFilter = { range: "all", from: "", to: "", page: 1 };
  }

  // Resize 3D viewports upon entering view
  if (view === "overview" && state.overview3D) {
    state.overview3D.handleResize();
  } else if (view === "locker" && state.detail3D) {
    state.detail3D.handleResize();
  }

  render();
}

/* ───────────────────────────────────────────────────────────────
   RENDER DISPATCHER
─────────────────────────────────────────────────────────────────*/

/** Activity records resolved against live locker connectivity. */
const sessions = () => resolveSessions(state.logs, state.lockers);

function render() {
  switch (state.route.view) {
    case "overview":
      renderOverview(state.lockers, sessions(), state.overview3D);
      break;

    case "lockers":
      renderLockerList(
        state.lockers,
        state.lockerManageFilter.search,
        state.lockerManageFilter.status
      );
      break;

    case "locker":
      renderLockerDetail(
        state.lockers.find((l) => l.id === state.route.id),
        sessions(),
        state.lockersLoaded,
        state.detail3D,
        state.lockerDetailFilter,
        (page) => {
          state.lockerDetailFilter.page = page;
          render();
        }
      );
      break;

    case "logs":
      renderLogsView();
      break;
  }
}

function filteredLogs() {
  const { search, state: st, dateRange, from, to } = state.filter;
  const q = (search || "").trim().toLowerCase();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  return sessions().filter((r) => {
    // 1. Search by Locker ID
    if (q && !(r.locker_id && r.locker_id.toLowerCase().includes(q))) {
      return false;
    }

    // 2. Session State Filter
    const s = sessionState(r);
    const matchesState = !st
      || s === st
      || (st === "DISCONNECTED" && (s === "DISCONNECTED" || s === "INTERRUPTED"))
      || (st === "INTERRUPTED" && (s === "DISCONNECTED" || s === "INTERRUPTED"));
    if (!matchesState) return false;

    // 3. Date Filter
    if (dateRange && dateRange !== "all") {
      if (!r.timestamp_open) return false;
      const t = new Date(r.timestamp_open).getTime();
      if (isNaN(t)) return false;

      if (dateRange === "today") {
        if (t < todayStart.getTime() || t > todayEnd.getTime()) return false;
      } else if (dateRange === "7d") {
        const past7d = todayStart.getTime() - 6 * 24 * 60 * 60 * 1000;
        if (t < past7d || t > todayEnd.getTime()) return false;
      } else if (dateRange === "30d") {
        const past30d = todayStart.getTime() - 29 * 24 * 60 * 60 * 1000;
        if (t < past30d || t > todayEnd.getTime()) return false;
      } else if (dateRange === "custom") {
        const day = (r.timestamp_open || "").slice(0, 10);
        if (from && day < from) return false;
        if (to && day > to) return false;
      }
    }

    return true;
  });
}

function renderLogsView() {
  const rows = filteredLogs();

  const perPage = APP_CONFIG.ROWS_PER_PAGE;
  const pages   = Math.max(1, Math.ceil(rows.length / perPage));
  state.filter.page = Math.min(state.filter.page, pages);

  const start = (state.filter.page - 1) * perPage;

  renderLogs(rows.slice(start, start + perPage), rows.length, state.filter.page, perPage, (page) => {
    state.filter.page = page;
    renderLogsView();
  });
}

/* ───────────────────────────────────────────────────────────────
   CSV EXPORT
─────────────────────────────────────────────────────────────────*/

function exportLogsToCSV() {
  const filtered = filteredLogs();

  if (filtered.length === 0) {
    alert("No records to export with active filters.");
    return;
  }

  const headers = ["Locker ID", "State", "Opened Timestamp", "Closed Timestamp", "Duration (sec)"];
  const csvRows = [headers.join(",")];

  filtered.forEach((r) => {
    const row = [
      `"${r.locker_id || ""}"`,
      `"${sessionState(r)}"`,
      `"${r.timestamp_open || ""}"`,
      `"${r.timestamp_close || ""}"`,
      r.duration_sec != null ? r.duration_sec : "",
    ];
    csvRows.push(row.join(","));
  });

  const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `LockSense_Activity_Logs_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ───────────────────────────────────────────────────────────────
   3D ENGINE CONTROLS
─────────────────────────────────────────────────────────────────*/

function init3D() {
  if (typeof THREE === "undefined") {
    console.warn("[LockSense] Three.js not loaded, 3D digital twin unavailable.");
    return;
  }

  // 1. Overview 3D Smart Locker Array
  const container = document.getElementById("three-canvas-container");
  if (container) {
    state.overview3D = new Locker3DEngine("three-canvas-container", false, (lockerId) => {
      // Single click selects & focuses locker
    });

    // Preset buttons (Front View, Isometric, Top View, Orbit)
    const btnFront = document.getElementById("btn-cam-front");
    const btnIso = document.getElementById("btn-cam-iso");
    const btnTop = document.getElementById("btn-cam-top");
    const btnOrbit = document.getElementById("btn-toggle-orbit");

    const updatePresetButtons = (activeBtn) => {
      [btnFront, btnIso, btnTop].forEach((b) => b?.classList.remove("active"));
      activeBtn?.classList.add("active");
    };

    if (btnFront) {
      btnFront.onclick = () => {
        state.overview3D.setCameraPreset("front");
        updatePresetButtons(btnFront);
      };
    }
    if (btnIso) {
      btnIso.onclick = () => {
        state.overview3D.setCameraPreset("iso");
        updatePresetButtons(btnIso);
      };
    }
    if (btnTop) {
      btnTop.onclick = () => {
        state.overview3D.setCameraPreset("top");
        updatePresetButtons(btnTop);
      };
    }
    if (btnOrbit) {
      btnOrbit.onclick = () => {
        state.overview3D.autoRotate = !state.overview3D.autoRotate;
        btnOrbit.classList.toggle("active", state.overview3D.autoRotate);
      };
    }
  }

  // 2. Single-Unit Locker Detail 3D Digital Twin
  const detailContainer = document.getElementById("detail-three-container");
  if (detailContainer) {
    state.detail3D = new Locker3DEngine("detail-three-container", true);
  }

  // 3. Continuous Animation Loop
  function animate() {
    requestAnimationFrame(animate);
    if (state.route.view === "overview" && state.overview3D) {
      state.overview3D.animate();
    } else if (state.route.view === "locker" && state.detail3D) {
      state.detail3D.animate();
    }
  }
  requestAnimationFrame(animate);
}

/* ───────────────────────────────────────────────────────────────
   EVENT LISTENERS & USER INPUTS
─────────────────────────────────────────────────────────────────*/

function initEventListeners() {
  // ── Activity Logs Filters ──
  // 1. Expandable Search
  const logSearchWrap = document.getElementById("logs-search-wrap");
  const logSearchToggle = document.getElementById("logs-search-toggle");
  const logSearchInput = document.getElementById("filter-search-locker");
  const logSearchClear = document.getElementById("logs-search-clear");

  if (logSearchToggle && logSearchWrap && logSearchInput) {
    logSearchToggle.addEventListener("click", () => {
      const isExpanded = logSearchWrap.classList.contains("is-expanded");
      if (!isExpanded) {
        logSearchWrap.classList.add("is-expanded");
        logSearchInput.focus();
      } else if (!logSearchInput.value) {
        logSearchWrap.classList.remove("is-expanded");
      } else {
        logSearchInput.focus();
      }
    });

    logSearchInput.addEventListener("input", (e) => {
      const val = e.target.value;
      if (logSearchClear) logSearchClear.hidden = !val;
      state.filter.search = val;
      state.filter.page = 1;
      renderLogsView();
    });

    logSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (logSearchInput.value) {
          logSearchInput.value = "";
          if (logSearchClear) logSearchClear.hidden = true;
          state.filter.search = "";
          state.filter.page = 1;
          renderLogsView();
        } else {
          logSearchWrap.classList.remove("is-expanded");
          logSearchInput.blur();
        }
      }
    });

    if (logSearchClear) {
      logSearchClear.addEventListener("click", () => {
        logSearchInput.value = "";
        logSearchClear.hidden = true;
        state.filter.search = "";
        state.filter.page = 1;
        renderLogsView();
        logSearchInput.focus();
      });
    }

    // Collapse search on click outside if empty
    document.addEventListener("click", (e) => {
      if (logSearchWrap && !logSearchWrap.contains(e.target) && !logSearchInput.value) {
        logSearchWrap.classList.remove("is-expanded");
      }
    });
  }

  // 2. Session State Dropdown
  const filterStateEl = document.getElementById("filter-state");
  if (filterStateEl) {
    filterStateEl.addEventListener("change", (e) => {
      state.filter.state = e.target.value;
      state.filter.page = 1;
      renderLogsView();
    });
  }

  // 3. Date Dropdown & Custom Range
  const filterDateRangeEl = document.getElementById("filter-date-range");
  const customDatesWrap = document.getElementById("logs-custom-dates");
  const dateFromEl = document.getElementById("filter-date-from");
  const dateToEl = document.getElementById("filter-date-to");

  if (filterDateRangeEl) {
    filterDateRangeEl.addEventListener("change", (e) => {
      const val = e.target.value;
      state.filter.dateRange = val;
      state.filter.page = 1;

      if (customDatesWrap) {
        customDatesWrap.hidden = (val !== "custom");
      }

      if (val !== "custom") {
        state.filter.from = "";
        state.filter.to = "";
        if (dateFromEl) dateFromEl.value = "";
        if (dateToEl) dateToEl.value = "";
      }

      renderLogsView();
    });
  }

  // Custom date pickers
  if (dateFromEl) {
    dateFromEl.addEventListener("change", (e) => {
      state.filter.from = e.target.value;
      state.filter.page = 1;
      if (state.filter.dateRange === "custom") renderLogsView();
    });
  }
  if (dateToEl) {
    dateToEl.addEventListener("change", (e) => {
      state.filter.to = e.target.value;
      state.filter.page = 1;
      if (state.filter.dateRange === "custom") renderLogsView();
    });
  }

  // 4. Reset Filters Button
  const btnClear = document.getElementById("btn-clear-filters");
  if (btnClear) {
    btnClear.addEventListener("click", () => {
      state.filter = { search: "", state: "", dateRange: "all", from: "", to: "", page: 1 };
      if (logSearchInput) logSearchInput.value = "";
      if (logSearchClear) logSearchClear.hidden = true;
      if (logSearchWrap) logSearchWrap.classList.remove("is-expanded");
      if (filterStateEl) filterStateEl.value = "";
      if (filterDateRangeEl) filterDateRangeEl.value = "all";
      if (customDatesWrap) customDatesWrap.hidden = true;
      if (dateFromEl) dateFromEl.value = "";
      if (dateToEl) dateToEl.value = "";
      renderLogsView();
    });
  }

  // Export CSV
  const btnExport = document.getElementById("btn-export-csv");
  if (btnExport) {
    btnExport.addEventListener("click", exportLogsToCSV);
  }

  // Manage Lockers Search & Status Filter Pills
  const lockerSearchInput = document.getElementById("locker-search-input");
  if (lockerSearchInput) {
    lockerSearchInput.addEventListener("input", (e) => {
      state.lockerManageFilter.search = e.target.value;
      renderLockerList(state.lockers, state.lockerManageFilter.search, state.lockerManageFilter.status);
    });
  }

  const statusPills = document.getElementById("locker-status-pills");
  if (statusPills) {
    statusPills.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-status-filter]");
      if (!btn) return;
      statusPills.querySelectorAll("[data-status-filter]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.lockerManageFilter.status = btn.dataset.statusFilter;
      renderLockerList(state.lockers, state.lockerManageFilter.search, state.lockerManageFilter.status);
    });
  }

  // Unit Activity History Date Filter Pills
  const detailPills = document.getElementById("detail-filter-pills");
  if (detailPills) {
    detailPills.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-range]");
      if (!btn) return;
      const range = btn.dataset.range;
      detailPills.querySelectorAll("[data-range]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      state.lockerDetailFilter.range = range;
      state.lockerDetailFilter.page = 1;

      const customDates = document.getElementById("detail-custom-dates");
      if (customDates) {
        customDates.hidden = range !== "custom";
      }

      render();
    });
  }

  // Custom Date Range Inputs
  const detailFrom = document.getElementById("detail-filter-from");
  if (detailFrom) {
    detailFrom.addEventListener("change", (e) => {
      state.lockerDetailFilter.from = e.target.value;
      state.lockerDetailFilter.page = 1;
      if (state.lockerDetailFilter.range === "custom") render();
    });
  }
  const detailTo = document.getElementById("detail-filter-to");
  if (detailTo) {
    detailTo.addEventListener("change", (e) => {
      state.lockerDetailFilter.to = e.target.value;
      state.lockerDetailFilter.page = 1;
      if (state.lockerDetailFilter.range === "custom") render();
    });
  }

  // Reset Filters Button for Unit Activity History
  const btnResetDetail = document.getElementById("detail-btn-reset");
  if (btnResetDetail) {
    btnResetDetail.addEventListener("click", () => {
      state.lockerDetailFilter = { range: "all", from: "", to: "", page: 1 };
      if (detailPills) {
        detailPills.querySelectorAll("[data-range]").forEach((b) => {
          b.classList.toggle("active", b.dataset.range === "all");
        });
      }
      const customDates = document.getElementById("detail-custom-dates");
      if (customDates) customDates.hidden = true;
      if (detailFrom) detailFrom.value = "";
      if (detailTo) detailTo.value = "";
      render();
    });
  }

  // Row clicks on table rows with data-href
  document.addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-href]");
    if (row && !e.target.closest("a, button")) {
      location.hash = row.dataset.href;
    }
  });
}

/* ───────────────────────────────────────────────────────────────
   BOOTSTRAP
─────────────────────────────────────────────────────────────────*/

function boot() {
  initEventListeners();
  init3D();
  window.addEventListener("hashchange", applyRoute);

  setConnectionStatus("connecting");
  applyRoute();

  updateClock();
  setInterval(() => {
    updateClock();
    // Live ticking timer only affects overview and locker detail views
    if (state.route.view === "overview" || state.route.view === "locker") {
      render();
    }
  }, 1000);

  try {
    initListeners({
      onLockers: (lockers) => {
        // Detect transitions from OPEN -> CLOSED to trigger 3s red LED closing pulse
        lockers.forEach((l) => {
          const prev = state.prevLockerStatus.get(l.id);
          if (prev === "OPEN" && l.status === "CLOSED") {
            if (state.overview3D) state.overview3D.triggerRedPulse(l.id, 3000);
            if (state.detail3D) state.detail3D.triggerRedPulse(l.id, 3000);
          }
          state.prevLockerStatus.set(l.id, l.status);
        });

        state.lockers = lockers;
        state.lockersLoaded = true;
        render();
      },
      onLogs: (logs) => {
        state.logs = logs;
        render();
      },
      onConnection: (ok) => setConnectionStatus(ok ? "connected" : "disconnected"),
    });
  } catch (err) {
    console.error("[LockSense] Failed to init Firebase:", err);
    setConnectionStatus("disconnected");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
