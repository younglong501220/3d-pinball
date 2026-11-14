import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import * as CANNON from 'cannon-es';
import { ArcadeAudio } from './audio';

export interface PinballCallbacks {
  onScoreChange: (score: number, animate: boolean) => void;
  onHighScoreChange: (highScore: number) => void;
  onBallsChange: (ballsLeft: number) => void;
  onChargeChange: (chargeRatio: number) => void;
  onBannerChange: (text: string | null) => void;
  onGameOverChange: (isGameOver: boolean, finalScore: number, isNewRecord: boolean) => void;
  onContextLostChange?: (lost: boolean) => void;
}

export interface PinballController {
  setLeftFlipper: (pressed: boolean) => void;
  setRightFlipper: (pressed: boolean) => void;
  setPlungerDown: (down: boolean) => void;
  setMuted: (muted: boolean) => void;
  restart: () => void;
  dispose: () => void;
}

interface FlipperEntity {
  body: CANNON.Body;
  group: THREE.Group;
  restAngle: number;
  activeAngle: number;
  currentAngle: number;
}

interface SparkParticle {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  active: boolean;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
}

interface BumperEntity {
  body: CANNON.Body;
  group: THREE.Group;
  coreMat: THREE.MeshStandardMaterial;
  shockRing: THREE.Mesh;
  shockRingMat: THREE.MeshBasicMaterial;
  flashLight: THREE.PointLight;
  neonColor: number;
  flashAmount: number;
  lastHitTime: number;
}

interface NeonTubeRig {
  coreMat: THREE.MeshStandardMaterial;
  haloMat: THREE.MeshBasicMaterial;
  glowLight: THREE.PointLight;
}

const BALL_RADIUS = 0.42;
const INITIAL_BALLS = 3;
const BUMPER_SCORE = 100;
const BUMPER_RADIUS = 0.85;
const PLUNGER_SPAWN = { x: 5.35, y: BALL_RADIUS, z: 9.0 };
const PLUNGER_REST_Z = 9.75;
const ARCH_CENTER_Z = -6.0;
const ARCH_INNER_R = 5.9;
const ARCH_THICK = 0.5;
const ARCH_SEGMENTS = 22;
const SPARK_POOL_SIZE = 120;
const HIGH_SCORE_STORAGE_KEY = 'neon_pinball_hi';

const Y_AXIS = new CANNON.Vec3(0, 1, 0);
const _lookTarget = new THREE.Vector3();

function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

function createPlayfieldTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 2048;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    // Deep arcade midnight enamel base
    const bgGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    bgGrad.addColorStop(0, '#12183b');
    bgGrad.addColorStop(0.45, '#0b102b');
    bgGrad.addColorStop(1, '#080b1f');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Subtle geometric arcade grid
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.08)';
    ctx.lineWidth = 2;
    const gridStep = 64;
    for (let x = 0; x <= canvas.width; x += gridStep) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y <= canvas.height; y += gridStep) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Center starburst lines
    const cx = canvas.width * 0.45;
    const cy = canvas.height * 0.56;
    ctx.save();
    ctx.translate(cx, cy);
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      ctx.strokeStyle = i % 2 === 0 ? 'rgba(255, 46, 196, 0.14)' : 'rgba(0, 229, 255, 0.12)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * 90, Math.sin(angle) * 90);
      ctx.lineTo(Math.cos(angle) * 280, Math.sin(angle) * 280);
      ctx.stroke();
    }
    ctx.restore();

    // Shooter lane stripes on right edge
    const laneX = canvas.width * 0.915;
    ctx.fillStyle = 'rgba(255, 159, 28, 0.12)';
    ctx.fillRect(laneX - 28, canvas.height * 0.25, 56, canvas.height * 0.72);
    ctx.strokeStyle = 'rgba(255, 190, 11, 0.35)';
    ctx.lineWidth = 3;
    ctx.setLineDash([18, 14]);
    ctx.beginPath();
    ctx.moveTo(laneX, canvas.height * 0.28);
    ctx.lineTo(laneX, canvas.height * 0.95);
    ctx.stroke();
    ctx.setLineDash([]);

    // Drain zone chevrons near flippers
    ctx.strokeStyle = 'rgba(255, 0, 110, 0.28)';
    ctx.lineWidth = 6;
    for (let i = 0; i < 3; i++) {
      const yBase = canvas.height * 0.87 + i * 38;
      ctx.beginPath();
      ctx.moveTo(cx - 80, yBase - 24);
      ctx.lineTo(cx, yBase);
      ctx.lineTo(cx + 80, yBase - 24);
      ctx.stroke();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.max(1, maxAnisotropy);
  return texture;
}

