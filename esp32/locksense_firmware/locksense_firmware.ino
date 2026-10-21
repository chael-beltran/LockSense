/*
 * ===========================================================================
 * LockSense — ESP32 Firmware (multi-locker)
 * Smart Locker Activity Monitoring System
 * ===========================================================================
 *
 * One ESP32 = one locker. Flash each board with its own LOCKER_ID
 * (e.g. "Locker-01", "Locker-02", ...). A locker registers itself in the
 * database the first time its board boots; no manual setup is required.
 *
 * HARDWARE CONNECTIONS:
 * ─────────────────────────────────────────────────────────────────────────
 *  Component               ESP32 Pin      Notes
 * ─────────────────────────────────────────────────────────────────────────
 *  MC-38 Reed Switch       GPIO 4         One terminal → GPIO, other → GND
 *                                         INPUT_PULLUP (magnet in contact = LOW)
 *  Snap-Action Microswitch GPIO 5         One terminal → GPIO, other → GND
 *                                         INPUT_PULLUP (pressed/engaged = LOW)
 *  Red LED                 GPIO 18        220Ω resistor in series to GND (Locker OPEN)
 *  Green LED               GPIO 19        220Ω resistor in series to GND (Locker CLOSED)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * SENSOR & STATE LOGIC:
 *  - Magnetic Door Sensor (MC-38, GPIO 4): LOW = Contact (Magnet present)
 *  - Physical Latch Switch (GPIO 5):       LOW = Engaged (Latch pressed)
 *  - CLOSED only when BOTH sensors are triggered (reedContact && microEngaged).
 *  - Any other combination (one sensor open, or both released) is OPEN.
 *  - Both sensor states (reed_contact, micro_engaged) are published individually
 *    to Firebase in real-time so the web dashboard displays their exact individual readings.
 *
 * LED BEHAVIOUR:
 *  - Locker OPEN   → Red LED ON, Green LED OFF (stays ON while door/latch is open).
 *  - Locker CLOSED → Green LED ON, Red LED OFF (indicates locker is fully secured).
 *
 * REQUIRED LIBRARIES (install via Arduino Library Manager):
 *   - ArduinoJson       by bblanchon (v6.x)
 *   - Firebase ESP32    by mobizt    "Firebase Arduino Client Library for ESP8266 and ESP32"
 *
 * REQUIRED BOARD SUPPORT:
 *   - "esp32 by Espressif Systems" via Boards Manager
 *
 * ===========================================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <FirebaseESP32.h>    // Firebase Arduino Client Library for ESP8266 and ESP32
#include <ArduinoJson.h>
#include <Preferences.h>     // NVS storage: remembers an open session across reboots
#include <time.h>

/* ──────────────────────────────────────────────────────────────────────────
   USER CONFIGURATION — EDIT THESE VALUES
────────────────────────────────────────────────────────────────────────── */

// Wi-Fi credentials
const char* WIFI_SSID     = "it's-Wi-Fi";
const char* WIFI_PASSWORD = "123456789";

// Firebase project settings
const char* FIREBASE_HOST = "locksense-default-rtdb.asia-southeast1.firebasedatabase.app";
const char* FIREBASE_AUTH = "1QKKJ9TyS7vorEx8i8kCQNw5NPymM6KC8nQlJYFo";

// Unique identifier of THIS locker. Change this for every board you flash.
// It becomes the database key (lockers/<LOCKER_ID>) and the name shown on the web app.
const char* LOCKER_ID = "Locker-01";

// NTP time server (for accurate timestamps)
const char* NTP_SERVER     = "pool.ntp.org";
const long  GMT_OFFSET_SEC = 28800;   // UTC+8 (Philippines) = 8 × 3600
const int   DST_OFFSET_SEC = 0;

/* ──────────────────────────────────────────────────────────────────────────
   PIN DEFINITIONS
────────────────────────────────────────────────────────────────────────── */

