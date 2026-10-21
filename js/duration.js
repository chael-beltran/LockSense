/**
 * duration.js
 * ------------------------------------------------------------------
 * Pure utility functions for duration and timestamp formatting.
 * No DOM access, no Firebase access — fully testable in isolation.
 * ------------------------------------------------------------------
 */

/**
 * Formats a duration in seconds into a human-readable string.
 * @param {number} totalSeconds
 * @returns {string}  e.g. "2h 5m 30s", "10m 12s", "45s"
 */
export function formatDuration(totalSeconds) {
  if (totalSeconds == null || isNaN(totalSeconds) || totalSeconds < 0) {
    return "—";
  }

  const seconds = Math.floor(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);

  return parts.join(" ");
}

/**
 * Formats seconds as a minutes:seconds clock for the live timer.
 * Minutes are not capped at 59 (75 minutes → "75:00").
 * @param {number} totalSeconds
 * @returns {string}  e.g. "04:09"
 */
export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * Returns elapsed seconds from an ISO timestamp string until now.
 * Used for the live ticking timer.
 * @param {string} isoStart
 * @returns {number}
 */
export function elapsedSecSince(isoStart) {
  if (!isoStart) return 0;
  const start = new Date(isoStart);
  const now   = new Date();
  const diff  = (now - start) / 1000;
  return diff >= 0 ? diff : 0;
}

/**
 * Formats an ISO timestamp string into a localized display string.
 * @param {string} iso
 * @returns {string}
 */
export function formatTimestamp(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleString("en-PH", {
    month:   "short",
    day:     "numeric",
    year:    "numeric",
    hour:    "2-digit",
    minute:  "2-digit",
    second:  "2-digit",
    hour12:  true,
  });
}

/**
 * Formats a Date object into a short time string for the header.
 * @param {Date} date
 * @returns {string}  e.g. "10:45:22 AM"
 */
export function formatTime(date) {
  return date.toLocaleTimeString("en-PH", {
    hour:    "2-digit",
    minute:  "2-digit",
    second:  "2-digit",
    hour12:  true,
  });
}