export function createPinballEngine(
  mountEl: HTMLElement,
  callbacks: PinballCallbacks
): PinballController {
  const isSoftwareGl = detectSoftwareWebGL();
  const audio = new ArcadeAudio();

  let score = 0;
  let highScore = 0;
  try {
    highScore = parseInt(localStorage.getItem(HIGH_SCORE_STORAGE_KEY) || '0', 10) || 0;
  } catch {
    highScore = 0;
  }
  callbacks.onHighScoreChange(highScore);
  callbacks.onScoreChange(0, false);
  callbacks.onBallsChange(INITIAL_BALLS);
  callbacks.onChargeChange(0);
  callbacks.onBannerChange('HOLD [S / ▼] TO LAUNCH');

  let ballsLeft = INITIAL_BALLS;
  let isGameOver = false;
  let ballInShooter = true;
  let gateActive = false;
  let plungerCharge = 0;
  let isCharging = false;
  let cameraShake = 0;
  let stuckTimer = 0;
  const pendingBumperImpulses: CANNON.Vec3[] = [];

  const keys = {
    left: false,
    right: false,
    down: false
  };

  // =========================================================================
  // 1. Three.js Scene, Camera, Renderer & Studio RoomEnvironment
  // =========================================================================
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060816);
  scene.fog = new THREE.FogExp2(0x060816, 0.015);

  const width = mountEl.clientWidth || window.innerWidth;
  const height = mountEl.clientHeight || window.innerHeight;
  const camera = new THREE.PerspectiveCamera(43, width / height, 0.1, 120);
  const baseCameraPos = new THREE.Vector3(0, 23.0, 19.8);
  camera.position.copy(baseCameraPos);
  camera.lookAt(0, -0.4, 0.3);

  const renderer = new THREE.WebGLRenderer({
    antialias: !isSoftwareGl,
    powerPreference: 'high-performance'
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = !isSoftwareGl;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  mountEl.appendChild(renderer.domElement);

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const envTexture = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTexture;
  pmremGenerator.dispose();

  // Balanced 3-point + neon arcade lighting
  const hemiLight = new THREE.HemisphereLight(0x7898ff, 0x16122e, 0.75);
  scene.add(hemiLight);

  const keyLight = new THREE.DirectionalLight(0xfff6ea, 1.35);
  keyLight.position.set(7, 26, 11);
  keyLight.castShadow = !isSoftwareGl;
  keyLight.shadow.mapSize.width = 2048;
  keyLight.shadow.mapSize.height = 2048;
  keyLight.shadow.camera.near = 5;
  keyLight.shadow.camera.far = 55;
  keyLight.shadow.camera.left = -10;
  keyLight.shadow.camera.right = 10;
  keyLight.shadow.camera.top = 16;
  keyLight.shadow.camera.bottom = -16;
  keyLight.shadow.bias = -0.0005;
  keyLight.shadow.normalBias = 0.02;
  scene.add(keyLight);

  const topNeonLight = new THREE.PointLight(0xff38b8, 1.35, 28);
  topNeonLight.position.set(-1.5, 5.5, -7.5);
  scene.add(topNeonLight);

  const bottomNeonLight = new THREE.PointLight(0x00e5ff, 1.1, 24);
  bottomNeonLight.position.set(-0.6, 4.5, 8.5);
  scene.add(bottomNeonLight);

  // =========================================================================
  // 2. Cannon-es 120Hz Physics World
  // =========================================================================
  const world = new CANNON.World();
  world.gravity.set(0, -28.0, 11.8);
  world.broadphase = new CANNON.NaiveBroadphase();
  (world.solver as CANNON.GSSolver).iterations = 15;

  const ballPhysMat = new CANNON.Material('ball');
  const floorPhysMat = new CANNON.Material('floor');
  const wallPhysMat = new CANNON.Material('wall');
  const bumperPhysMat = new CANNON.Material('bumper');
  const flipperPhysMat = new CANNON.Material('flipper');

  world.addContactMaterial(
    new CANNON.ContactMaterial(ballPhysMat, floorPhysMat, {
      friction: 0.008,
      restitution: 0.08
    })
  );
  world.addContactMaterial(
    new CANNON.ContactMaterial(ballPhysMat, wallPhysMat, {
      friction: 0.02,
      restitution: 0.72
    })
  );
  world.addContactMaterial(
    new CANNON.ContactMaterial(ballPhysMat, bumperPhysMat, {
      friction: 0.0,
      restitution: 1.25
    })
  );
  world.addContactMaterial(
    new CANNON.ContactMaterial(ballPhysMat, flipperPhysMat, {
      friction: 0.04,
      restitution: 0.62
    })
  );

  // =========================================================================
  // 3. Playfield Cabinet, Walls, Neon Tubes & Guide Ramps
  // =========================================================================
  const floorBody = new CANNON.Body({ mass: 0, material: floorPhysMat });
  floorBody.addShape(new CANNON.Plane());
  floorBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
  world.addBody(floorBody);

  const glassCeilingBody = new CANNON.Body({ mass: 0, material: floorPhysMat });
  glassCeilingBody.addShape(new CANNON.Plane());
  glassCeilingBody.position.set(0, 1.15, 0);
  glassCeilingBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI / 2);
  world.addBody(glassCeilingBody);

  const playfieldTexture = createPlayfieldTexture(renderer.capabilities.getMaxAnisotropy());
  const playfieldMesh = new THREE.Mesh(
    new THREE.BoxGeometry(12.6, 0.5, 24.4),
    new THREE.MeshStandardMaterial({
      map: playfieldTexture,
      roughness: 0.36,
      metalness: 0.28
    })
  );
  playfieldMesh.position.set(0, -0.25, -0.3);
  playfieldMesh.receiveShadow = true;
  scene.add(playfieldMesh);

  const cabinetMesh = new THREE.Mesh(
    new THREE.BoxGeometry(13.8, 1.4, 25.6),
    new THREE.MeshStandardMaterial({
      color: 0x16192c,
      roughness: 0.55,
      metalness: 0.45
    })
  );
  cabinetMesh.position.set(0, -0.95, -0.3);
  cabinetMesh.receiveShadow = true;
  scene.add(cabinetMesh);

  const decoRingMat = new THREE.MeshBasicMaterial({
    color: 0x00e5ff,
    transparent: true,
    opacity: 0.25,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
  });
  const decoRing = new THREE.Mesh(new THREE.RingGeometry(2.15, 2.28, 48), decoRingMat);
  decoRing.rotation.x = -Math.PI / 2;
  decoRing.position.set(-0.625, 0.02, 1.8);
  scene.add(decoRing);

  const decoInnerRingMat = new THREE.MeshBasicMaterial({
    color: 0xff2ec4,
    transparent: true,
    opacity: 0.28,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
  });
  const decoInnerRing = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.18, 40), decoInnerRingMat);
  decoInnerRing.rotation.x = -Math.PI / 2;
  decoInnerRing.position.set(-0.625, 0.022, 1.8);
  scene.add(decoInnerRing);

  const wallSharedMat = new THREE.MeshStandardMaterial({
    color: 0x2a3566,
    roughness: 0.28,
    metalness: 0.65
  });
  const archNeonMat = new THREE.MeshStandardMaterial({
    color: 0x00e5ff,
    emissive: 0x00b4d8,
    emissiveIntensity: 0.75,
    roughness: 0.2,
    metalness: 0.4
  });

  function createWallBox(
    x: number,
    z: number,
    w: number,
    d: number,
    h: number,
    rotY: number,
    customMat?: THREE.Material
  ) {
    const body = new CANNON.Body({ mass: 0, material: wallPhysMat });
    body.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)));
    body.position.set(x, h / 2, z);
    if (rotY) body.quaternion.setFromAxisAngle(Y_AXIS, rotY);
    world.addBody(body);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), customMat || wallSharedMat);
    mesh.position.set(body.position.x, body.position.y, body.position.z);
    mesh.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return { body, mesh };
  }

  createWallBox(-6.15, 2.75, 0.5, 17.5, 1.25, 0, wallSharedMat);
  createWallBox(6.15, 2.75, 0.5, 17.5, 1.25, 0, wallSharedMat);
  createWallBox(4.65, 2.9, 0.3, 17.4, 1.15, 0, wallSharedMat);
  createWallBox(5.4, 11.4, 1.6, 0.4, 1.2, 0, wallSharedMat);

  function createSideNeonTube(xPos: number, zCenter: number, length: number): NeonTubeRig {
    const tubeGroup = new THREE.Group();
    tubeGroup.position.set(xPos, 1.38, zCenter);

    const coreMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x00ffff,
      emissiveIntensity: 1.65,
      roughness: 0.12,
      metalness: 0.1
    });
    const coreTube = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, length, 16), coreMat);
    coreTube.rotation.x = Math.PI / 2;
    tubeGroup.add(coreTube);

    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const haloTube = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.24, length + 0.15, 16),
      haloMat
    );
    haloTube.rotation.x = Math.PI / 2;
    tubeGroup.add(haloTube);

    const bracketMat = new THREE.MeshStandardMaterial({
      color: 0x8d99ae,
      metalness: 0.85,
      roughness: 0.25
    });
    [-length / 2 + 0.25, 0, length / 2 - 0.25].forEach((zOff) => {
      const bracket = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.16, 0.28, 14),
        bracketMat
      );
      bracket.rotation.x = Math.PI / 2;
      bracket.position.z = zOff;
      tubeGroup.add(bracket);
    });

    const glowLight = new THREE.PointLight(0x00ffff, 0.85, 15);
    glowLight.position.set(xPos < 0 ? 0.6 : -0.6, 0.6, 0);
    tubeGroup.add(glowLight);

    scene.add(tubeGroup);
    return { coreMat, haloMat, glowLight };
  }

  const leftNeonTube = createSideNeonTube(-6.12, 2.75, 17.1);
  const rightNeonTube = createSideNeonTube(6.12, 2.75, 17.1);

  for (let i = 0; i < ARCH_SEGMENTS; i++) {
    const theta = ((i + 0.5) / ARCH_SEGMENTS) * Math.PI;
    const rMid = ARCH_INNER_R + ARCH_THICK / 2;
    const sx = Math.cos(theta) * rMid;
    const sz = ARCH_CENTER_Z - Math.sin(theta) * rMid;
    const rotY = theta - Math.PI / 2;
    createWallBox(sx, sz, 1.15, ARCH_THICK, 1.25, rotY, wallSharedMat);
  }

  const archNeonMesh = new THREE.Mesh(
    new THREE.TorusGeometry(ARCH_INNER_R + 0.05, 0.07, 10, 48, Math.PI),
    archNeonMat
  );
  archNeonMesh.rotation.x = Math.PI / 2;
  archNeonMesh.rotation.z = Math.PI;
  archNeonMesh.position.set(0, 1.28, ARCH_CENTER_Z);
  scene.add(archNeonMesh);

  // One-way shooter gate
  const gateBody = new CANNON.Body({ mass: 0, material: wallPhysMat });
  gateBody.addShape(new CANNON.Box(new CANNON.Vec3(0.15, 0.55, 2.1)));
  gateBody.position.set(4.65, 0.55, -7.85);

  const gateMat = new THREE.MeshStandardMaterial({
    color: 0xff2ec4,
    emissive: 0xff2ec4,
    emissiveIntensity: 0.7,
    transparent: true,
    opacity: 0.2
  });
  const gateMesh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.85, 3.8), gateMat);
  gateMesh.position.set(gateBody.position.x, gateBody.position.y, gateBody.position.z);
  scene.add(gateMesh);

  function setGateState(active: boolean) {
    if (active === gateActive) return;
    gateActive = active;
    if (active) {
      world.addBody(gateBody);
      gateMat.opacity = 0.72;
    } else {
      world.removeBody(gateBody);
      gateMat.opacity = 0.16;
    }
  }

  const guideMat = new THREE.MeshStandardMaterial({
    color: 0x3b4d91,
    emissive: 0x0d214f,
    roughness: 0.25,
    metalness: 0.65
  });
  function createGuideRamp(x1: number, z1: number, x2: number, z2: number) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const angleY = Math.atan2(-dz, dx);
    const thick = 0.45;
    const nx = dz / len;
    const nz = -dx / len;
    const sign = nz > 0 ? 1 : -1;
    const cx = (x1 + x2) / 2 + nx * (thick / 2) * sign;
    const cz = (z1 + z2) / 2 + nz * (thick / 2) * sign;
    createWallBox(cx, cz, len + 0.15, thick, 1.05, angleY, guideMat);
  }

  createGuideRamp(-5.95, 6.65, -3.45, 8.4);
  createGuideRamp(4.55, 6.65, 2.2, 8.4);
  createGuideRamp(-3.45, 8.4, -2.55, 11.6);
  createGuideRamp(2.2, 8.4, 1.3, 11.6);

  // =========================================================================
  // 4. Chrome Steel Ball & Multi-Part Plunger
  // =========================================================================
  const ballBody = new CANNON.Body({
    mass: 1.0,
    material: ballPhysMat,
    linearDamping: 0.015,
    angularDamping: 0.02
  });
  ballBody.addShape(new CANNON.Sphere(BALL_RADIUS));
  ballBody.position.set(PLUNGER_SPAWN.x, PLUNGER_SPAWN.y, PLUNGER_SPAWN.z);
  world.addBody(ballBody);

  const ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_RADIUS, 32, 32),
    new THREE.MeshStandardMaterial({
      color: 0xf4f8ff,
      metalness: 0.96,
      roughness: 0.1
    })
  );
  ballMesh.castShadow = true;
  ballMesh.receiveShadow = true;
  scene.add(ballMesh);

  const plungerGroup = new THREE.Group();
  const plungerHead = new THREE.Mesh(
    new THREE.CylinderGeometry(0.36, 0.36, 0.45, 20),
    new THREE.MeshStandardMaterial({
      color: 0xff5e57,
      emissive: 0x7a1212,
      roughness: 0.35,
      metalness: 0.4
    })
  );
  plungerHead.rotation.x = Math.PI / 2;
  plungerHead.position.set(0, 0.42, 0);
  plungerHead.castShadow = true;
  plungerGroup.add(plungerHead);

  const plungerCollar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.24, 0.18, 16),
    new THREE.MeshStandardMaterial({
      color: 0xffbe0b,
      metalness: 0.85,
      roughness: 0.2
    })
  );
  plungerCollar.rotation.x = Math.PI / 2;
  plungerCollar.position.set(0, 0.42, 0.28);
  plungerGroup.add(plungerCollar);

  const plungerRod = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.12, 1.4, 12),
    new THREE.MeshStandardMaterial({
      color: 0xc8d6e5,
      metalness: 0.88,
      roughness: 0.22
    })
  );
  plungerRod.rotation.x = Math.PI / 2;
  plungerRod.position.set(0, 0.42, 0.85);
  plungerGroup.add(plungerRod);

  plungerGroup.position.set(PLUNGER_SPAWN.x, 0, PLUNGER_REST_Z);
  scene.add(plungerGroup);

  // =========================================================================
  // 5. Kinematic Flippers (3-Part Composite)
  // =========================================================================
  const flipperMat = new THREE.MeshStandardMaterial({
    color: 0xff7b00,
    emissive: 0x702200,
    emissiveIntensity: 0.55,
    roughness: 0.28,
    metalness: 0.32
  });
  const flipperCapMat = new THREE.MeshStandardMaterial({
    color: 0xffe066,
    emissive: 0xffaa00,
    emissiveIntensity: 0.35,
    roughness: 0.18,
    metalness: 0.72
  });

  function createFlipper(config: {
    pivotX: number;
    pivotZ: number;
    direction: number;
    restAngle: number;
    activeAngle: number;
  }): FlipperEntity {
    const { pivotX, pivotZ, direction, restAngle, activeAngle } = config;
    const armLength = 2.55;
    const boxCenterOffset = direction * (armLength / 2 - 0.15);

    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.KINEMATIC,
      material: flipperPhysMat
    });
    body.addShape(
      new CANNON.Box(new CANNON.Vec3(armLength / 2, 0.5, 0.23)),
      new CANNON.Vec3(boxCenterOffset, 0, 0)
    );
    body.position.set(pivotX, 0.5, pivotZ);
    body.quaternion.setFromAxisAngle(Y_AXIS, restAngle);
    world.addBody(body);

    const group = new THREE.Group();
    const pivotCyl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.28, 0.88, 20),
      flipperCapMat
    );
    pivotCyl.castShadow = true;
    group.add(pivotCyl);

    const bladeMesh = new THREE.Mesh(new THREE.BoxGeometry(armLength, 0.82, 0.44), flipperMat);
    bladeMesh.position.set(boxCenterOffset, 0, 0);
    bladeMesh.castShadow = true;
    bladeMesh.receiveShadow = true;
    group.add(bladeMesh);

    const tipOffset = direction * (armLength - 0.15);
    const tipCyl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 0.82, 16),
      flipperMat
    );
    tipCyl.position.set(tipOffset, 0, 0);
    tipCyl.castShadow = true;
    group.add(tipCyl);

    group.position.set(body.position.x, body.position.y, body.position.z);
    group.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    scene.add(group);

    return {
      body,
      group,
      restAngle,
      activeAngle,
      currentAngle: restAngle
    };
  }

  const leftFlipper = createFlipper({
    pivotX: -3.45,
    pivotZ: 8.4,
    direction: 1,
    restAngle: -0.46,
    activeAngle: 0.56
  });

  const rightFlipper = createFlipper({
    pivotX: 2.2,
    pivotZ: 8.4,
    direction: -1,
    restAngle: 0.46,
    activeAngle: -0.56
  });

  function updateFlipperPhysics(flipper: FlipperEntity, pressed: boolean, dt: number) {
    const target = pressed ? flipper.activeAngle : flipper.restAngle;
    const diff = target - flipper.currentAngle;

    if (Math.abs(diff) < 0.0005) {
      flipper.currentAngle = target;
      flipper.body.angularVelocity.set(0, 0, 0);
      flipper.body.quaternion.setFromAxisAngle(Y_AXIS, flipper.currentAngle);
      return;
    }

    const speed = pressed ? 24.0 : 14.0;
    const maxStep = speed * dt;
    const delta = Math.max(-maxStep, Math.min(maxStep, diff));
    const omega = delta / dt;

    flipper.body.angularVelocity.set(0, omega, 0);
    flipper.currentAngle += delta;
    flipper.body.quaternion.setFromAxisAngle(Y_AXIS, flipper.currentAngle);
  }

  // =========================================================================
  // 6. Zero-GC 3D Impact Spark Particle Pool
  // =========================================================================
  const sparkGeo = new THREE.BoxGeometry(0.065, 0.065, 0.28);
  const sparkPool: SparkParticle[] = [];

  for (let i = 0; i < SPARK_POOL_SIZE; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe066,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(sparkGeo, mat);
    mesh.visible = false;
    scene.add(mesh);

    sparkPool.push({
      mesh,
      mat,
      active: false,
      vx: 0,
      vy: 0,
      vz: 0,
      life: 0,
      maxLife: 0.4
    });
  }

  function spawnSparkBurst(
    x: number,
    y: number,
    z: number,
    nx: number,
    nz: number,
    neonColor: number
  ) {
    const count = 26;
    let spawned = 0;

    for (let i = 0; i < SPARK_POOL_SIZE && spawned < count; i++) {
      const p = sparkPool[i];
      if (p.active) continue;

      p.active = true;
      p.life = 0;
      p.maxLife = 0.28 + Math.random() * 0.26;

      p.mesh.visible = true;
      p.mesh.position.set(
        x + (Math.random() - 0.5) * 0.12,
        y + (Math.random() - 0.5) * 0.1,
        z + (Math.random() - 0.5) * 0.12
      );

      const spreadAngle = (Math.random() - 0.5) * 2.2;
      const cosA = Math.cos(spreadAngle);
      const sinA = Math.sin(spreadAngle);
      const dirX = nx * cosA - nz * sinA;
      const dirZ = nx * sinA + nz * cosA;
      const speed = 7.5 + Math.random() * 11.5;

      p.vx = dirX * speed;
      p.vy = 2.5 + Math.random() * 6.5;
      p.vz = dirZ * speed;

      if (spawned % 3 === 0) {
        p.mat.color.setHex(0xffffff);
      } else if (spawned % 3 === 1) {
        p.mat.color.setHex(0xffbe0b);
      } else {
        p.mat.color.setHex(neonColor);
      }
      p.mat.opacity = 1.0;
      p.mesh.scale.set(1, 1, 1);
      spawned++;
    }
  }

  function updateSparkParticles(dt: number) {
    for (let i = 0; i < SPARK_POOL_SIZE; i++) {
      const p = sparkPool[i];
      if (!p.active) continue;

      p.life += dt;
      if (p.life >= p.maxLife) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }

      p.vy -= 18.0 * dt;
      p.vx *= 0.985;
      p.vz *= 0.985;

      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;

      if (p.mesh.position.y < 0.05) {
        p.mesh.position.y = 0.05;
        p.vy = Math.abs(p.vy) * 0.45;
      }

      _lookTarget.set(
        p.mesh.position.x + p.vx,
        p.mesh.position.y + p.vy,
        p.mesh.position.z + p.vz
      );
      p.mesh.lookAt(_lookTarget);

      const ratio = 1 - p.life / p.maxLife;
      p.mat.opacity = ratio;
      const s = 0.4 + ratio * 0.85;
      p.mesh.scale.set(s, s, 0.7 + ratio * 0.9);
    }
  }

  // =========================================================================
  // 7. Three Random Cylindrical Bumpers (Y-aligned in cannon-es!)
  // =========================================================================
  const bumpers: BumperEntity[] = [];
  const bumperPalette = [
    { base: 0x0088cc, neon: 0x00ffff },
    { base: 0xb5179e, neon: 0xff4dff },
    { base: 0xd9480f, neon: 0xffd000 }
  ];

  function generateRandomBumperPositions(): Array<{ x: number; z: number }> {
    const positions: Array<{ x: number; z: number }> = [];
    const minDist = 3.25;
    let attempts = 0;

    while (positions.length < 3 && attempts < 500) {
      attempts++;
      const rx = -3.5 + Math.random() * 6.0;
      const rz = -7.2 + Math.random() * 5.8;

      const distToArchCenter = Math.hypot(rx, rz - ARCH_CENTER_Z);
      if (rz < -6.0 && distToArchCenter > ARCH_INNER_R - 1.55) continue;

      let valid = true;
      for (const p of positions) {
        if (Math.hypot(rx - p.x, rz - p.z) < minDist) {
          valid = false;
          break;
        }
      }
      if (valid) positions.push({ x: rx, z: rz });
    }

    if (positions.length < 3) {
      return [
        { x: -2.4, z: -5.2 },
        { x: 1.3, z: -5.0 },
        { x: -0.6, z: -2.2 }
      ];
    }
    return positions;
  }

  function triggerBumperHit(bumper: BumperEntity) {
    bumper.flashAmount = 1.0;

    const bPos = bumper.body.position;
    const dx = ballBody.position.x - bPos.x;
    const dz = ballBody.position.z - bPos.z;
    const dist = Math.hypot(dx, dz) || 1;
    const nx = dx / dist;
    const nz = dz / dist;
    const impactX = bPos.x + nx * BUMPER_RADIUS;
    const impactY = BALL_RADIUS + 0.08;
    const impactZ = bPos.z + nz * BUMPER_RADIUS;

    spawnSparkBurst(impactX, impactY, impactZ, nx, nz, bumper.neonColor);

    score += BUMPER_SCORE;
    callbacks.onScoreChange(score, true);
    if (score > highScore) {
      highScore = score;
      callbacks.onHighScoreChange(highScore);
    }

    cameraShake = Math.max(cameraShake, 0.14);
    audio.playBumper();

    pendingBumperImpulses.push(bumper.body.position);
  }

  const initialCoords = generateRandomBumperPositions();
  for (let i = 0; i < 3; i++) {
    const pos = initialCoords[i];
    const colors = bumperPalette[i];

    // NOTE: In cannon-es, Cylinder is already aligned along the Y axis!
    const body = new CANNON.Body({ mass: 0, material: bumperPhysMat });
    const cylShape = new CANNON.Cylinder(BUMPER_RADIUS, BUMPER_RADIUS, 1.2, 20);
    body.addShape(cylShape);
    body.position.set(pos.x, 0.6, pos.z);
    world.addBody(body);

    const group = new THREE.Group();
    group.position.set(pos.x, 0, pos.z);

    const coreMat = new THREE.MeshStandardMaterial({
      color: colors.base,
      emissive: colors.neon,
      emissiveIntensity: 0.45,
      roughness: 0.35,
      metalness: 0.35
    });
    const coreMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(BUMPER_RADIUS, BUMPER_RADIUS * 1.05, 0.85, 28),
      coreMat
    );
    coreMesh.position.y = 0.45;
    coreMesh.castShadow = true;
    coreMesh.receiveShadow = true;
    group.add(coreMesh);

    const capMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(BUMPER_RADIUS * 0.68, BUMPER_RADIUS * 0.78, 0.22, 24),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: colors.neon,
        emissiveIntensity: 0.3,
        metalness: 0.82,
        roughness: 0.16
      })
    );
    capMesh.position.y = 0.96;
    capMesh.castShadow = true;
    group.add(capMesh);

    const ringBase = new THREE.Mesh(
      new THREE.TorusGeometry(BUMPER_RADIUS * 1.02, 0.055, 10, 28),
      new THREE.MeshStandardMaterial({
        color: 0xd9e4ff,
        metalness: 0.88,
        roughness: 0.2
      })
    );
    ringBase.rotation.x = Math.PI / 2;
    ringBase.position.y = 0.06;
    group.add(ringBase);

    const shockRingMat = new THREE.MeshBasicMaterial({
      color: colors.neon,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide
    });
    const shockRing = new THREE.Mesh(
      new THREE.RingGeometry(BUMPER_RADIUS * 0.95, BUMPER_RADIUS * 1.25, 32),
      shockRingMat
    );
    shockRing.rotation.x = -Math.PI / 2;
    shockRing.position.y = 0.03;
    group.add(shockRing);

    const flashLight = new THREE.PointLight(colors.neon, 0, 7.5);
    flashLight.position.set(0, 1.5, 0);
    group.add(flashLight);

    scene.add(group);

    const bumperObj: BumperEntity = {
      body,
      group,
      coreMat,
      shockRing,
      shockRingMat,
      flashLight,
      neonColor: colors.neon,
      flashAmount: 0,
      lastHitTime: 0
    };

    body.addEventListener('collide', (event: { body: CANNON.Body }) => {
      if (event.body !== ballBody || isGameOver) return;
      const now = performance.now();
      if (now - bumperObj.lastHitTime < 65) return;
      bumperObj.lastHitTime = now;
      triggerBumperHit(bumperObj);
    });

    bumpers.push(bumperObj);
  }

  function randomizeBumperPositions() {
    const coords = generateRandomBumperPositions();
    bumpers.forEach((b, idx) => {
      const p = coords[idx];
      b.body.position.set(p.x, 0.6, p.z);
      b.group.position.set(p.x, 0, p.z);
      b.flashAmount = 0;
    });
  }

  // =========================================================================
  // 8. Ball Reset, Drain, Game Over & Controls
  // =========================================================================
  function resetBallToShooter() {
    ballBody.position.set(PLUNGER_SPAWN.x, PLUNGER_SPAWN.y, PLUNGER_SPAWN.z);
    ballBody.velocity.set(0, 0, 0);
    ballBody.angularVelocity.set(0, 0, 0);
    ballInShooter = true;
    plungerCharge = 0;
    isCharging = false;
    callbacks.onChargeChange(0);
    setGateState(false);
    stuckTimer = 0;
    callbacks.onBannerChange('HOLD [S / ▼] TO LAUNCH');
  }

  function handleBallDrain() {
    audio.playDrain();
    ballsLeft = Math.max(0, ballsLeft - 1);
    callbacks.onBallsChange(ballsLeft);

    if (ballsLeft > 0) {
      resetBallToShooter();
      callbacks.onBannerChange(`BALL READY · REMAINING: ${ballsLeft}`);
    } else {
      isGameOver = true;
      ballBody.velocity.set(0, 0, 0);
      ballBody.position.set(0, -10, 0);
      callbacks.onBannerChange(null);

      let isNewRecord = false;
      try {
        const savedHi = parseInt(localStorage.getItem(HIGH_SCORE_STORAGE_KEY) || '0', 10) || 0;
        if (score > 0 && score >= highScore && score > savedHi) {
          localStorage.setItem(HIGH_SCORE_STORAGE_KEY, String(score));
          isNewRecord = true;
        }
      } catch {
        // Ignore storage restrictions
      }

      callbacks.onGameOverChange(true, score, isNewRecord);
    }
  }

  function releasePlunger() {
    if (!isCharging) return;
    isCharging = false;

    if (!isGameOver && ballBody.position.x > 4.65 && ballBody.position.z > 6.0) {
      const effectiveCharge = Math.max(0.28, plungerCharge);
      const launchSpeed = 24.5 + effectiveCharge * 22.0;
      ballBody.velocity.set((Math.random() - 0.5) * 0.25, 0, -launchSpeed);
      audio.playLaunch();
      callbacks.onBannerChange(null);
    }
    plungerCharge = 0;
    callbacks.onChargeChange(0);
  }

  function restart() {
    audio.ensure();
    score = 0;
    ballsLeft = INITIAL_BALLS;
    isGameOver = false;
    callbacks.onGameOverChange(false, 0, false);
    callbacks.onScoreChange(0, false);
    callbacks.onBallsChange(INITIAL_BALLS);
    randomizeBumperPositions();
    resetBallToShooter();
  }

  // Keyboard & resize listeners
  function handleKeyDown(e: KeyboardEvent) {
    audio.ensure();
    if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Space'].includes(e.code)) {
      e.preventDefault();
    }
    if (isGameOver) return;

    if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
      if (!keys.left) audio.playFlipper();
      keys.left = true;
    } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
      if (!keys.right) audio.playFlipper();
      keys.right = true;
    } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
      keys.down = true;
      if (ballBody.position.x > 4.65 && ballBody.position.z > 6.0) {
        isCharging = true;
      }
    }
  }

  function handleKeyUp(e: KeyboardEvent) {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
      keys.left = false;
    } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
      keys.right = false;
    } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
      keys.down = false;
      releasePlunger();
    }
  }

  function handleBlur() {
    keys.left = false;
    keys.right = false;
    keys.down = false;
    isCharging = false;
    plungerCharge = 0;
    callbacks.onChargeChange(0);
  }

  function handleResize() {
    const w = mountEl.clientWidth || window.innerWidth;
    const h = mountEl.clientHeight || window.innerHeight;
    const aspect = w / h;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);

    const zoomScale = aspect < 0.9 ? 0.9 / aspect : 1.0;
    baseCameraPos.set(0, 23.0 * zoomScale, 19.8 * zoomScale);
  }

  function handleContextLost(e: Event) {
    e.preventDefault();
    callbacks.onContextLostChange?.(true);
  }

  function handleContextRestored() {
    callbacks.onContextLostChange?.(false);
  }

  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', handleBlur);
  window.addEventListener('resize', handleResize);
  renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
  renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored);

  handleResize();
  if (!isSoftwareGl) {
    renderer.compile(scene, camera);
  }

  // =========================================================================
  // 9. Simulation & Render Loop (Software-WebGL Paced)
  // =========================================================================
  const FIXED_TIMESTEP = 1 / 120;
  let physicsAccumulator = 0;
  let lastFrameTime = performance.now();
  let elapsedTime = 0;
  let frameId = 0;
  let disposed = false;

  function stepSimulation(dt: number) {
    if (isGameOver) return;

    if (isCharging && ballBody.position.x > 4.65 && ballBody.position.z > 6.0) {
      plungerCharge = Math.min(1.0, plungerCharge + dt * 1.15);
      callbacks.onChargeChange(plungerCharge);
    }
    const targetPlungerZ = PLUNGER_REST_Z + plungerCharge * 1.35;
    plungerGroup.position.z +=
      (targetPlungerZ - plungerGroup.position.z) * Math.min(1, dt * 22);

    physicsAccumulator += dt;
    let substeps = 0;
    while (physicsAccumulator >= FIXED_TIMESTEP && substeps < 8) {
      updateFlipperPhysics(leftFlipper, keys.left, FIXED_TIMESTEP);
      updateFlipperPhysics(rightFlipper, keys.right, FIXED_TIMESTEP);

      world.step(FIXED_TIMESTEP);

      while (pendingBumperImpulses.length > 0) {
        const bPos = pendingBumperImpulses.shift()!;
        const dx = ballBody.position.x - bPos.x;
        const dz = ballBody.position.z - bPos.z;
        const dist = Math.hypot(dx, dz) || 1;
        const nx = dx / dist;
        const nz = dz / dist;

        const jitter = (Math.random() - 0.5) * 0.12;
        const rx = nx - nz * jitter;
        const rz = nz + nx * jitter;
        const currentSpeed = Math.hypot(ballBody.velocity.x, ballBody.velocity.z);
        const boostSpeed = Math.min(28, Math.max(16.5, currentSpeed * 1.12 + 4.5));

        ballBody.velocity.x = rx * boostSpeed;
        ballBody.velocity.z = rz * boostSpeed;
      }

      if (ballBody.position.y < BALL_RADIUS) {
        ballBody.position.y = BALL_RADIUS;
      }
      if (ballBody.velocity.y > 2.5) {
        ballBody.velocity.y = 2.5;
      }
      const speedSq =
        ballBody.velocity.x * ballBody.velocity.x + ballBody.velocity.z * ballBody.velocity.z;
      const MAX_SPEED = 48;
      if (speedSq > MAX_SPEED * MAX_SPEED) {
        const scale = MAX_SPEED / Math.sqrt(speedSq);
        ballBody.velocity.x *= scale;
        ballBody.velocity.z *= scale;
      }

      physicsAccumulator -= FIXED_TIMESTEP;
      substeps++;
    }

    if (ballInShooter && ballBody.position.x < 4.25) {
      ballInShooter = false;
      setGateState(true);
      callbacks.onBannerChange(null);
    }

    if (!ballInShooter) {
      const speed = Math.hypot(ballBody.velocity.x, ballBody.velocity.z);
      if (speed < 0.12) {
        stuckTimer += dt;
        if (stuckTimer > 2.2) {
          ballBody.velocity.set((Math.random() - 0.5) * 3.5, 0, 5.5);
          stuckTimer = 0;
        }
      } else {
        stuckTimer = 0;
      }
    }

    if (ballBody.position.z > 11.45 && ballBody.position.x < 4.5) {
      handleBallDrain();
    }
  }

  function updateVisualEffects(dt: number) {
    elapsedTime += dt;

    ballMesh.position.set(ballBody.position.x, ballBody.position.y, ballBody.position.z);
    ballMesh.quaternion.set(
      ballBody.quaternion.x,
      ballBody.quaternion.y,
      ballBody.quaternion.z,
      ballBody.quaternion.w
    );

    leftFlipper.group.position.set(
      leftFlipper.body.position.x,
      leftFlipper.body.position.y,
      leftFlipper.body.position.z
    );
    leftFlipper.group.quaternion.set(
      leftFlipper.body.quaternion.x,
      leftFlipper.body.quaternion.y,
      leftFlipper.body.quaternion.z,
      leftFlipper.body.quaternion.w
    );

    rightFlipper.group.position.set(
      rightFlipper.body.position.x,
      rightFlipper.body.position.y,
      rightFlipper.body.position.z
    );
    rightFlipper.group.quaternion.set(
      rightFlipper.body.quaternion.x,
      rightFlipper.body.quaternion.y,
      rightFlipper.body.quaternion.z,
      rightFlipper.body.quaternion.w
    );

    // Side 3D Neon Tubes smooth HSL color cycle
    const leftHue = (elapsedTime * 0.065) % 1.0;
    const rightHue = (elapsedTime * 0.065 + 0.38) % 1.0;

    leftNeonTube.coreMat.emissive.setHSL(leftHue, 1.0, 0.55);
    leftNeonTube.haloMat.color.setHSL(leftHue, 1.0, 0.6);
    leftNeonTube.glowLight.color.setHSL(leftHue, 1.0, 0.6);

    rightNeonTube.coreMat.emissive.setHSL(rightHue, 1.0, 0.55);
    rightNeonTube.haloMat.color.setHSL(rightHue, 1.0, 0.6);
    rightNeonTube.glowLight.color.setHSL(rightHue, 1.0, 0.6);

    for (const b of bumpers) {
      if (b.flashAmount > 0.001) {
        b.flashAmount = Math.max(0, b.flashAmount - dt * 4.2);
        const f = b.flashAmount;

        b.coreMat.emissiveIntensity = 0.45 + f * 3.4;
        const pulseScale = 1 + f * 0.22;
        b.group.scale.set(pulseScale, 1 + f * 0.12, pulseScale);

        const ringScale = 1 + (1 - f) * 1.45;
        b.shockRing.scale.set(ringScale, ringScale, 1);
        b.shockRingMat.opacity = f * 0.85;

        b.flashLight.intensity = f * 3.6;
      } else {
        b.coreMat.emissiveIntensity = 0.45;
        b.group.scale.set(1, 1, 1);
        b.shockRingMat.opacity = 0;
        b.flashLight.intensity = 0;
      }
    }

    updateSparkParticles(dt);

    if (cameraShake > 0.001) {
      camera.position.set(
        baseCameraPos.x + (Math.random() - 0.5) * cameraShake,
        baseCameraPos.y + (Math.random() - 0.5) * cameraShake,
        baseCameraPos.z + (Math.random() - 0.5) * cameraShake
      );
      cameraShake *= Math.pow(0.02, dt);
    } else {
      camera.position.copy(baseCameraPos);
      cameraShake = 0;
    }
  }

  function afterDraw(cb: () => void) {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (!gl || typeof gl.fenceSync !== 'function') {
      frameId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (disposed) return;
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        frameId = window.setTimeout(cb, 80);
      }
    };
    frameId = window.setTimeout(poll, 5);
  }

  function tick() {
    if (disposed) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    stepSimulation(dt);
    updateVisualEffects(dt);
    renderer.render(scene, camera);

    if (isSoftwareGl) {
      afterDraw(tick);
    } else {
      frameId = requestAnimationFrame(tick);
    }
  }

  if (isSoftwareGl) {
    tick();
  } else {
    frameId = requestAnimationFrame(tick);
  }

  return {
    setLeftFlipper(pressed: boolean) {
      audio.ensure();
      if (isGameOver) return;
      if (pressed && !keys.left) audio.playFlipper();
      keys.left = pressed;
    },
    setRightFlipper(pressed: boolean) {
      audio.ensure();
      if (isGameOver) return;
      if (pressed && !keys.right) audio.playFlipper();
      keys.right = pressed;
    },
    setPlungerDown(down: boolean) {
      audio.ensure();
      if (isGameOver) return;
      keys.down = down;
      if (down) {
        if (ballBody.position.x > 4.65 && ballBody.position.z > 6.0) {
          isCharging = true;
        }
      } else {
        releasePlunger();
      }
    },
    setMuted(muted: boolean) {
      audio.setMuted(muted);
    },
    restart,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);

      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('resize', handleResize);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', handleContextRestored);

      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const m = obj as THREE.Mesh;
          m.geometry?.dispose();
          if (Array.isArray(m.material)) {
            m.material.forEach((mat) => mat.dispose());
          } else {
            m.material?.dispose();
          }
        }
      });

      playfieldTexture.dispose();
      envTexture.dispose();
      renderer.dispose();
      audio.dispose();

      if (renderer.domElement.parentElement === mountEl) {
        mountEl.removeChild(renderer.domElement);
      }
    }
  };
}
