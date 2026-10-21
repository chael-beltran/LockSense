/**
 * dom-updater.js
 * ------------------------------------------------------------------
 * Responsible exclusively for reading from and writing to the DOM.
 * Receives plain data objects & handles UI state presentation.
 * ------------------------------------------------------------------
 */

import { formatDuration, formatClock, elapsedSecSince, formatTimestamp, formatTime } from "./duration.js";
import { APP_CONFIG } from "./firebase-config.js";

/* ───────────────────────────────────────────────────────────────
   STATE HELPERS
─────────────────────────────────────────────────────────────────*/

export const isOpen = (l) => l && l.status === "OPEN";

export function isOnline(l) {
  if (!l) return false;
  const t = new Date(l.last_seen || l.updated_at).getTime();
  return !isNaN(t) && Date.now() - t <= APP_CONFIG.OFFLINE_THRESHOLD_MS;
}

export function stateBadge(open) {
  if (open) {
    return `<span class="badge badge--open">
      <span class="badge-dot led-bulb-red"></span>Open
    </span>`;
  }
  return `<span class="badge badge--closed">
    <span class="badge-dot led-bulb-green"></span>Closed
  </span>`;
}

export function connectionLabel(online, lastSeenIso) {
  const ageSec = lastSeenIso ? Math.floor(elapsedSecSince(lastSeenIso)) : null;
  const ageStr = ageSec != null && ageSec < 120 ? ` (${ageSec}s ago)` : "";
  if (online) {
    return `<span class="status-dot-label status-dot-label--online">
      <span class="status-dot"></span>Online${ageStr}
    </span>`;
  }
  return `<span class="status-dot-label status-dot-label--offline">
    <span class="status-dot"></span>Offline
  </span>`;
}

export const lockerLink = (id) =>
  `<a class="link td-locker-id" href="#/lockers/${encodeURIComponent(id)}">${_esc(id)}</a>`;

export function durationCell(r) {
  const s = sessionState(r);
  if (s === "DISCONNECTED") {
    return `<span class="badge badge--disconnected td-mono">
      <span class="badge-dot led-bulb-amber"></span>
      Disconnected${r.duration_sec != null ? ` (${formatDuration(r.duration_sec)})` : ""}
    </span>`;
  }
  if (s === "CLOSED") {
    return `<span class="td-duration td-mono">${formatDuration(r.duration_sec)}</span>`;
  }
  const liveSec = elapsedSecSince(r.timestamp_open);
  return `<span class="badge badge--open td-mono">
    <span class="badge-dot led-bulb-red"></span>
    In progress (${formatClock(liveSec)})
  </span>`;
}

/* ── Session resolution ───────────────────────────────────────────────────────
 * A record is only a live OPEN session when it is the newest record of its
 * locker AND that locker is currently online and hasn't closed since. A
 * record that never received a close event otherwise lost its connection:
 * it is resolved as DISCONNECTED with its duration frozen at the locker's
 * last confirmed contact (heartbeat), so it never keeps counting.
 * Records finalized by the firmware carry status "DISCONNECTED" themselves.
 */
export function sessionState(r) {
  if (r.session) return r.session;
  if (r.status === "DISCONNECTED" || r.status === "INTERRUPTED") return "DISCONNECTED";
  return r.timestamp_close ? "CLOSED" : "OPEN";
}

