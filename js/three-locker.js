/**
 * three-locker.js
 * ------------------------------------------------------------------
 * Interactive 3D Smart Locker Array & Single-Unit Digital Twin Engine.
 * Built with Three.js (r128).
 *
 * Overview mode:
 * - Displays a realistic physical 10-slot locker cabinet bank.
 * - Arranged in 2 rows of 5 slots:
 *     Bottom row: Slots 01, 02, 03, 04, 05
 *     Top row:    Slots 06, 07, 08, 09, 10
 * - Flush front face (Z = 0) with authentic cabinet carcass, base plinth,
 *   dividing shelf, and vertical column mullions.
 * - Only registered lockers (e.g. Locker-01) have active door mechanics,
 *   LED indicators, dynamic telemetry nameplates, and interactive logs.
 * - Unconnected slots (Slots 02-10) are clearly rendered as unassigned
 *   compartments (minimal slot number, unlit LEDs, no fake OPEN/CLOSED).
 *
 * Single-unit mode:
 * - Focuses on a single locker node at (0, 0, 0) for close inspection.
 * ------------------------------------------------------------------
 */

import { formatClock, elapsedSecSince, formatTimestamp } from "./duration.js";
import { APP_CONFIG } from "./firebase-config.js";

const isOpen = (l) => l && l.status === "OPEN";

function isOnline(l) {
  if (!l) return false;
  const t = new Date(l.last_seen || l.updated_at).getTime();
  return !isNaN(t) && Date.now() - t <= APP_CONFIG.OFFLINE_THRESHOLD_MS;
}

export class Locker3DEngine {
  constructor(containerId, isSingleUnit = false, onLockerClick = null) {
    this.containerId = containerId;
    this.isSingleUnit = isSingleUnit;
    this.onLockerClick = onLockerClick;
    this.container = document.getElementById(containerId);
    this.scene = null;
    this.camera = null;
    this.renderer = null;

    // Slot & mesh state
    this.slotUnits = new Map(); // slotIndex -> slotRecord
    this.lockerMeshes = new Map(); // lockerId -> unitRecord (for backwards compat and focus)
    this.carcassGroup = null;

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.isDragging = false;
    this.dragDistance = 0;
    this.prevMouse = { x: 0, y: 0 };
    this.autoRotate = false;

    // Spherical camera orbit coordinates (default Front View for overview, full-body for single unit)
    this.spherical = {
      radius: isSingleUnit ? 3.75 : 8.6,
      theta: isSingleUnit ? 0.0 : 0.0,
      phi: isSingleUnit ? 1.48 : 1.34,
    };
    this.targetSpherical = { ...this.spherical };
    this.cameraTarget = new THREE.Vector3(0, isSingleUnit ? 0.88 : 1.78, 0);
    this.targetLookAt = new THREE.Vector3(0, isSingleUnit ? 0.88 : 1.78, 0);

    this.hoveredObject = null;
    this.activeLockers = [];
    this.redLedPulseMap = new Map(); // lockerId -> timestamp until which red LED pulses

    if (this.container && typeof THREE !== "undefined") {
      this.init();
    }
  }

