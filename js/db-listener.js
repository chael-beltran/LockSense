/**
 * db-listener.js
 * ------------------------------------------------------------------
 * Manages the real-time Firebase Realtime Database connection.
 * Subscribes once to ALL lockers and the recent activity log, then
 * hands plain arrays to the callbacks. Never touches the DOM.
 * ------------------------------------------------------------------
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, onValue, query, limitToLast }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

import { FIREBASE_CONFIG, DB_PATHS, APP_CONFIG } from "./firebase-config.js";

/**
 * Start all listeners. Call once after the DOM is ready.
 *
 * @param {object}   handlers
 * @param {Function} handlers.onLockers     (lockers[]) sorted by id; each { id, status, updated_at, ... }
 * @param {Function} handlers.onLogs        (logs[]) newest first; each { key, locker_id, timestamp_open, ... }
 * @param {Function} handlers.onConnection  (connected:boolean) database connectivity
 */
export function initListeners({ onLockers, onLogs, onConnection }) {
  const db = getDatabase(initializeApp(FIREBASE_CONFIG));

  onValue(ref(db, ".info/connected"), (snap) => onConnection(snap.val() === true));

  onValue(
    ref(db, DB_PATHS.LOCKERS),
    (snap) => {
      const lockers = Object.entries(snap.val() ?? {})
        .filter(([, v]) => v && typeof v === "object")
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      onLockers(lockers);
    },
    (err) => {
      console.error("[LockSense] Locker listener error:", err);
      onConnection(false);
    }
  );

  // Push-ids are chronological, so limitToLast returns the newest records
  // across every locker without needing a database index.
  onValue(
    query(ref(db, DB_PATHS.ACTIVITY_LOGS), limitToLast(APP_CONFIG.MAX_LOGS)),
    (snap) => {
      const logs = Object.entries(snap.val() ?? {})
        .map(([key, v]) => ({ key, ...v }))
        .filter((r) => r.locker_id && r.timestamp_open)
        .sort((a, b) => new Date(b.timestamp_open) - new Date(a.timestamp_open));
      onLogs(logs);
    },
    (err) => {
      console.error("[LockSense] Log listener error:", err);
      onConnection(false);
    }
  );
}