export function resolveSessions(logs, lockers) {
  const byId = new Map(lockers.map((l) => [l.id, l]));
  const seen = new Set();

  return logs.map((r) => {
    const newest = !seen.has(r.locker_id);
    seen.add(r.locker_id);

    if (r.status === "DISCONNECTED" || r.status === "INTERRUPTED") return { ...r, session: "DISCONNECTED" };
    if (r.timestamp_close) return { ...r, session: "CLOSED" };

    const l = byId.get(r.locker_id);
    const openT = Date.parse(r.timestamp_open);
    const closedT = l ? Date.parse(l.last_closed_at) : NaN;
    const closedSince = !isNaN(closedT) && !isNaN(openT) && closedT >= openT;

    if (newest && l && isOnline(l) && !closedSince) {
      return { ...r, session: "OPEN" };
    }

    // Frozen end = last confirmed contact with the locker (only knowable for
    // its newest record; older orphans have no reliable end time).
    let endIso = null;
    if (newest && l) endIso = closedSince ? l.last_closed_at : l.last_seen;
    const endT = Date.parse(endIso);
    const valid = !isNaN(endT) && !isNaN(openT) && endT >= openT;

    return {
      ...r,
      session: "DISCONNECTED",
      timestamp_close: valid ? endIso : null,
      duration_sec: valid ? Math.floor((endT - openT) / 1000) : null,
    };
  });
}

function _sessionBadge(r) {
  const s = sessionState(r);
  if (s === "DISCONNECTED") {
    return `<span class="badge badge--disconnected">
      <span class="badge-dot led-bulb-amber"></span>Disconnected
    </span>`;
  }
  return stateBadge(s === "OPEN");
}

const _isCompleted = (r) =>
  sessionState(r) === "CLOSED" && r.duration_sec != null && !isNaN(r.duration_sec);

/* ───────────────────────────────────────────────────────────────
   DOM UTILITIES
─────────────────────────────────────────────────────────────────*/

const _$ = (id) => document.getElementById(id);
const _rendered = new Map();

function _setHTML(id, html) {
  const el = _$(id);
  if (!el || _rendered.get(id) === html) return;
  _rendered.set(id, html);
  el.innerHTML = html;
}

function _setText(id, value) {
  const el = _$(id);
  if (el && el.textContent !== String(value)) {
    el.textContent = value;
  }
}

function _esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const _emptyRow = (cols, text) =>
  `<tr><td colspan="${cols}"><div class="empty-state">${text}</div></td></tr>`;

/* ───────────────────────────────────────────────────────────────
   DASHBOARD OVERVIEW
─────────────────────────────────────────────────────────────────*/