const int PIN_REED_SWITCH = 4;    // MC-38 magnetic reed switch
const int PIN_MICROSWITCH = 5;    // Snap-action microswitch (door latch pressed against it)
const int PIN_LED_RED     = 18;   // Red LED   — Active when locker is OPEN
const int PIN_LED_GREEN   = 19;   // Green LED — Active when locker is CLOSED

/* ──────────────────────────────────────────────────────────────────────────
   TIMING
────────────────────────────────────────────────────────────────────────── */

// A reading must be stable this long before it is accepted (switch bounce).
const unsigned long DEBOUNCE_MS  = 50;
// Heartbeat interval; the web app marks the locker Offline after ~20 s of silence.
const unsigned long HEARTBEAT_MS = 5000;
// No successful database write for this long = disconnected (matches the web
// app's OFFLINE_THRESHOLD_MS). An open session is disconnected at that point.
const unsigned long OFFLINE_GRACE_MS = 20000;

/* ──────────────────────────────────────────────────────────────────────────
   STATE & SENSOR DEFINITIONS
────────────────────────────────────────────────────────────────────────── */

enum LockerState { STATE_CLOSED, STATE_OPEN };

// Sensor telemetry structure for individual hardware reporting
struct SensorReadings {
  bool reedContact;   // true = MC-38 magnet in contact (LOW); false = separated (HIGH)
  bool microEngaged;  // true = microswitch latch pressed (LOW); false = released (HIGH)

  bool isClosed() const {
    return reedContact && microEngaged;
  }
};

// Status strings stored in the database (must match the web app)
const char* STATUS_OPEN   = "OPEN";
const char* STATUS_CLOSED = "CLOSED";

FirebaseData   fbData;
FirebaseConfig fbConfig;
FirebaseAuth   fbAuth;

SensorReadings confirmedSensors = { false, false };
SensorReadings pendingSensors   = { false, false };
LockerState    confirmedState   = STATE_OPEN;
unsigned long  debounceStart    = 0;

// Open-session tracking (one activity log record per open → close cycle)
bool          sessionActive  = false;
String        sessionLogKey  = "";
unsigned long sessionStartMs = 0;

// Connectivity tracking — a session that loses its connection is frozen at the
// last moment the board was confirmed online and is finalized as DISCONNECTED.
const char*   STATUS_DISCONNECTED = "DISCONNECTED";
bool          linkUp              = false;  // last known Wi-Fi + Firebase state
bool          sessionDisconnected = false;  // open session lost its connection
unsigned long lastOnlineMs        = 0;      // millis() of last successful write
String        lastOnlineTs        = "";     // ISO time of last successful write
unsigned long frozenEndMs         = 0;      // session end captured at disconnect
String        frozenEndTs         = "";

Preferences   prefs;

/* ──────────────────────────────────────────────────────────────────────────
   FUNCTION DECLARATIONS
────────────────────────────────────────────────────────────────────────── */

SensorReadings readSensors();
void           setLEDs(bool redOn, bool greenOn);
void           handleSensorChange(const SensorReadings& sensors);
String         getISOTimestamp();
void           publishState(LockerState state, const SensorReadings& sensors, const String& ts);
void           startSessionLog(const String& ts);
void           endSessionLog(const String& ts);
void           sendHeartbeat();
void           markOnline(const String& ts);
void           disconnectSession();
void           checkConnectivity();
void           finalizeDisconnectedSession();
void           recoverOrphanSession();
void           persistSession();
void           clearPersistedSession();
void           connectWiFi();
void           setupNTP();