  init() {
    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 480;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
    this.updateCameraPosition(true);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.container.innerHTML = "";
    this.container.appendChild(this.renderer.domElement);

    // Studio & Architectural Lighting
    const ambientLight = new THREE.AmbientLight(0xdbeafe, 0.75);
    this.scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.25);
    keyLight.position.set(7, 13, 10);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x4f72e3, 0.65);
    rimLight.position.set(-9, 7, -6);
    this.scene.add(rimLight);

    // Subtle Industrial Floor Grid
    const gridHelper = new THREE.GridHelper(32, 32, 0x252b3d, 0x161a26);
    gridHelper.position.y = -0.01;
    this.scene.add(gridHelper);

    const floorGeo = new THREE.PlaneGeometry(40, 40);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x090b10,
      roughness: 0.85,
      metalness: 0.15,
    });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = -0.02;
    floorMesh.receiveShadow = true;
    this.scene.add(floorMesh);

    if (!this.isSingleUnit) {
      this.buildCabinetCarcass();
      this.buildPhysicalSlots();
    }

    this.bindEvents();
  }

  /* ───────────────────────────────────────────────────────────────
     CABINET CARCASS & 10 PHYSICAL SLOTS (2 ROWS × 5 COLUMNS)
  ─────────────────────────────────────────────────────────────────*/

  buildCabinetCarcass() {
    this.carcassGroup = new THREE.Group();

    const cols = 5;
    const pitchX = 1.42;
    const plinthH = 0.16;
    const slotH = 1.62;
    const shelfH = 0.04;
    const topCapH = 0.08;
    const totalW = cols * pitchX + 0.14; // ~7.24
    const totalH = plinthH + slotH + shelfH + slotH + topCapH; // ~3.52
    const totalD = 1.22;

    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x121622,
      roughness: 0.55,
      metalness: 0.6,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x1e2433,
      roughness: 0.45,
      metalness: 0.65,
    });
    const plinthMat = new THREE.MeshStandardMaterial({
      color: 0x0c0f17,
      roughness: 0.7,
      metalness: 0.4,
    });

    // 1. Bottom Plinth / Kickplate
    const plinthMesh = new THREE.Mesh(new THREE.BoxGeometry(totalW, plinthH, totalD), plinthMat);
    plinthMesh.position.set(0, plinthH / 2, 0);
    plinthMesh.receiveShadow = true;
    this.carcassGroup.add(plinthMesh);

    // 2. Full Back Enclosure Panel
    const backMesh = new THREE.Mesh(new THREE.BoxGeometry(totalW, totalH - plinthH, 0.04), frameMat);
    backMesh.position.set(0, plinthH + (totalH - plinthH) / 2, -totalD / 2 + 0.02);
    backMesh.castShadow = true;
    this.carcassGroup.add(backMesh);

    // 3. Left Outer Wall
    const leftMesh = new THREE.Mesh(new THREE.BoxGeometry(0.05, totalH - plinthH, totalD), frameMat);
    leftMesh.position.set(-totalW / 2 + 0.025, plinthH + (totalH - plinthH) / 2, 0);
    leftMesh.castShadow = true;
    this.carcassGroup.add(leftMesh);

    // 4. Right Outer Wall
    const rightMesh = new THREE.Mesh(new THREE.BoxGeometry(0.05, totalH - plinthH, totalD), frameMat);
    rightMesh.position.set(totalW / 2 - 0.025, plinthH + (totalH - plinthH) / 2, 0);
    rightMesh.castShadow = true;
    this.carcassGroup.add(rightMesh);

    // 5. Top Architectural Canopy
    const topMesh = new THREE.Mesh(new THREE.BoxGeometry(totalW + 0.06, topCapH, totalD + 0.04), trimMat);
    topMesh.position.set(0, totalH - topCapH / 2, 0);
    topMesh.castShadow = true;
    this.carcassGroup.add(topMesh);

    // 6. Middle Horizontal Dividing Shelf (between Row 0 and Row 1)
    const midShelfY = plinthH + slotH + shelfH / 2;
    const midShelf = new THREE.Mesh(new THREE.BoxGeometry(totalW - 0.08, shelfH, totalD - 0.04), trimMat);
    midShelf.position.set(0, midShelfY, 0);
    midShelf.castShadow = true;
    this.carcassGroup.add(midShelf);

    // 7. Vertical Dividing Columns (4 mullions separating the 5 bays)
    for (let c = 1; c < cols; c++) {
      const dividerX = -totalW / 2 + c * pitchX + 0.07;
      const divider = new THREE.Mesh(new THREE.BoxGeometry(0.03, totalH - plinthH - topCapH, totalD - 0.06), frameMat);
      divider.position.set(dividerX, plinthH + (totalH - plinthH - topCapH) / 2, 0);
      this.carcassGroup.add(divider);
    }

    this.scene.add(this.carcassGroup);
  }

  buildPhysicalSlots() {
    const pitchX = 1.42;
    const plinthH = 0.16;
    const slotH = 1.62;
    const shelfH = 0.04;

    const row0Y = plinthH + slotH / 2; // Bottom row center: 0.16 + 0.81 = 0.97
    const row1Y = plinthH + slotH + shelfH + slotH / 2; // Top row center: 0.16 + 1.62 + 0.04 + 0.81 = 2.63

    // 10 slots: 0..4 = bottom row (Slots 01..05); 5..9 = top row (Slots 06..10)
    for (let i = 0; i < 10; i++) {
      const col = i % 5;
      const row = Math.floor(i / 5);
      const slotNum = i + 1; // 1 to 10
      const posX = (col - 2) * pitchX;
      const posY = row === 0 ? row0Y : row1Y;
      const posZ = 0;

      const slotUnit = this.createSlotMeshUnit(i, slotNum, posX, posY, posZ);
      this.slotUnits.set(i, slotUnit);
    }
  }

  createSlotMeshUnit(slotIndex, slotNum, posX, posY, posZ) {
    const slotGroup = new THREE.Group();
    slotGroup.position.set(posX, posY, posZ);

    const slotW = 1.34;
    const slotH = 1.58;
    const slotD = 1.15;
    const wall = 0.04;

    // Materials
    const interiorMat = new THREE.MeshStandardMaterial({
      color: 0x0a0d14,
      roughness: 0.75,
      metalness: 0.3,
    });
    const doorActiveMat = new THREE.MeshStandardMaterial({
      color: 0x222a3d,
      roughness: 0.38,
      metalness: 0.62,
    });
    const doorUnassignedMat = new THREE.MeshStandardMaterial({
      color: 0x131722,
      roughness: 0.65,
      metalness: 0.4,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: 0x333f5c,
      roughness: 0.35,
      metalness: 0.75,
    });

    // Interior Shelf
    const shelfMesh = new THREE.Mesh(new THREE.BoxGeometry(slotW - wall * 2, 0.035, slotD - 0.1), interiorMat);
    shelfMesh.position.set(0, -slotH * 0.18, -0.02);
    shelfMesh.visible = false; // only visible when door opens
    slotGroup.add(shelfMesh);

    // Interior Parcel Box
    const parcelMat = new THREE.MeshStandardMaterial({ color: 0x2b354f, roughness: 0.5, metalness: 0.2 });
    const parcelMesh = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.32, 0.42), parcelMat);
    parcelMesh.position.set(-0.1, -slotH * 0.18 + 0.16 + 0.02, -0.08);
    parcelMesh.visible = false;
    slotGroup.add(parcelMesh);

    // Interior Illuminator (Illuminates when open)
    const interiorLight = new THREE.PointLight(0x10b981, 0, 2.4);
    interiorLight.position.set(0, slotH * 0.28, 0.05);
    slotGroup.add(interiorLight);

    // Hardware Telemetry Bezel (Top Header of Bay)
    const bezelMesh = new THREE.Mesh(new THREE.BoxGeometry(slotW - 0.08, 0.12, 0.035), interiorMat);
    bezelMesh.position.set(0, slotH / 2 - 0.065, slotD / 2 + 0.015);
    slotGroup.add(bezelMesh);

    // Left Indicator: Red LED (Locker OPEN)
    const redLedMat = new THREE.MeshBasicMaterial({
      color: 0x2a0d10,
    });
    const redLedMesh = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 16), redLedMat);
    redLedMesh.position.set(slotW / 2 - 0.24, slotH / 2 - 0.065, slotD / 2 + 0.038);
    slotGroup.add(redLedMesh);

    // Right Indicator: Green LED (Locker CLOSED)
    const greenLedMat = new THREE.MeshBasicMaterial({
      color: 0x082417,
    });
    const greenLedMesh = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 16), greenLedMat);
    greenLedMesh.position.set(slotW / 2 - 0.14, slotH / 2 - 0.065, slotD / 2 + 0.038);
    slotGroup.add(greenLedMesh);

    // Sensor Details (MC-38 reed switch + microswitch)
    const sensorMat = new THREE.MeshStandardMaterial({
      color: 0x06b6d4,
      emissive: 0x06b6d4,
      emissiveIntensity: 0.35,
      roughness: 0.3,
    });
    const reedSwitch = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.03, 0.04), sensorMat);
    reedSwitch.position.set(-slotW / 2 + 0.24, slotH / 2 - 0.14, slotD / 2 - 0.03);
    reedSwitch.visible = false;
    slotGroup.add(reedSwitch);

    const microSwitch = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.10, 0.05), sensorMat);
    microSwitch.position.set(-slotW / 2 + 0.08, 0, slotD / 2 - 0.03);
    microSwitch.visible = false;
    slotGroup.add(microSwitch);

    // Hinged Door Assembly
    const doorPivot = new THREE.Group();
    doorPivot.position.set(slotW / 2 - wall, 0, slotD / 2 - 0.015);
    slotGroup.add(doorPivot);

    const doorW = slotW - wall * 2 - 0.02; // ~1.24
    const doorH = slotH - 0.18; // ~1.40
    const doorThickness = 0.04;

    const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(doorW, doorH, doorThickness), doorUnassignedMat);
    doorMesh.position.set(-doorW / 2, -0.03, 0);
    doorMesh.castShadow = true;
    doorMesh.receiveShadow = true;
    doorPivot.add(doorMesh);

    // Door face: display panel, pull handle, vents (non-overlapping zones)
    const { labelCanvas, labelTex } = this.buildDoorFace(doorPivot, doorW, doorH, doorThickness, accentMat);

    // Metadata on group and meshes for raycasting
    const userData = {
      isSlot: true,
      slotIndex,
      slotNum,
      isRegistered: false,
      lockerId: null,
      assignedLocker: null,
    };

    slotGroup.userData = userData;
    slotGroup.traverse((child) => {
      child.userData = userData;
    });

    this.scene.add(slotGroup);

    const slotRecord = {
      slotIndex,
      slotNum,
      rootGroup: slotGroup,
      doorPivot,
      doorMesh,
      doorActiveMat,
      doorUnassignedMat,
      greenLedMat,
      redLedMat,
      shelfMesh,
      parcelMesh,
      reedSwitch,
      microSwitch,
      interiorLight,
      labelCanvas,
      labelTex,
      currentAngle: 0,
      targetAngle: 0,
      assignedLocker: null,
      lastBadgeKey: "",
    };

    // Render initial unassigned plate
    this.renderUnassignedNameplate(slotRecord, slotNum);

    return slotRecord;
  }

  /* ───────────────────────────────────────────────────────────────
     DOOR FACE (shared by dashboard slots and single-unit view)
     Layout zones on the door, top to bottom, none overlapping:
       1. Display panel (name + connection + state), upper area
       2. Vertical pull handle, opening edge (left), mid height
       3. Ventilation slots, lower area
  ─────────────────────────────────────────────────────────────────*/

  buildDoorFace(doorPivot, doorW, doorH, doorThickness, accentMat) {
    const doorCenterX = -doorW / 2;
    const doorCenterY = -0.03;
    const faceZ = doorThickness / 2;
    const doorTop = doorCenterY + doorH / 2;
    const doorBottom = doorCenterY - doorH / 2;

    // 1. Display panel: dark bezel housing with the label screen set in front of it
    const plateW = doorW * 0.64;
    const plateH = plateW / 2; // matches 2:1 canvas, so text is never stretched
    const plateY = doorTop - 0.17 - plateH / 2;

    const bezelMat = new THREE.MeshStandardMaterial({ color: 0x0a0d14, roughness: 0.4, metalness: 0.5 });
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(plateW + 0.05, plateH + 0.05, 0.01), bezelMat);
    bezel.position.set(doorCenterX, plateY, faceZ + 0.005);
    doorPivot.add(bezel);

    const labelCanvas = document.createElement("canvas");
    labelCanvas.width = 1024;
    labelCanvas.height = 512;
    const labelTex = new THREE.CanvasTexture(labelCanvas);
    labelTex.anisotropy = 8;

    const plateMat = new THREE.MeshBasicMaterial({ map: labelTex, transparent: true });
    const plateMesh = new THREE.Mesh(new THREE.PlaneGeometry(plateW, plateH), plateMat);
    plateMesh.position.set(doorCenterX, plateY, faceZ + 0.0115);
    doorPivot.add(plateMesh);

    // 2. Vertical bar pull handle on the opening edge, clear of the display panel
    const handleX = -doorW + 0.09;
    const handleY = doorCenterY + 0.02;
    const handleLen = 0.34;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, handleLen, 0.025), accentMat);
    handle.position.set(handleX, handleY, faceZ + 0.04);
    handle.castShadow = true;
    doorPivot.add(handle);
    [handleLen / 2 - 0.03, -handleLen / 2 + 0.03].forEach((dy) => {
      const standoff = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.03), accentMat);
      standoff.position.set(handleX, handleY + dy, faceZ + 0.015);
      doorPivot.add(standoff);
    });

    // 3. Ventilation slots near the bottom of the door
    const ventMat = new THREE.MeshStandardMaterial({ color: 0x080a10, roughness: 0.8, metalness: 0.2 });
    const ventCount = 4;
    const ventGap = 0.045;
    const ventStart = doorBottom + 0.1 + (ventCount - 1) * ventGap;
    for (let v = 0; v < ventCount; v++) {
      const vent = new THREE.Mesh(new THREE.BoxGeometry(doorW * 0.46, 0.014, 0.004), ventMat);
      vent.position.set(doorCenterX, ventStart - v * ventGap, faceZ + 0.002);
      doorPivot.add(vent);
    }

    return { labelCanvas, labelTex, plateMesh };
  }

  /* ───────────────────────────────────────────────────────────────
     NAMEPLATE RENDERING (REGISTERED vs UNASSIGNED SLOTS)
     Canvas is 1024x512 drawn at 2x scale on a 512x256 layout.
  ─────────────────────────────────────────────────────────────────*/

  _beginPlate(slotRecord) {
    const ctx = slotRecord.labelCanvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, slotRecord.labelCanvas.width, slotRecord.labelCanvas.height);
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    return ctx;
  }

  renderUnassignedNameplate(slotRecord, slotNum) {
    const isHovered = this.hoveredObject && this.hoveredObject.slotIndex === slotRecord.slotIndex;
    const badgeKey = `unassigned|${slotNum}|${isHovered}`;
    if (slotRecord.lastBadgeKey === badgeKey) return;
    slotRecord.lastBadgeKey = badgeKey;

    const ctx = this._beginPlate(slotRecord);

    // Muted screen
    ctx.fillStyle = isHovered ? "#141926" : "#0E1118";
    ctx.strokeStyle = isHovered ? "#2C344A" : "#1A202C";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(6, 6, 500, 244, 22);
    ctx.fill();
    ctx.stroke();

    const numStr = slotNum < 10 ? `0${slotNum}` : `${slotNum}`;
    ctx.fillStyle = isHovered ? "#94A3B8" : "#475569";
    ctx.font = "bold 60px 'JetBrains Mono', monospace";
    ctx.fillText(`SLOT ${numStr}`, 40, 104);

    ctx.fillStyle = "#334155";
    ctx.font = "600 26px 'JetBrains Mono', monospace";
    ctx.fillText("UNASSIGNED", 40, 196);

    slotRecord.labelTex.needsUpdate = true;
  }

  renderRegisteredNameplate(slotRecord, locker, online, open, redPulse) {
    const timerText = open && online ? formatClock(elapsedSecSince(locker.updated_at)) : (open ? "PAUSED" : "");
    const isHovered = this.hoveredObject && this.hoveredObject.lockerId === locker.id;
    const badgeKey = `${locker.id}|${online}|${open}|${redPulse}|${timerText}|${isHovered}`;
    if (slotRecord.lastBadgeKey === badgeKey) return;
    slotRecord.lastBadgeKey = badgeKey;

    const ctx = this._beginPlate(slotRecord);
    const stateColor = open ? "#EF4444" : "#10B981";

    // Screen: border reflects door state (red OPEN, green CLOSED)
    ctx.fillStyle = isHovered ? "#161D2F" : "#0E121D";
    ctx.strokeStyle = stateColor;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.roundRect(6, 6, 500, 244, 22);
    ctx.fill();
    ctx.stroke();

    // Row 1: Locker name
    ctx.fillStyle = "#F8FAFC";
    ctx.font = "bold 56px 'JetBrains Mono', monospace";
    ctx.fillText(locker.id, 38, 88);

    // Row 2: Connection status with dot
    const connColor = online ? "#10B981" : "#EF4444";
    ctx.fillStyle = connColor;
    ctx.beginPath();
    ctx.arc(46, 131, 7, 0, Math.PI * 2);
    if (online) {
      ctx.fill();
    } else {
      ctx.lineWidth = 3;
      ctx.strokeStyle = connColor;
      ctx.stroke();
    }
    ctx.font = "600 24px 'JetBrains Mono', monospace";
    ctx.fillText(online ? "ONLINE" : "OFFLINE", 64, 140);

    // Row 3: Door state (left) and open timer (right)
    ctx.fillStyle = stateColor;
    ctx.font = "bold 44px 'JetBrains Mono', monospace";
    ctx.fillText(open ? "OPEN" : "CLOSED", 38, 212);

    if (timerText) {
      ctx.textAlign = "right";
      ctx.font = "600 32px 'JetBrains Mono', monospace";
      ctx.fillText(timerText, 474, 210);
      ctx.textAlign = "left";
    }

    slotRecord.labelTex.needsUpdate = true;
  }

  /* ───────────────────────────────────────────────────────────────
     SINGLE-UNIT DIGITAL TWIN (FOR #/lockers/:id VIEW)
  ─────────────────────────────────────────────────────────────────*/

  createSingleUnit(lockerId) {
    const rootGroup = new THREE.Group();
    rootGroup.userData.lockerId = lockerId;

    // Exact proportions and dimensions matching the dashboard Smart Locker module
    const slotW = 1.34;
    const slotH = 1.58;
    const slotD = 1.15;
    const wall = 0.04;
    const plinthH = 0.12;
    const topCapH = 0.06;

    // Materials identical to dashboard 3D Smart Locker
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x121622,
      roughness: 0.55,
      metalness: 0.6,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x1e2433,
      roughness: 0.45,
      metalness: 0.65,
    });
    const plinthMat = new THREE.MeshStandardMaterial({
      color: 0x0c0f17,
      roughness: 0.7,
      metalness: 0.4,
    });
    const interiorMat = new THREE.MeshStandardMaterial({
      color: 0x0a0d14,
      roughness: 0.75,
      metalness: 0.3,
    });
    const doorActiveMat = new THREE.MeshStandardMaterial({
      color: 0x222a3d,
      roughness: 0.38,
      metalness: 0.62,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: 0x333f5c,
      roughness: 0.35,
      metalness: 0.75,
    });

    const unitCenterY = plinthH + slotH / 2;

    // 1. Bottom Plinth / Kickplate
    const plinthMesh = new THREE.Mesh(new THREE.BoxGeometry(slotW + 0.06, plinthH, slotD + 0.04), plinthMat);
    plinthMesh.position.set(0, plinthH / 2, 0);
    plinthMesh.receiveShadow = true;
    rootGroup.add(plinthMesh);

    // 2. Full Back Enclosure Panel
    const backMesh = new THREE.Mesh(new THREE.BoxGeometry(slotW + 0.06, slotH, 0.04), frameMat);
    backMesh.position.set(0, unitCenterY, -slotD / 2 + 0.02);
    backMesh.castShadow = true;
    rootGroup.add(backMesh);

    // 3. Left Outer Wall
    const leftMesh = new THREE.Mesh(new THREE.BoxGeometry(0.04, slotH, slotD), frameMat);
    leftMesh.position.set(-slotW / 2 - 0.01, unitCenterY, 0);
    leftMesh.castShadow = true;
    rootGroup.add(leftMesh);

    // 4. Right Outer Wall
    const rightMesh = new THREE.Mesh(new THREE.BoxGeometry(0.04, slotH, slotD), frameMat);
    rightMesh.position.set(slotW / 2 + 0.01, unitCenterY, 0);
    rightMesh.castShadow = true;
    rootGroup.add(rightMesh);

    // 5. Top Architectural Canopy
    const topMesh = new THREE.Mesh(new THREE.BoxGeometry(slotW + 0.08, topCapH, slotD + 0.06), trimMat);
    topMesh.position.set(0, plinthH + slotH + topCapH / 2, 0);
    topMesh.castShadow = true;
    rootGroup.add(topMesh);

    // Inner Locker Bay Group (centered at unitCenterY)
    const bayGroup = new THREE.Group();
    bayGroup.position.set(0, unitCenterY, 0);
    rootGroup.add(bayGroup);

    // Interior Shelf
    const shelfMesh = new THREE.Mesh(new THREE.BoxGeometry(slotW - wall * 2, 0.035, slotD - 0.1), interiorMat);
    shelfMesh.position.set(0, -slotH * 0.18, -0.02);
    shelfMesh.visible = false;
    bayGroup.add(shelfMesh);

    // Interior Parcel Box
    const parcelMat = new THREE.MeshStandardMaterial({ color: 0x2b354f, roughness: 0.5, metalness: 0.2 });
    const parcelMesh = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.32, 0.42), parcelMat);
    parcelMesh.position.set(-0.1, -slotH * 0.18 + 0.16 + 0.02, -0.08);
    parcelMesh.visible = false;
    bayGroup.add(parcelMesh);

    // Interior Illuminator (PointLight)
    const interiorLight = new THREE.PointLight(0xef4444, 0, 2.4);
    interiorLight.position.set(0, slotH * 0.28, 0.05);
    bayGroup.add(interiorLight);

    // Hardware Telemetry Bezel (Top Header of Bay)
    const bezelMesh = new THREE.Mesh(new THREE.BoxGeometry(slotW - 0.08, 0.12, 0.035), interiorMat);
    bezelMesh.position.set(0, slotH / 2 - 0.065, slotD / 2 + 0.015);
    bayGroup.add(bezelMesh);

    // Left Indicator: Red LED (Locker OPEN)
    const redLedMat = new THREE.MeshBasicMaterial({ color: 0x2a0d10 });
    const redLedMesh = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 16), redLedMat);
    redLedMesh.position.set(slotW / 2 - 0.24, slotH / 2 - 0.065, slotD / 2 + 0.038);
    bayGroup.add(redLedMesh);

    // Right Indicator: Green LED (Locker CLOSED)
    const greenLedMat = new THREE.MeshBasicMaterial({ color: 0x082417 });
    const greenLedMesh = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 16), greenLedMat);
    greenLedMesh.position.set(slotW / 2 - 0.14, slotH / 2 - 0.065, slotD / 2 + 0.038);
    bayGroup.add(greenLedMesh);

    // Sensor Details (MC-38 reed switch + microswitch)
    const sensorMat = new THREE.MeshStandardMaterial({
      color: 0x06b6d4,
      emissive: 0x06b6d4,
      emissiveIntensity: 0.35,
      roughness: 0.3,
    });
    const reedSwitch = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.03, 0.04), sensorMat);
    reedSwitch.position.set(-slotW / 2 + 0.24, slotH / 2 - 0.14, slotD / 2 - 0.03);
    reedSwitch.visible = true;
    bayGroup.add(reedSwitch);

    const microSwitch = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.10, 0.05), sensorMat);
    microSwitch.position.set(-slotW / 2 + 0.08, 0, slotD / 2 - 0.03);
    microSwitch.visible = true;
    bayGroup.add(microSwitch);

    // Hinged Door Assembly
    const doorPivot = new THREE.Group();
    doorPivot.position.set(slotW / 2 - wall, 0, slotD / 2 - 0.015);
    bayGroup.add(doorPivot);

    const doorW = slotW - wall * 2 - 0.02; // ~1.24
    const doorH = slotH - 0.18; // ~1.40
    const doorThickness = 0.04;

    const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(doorW, doorH, doorThickness), doorActiveMat);
    doorMesh.position.set(-doorW / 2, -0.03, 0);
    doorMesh.castShadow = true;
    doorMesh.receiveShadow = true;
    doorPivot.add(doorMesh);

    // Door face: display panel, pull handle, vents (same layout as dashboard slots)
    const { labelCanvas, labelTex } = this.buildDoorFace(doorPivot, doorW, doorH, doorThickness, accentMat);

    this.scene.add(rootGroup);

    const unitRecord = {
      lockerId,
      rootGroup,
      doorPivot,
      doorMesh,
      greenLedMat,
      redLedMat,
      interiorLight,
      shelfMesh,
      parcelMesh,
      labelCanvas,
      labelTex,
      currentAngle: 0,
      targetAngle: 0,
      lastBadgeKey: "",
    };

    this.lockerMeshes.set(lockerId, unitRecord);
    return unitRecord;
  }

  /* ───────────────────────────────────────────────────────────────
     SYNCHRONIZATION WITH REAL-TIME DATABASE
  ─────────────────────────────────────────────────────────────────*/

  syncLockers(lockers) {
    if (!this.scene) return;
    this.activeLockers = lockers;

    if (this.isSingleUnit) {
      // In single-unit view, display only the target locker
      const locker = lockers[0];
      if (!locker) return;

      let unit = this.lockerMeshes.get(locker.id);
      if (!unit) {
        unit = this.createSingleUnit(locker.id);
      }

      const open = isOpen(locker);
      const online = isOnline(locker);
      const redPulse = this.isRedPulseActive(locker.id);

      unit.targetAngle = open ? 1.62 : 0;
      // Red LED = OPEN (Pure vibrant red when open, dimmed when closed)
      unit.redLedMat.color.setHex(open ? 0xef4444 : 0x2a0d10);
      // Green LED = CLOSED (Pure vibrant emerald when closed, dimmed when open)
      unit.greenLedMat.color.setHex(!open ? 0x10b981 : 0x082417);
      // Interior light
      unit.interiorLight.intensity = open ? 1.35 : 0;
      unit.interiorLight.color.setHex(0xef4444);
      // Interior shelf & parcel box visible when open
      if (unit.shelfMesh) unit.shelfMesh.visible = open;
      if (unit.parcelMesh) unit.parcelMesh.visible = open;

      this.renderRegisteredNameplate(unit, locker, online, open, redPulse);
      return;
    }

    // Overview 10-Slot Cabinet Synchronization:
    // Map registered lockers to their slots (Locker-01 -> Slot 0, etc.)
    const assignedSlots = new Map(); // slotIndex -> locker
    const unmappedLockers = [];

    lockers.forEach((l) => {
      // Parse slot number from ID like "Locker-01" -> 1 -> slotIndex 0
      const match = l.id.match(/\d+/);
      const slotNum = match ? parseInt(match[0], 10) : null;
      if (slotNum && slotNum >= 1 && slotNum <= 10 && !assignedSlots.has(slotNum - 1)) {
        assignedSlots.set(slotNum - 1, l);
      } else {
        unmappedLockers.push(l);
      }
    });

    // Assign any unmapped lockers to the first free slot
    unmappedLockers.forEach((l) => {
      for (let s = 0; s < 10; s++) {
        if (!assignedSlots.has(s)) {
          assignedSlots.set(s, l);
          break;
        }
      }
    });

    // Update each of the 10 physical cabinet slots
    for (let s = 0; s < 10; s++) {
      const slotUnit = this.slotUnits.get(s);
      if (!slotUnit) continue;

      const assignedLocker = assignedSlots.get(s) || null;
      slotUnit.assignedLocker = assignedLocker;

      // Update userData for raycasting
      const userData = {
        isSlot: true,
        slotIndex: s,
        slotNum: s + 1,
        isRegistered: !!assignedLocker,
        lockerId: assignedLocker ? assignedLocker.id : null,
        assignedLocker,
      };

      slotUnit.rootGroup.userData = userData;
      slotUnit.rootGroup.traverse((c) => {
        c.userData = userData;
      });

      if (assignedLocker) {
        // Register this unit in lockerMeshes for quick camera focus
        this.lockerMeshes.set(assignedLocker.id, slotUnit);

        const open = isOpen(assignedLocker);
        const online = isOnline(assignedLocker);
        const redPulse = this.isRedPulseActive(assignedLocker.id);

        slotUnit.doorMesh.material = slotUnit.doorActiveMat;
        slotUnit.targetAngle = open ? 1.62 : 0;

        // Visual components visible when assigned
        slotUnit.shelfMesh.visible = open;
        slotUnit.parcelMesh.visible = open;
        slotUnit.reedSwitch.visible = true;
        slotUnit.microSwitch.visible = true;

        // LEDs: Red indicates OPEN, Green indicates CLOSED
        slotUnit.redLedMat.color.setHex(open ? 0xef4444 : 0x2a0d10);
        slotUnit.greenLedMat.color.setHex(!open ? 0x10b981 : 0x082417);

        // Interior light
        slotUnit.interiorLight.intensity = open ? 1.35 : 0;
        slotUnit.interiorLight.color.setHex(0xef4444);

        this.renderRegisteredNameplate(slotUnit, assignedLocker, online, open, redPulse);
      } else {
        // Unassigned / Empty physical slot
        slotUnit.doorMesh.material = slotUnit.doorUnassignedMat;
        slotUnit.targetAngle = 0; // Stays securely closed

        slotUnit.shelfMesh.visible = false;
        slotUnit.parcelMesh.visible = false;
        slotUnit.reedSwitch.visible = false;
        slotUnit.microSwitch.visible = false;

        // LEDs remain dark / unpowered
        slotUnit.greenLedMat.color.setHex(0x131722);
        slotUnit.redLedMat.color.setHex(0x131722);

        slotUnit.interiorLight.intensity = 0;

        this.renderUnassignedNameplate(slotUnit, s + 1);
      }
    }
  }

  triggerRedPulse(lockerId, durationMs = 3000) {
    this.redLedPulseMap.set(lockerId, Date.now() + durationMs);
  }

  isRedPulseActive(lockerId) {
    const expiry = this.redLedPulseMap.get(lockerId);
    if (!expiry) return false;
    if (Date.now() < expiry) return true;
    this.redLedPulseMap.delete(lockerId);
    return false;
  }

  /* ───────────────────────────────────────────────────────────────
     CAMERA CONTROLS & PRESETS
  ─────────────────────────────────────────────────────────────────*/

  setCameraPreset(preset) {
    if (this.isSingleUnit) {
      this.targetSpherical = { radius: 3.75, theta: 0.0, phi: 1.48 };
      this.targetLookAt.set(0, 0.88, 0);
      return;
    }

    // 10-Slot 2×5 Cabinet Presets
    if (preset === "front") {
      this.targetSpherical = { radius: 8.6, theta: 0.0, phi: 1.34 };
      this.targetLookAt.set(0, 1.78, 0);
    } else if (preset === "top") {
      this.targetSpherical = { radius: 11.5, theta: 0.04, phi: 0.48 };
      this.targetLookAt.set(0, 1.2, 0);
    } else {
      // Isometric
      this.targetSpherical = { radius: 11.2, theta: 0.38, phi: 1.22 };
      this.targetLookAt.set(0, 1.78, 0);
    }
  }

  focusLocker(lockerId) {
    if (this.isSingleUnit) return;
    const unit = this.lockerMeshes.get(lockerId);
    if (!unit) return;
    const pos = unit.rootGroup.position;
    this.targetLookAt.set(pos.x, pos.y + 0.1, pos.z);
    this.targetSpherical = { radius: 4.8, theta: 0.28, phi: 1.22 };
  }

  focusSlot(slotIndex) {
    if (this.isSingleUnit) return;
    const unit = this.slotUnits.get(slotIndex);
    if (!unit) return;
    const pos = unit.rootGroup.position;
    this.targetLookAt.set(pos.x, pos.y + 0.1, pos.z);
    this.targetSpherical = { radius: 4.8, theta: 0.28, phi: 1.22 };
  }

  updateCameraPosition(immediate = false) {
    if (!this.camera) return;
    const lerpFactor = immediate ? 1 : 0.1;
    this.spherical.radius += (this.targetSpherical.radius - this.spherical.radius) * lerpFactor;
    this.spherical.theta  += (this.targetSpherical.theta  - this.spherical.theta)  * lerpFactor;
    this.spherical.phi    += (this.targetSpherical.phi    - this.spherical.phi)    * lerpFactor;
    this.cameraTarget.lerp(this.targetLookAt, lerpFactor);

    const r = this.spherical.radius;
    const sinPhi = Math.sin(this.spherical.phi);
    const x = this.cameraTarget.x + r * sinPhi * Math.sin(this.spherical.theta);
    const y = this.cameraTarget.y + r * Math.cos(this.spherical.phi);
    const z = this.cameraTarget.z + r * sinPhi * Math.cos(this.spherical.theta);

    this.camera.position.set(x, Math.max(0.3, y), z);
    this.camera.lookAt(this.cameraTarget);
  }

  /* ───────────────────────────────────────────────────────────────
     INTERACTION EVENTS (RAYCASTING, HOVER, CLICKS)
  ─────────────────────────────────────────────────────────────────*/

  bindEvents() {
    const dom = this.renderer.domElement;

    // Single unit on personal page is strictly view-only (no dragging, orbiting, rotating, or zooming)
    if (this.isSingleUnit) {
      dom.style.cursor = "default";
      return;
    }

    dom.addEventListener("pointerdown", (e) => {
      this.isDragging = true;
      this.dragDistance = 0;
      this.prevMouse = { x: e.clientX, y: e.clientY };
      dom.style.cursor = "grabbing";
    });

    window.addEventListener("pointermove", (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.prevMouse.x;
      const dy = e.clientY - this.prevMouse.y;
      this.dragDistance += Math.abs(dx) + Math.abs(dy);

      this.targetSpherical.theta -= dx * 0.006;
      this.targetSpherical.phi = Math.max(0.15, Math.min(Math.PI / 2 - 0.04, this.targetSpherical.phi - dy * 0.005));

      this.prevMouse = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener("pointerup", () => {
      if (this.isDragging) {
        this.isDragging = false;
        dom.style.cursor = "grab";
      }
    });

    dom.addEventListener("wheel", (e) => {
      e.preventDefault();
      const minR = this.isSingleUnit ? 2.5 : 4.0;
      const maxR = this.isSingleUnit ? 9.0 : 20.0;
      this.targetSpherical.radius = Math.max(minR, Math.min(maxR, this.targetSpherical.radius + e.deltaY * 0.008));
    }, { passive: false });

    // Hover Tooltip & Cursor Tracking
    dom.addEventListener("mousemove", (e) => {
      if (this.isDragging) return;
      const rect = dom.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      this.raycaster.setFromCamera(this.mouse, this.camera);

      // Collect all interactive slot/locker objects
      const roots = this.isSingleUnit
        ? Array.from(this.lockerMeshes.values()).map((u) => u.rootGroup)
        : Array.from(this.slotUnits.values()).map((s) => s.rootGroup);

      const hits = this.raycaster.intersectObjects(roots, true);
      const tooltip = document.getElementById("three-tooltip");

      if (hits.length > 0) {
        const hitData = hits[0].object.userData;
        this.hoveredObject = hitData;
        dom.style.cursor = "pointer";

        if (tooltip) {
          tooltip.hidden = false;
          const pad = 16;
          let left = e.clientX - rect.left + pad;
          let top = e.clientY - rect.top + pad;

          if (left + 230 > rect.width) left = e.clientX - rect.left - 235;
          if (top + 160 > rect.height) top = e.clientY - rect.top - 165;

          tooltip.style.left = `${Math.max(10, left)}px`;
          tooltip.style.top = `${Math.max(10, top)}px`;

          const ttId = document.getElementById("tt-id");
          const ttConn = document.getElementById("tt-conn");
          const ttState = document.getElementById("tt-state");
          const ttReed = document.getElementById("tt-reed");
          const ttMicro = document.getElementById("tt-micro");
          const ttTimer = document.getElementById("tt-timer");
          const ttFooter = tooltip.querySelector(".three-tooltip-footer");

          if (hitData.isRegistered && hitData.assignedLocker) {
            // Registered active locker (e.g. Locker-01)
            const locker = hitData.assignedLocker;
            const open = isOpen(locker);
            const online = isOnline(locker);

            if (ttId) ttId.textContent = locker.id;
            if (ttConn) {
              ttConn.textContent = online ? "ONLINE" : "OFFLINE";
              ttConn.className = `status-dot-label ${online ? "status-dot-label--online" : "status-dot-label--offline"}`;
            }
            if (ttState) {
              ttState.textContent = open ? "OPEN" : "CLOSED";
              ttState.style.color = open ? "var(--led-red)" : "var(--led-green)";
            }
            const isReedContact = locker.reed_contact !== undefined ? Boolean(locker.reed_contact) : !open;
            const isMicroEngaged = locker.micro_engaged !== undefined ? Boolean(locker.micro_engaged) : !open;

            if (ttReed) {
              ttReed.textContent = isReedContact ? "Contact" : "Open";
              ttReed.style.color = isReedContact ? "var(--led-green)" : "var(--led-red)";
            }
            if (ttMicro) {
              ttMicro.textContent = isMicroEngaged ? "Engaged" : "Released";
              ttMicro.style.color = isMicroEngaged ? "var(--led-green)" : "var(--led-red)";
            }
            if (ttTimer) {
              ttTimer.textContent = open && online
                ? formatClock(elapsedSecSince(locker.updated_at))
                : formatTimestamp(locker.updated_at).slice(0, 16);
            }
            if (ttFooter) {
              ttFooter.innerHTML = `<span>Double-click details →</span>`;
            }
          } else {
            // Unassigned empty cabinet slot
            const slotNum = hitData.slotNum || (hitData.slotIndex + 1);
            const numStr = slotNum < 10 ? `0${slotNum}` : `${slotNum}`;

            if (ttId) ttId.textContent = `Slot ${numStr}`;
            if (ttConn) {
              ttConn.textContent = "UNASSIGNED";
              ttConn.className = "status-dot-label status-dot-label--unassigned";
            }
            if (ttState) {
              ttState.textContent = "Available Slot";
              ttState.style.color = "var(--color-text-muted)";
            }
            if (ttReed) ttReed.textContent = "None";
            if (ttMicro) ttMicro.textContent = "None";
            if (ttTimer) ttTimer.textContent = "--:--";
            if (ttFooter) {
              ttFooter.innerHTML = `<span style="color: var(--color-text-muted);">Slot ready for ESP32 node</span>`;
            }
          }
        }
      } else {
        this.hoveredObject = null;
        dom.style.cursor = "grab";
        if (tooltip) tooltip.hidden = true;
      }
    });

    dom.addEventListener("mouseleave", () => {
      this.hoveredObject = null;
      const tooltip = document.getElementById("three-tooltip");
      if (tooltip) tooltip.hidden = true;
    });

    // Single Click: Focus on locker/slot & trigger callback
    dom.addEventListener("click", () => {
      if (this.dragDistance > 6) return;
      if (!this.hoveredObject) return;

      if (this.hoveredObject.isRegistered && this.hoveredObject.lockerId) {
        this.focusLocker(this.hoveredObject.lockerId);
        if (this.onLockerClick) {
          this.onLockerClick(this.hoveredObject.lockerId);
        }
      } else if (this.hoveredObject.isSlot) {
        this.focusSlot(this.hoveredObject.slotIndex);
      }
    });

    // Double Click: Navigate to locker details only if registered
    dom.addEventListener("dblclick", () => {
      if (this.isSingleUnit) return;
      if (this.hoveredObject && this.hoveredObject.isRegistered && this.hoveredObject.lockerId) {
        location.hash = `#/lockers/${encodeURIComponent(this.hoveredObject.lockerId)}`;
      }
    });

    window.addEventListener("resize", () => this.handleResize());
  }

  handleResize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w > 0 && h > 0) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    }
    if (this.isSingleUnit) {
      this.targetSpherical = { radius: 3.75, theta: 0.0, phi: 1.48 };
      this.targetLookAt.set(0, 0.88, 0);
      this.updateCameraPosition(true);
    }
  }

  /* ───────────────────────────────────────────────────────────────
     ANIMATION LOOP
  ─────────────────────────────────────────────────────────────────*/

  animate() {
    if (!this.renderer || !this.scene || !this.camera) return;

    if (!this.isSingleUnit && this.autoRotate && !this.isDragging) {
      this.targetSpherical.theta += 0.003;
    }

    this.updateCameraPosition(false);

    // Smooth door rotation for single unit or 10 slots
    if (this.isSingleUnit) {
      for (const unit of this.lockerMeshes.values()) {
        const diff = unit.targetAngle - unit.currentAngle;
        if (Math.abs(diff) > 0.001) {
          unit.currentAngle += diff * 0.12;
          unit.doorPivot.rotation.y = unit.currentAngle;
        } else {
          unit.currentAngle = unit.targetAngle;
          unit.doorPivot.rotation.y = unit.currentAngle;
        }
      }
    } else {
      for (const slot of this.slotUnits.values()) {
        const diff = slot.targetAngle - slot.currentAngle;
        if (Math.abs(diff) > 0.001) {
          slot.currentAngle += diff * 0.12;
          slot.doorPivot.rotation.y = slot.currentAngle;
        } else {
          slot.currentAngle = slot.targetAngle;
          slot.doorPivot.rotation.y = slot.currentAngle;
        }
      }
    }

    this.renderer.render(this.scene, this.camera);
  }
}