export function renderOverview(lockers, logs, overview3D, proppedThresholdSec = 180) {
  const online = lockers.filter(isOnline);
  const openNow = online.filter(isOpen);
  const offlineCount = lockers.length - online.length;

  // Bento KPI Ribbon
  _setText("stat-total", lockers.length);
  _setText("stat-online", online.length);
  _setText("stat-offline", offlineCount);
  _setText("stat-open", openNow.length);
  const openEl = _$("stat-open");
  if (openEl) {
    if (openNow.length > 0) openEl.classList.add("kpi-value--red");
    else openEl.classList.remove("kpi-value--red");
  }
  const openDot = _$("stat-open-dot");
  if (openDot) {
    openDot.className = `status-dot ${openNow.length > 0 ? "led-bulb-red" : "led-bulb-off"}`;
  }

  const pct = lockers.length > 0 ? Math.round((online.length / lockers.length) * 100) : 100;
  _setText("stat-online-pct", `${pct}% active`);
  const onlineBar = _$("stat-online-bar");
  if (onlineBar) onlineBar.style.width = `${pct}%`;

  _setText("stat-open-note", openNow.length === 0
    ? "All doors secured"
    : `${openNow.length} unit${openNow.length > 1 ? "s" : ""} active`);

  // Average open duration
  const closedLogs = logs.filter(_isCompleted);
  const avgSec = closedLogs.length > 0
    ? Math.round(closedLogs.reduce((acc, r) => acc + Number(r.duration_sec), 0) / closedLogs.length)
    : null;
  _setText("stat-avg-duration", avgSec != null ? `Avg open: ${formatDuration(avgSec)}` : "Avg open: —");

  // Propped-Open Alert Banner
  const proppedLockers = openNow.filter((l) => elapsedSecSince(l.updated_at) >= proppedThresholdSec);
  const banner = _$("propped-alert-banner");
  if (banner) {
    if (proppedLockers.length > 0) {
      banner.classList.add("active");
      const first = proppedLockers[0];
      _setText("propped-alert-text", `${first.id} open for ${formatClock(elapsedSecSince(first.updated_at))} (exceeds ${formatDuration(proppedThresholdSec)})`);
      const btnFocus = _$("btn-focus-propped");
      if (btnFocus) {
        btnFocus.onclick = () => {
          if (overview3D) overview3D.focusLocker(first.id);
        };
      }
    } else {
      banner.classList.remove("active");
    }
  }

  // Sync 3D Locker Array
  if (overview3D) {
    overview3D.syncLockers(lockers);
  }

  // 3D Quick-Action Pills
  const quickPills = _$("quick-locker-pills");
  if (quickPills) {
    const pillsHtml = lockers.map((l) => {
      const open = isOpen(l);
      return `<button type="button" class="quick-locker-btn ${open ? "is-active-open" : ""}" data-focus-id="${_esc(l.id)}">
        <span class="status-dot ${open ? "led-bulb-red" : "led-bulb-green"}"></span>
        <span>${_esc(l.id)}</span>
      </button>`;
    }).join("");
    _setHTML("quick-locker-pills", pillsHtml);

    quickPills.querySelectorAll("[data-focus-id]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.focusId;
        if (overview3D) overview3D.focusLocker(id);
      };
    });
  }

  // Open Now (Live Timers) List
  const openList = _$("overview-open-list");
  if (openList) {
    if (openNow.length === 0) {
      _setHTML("overview-open-list", `<li class="empty-state" style="padding: 1.5rem 0.5rem;">All locker doors are currently closed and secured.</li>`);
    } else {
      const html = openNow.map((l) => {
        const sec = elapsedSecSince(l.updated_at);
        const pctAlert = Math.min(100, Math.round((sec / proppedThresholdSec) * 100));
        const isWarn = sec >= proppedThresholdSec;

        return `
          <li class="open-now-item ${isWarn ? "is-warn" : ""}">
            <div class="open-now-row">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span class="status-dot ${isWarn ? "led-bulb-amber" : "led-bulb-red"}"></span>
                ${lockerLink(l.id)}
              </div>
              <div style="display: flex; align-items: center; gap: 10px;">
                <span class="open-now-timer ${isWarn ? "is-warn" : ""}">${formatClock(sec)}</span>
                <a href="#/lockers/${encodeURIComponent(l.id)}" class="btn--table-view" style="padding: 2px 8px; font-size: 11px;">View</a>
              </div>
            </div>
            <div class="open-now-bar-track">
              <div class="open-now-bar-fill ${isWarn ? "is-warn" : ""}" style="width: ${pctAlert}%"></div>
            </div>
          </li>`;
      }).join("");
      _setHTML("overview-open-list", html);
    }
  }

  // Recent Activity Stream (Top 6)
  const recentBody = _$("overview-recent-body");
  if (recentBody) {
    if (logs.length === 0) {
      _setHTML("overview-recent-body", _emptyRow(3, "No activity recorded yet."));
    } else {
      const html = logs.slice(0, 6).map((r) => `
        <tr>
          <td>${lockerLink(r.locker_id)}</td>
          <td class="td-mono">${formatTimestamp(r.timestamp_open)}</td>
          <td class="text-right">${durationCell(r)}</td>
        </tr>`).join("");
      _setHTML("overview-recent-body", html);
    }
  }

  // Activity Distribution by Unit
  const barsEl = _$("overview-utilization-bars");
  _setText("chart-total-sessions", `${logs.length} sessions`);
  if (barsEl) {
    const counts = new Map();
    lockers.forEach((l) => counts.set(l.id, 0));
    logs.forEach((r) => counts.set(r.locker_id, (counts.get(r.locker_id) || 0) + 1));
    const maxCount = Math.max(1, ...Array.from(counts.values()));

    const barsHtml = Array.from(counts.entries()).slice(0, 5).map(([id, count]) => {
      const widthPct = Math.round((count / maxCount) * 100);
      return `
        <div class="utilization-item">
          <div class="utilization-info">
            <a href="#/lockers/${encodeURIComponent(id)}" class="utilization-link">${_esc(id)}</a>
            <span class="utilization-count">${count} sessions</span>
          </div>
          <div class="utilization-bar-track">
            <div class="utilization-bar-fill" style="width: ${widthPct}%"></div>
          </div>
        </div>`;
    }).join("");
    _setHTML("overview-utilization-bars", barsHtml || `<div class="empty-state">No utilization data yet.</div>`);
  }
}