/* ──────────────────────────────────────────────────────────────────────────
   SETUP
────────────────────────────────────────────────────────────────────────── */

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.printf("\n[LockSense] Booting %s...\n", LOCKER_ID);

  pinMode(PIN_REED_SWITCH, INPUT_PULLUP);
  pinMode(PIN_MICROSWITCH, INPUT_PULLUP);
  pinMode(PIN_LED_RED,     OUTPUT);
  pinMode(PIN_LED_GREEN,   OUTPUT);

  // Read initial physical sensor readings immediately
  confirmedSensors = readSensors();
  pendingSensors   = confirmedSensors;
  confirmedState   = confirmedSensors.isClosed() ? STATE_CLOSED : STATE_OPEN;

  // Set hardware LEDs according to physical state
  if (confirmedState == STATE_OPEN) {
    setLEDs(true, false); // Red ON, Green OFF
  } else {
    setLEDs(false, true); // Red OFF, Green ON
  }

  connectWiFi();
  setupNTP();

  fbConfig.host                       = FIREBASE_HOST;
  fbConfig.signer.tokens.legacy_token = FIREBASE_AUTH;
  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectWiFi(true);
  fbData.setResponseSize(4096);

  // A reboot is a reconnect, not an opening event: close out any session that
  // was left open before the power/connection loss, and do NOT start a new one
  // even if the door is currently open. A new session is only recorded when a
  // real CLOSED → OPEN transition is detected.
  prefs.begin("locksense", false);
  linkUp = (WiFi.status() == WL_CONNECTED) && Firebase.ready();
  recoverOrphanSession();

  String ts = getISOTimestamp();
  publishState(confirmedState, confirmedSensors, ts);

  Serial.println("[LockSense] Ready. Entering monitoring loop.");
}

/* ──────────────────────────────────────────────────────────────────────────
   MAIN LOOP
────────────────────────────────────────────────────────────────────────── */

void loop() {
  checkConnectivity();
  sendHeartbeat();

  // Read both sensors continuously
  SensorReadings sampled = readSensors();

  // Detect any sensor transition
  if (sampled.reedContact != pendingSensors.reedContact ||
      sampled.microEngaged != pendingSensors.microEngaged) {
    pendingSensors = sampled;
    debounceStart  = millis();
  }

  // Once stable for DEBOUNCE_MS, confirm and broadcast
  if ((pendingSensors.reedContact != confirmedSensors.reedContact ||
       pendingSensors.microEngaged != confirmedSensors.microEngaged) &&
      (millis() - debounceStart) >= DEBOUNCE_MS) {
    confirmedSensors = pendingSensors;
    handleSensorChange(confirmedSensors);
  }

  delay(10);
}

/* ──────────────────────────────────────────────────────────────────────────
   SENSORS
────────────────────────────────────────────────────────────────────────── */

/**
 * Both sensors use INPUT_PULLUP (LOW = active / contact / engaged):
 *   Reed switch LOW → MC-38 magnet in contact (door in frame)
 *   Microswitch LOW → physical latch depressed
 *
 * The locker is CLOSED only when both are engaged simultaneously.
 * If either one (or both) is open, the locker is classified as OPEN.
 */
SensorReadings readSensors() {
  SensorReadings s;
  s.reedContact  = (digitalRead(PIN_REED_SWITCH) == LOW);
  s.microEngaged = (digitalRead(PIN_MICROSWITCH) == LOW);
  return s;
}

/* ──────────────────────────────────────────────────────────────────────────
   LED CONTROL
────────────────────────────────────────────────────────────────────────── */

void setLEDs(bool redOn, bool greenOn) {
  digitalWrite(PIN_LED_RED,   redOn   ? HIGH : LOW);
  digitalWrite(PIN_LED_GREEN, greenOn ? HIGH : LOW);
}

/* ──────────────────────────────────────────────────────────────────────────
   STATE & SENSOR TRANSITIONS
────────────────────────────────────────────────────────────────────────── */

/**
 * Triggered whenever EITHER sensor detects a physical change.
 * Updates hardware LEDs instantly, manages session logs, and pushes telemetry.
 */
