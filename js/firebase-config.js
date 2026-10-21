/**
 * firebase-config.js
 * ------------------------------------------------------------------
 * Single source of truth for Firebase project credentials.
 *
 * How to find these values:
 *   Firebase Console → Project Settings → General → Your Apps → SDK setup
 * ------------------------------------------------------------------
 */

export const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyA6CyZVs_U5onfeOcM3W3aUQR-uE3ZBiIY",
  authDomain:        "locksense.firebaseapp.com",
  databaseURL:       "https://locksense-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "locksense",
  storageBucket:     "locksense.firebasestorage.app",
  messagingSenderId: "7761140209",
  appId:             "1:7761140209:web:a3a85387bcbf046e5ecc50",
};

/**
 * Database node paths — keep all path strings here so they are
 * easy to update if the database schema changes.
 */
export const DB_PATHS = {
  /**
   * One child per locker, keyed by the LOCKER_ID flashed on its ESP32.
   * Structure: lockers/{lockerId} → {
   *   status:         "OPEN" | "CLOSED",
   *   updated_at:     ISO timestamp of the last state change,
   *   last_seen:      ISO timestamp of the last heartbeat,
   *   last_opened_at: ISO timestamp,
   *   last_closed_at: ISO timestamp,
   * }
   */
  LOCKERS: "lockers",

  /**
   * One record per open → close cycle. Child keys are Firebase push-ids.
   * Structure: {
   *   locker_id:       string,
   *   timestamp_open:  string,
   *   timestamp_close: string | absent while the locker is still open,
   *   duration_sec:    number | absent while the locker is still open,
   *   status:          "OPEN" | "CLOSED" | "DISCONNECTED" (connection lost
   *                    mid-session; close time/duration frozen at the last
   *                    confirmed contact),
   * }
   */
  ACTIVITY_LOGS: "activity_logs",
};

/**
 * Application-level constants.
 */
export const APP_CONFIG = {
  /** Number of log rows shown per page in the activity table. */
  ROWS_PER_PAGE: 15,

  /** Number of history rows shown per page in the unit activity history table. */
  DETAIL_ROWS_PER_PAGE: 10,

  /** Most recent log records loaded from the database. */
  MAX_LOGS: 500,

  /** A locker with no heartbeat for this long is shown as Offline. */
  OFFLINE_THRESHOLD_MS: 20000,
};