/* ───────────────────────────────────────────────────────────────
   MANAGE LOCKERS: REGISTERED LOCKERS TABLE
─────────────────────────────────────────────────────────────────*/

export function renderLockerList(lockers, search = "", statusFilter = "ALL") {
  _setText("lockers-count", lockers.length);

  const filtered = lockers.filter((l) => {
    const matchesSearch = !search || l.id.toLowerCase().includes(search.toLowerCase());
    const online = isOnline(l);
    const open = isOpen(l);

    if (statusFilter === "ONLINE" && !online) return false;
    if (statusFilter === "OFFLINE" && online) return false;
    if (statusFilter === "OPEN" && !open) return false;
    if (statusFilter === "CLOSED" && open) return false;

    return matchesSearch;
  });

  const bodyEl = _$("lockers-body");
  if (!bodyEl) return;

  if (filtered.length === 0) {
    _setHTML("lockers-body", _emptyRow(5, lockers.length === 0
      ? "No lockers registered yet. Lockers register automatically as soon as their ESP32 boots."
      : "No lockers match the current search or filter."));
    return;
  }

  const html = filtered.map((l) => {
    const online = isOnline(l);
    const open = isOpen(l);

    return `
      <tr class="row-clickable" data-href="#/lockers/${encodeURIComponent(l.id)}">
        <td>${lockerLink(l.id)}</td>
        <td>${connectionLabel(online, l.last_seen)}</td>
        <td>${stateBadge(open)}</td>
        <td class="td-mono">${formatTimestamp(l.updated_at)}</td>
        <td class="text-right">
          <a class="btn--table-view" href="#/lockers/${encodeURIComponent(l.id)}" data-view-btn="true">
            <span>View</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </a>
        </td>
      </tr>`;
  }).join("");

  _setHTML("lockers-body", html);
}

/* ───────────────────────────────────────────────────────────────
   LOCKER DETAILS
─────────────────────────────────────────────────────────────────*/