void handleSensorChange(const SensorReadings& sensors) {
  LockerState newState = sensors.isClosed() ? STATE_CLOSED : STATE_OPEN;
  String ts = getISOTimestamp();

  if (newState == STATE_OPEN) {
    // Locker is OPEN: Red LED ON, Green LED OFF
    setLEDs(true, false);
    Serial.printf("[LockSense] SENSORS -> OPEN (Magnetic Reed: %s | Latch Switch: %s) at %s\n",
                  sensors.reedContact ? "CONTACT" : "OPEN",
                  sensors.microEngaged ? "ENGAGED" : "RELEASED",
                  ts.c_str());

    // If transitioned from CLOSED to OPEN, start open session log
    if (confirmedState != STATE_OPEN) {
      startSessionLog(ts);
    }
  } else {
    // Locker is CLOSED: Green LED ON, Red LED OFF
    setLEDs(false, true);
    Serial.printf("[LockSense] SENSORS -> CLOSED (Secured) at %s\n", ts.c_str());

    // If transitioned from OPEN to CLOSED, end session log with duration
    if (confirmedState != STATE_CLOSED) {
      endSessionLog(ts);
    }
  }

  confirmedState = newState;
  publishState(confirmedState, sensors, ts);
}

/* ──────────────────────────────────────────────────────────────────────────
   TIMESTAMP (ISO 8601)
────────────────────────────────────────────────────────────────────────── */

String getISOTimestamp() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    Serial.println("[LockSense] WARNING: NTP time not available.");
    return "1970-01-01T00:00:00+08:00";
  }

  char buf[32];
  // Format: 2026-10-20T13:45:00+08:00
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S+08:00", &timeinfo);
  return String(buf);
}

/* ──────────────────────────────────────────────────────────────────────────
   FIREBASE REAL-TIME TELEMETRY
────────────────────────────────────────────────────────────────────────── */

/**
 * Writes the live state to lockers/<LOCKER_ID>:
 *   - status: "OPEN" or "CLOSED"
 *   - reed_contact: true (contact) / false (open)
 *   - micro_engaged: true (engaged) / false (released)
 *   - updated_at, last_seen, and transition timestamps
 */
void publishState(LockerState state, const SensorReadings& sensors, const String& ts) {
  if (!Firebase.ready()) {
    Serial.println("[LockSense] Firebase not ready, skipping publish.");
    return;
  }

  FirebaseJson json;
  json.set("status",        state == STATE_OPEN ? STATUS_OPEN : STATUS_CLOSED);
  json.set("reed_contact",  sensors.reedContact);
  json.set("micro_engaged", sensors.microEngaged);
  json.set("updated_at",    ts.c_str());
  json.set("last_seen",     ts.c_str());
  json.set(state == STATE_OPEN ? "last_opened_at" : "last_closed_at", ts.c_str());

  String path = String("lockers/") + LOCKER_ID;
  if (Firebase.updateNode(fbData, path, json)) {
    markOnline(ts);
  } else {
    Serial.printf("[LockSense] Publish FAILED: %s\n", fbData.errorReason().c_str());
  }
}

/**
 * Opens an activity log record: activity_logs/<pushId>
 * The record is completed (close time + duration) by endSessionLog().
 */
void startSessionLog(const String& ts) {
  // Never start a new session while a previous disconnected one is still waiting
  // to be finalized, or while the board is offline (nothing can be recorded).
  if (sessionDisconnected || !linkUp || !Firebase.ready()) {
    Serial.println("[LockSense] Opening detected while offline — not recorded.");
    return;
  }

  FirebaseJson json;
  json.set("locker_id",      LOCKER_ID);
  json.set("timestamp_open", ts.c_str());
  json.set("status",         STATUS_OPEN);

  if (Firebase.pushJSON(fbData, "activity_logs", json)) {
    sessionActive  = true;
    sessionStartMs = millis();
    sessionLogKey  = fbData.pushName();
    markOnline(ts);
    persistSession();
  } else {
    Serial.printf("[LockSense] Open log FAILED: %s\n", fbData.errorReason().c_str());
  }
}

/**
 * Completes the open record with the close time and the session duration.
 * Duration comes from millis(), so it stays correct even if NTP is unavailable.
 */