export function renderLockerDetail(
  locker,
  logs,
  loaded,
  detail3D,
  detailFilter = { range: "all", from: "", to: "", page: 1 },
  onPage = null
) {
  const content = _$("detail-content");
  const message = _$("detail-message");
  if (!content || !message) return;

  content.hidden = !locker;
  message.hidden = !!locker;

  if (!locker) {
    message.textContent = loaded ? "This locker does not exist in the database." : "Loading locker telemetry…";
    return;
  }

  const open = isOpen(locker);
  const online = isOnline(locker);
  const history = logs.filter((r) => r.locker_id === locker.id);

  _setText("detail-name", locker.id);
  _setText("detail-db-path", `lockers/${locker.id}`);
  _setHTML("detail-badges", `${stateBadge(open)} ${connectionLabel(online, locker.last_seen)}`);

  // Avatar LED
  const avatar = _$("detail-led-avatar");
  if (avatar) {
    avatar.innerHTML = `<span class="status-dot ${open ? "led-bulb-red" : "led-bulb-green"}" style="width: 16px; height: 16px;"></span>`;
  }

  // Status readout
  _setHTML("detail-state", `
    <p class="detail-state-value ${open ? "detail-state-value--open" : "detail-state-value--closed"}">${open ? "OPEN" : "CLOSED"}</p>
    <p class="table-subtitle">${online ? `Since ${formatTimestamp(locker.updated_at)}` : "Device offline — showing last known state"}</p>
  `);

  // Live Timer
  const ticking = open && online;
  _setHTML("detail-timer", `
    <p class="detail-timer-value ${ticking ? "" : "is-idle"}">${ticking ? formatClock(elapsedSecSince(locker.updated_at)) : "00:00"}</p>
    <p class="table-subtitle">${ticking ? "Minutes : seconds open" : open ? "Paused — device offline" : "Door is secured"}</p>
  `);

  // Sync Single-Unit 3D Inspector
  if (detail3D) {
    detail3D.syncLockers([locker]);
  }

  // Dual-Sensor State Readouts (reflecting actual hardware readings)
  const isReedContact = locker.reed_contact !== undefined ? Boolean(locker.reed_contact) : !open;
  const isMicroEngaged = locker.micro_engaged !== undefined ? Boolean(locker.micro_engaged) : !open;

  const reedBadge = _$("detail-reed-badge");
  if (reedBadge) {
    reedBadge.textContent = isReedContact ? "Contact" : "Open";
    reedBadge.className = `badge ${isReedContact ? "badge--closed" : "badge--open"}`;
  }

  const microBadge = _$("detail-micro-badge");
  if (microBadge) {
    microBadge.textContent = isMicroEngaged ? "Engaged" : "Released";
    microBadge.className = `badge ${isMicroEngaged ? "badge--closed" : "badge--open"}`;
  }

  const g18Bulb = _$("detail-gpio18-bulb");
  if (g18Bulb) {
    g18Bulb.className = `status-dot ${open ? "led-bulb-red" : "led-bulb-off"}`;
  }
  _setText("detail-gpio18-text", open ? "Active (Locker Open)" : "Off");

  const g19Bulb = _$("detail-gpio19-bulb");
  if (g19Bulb) {
    g19Bulb.className = `status-dot ${!open ? "led-bulb-green" : "led-bulb-off"}`;
  }
  _setText("detail-gpio19-text", !open ? "Active (Locker Closed)" : "Off");

  // Calculate today's openings for this specific locker
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const todayOpenings = history.filter((r) => {
    if (!r.timestamp_open) return false;
    const t = new Date(r.timestamp_open).getTime();
    return !isNaN(t) && t >= todayStart.getTime() && t <= todayEnd.getTime();
  });

  // Telemetry metadata list
  _setHTML("detail-info", [
    ["Locker ID", `<span class="td-locker-id">${_esc(locker.id)}</span>`],
    ["Connection", connectionLabel(online, locker.last_seen)],
    ["Last Heartbeat", `<span class="td-mono">${formatTimestamp(locker.last_seen)}</span>`],
    ["Last Opened", `<span class="td-mono">${formatTimestamp(locker.last_opened_at)}</span>`],
    ["Last Closed", `<span class="td-mono">${formatTimestamp(locker.last_closed_at)}</span>`],
    ["Today's Openings", `<span class="td-locker-id">${todayOpenings.length}</span>`],
  ].map(([k, v]) => `
    <div class="meta-item">
      <dt class="meta-label">${k}</dt>
      <dd class="meta-value">${v}</dd>
    </div>
  `).join(""));

  // Filter history records based on selected date range
  const range = detailFilter?.range || "all";
  const from = detailFilter?.from || "";
  const to = detailFilter?.to || "";

  const filteredHistory = history.filter((r) => {
    if (!r.timestamp_open) return false;
    const t = new Date(r.timestamp_open).getTime();
    if (isNaN(t)) return false;

    if (range === "today") {
      return t >= todayStart.getTime() && t <= todayEnd.getTime();
    }
    if (range === "7d") {
      const past7d = todayStart.getTime() - 6 * 24 * 60 * 60 * 1000;
      return t >= past7d && t <= todayEnd.getTime();
    }
    if (range === "30d") {
      const past30d = todayStart.getTime() - 29 * 24 * 60 * 60 * 1000;
      return t >= past30d && t <= todayEnd.getTime();
    }
    if (range === "custom") {
      const day = (r.timestamp_open || "").slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    }
    return true;
  });

  // Total Records indicator clearly reflecting the active filter
  const countBadge = _$("detail-history-count");
  if (countBadge) {
    const n = filteredHistory.length;
    let label = `${n} ${n === 1 ? "record" : "records"}`;
    if (range === "today") {
      label = `${n} ${n === 1 ? "record" : "records"} today`;
    } else if (range === "7d") {
      label = `${n} ${n === 1 ? "record" : "records"} (last 7 days)`;
    } else if (range === "30d") {
      label = `${n} ${n === 1 ? "record" : "records"} (last 30 days)`;
    } else if (range === "custom") {
      if (from && to) {
        label = `${n} ${n === 1 ? "record" : "records"} (${from} to ${to})`;
      } else if (from) {
        label = `${n} ${n === 1 ? "record" : "records"} (since ${from})`;
      } else if (to) {
        label = `${n} ${n === 1 ? "record" : "records"} (until ${to})`;
      } else {
        label = `${n} ${n === 1 ? "record" : "records"} (custom)`;
      }
    }
    countBadge.textContent = label;
  }

  // Sync Filter UI state in DOM
  const pillsWrap = _$("detail-filter-pills");
  if (pillsWrap) {
    pillsWrap.querySelectorAll("[data-range]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.range === range);
    });
  }
  const customDates = _$("detail-custom-dates");
  if (customDates) {
    customDates.hidden = range !== "custom";
  }
  const fromInput = _$("detail-filter-from");
  if (fromInput && fromInput.value !== from) {
    fromInput.value = from;
  }
  const toInput = _$("detail-filter-to");
  if (toInput && toInput.value !== to) {
    toInput.value = to;
  }

  // Pagination calculation
  const perPage = APP_CONFIG.DETAIL_ROWS_PER_PAGE || 10;
  const total = filteredHistory.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const currentPage = Math.min(Math.max(1, Number(detailFilter?.page) || 1), pages);

  const startIdx = (currentPage - 1) * perPage;
  const pageRows = filteredHistory.slice(startIdx, startIdx + perPage);

  // Render Activity History Table Rows
  const tbody = _$("detail-activity-body");
  if (tbody) {
    if (filteredHistory.length === 0) {
      const emptyMsg = history.length === 0
        ? "No activity recorded for this locker yet."
        : "No activity records found for the selected date filter.";
      _setHTML("detail-activity-body", _emptyRow(4, emptyMsg));
    } else {
      const html = pageRows.map((r) => `
        <tr>
          <td>${_sessionBadge(r)}</td>
          <td class="td-mono">${formatTimestamp(r.timestamp_open)}</td>
          <td class="td-mono">${formatTimestamp(r.timestamp_close)}</td>
          <td class="text-right">${durationCell(r)}</td>
        </tr>
      `).join("");
      _setHTML("detail-activity-body", html);
    }
  }

  // Table Footer & Pagination
  const startRecord = (currentPage - 1) * perPage + 1;
  _setText("detail-history-footer-info", total === 0
    ? "Showing 0 records"
    : `Showing ${startRecord}–${Math.min(currentPage * perPage, total)} of ${total} records`);

  _renderPagination(total, currentPage, perPage, onPage, "detail-pagination-container");
}

/* ───────────────────────────────────────────────────────────────
   ACTIVITY LOGS
─────────────────────────────────────────────────────────────────*/

export function syncLockerFilter(lockers, selected) {
  const select = _$("filter-locker");
  if (!select) return;
  const html = `<option value="">All lockers</option>` + lockers
    .map((l) => `<option value="${_esc(l.id)}">${_esc(l.id)}</option>`).join("");
  if (_rendered.get("filter-locker") !== html) {
    _rendered.set("filter-locker", html);
    select.innerHTML = html;
  }
  select.value = selected;
}

export function renderLogs(rows, total, page, perPage, onPage) {
  _setText("logs-count", total);

  // Summary Metrics
  const completed = rows.filter(_isCompleted);
  const totalDur = completed.reduce((acc, r) => acc + Number(r.duration_sec || 0), 0);
  const avgDur = completed.length ? Math.round(totalDur / completed.length) : 0;
  const metricsEl = _$("logs-summary-metrics");
  if (metricsEl) {
    metricsEl.textContent = completed.length
      ? `Avg Session: ${formatDuration(avgDur)} • Total Open Time: ${formatDuration(totalDur)}`
      : "Real-time database activity log telemetry";
  }

  // Rows
  const tbody = _$("logs-body");
  if (tbody) {
    if (rows.length === 0) {
      _setHTML("logs-body", _emptyRow(5, "No records match the current filters."));
    } else {
      const html = rows.map((r) => `
        <tr>
          <td>${lockerLink(r.locker_id)}</td>
          <td>${_sessionBadge(r)}</td>
          <td class="td-mono">${formatTimestamp(r.timestamp_open)}</td>
          <td class="td-mono">${formatTimestamp(r.timestamp_close)}</td>
          <td class="text-right">${durationCell(r)}</td>
        </tr>
      `).join("");
      _setHTML("logs-body", html);
    }
  }

  const start = (page - 1) * perPage + 1;
  _setText("logs-footer-info", total === 0
    ? "Showing 0 records"
    : `Showing ${start}–${Math.min(page * perPage, total)} of ${total} records`);

  _renderPagination(total, page, perPage, onPage);
}