void endSessionLog(const String& ts) {
  if (!sessionActive) return;

  // The connection dropped during this session: its duration is already frozen
  // and it will be finalized as DISCONNECTED once the board reconnects.
  if (sessionDisconnected || !linkUp || !Firebase.ready()) {
    disconnectSession();
    return;
  }

  long durationSec = (long)((millis() - sessionStartMs) / 1000UL);

  FirebaseJson json;
  json.set("timestamp_close", ts.c_str());
  json.set("duration_sec",    durationSec);
  json.set("status",          STATUS_CLOSED);

  String path = String("activity_logs/") + sessionLogKey;
  if (Firebase.updateNode(fbData, path, json)) {
    markOnline(ts);
    sessionActive = false;
    sessionLogKey = "";
    clearPersistedSession();
  } else {
    // Write failed → the close could not be confirmed; finalize on reconnect.
    Serial.printf("[LockSense] Close log FAILED: %s\n", fbData.errorReason().c_str());
    disconnectSession();
  }
}

/**
 * Records the last moment the board was confirmed online (successful write).
 */
void markOnline(const String& ts) {
  lastOnlineMs = millis();
  lastOnlineTs = ts;
}

/**
 * Freezes the open session at the last confirmed online moment. Called once
 * when the connection is lost; later calls keep the original frozen point.
 */
void disconnectSession() {
  if (!sessionActive || sessionDisconnected) return;
  sessionDisconnected = true;
  frozenEndMs = lastOnlineMs;
  frozenEndTs = lastOnlineTs;
  Serial.println("[LockSense] Open session DISCONNECTED (connection lost) — duration frozen.");
}

/**
 * Detects Wi-Fi / Firebase connection loss and recovery.
 *   Online = Wi-Fi + Firebase ready + a successful write within
 *            OFFLINE_GRACE_MS (same 20 s window the dashboard uses).
 *   - Lost during an open session → freeze the session (disconnected).
 *   - Restored                    → finalize the disconnected session and
 *                                   re-publish the current live state.
 * Reconnecting never creates a new session.
 */
void checkConnectivity() {
  bool transportUp = (WiFi.status() == WL_CONNECTED) && Firebase.ready();
  bool fresh       = lastOnlineMs != 0 && (millis() - lastOnlineMs) <= OFFLINE_GRACE_MS;
  bool nowUp       = transportUp && fresh;

  if (!nowUp && linkUp) {
    Serial.println("[LockSense] Connection LOST.");
    disconnectSession();
  }

  if (nowUp && !linkUp) {
    Serial.println("[LockSense] Connection RESTORED.");
    publishState(confirmedState, confirmedSensors, getISOTimestamp());
  }
  linkUp = nowUp;

  // Finalize a pending disconnected session while online (throttled retries).
  static unsigned long lastFinalizeTry = 0;
  if (linkUp && sessionDisconnected && millis() - lastFinalizeTry >= HEARTBEAT_MS) {
    lastFinalizeTry = millis();
    finalizeDisconnectedSession();
  }
}

/**
 * Completes a disconnected session record with the last confirmed online time
 * and the duration up to that point, and tags it as DISCONNECTED.
 */
void finalizeDisconnectedSession() {
  if (sessionActive && sessionLogKey.length() > 0) {
    unsigned long endMs = frozenEndMs >= sessionStartMs ? frozenEndMs : sessionStartMs;
    long durationSec = (long)((endMs - sessionStartMs) / 1000UL);
    String endTs = frozenEndTs.length() ? frozenEndTs : getISOTimestamp();

    FirebaseJson json;
    json.set("timestamp_close", endTs.c_str());
    json.set("duration_sec",    durationSec);
    json.set("status",          STATUS_DISCONNECTED);

    String path = String("activity_logs/") + sessionLogKey;
    if (!Firebase.updateNode(fbData, path, json)) {
      Serial.printf("[LockSense] Disconnect log FAILED: %s\n", fbData.errorReason().c_str());
      return;   // retried by checkConnectivity()
    }
    Serial.printf("[LockSense] Session %s marked DISCONNECTED (%lds).\n", sessionLogKey.c_str(), durationSec);
  }

  sessionActive       = false;
  sessionDisconnected = false;
  sessionLogKey       = "";
  clearPersistedSession();
}

/**
 * After a reboot, any session key still stored in NVS belongs to a session
 * that never received its close event (power loss / crash). Finalize it as
 * DISCONNECTED using the locker's last heartbeat as the end time.
 */
void recoverOrphanSession() {
  String key = prefs.getString("sessKey", "");
  if (key.length() == 0) return;
  if (!linkUp) {
    // Keep the key; it will be recovered on a later boot with connectivity.
    Serial.println("[LockSense] Orphan session pending (offline).");
    return;
  }

  long openEpoch = (long)prefs.getLong("sessOpen", 0);
  FirebaseJson json;
  json.set("status", STATUS_DISCONNECTED);

  String lockerPath = String("lockers/") + LOCKER_ID + "/last_seen";
  if (Firebase.getString(fbData, lockerPath)) {
    String lastSeen = fbData.stringData();
    struct tm tmSeen = {};
    if (strptime(lastSeen.c_str(), "%Y-%m-%dT%H:%M:%S", &tmSeen)) {
      long seenEpoch = (long)mktime(&tmSeen);
      json.set("timestamp_close", lastSeen.c_str());
      if (openEpoch > 0 && seenEpoch >= openEpoch) {
        json.set("duration_sec", seenEpoch - openEpoch);
      }
    }
  }

  String path = String("activity_logs/") + key;
  if (Firebase.updateNode(fbData, path, json)) {
    Serial.printf("[LockSense] Orphan session %s marked DISCONNECTED.\n", key.c_str());
    clearPersistedSession();
  }
}

void persistSession() {
  prefs.putString("sessKey", sessionLogKey);
  prefs.putLong("sessOpen", (long)time(nullptr));
}

void clearPersistedSession() {
  prefs.remove("sessKey");
  prefs.remove("sessOpen");
}

/**
 * Periodic heartbeat so the web app knows the board is online.
 * Also keeps sensor telemetry in sync with the web frontend.
 */
void sendHeartbeat() {
  static unsigned long lastBeat = 0;
  if (millis() - lastBeat < HEARTBEAT_MS) return;
  lastBeat = millis();

  if (WiFi.status() == WL_CONNECTED && Firebase.ready()) {
    String path = String("lockers/") + LOCKER_ID;
    String ts = getISOTimestamp();
    FirebaseJson json;
    json.set("last_seen",     ts.c_str());
    json.set("reed_contact",  confirmedSensors.reedContact);
    json.set("micro_engaged", confirmedSensors.microEngaged);
    if (Firebase.updateNode(fbData, path, json)) {
      markOnline(ts);
    } else {
      // Heartbeat could not reach the database. If this persists past
      // OFFLINE_GRACE_MS, checkConnectivity() interrupts any open session.
      Serial.printf("[LockSense] Heartbeat FAILED: %s\n", fbData.errorReason().c_str());
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   WI-FI CONNECTION
────────────────────────────────────────────────────────────────────────── */

void connectWiFi() {
  Serial.printf("[LockSense] Connecting to Wi-Fi: %s\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 15000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[LockSense] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("[LockSense] Wi-Fi FAILED. Operating in offline mode (no Firebase push).");
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   NTP TIME SYNC
────────────────────────────────────────────────────────────────────────── */

void setupNTP() {
  configTime(GMT_OFFSET_SEC, DST_OFFSET_SEC, NTP_SERVER);
  Serial.print("[LockSense] Syncing NTP time");

  struct tm timeinfo;
  int retries = 0;
  while (!getLocalTime(&timeinfo) && retries < 10) {
    delay(500);
    Serial.print(".");
    retries++;
  }
  Serial.println();

  if (retries < 10) {
    char buf[32];
    strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &timeinfo);
    Serial.printf("[LockSense] Time synced: %s\n", buf);
  } else {
    Serial.println("[LockSense] NTP sync failed — timestamps may be inaccurate.");
  }
}