function _renderPagination(total, page, perPage, onPage, containerId = "pagination-container") {
  const container = _$(containerId);
  if (!container) return;

  const pages = Math.max(1, Math.ceil(total / perPage));
  let html = `<button class="page-btn" data-page="${page - 1}" ${page === 1 ? "disabled" : ""} aria-label="Previous page">‹</button>`;

  for (const p of _pageRange(page, pages)) {
    html += p === "…"
      ? `<button class="page-btn" disabled>…</button>`
      : `<button class="page-btn${p === page ? " active" : ""}" data-page="${p}">${p}</button>`;
  }

  html += `<button class="page-btn" data-page="${page + 1}" ${page === pages ? "disabled" : ""} aria-label="Next page">›</button>`;
  container.innerHTML = html;

  if (typeof onPage === "function") {
    container.querySelectorAll("[data-page]:not(:disabled)").forEach((btn) =>
      btn.addEventListener("click", () => onPage(Number(btn.dataset.page))));
  }
}

function _pageRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages = [1];
  if (current > 3) pages.push("…");
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i);
  if (current < total - 2) pages.push("…");
  pages.push(total);
  return pages;
}

/* ───────────────────────────────────────────────────────────────
   SHELL: TITLE, NAV, CONNECTION, CLOCK
─────────────────────────────────────────────────────────────────*/

export function setTitle(title) {
  _setText("header-title", title);
  document.title = `${title} — LockSense`;
}

export function showView(view, navId) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  document.querySelectorAll(".nav-item").forEach((n) => {
    const active = n.id === navId;
    n.classList.toggle("active", active);
    if (active) n.setAttribute("aria-current", "page"); else n.removeAttribute("aria-current");
  });
}

/** @param {"connecting"|"connected"|"disconnected"} status */
export function setConnectionStatus(status) {
  const dot = _$("conn-dot");
  const ping = _$("conn-ping");
  if (!dot) return;

  dot.className = `conn-dot is-${status}`;
  if (ping) ping.className = `conn-ping is-${status}`;

  _setText("conn-label", {
    connecting: "Connecting…",
    connected: "Connected",
    disconnected: "Disconnected"
  }[status]);
}

export function updateClock() {
  _setText("live-clock", formatTime(new Date()));
}
