/**
 * Interactive AionForge model stage.
 *
 * Pointer model (simple, no physics, no OrbitControls fight):
 * - Press on a model (left OR right) → pick it up
 * - Drag while held → move it on the ground plane
 * - Release → drop
 * - Drag empty space (left) → orbit camera
 * - Scroll → zoom
 * - Esc → drop if held
 */
import * as THREE from './vendor/three.module.js';
import {
  loadBedrockModel,
  loadAnimation,
  sampleBedrockAnimation,
} from './bedrock-model.js';

const DEG = Math.PI / 180;
const ARENA_RADIUS = 3.5;
const HOLD_HEIGHT = 1.05;

export async function mountStage(canvas, options = {}) {
  if (!canvas) throw new Error('Stage canvas missing');
  if (!window.WebGLRenderingContext) throw new Error('WebGL not available');

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
  else if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0b0e14, 0.04);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 200);
  // Spherical orbit state (custom — no OrbitControls)
  const orbit = {
    target: new THREE.Vector3(0, 1.05, 0),
    radius: 8.2,
    theta: 0.55, // horizontal
    phi: 1.15, // vertical
    minRadius: 2.2,
    maxRadius: 16,
    minPhi: 0.25,
    maxPhi: Math.PI * 0.48,
  };

  function applyOrbit() {
    const { target, radius, theta, phi } = orbit;
    camera.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta)
    );
    camera.lookAt(target);
  }
  applyOrbit();

  scene.add(new THREE.AmbientLight(0xc8d0e0, 0.7));
  const key = new THREE.DirectionalLight(0xfff2dd, 1.25);
  key.position.set(5, 10, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const sc = key.shadow.camera;
  sc.near = 1;
  sc.far = 30;
  sc.left = -10;
  sc.right = 10;
  sc.top = 10;
  sc.bottom = -10;
  scene.add(key);

  const cyan = new THREE.PointLight(0x3ec8ff, 1.6, 20, 2);
  cyan.position.set(-3.2, 2.4, 2.2);
  scene.add(cyan);
  const amber = new THREE.PointLight(0xf0a030, 1.2, 18, 2);
  amber.position.set(3.6, 2.0, -1.8);
  scene.add(amber);
  scene.add(new THREE.HemisphereLight(0x9eb6ff, 0x1a1520, 0.45));

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(10, 64),
    new THREE.MeshStandardMaterial({
      color: 0x121722,
      roughness: 0.92,
      metalness: 0.04,
    })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(3.8, 3.95, 64),
    new THREE.MeshBasicMaterial({
      color: 0x3ec8ff,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.015;
  scene.add(ring);

  const grid = new THREE.GridHelper(14, 28, 0x2a3348, 0x1a2233);
  grid.position.y = 0.008;
  const gridMats = Array.isArray(grid.material) ? grid.material : [grid.material];
  for (const m of gridMats) {
    m.transparent = true;
    m.opacity = 0.4;
  }
  scene.add(grid);

  const dropMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.42, 40),
    new THREE.MeshBasicMaterial({
      color: 0x5ac8ff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  dropMarker.rotation.x = -Math.PI / 2;
  dropMarker.position.y = 0.03;
  scene.add(dropMarker);

  const nameEl = document.getElementById('stage-name');
  const roleEl = document.getElementById('stage-role');
  const hintEl = document.getElementById('stage-hint');
  if (nameEl) nameEl.textContent = 'Loading models…';
  if (roleEl) roleEl.textContent = 'Fetching Bedrock geometry';

  const manifestRes = await fetch(options.manifestUrl || 'assets/models/manifest.json');
  if (!manifestRes.ok) throw new Error(`Manifest ${manifestRes.status}`);
  const manifest = await manifestRes.json();

  /** @type {any[]} */
  const actors = [];
  const errors = [];
  let slot = 0;
  for (const entry of manifest.models || []) {
    try {
      const actor = await createActor(entry, slot, (manifest.models || []).length);
      actors.push(actor);
      scene.add(actor.wrapper);
      slot += 1;
    } catch (err) {
      console.error('Failed to load model', entry.id, err);
      errors.push(`${entry.id}: ${err?.message || err}`);
    }
  }
  if (!actors.length) throw new Error(`No models loaded. ${errors.join(' | ')}`);

  let focused = actors[0];
  /** @type {any|null} */
  let held = null;
  /** @type {any|null} */
  let hovered = null;
  let globalMode = 'walk';

  // Pointer state machine
  /** @type {'none'|'orbit'|'drag'} */
  let dragMode = 'none';
  let activePointerId = null;
  let lastX = 0;
  let lastY = 0;
  const holdTarget = new THREE.Vector3();
  const holdSmooth = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  updateHud(focused);
  setHintDefault();

  function setHintDefault() {
    if (!hintEl) return;
    hintEl.textContent =
      'Click a model to pick up · drag to place · release to drop · drag empty space to look around.';
  }

  function updateHud(actor) {
    if (!actor) return;
    if (nameEl) nameEl.textContent = actor.name;
    if (roleEl) {
      roleEl.textContent = held === actor ? 'Holding — drag to move, release to drop' : actor.role;
    }
  }

  function setPointerNdc(ev) {
    const rect = canvas.getBoundingClientRect();
    pointerNdc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function hitActor(ev) {
    setPointerNdc(ev);
    raycaster.setFromCamera(pointerNdc, camera);
    const proxies = actors.map((a) => a.pickProxy).filter(Boolean);
    let hits = raycaster.intersectObjects(proxies, false);
    if (!hits.length) {
      hits = raycaster.intersectObjects(
        actors.map((a) => a.wrapper),
        true
      );
    }
    if (!hits.length) return null;
    let obj = hits[0].object;
    while (obj && !obj.userData.actorId) obj = obj.parent;
    if (!obj) return null;
    return actors.find((a) => a.id === obj.userData.actorId) || null;
  }

  function groundPoint(ev, height = 0) {
    setPointerNdc(ev);
    raycaster.setFromCamera(pointerNdc, camera);
    groundPlane.constant = -height;
    const out = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, out)) return null;
    const r = Math.hypot(out.x, out.z);
    if (r > ARENA_RADIUS) {
      out.x = (out.x / r) * ARENA_RADIUS;
      out.z = (out.z / r) * ARENA_RADIUS;
    }
    out.y = height;
    return out;
  }

  function pickUp(actor, ev) {
    if (held && held !== actor) dropHeld(false);
    held = actor;
    actor.setHeld(true);
    focused = actor;
    updateHud(actor);

    const pt = groundPoint(ev, HOLD_HEIGHT);
    if (pt) {
      holdTarget.copy(pt);
      holdSmooth.set(actor.wrapper.position.x, HOLD_HEIGHT, actor.wrapper.position.z);
    } else {
      holdTarget.set(actor.wrapper.position.x, HOLD_HEIGHT, actor.wrapper.position.z);
      holdSmooth.copy(holdTarget);
    }
    // Snap up immediately so user sees grab
    actor.wrapper.position.y = HOLD_HEIGHT;

    canvas.classList.add('is-holding');
    canvas.style.cursor = 'grabbing';
    dropMarker.material.opacity = 0.6;
    if (hintEl) {
      hintEl.textContent = `Holding ${actor.name} — drag to move · release to drop · Esc cancels.`;
    }
  }

  function dropHeld(restoreMode = true) {
    if (!held) return;
    const actor = held;
    const x = actor.wrapper.position.x;
    const z = actor.wrapper.position.z;
    const r = Math.hypot(x, z);
    const nx = r > ARENA_RADIUS ? (x / r) * ARENA_RADIUS : x;
    const nz = r > ARENA_RADIUS ? (z / r) * ARENA_RADIUS : z;
    actor.dropAt(nx, nz);
    actor.setHeld(false);
    if (restoreMode) actor.setMode(globalMode);
    held = null;
    canvas.classList.remove('is-holding');
    canvas.style.cursor = '';
    dropMarker.material.opacity = 0;
    setHintDefault();
    updateHud(actor);
  }

  // —— Pointer handlers (single system, no OrbitControls) ——
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
  });

  canvas.addEventListener('pointerdown', (ev) => {
    // Only primary/secondary mouse buttons
    if (ev.button !== 0 && ev.button !== 2) return;
    ev.preventDefault();

    // If already holding and click elsewhere — drop then maybe grab new
    const actor = hitActor(ev);

    if (held) {
      // Click while holding drops; if on another model, swap grab
      if (actor && actor !== held) {
        dropHeld(false);
        pickUp(actor, ev);
        dragMode = 'drag';
      } else {
        dropHeld(true);
        dragMode = 'none';
      }
      activePointerId = ev.pointerId;
      lastX = ev.clientX;
      lastY = ev.clientY;
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch (_) {
        /* ignore */
      }
      return;
    }

    if (actor) {
      // Grab model (left OR right click)
      pickUp(actor, ev);
      dragMode = 'drag';
      activePointerId = ev.pointerId;
      lastX = ev.clientX;
      lastY = ev.clientY;
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch (_) {
        /* ignore */
      }
      // Also fire a brief action flash
      return;
    }

    // Empty space + left button → orbit camera
    if (ev.button === 0) {
      dragMode = 'orbit';
      activePointerId = ev.pointerId;
      lastX = ev.clientX;
      lastY = ev.clientY;
      canvas.style.cursor = 'grabbing';
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch (_) {
        /* ignore */
      }
    }
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (dragMode === 'none' || activePointerId !== ev.pointerId) {
      // Hover only when idle
      if (!held) {
        const actor = hitActor(ev);
        if (hovered && hovered !== actor) hovered.setHovered(false);
        if (actor && actor !== hovered) actor.setHovered(true);
        hovered = actor;
        canvas.style.cursor = actor ? 'grab' : '';
      }
      return;
    }

    const dx = ev.clientX - lastX;
    const dy = ev.clientY - lastY;
    lastX = ev.clientX;
    lastY = ev.clientY;

    if (dragMode === 'orbit') {
      orbit.theta -= dx * 0.0055;
      orbit.phi -= dy * 0.0055;
      orbit.phi = Math.max(orbit.minPhi, Math.min(orbit.maxPhi, orbit.phi));
      applyOrbit();
      return;
    }

    if (dragMode === 'drag' && held) {
      const pt = groundPoint(ev, HOLD_HEIGHT);
      if (pt) holdTarget.copy(pt);
    }
  });

  function endPointer(ev) {
    if (activePointerId !== null && ev.pointerId !== activePointerId) return;

    if (dragMode === 'drag' && held) {
      // Release drops
      dropHeld(true);
    }

    if (dragMode === 'orbit') {
      canvas.style.cursor = '';
    }

    dragMode = 'none';
    activePointerId = null;
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch (_) {
      /* ignore */
    }
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const factor = Math.exp(ev.deltaY * 0.0012);
      orbit.radius = Math.max(
        orbit.minRadius,
        Math.min(orbit.maxRadius, orbit.radius * factor)
      );
      applyOrbit();
    },
    { passive: false }
  );

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && held) dropHeld(true);
  });

  // Mode buttons
  document.querySelectorAll('[data-stage-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-stage-mode');
      // Ignore non walk/idle/action (e.g. grab btn handled separately if present)
      if (mode !== 'walk' && mode !== 'idle' && mode !== 'action') return;
      globalMode = mode;
      document.querySelectorAll('[data-stage-mode]').forEach((b) => {
        if (['walk', 'idle', 'action'].includes(b.getAttribute('data-stage-mode'))) {
          b.classList.remove('is-active');
        }
      });
      btn.classList.add('is-active');
      for (const a of actors) {
        if (!a.isHeld()) a.setMode(globalMode);
      }
      if (!held) setHintDefault();
    });
  });

  // Optional Grab button — just focuses hint; click-to-grab is always on
  const grabBtn = document.getElementById('stage-grab-btn');
  if (grabBtn) {
    grabBtn.addEventListener('click', () => {
      if (hintEl) {
        hintEl.textContent =
          'Click any model to pick it up, then drag and release to place.';
      }
      grabBtn.classList.add('is-active');
      setTimeout(() => grabBtn.classList.remove('is-active'), 1200);
    });
  }

  function resize() {
    const parent = canvas.parentElement || canvas;
    const w = Math.max(parent.clientWidth || 800, 1);
    const h = Math.max(parent.clientHeight || 420, 1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);
  renderer.render(scene, camera);

  const clock = new THREE.Clock();
  let running = true;

  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;

    if (held) {
      holdSmooth.lerp(holdTarget, 1 - Math.exp(-14 * dt));
      held.wrapper.position.x = holdSmooth.x;
      held.wrapper.position.z = holdSmooth.z;
      held.wrapper.position.y = holdSmooth.y + Math.sin(t * 3.5) * 0.035;
      held.wrapper.rotation.y += dt * 0.4;
      dropMarker.position.x = holdSmooth.x;
      dropMarker.position.z = holdSmooth.z;
      dropMarker.material.opacity = 0.45 + Math.sin(t * 5) * 0.12;
      dropMarker.scale.setScalar(1 + Math.sin(t * 5) * 0.06);
    }

    for (const a of actors) a.update(dt, t);
    cyan.position.x = Math.sin(t * 0.4) * 3.2;
    amber.position.z = Math.cos(t * 0.35) * 2.5;
    ring.rotation.z = t * 0.08;
    renderer.render(scene, camera);
  }
  frame();

  return {
    dispose() {
      running = false;
      renderer.dispose();
      window.removeEventListener('resize', resize);
    },
    actors,
    errors,
  };
}

async function createActor(entry, index, total) {
  const model = await loadBedrockModel(entry.path);
  const anims = await loadAnimation(entry.path);

  const scale = entry.scale || 0.08;
  model.root.scale.setScalar(scale);
  model.root.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(model.root);
  const lift = -box.min.y + (entry.yOffset || 0);

  const pivot = new THREE.Group();
  model.root.position.set(0, lift, 0);
  model.root.rotation.y = Math.PI;
  pivot.add(model.root);

  const wrapper = new THREE.Group();
  wrapper.add(pivot);
  wrapper.userData.actorId = entry.id;

  // Big invisible pick sphere
  const pickProxy = new THREE.Mesh(
    new THREE.SphereGeometry(entry.kind === 'weapon' ? 1.0 : 1.25, 16, 12),
    new THREE.MeshBasicMaterial({
      visible: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
  );
  pickProxy.position.y = entry.kind === 'weapon' ? 1.15 : 1.0;
  pickProxy.userData.actorId = entry.id;
  pickProxy.name = 'pickProxy';
  wrapper.add(pickProxy);

  const angle = (index / Math.max(total, 1)) * Math.PI * 1.1 - Math.PI * 0.55;
  const radius = 2.0 + index * 0.2;
  wrapper.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius * 0.75);

  const glow = new THREE.Mesh(
    new THREE.RingGeometry(0.32, 0.46, 32),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(entry.color || '#3ec8ff'),
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.025;
  wrapper.add(glow);

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.48, 0.58, 40),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(entry.color || '#5ac8ff'),
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.028;
  wrapper.add(halo);

  for (const bone of Object.values(model.bones)) {
    bone.userData.baseLocal = bone.position.clone();
    bone.userData.baseRot = {
      x: bone.rotation.x,
      y: bone.rotation.y,
      z: bone.rotation.z,
    };
  }

  const idleKey = Object.keys(anims || {}).find((k) => k.endsWith('.idle'));
  const actionKey = Object.keys(anims || {}).find((k) => k.endsWith('.action'));
  const idleDef = idleKey ? anims[idleKey] : null;
  const actionDef = actionKey ? anims[actionKey] : null;

  /** @type {'idle'|'walk'|'action'} */
  let mode = entry.canWalk ? 'walk' : 'idle';
  let actionUntil = 0;
  let heading = Math.random() * Math.PI * 2;
  let speed = 0.5 + Math.random() * 0.3;
  let turnTimer = 1 + Math.random() * 2;
  let phase = Math.random() * Math.PI * 2;
  let held = false;
  let hovered = false;

  const bones = model.bones;

  function resetBoneRots() {
    for (const bone of Object.values(bones)) {
      const b = bone.userData.baseRot;
      if (b) bone.rotation.set(b.x, b.y, b.z);
      if (bone.userData.baseLocal) bone.position.copy(bone.userData.baseLocal);
    }
  }

  function applyProceduralWalk(t, amount = 1) {
    const swing = Math.sin(t * 6 + phase) * amount;
    const swing2 = Math.sin(t * 6 + phase + Math.PI) * amount;
    const bob = Math.abs(Math.sin(t * 6 + phase)) * 0.06 * amount;
    const legL = bones.leg_l;
    const legR = bones.leg_r;
    const armL = bones.arm_l;
    const armR = bones.arm_r;
    const body = bones.body || bones.torso || bones.pelvis;
    const head = bones.head;
    const tail = bones.tail;
    const jaw = bones.jaw;
    if (legL) legL.rotation.x = swing * 0.55;
    if (legR) legR.rotation.x = swing2 * 0.55;
    if (armL) armL.rotation.x = swing2 * 0.4;
    if (armR) armR.rotation.x = swing * 0.4;
    if (body) {
      body.rotation.z = swing * 0.04;
      body.rotation.y = swing * 0.05;
      if (body.userData.baseLocal) {
        body.position.y = body.userData.baseLocal.y + bob * 2.5;
      }
    }
    if (head) head.rotation.y = swing * 0.08;
    if (tail) tail.rotation.y = swing2 * 0.25;
    if (jaw) jaw.rotation.x = 0.05 + Math.max(0, swing) * 0.08;
  }

  function applyProceduralIdle(t) {
    const s = Math.sin(t * 1.4 + phase);
    const body = bones.body || bones.torso || bones.pelvis || bones.root;
    const head = bones.head;
    if (body) body.rotation.y = s * 6 * DEG;
    if (head) head.rotation.y = Math.sin(t * 1.1 + phase) * 0.08;
    const grip = bones.grip;
    if (grip) grip.rotation.z = Math.sin(t * 1.6) * 0.06;
  }

  function applyCarriedPose(t) {
    applyProceduralIdle(t);
    if (bones.leg_l) bones.leg_l.rotation.x = -0.25;
    if (bones.leg_r) bones.leg_r.rotation.x = -0.25;
    if (bones.arm_l) bones.arm_l.rotation.x = 0.2;
    if (bones.arm_r) bones.arm_r.rotation.x = 0.2;
  }

  const actor = {
    id: entry.id,
    name: entry.name,
    role: entry.role,
    wrapper,
    pickProxy,
    isHeld() {
      return held;
    },
    setHeld(v) {
      held = !!v;
      hovered = false;
      wrapper.scale.setScalar(held ? 1.14 : 1);
      glow.material.opacity = held ? 0.9 : 0;
      halo.material.opacity = held ? 0.7 : 0;
      if (held) mode = 'idle';
    },
    setHovered(v) {
      if (held) return;
      hovered = !!v;
      halo.material.opacity = hovered ? 0.45 : 0;
      wrapper.scale.setScalar(hovered ? 1.05 : 1);
    },
    dropAt(x, z) {
      wrapper.position.set(x, 0, z);
      wrapper.scale.setScalar(1);
      pivot.position.y = 0;
    },
    setMode(m) {
      if (held) return;
      mode = m === 'walk' || m === 'action' || m === 'idle' ? m : 'idle';
      if (mode === 'action') actionUntil = performance.now() / 1000 + 1.2;
      if (mode !== 'action' && !hovered) glow.material.opacity = 0;
    },
    playAction() {
      if (held) return;
      mode = 'action';
      actionUntil = performance.now() / 1000 + 1.4;
      glow.material.opacity = 0.85;
    },
    update(dt, t) {
      resetBoneRots();
      const now = performance.now() / 1000;

      if (held) {
        applyCarriedPose(t);
        pivot.position.y = Math.sin(t * 3 + phase) * 0.05;
        glow.material.opacity = 0.55 + Math.sin(t * 5) * 0.15;
        halo.material.opacity = 0.5 + Math.sin(t * 5) * 0.12;
        if (entry.kind === 'weapon') pivot.rotation.z = Math.sin(t * 1.5) * 0.1;
        return;
      }

      const targetScale = hovered ? 1.05 : 1;
      const cur = wrapper.scale.x;
      if (Math.abs(cur - targetScale) > 0.001) {
        wrapper.scale.setScalar(
          THREE.MathUtils.lerp(cur, targetScale, 1 - Math.exp(-10 * dt))
        );
      }

      let active = mode;
      if (mode === 'action' && now > actionUntil) {
        active = entry.canWalk ? 'walk' : 'idle';
        mode = active;
        if (!hovered) glow.material.opacity = 0;
      }

      if (idleDef && active !== 'action') sampleBedrockAnimation(idleDef, bones, t);
      if (active === 'action' && actionDef) {
        sampleBedrockAnimation(actionDef, bones, Math.max(0, 1.2 - (actionUntil - now)));
      }

      wrapper.position.y = THREE.MathUtils.lerp(wrapper.position.y, 0, 1 - Math.exp(-10 * dt));
      pivot.position.y = 0;

      if (entry.kind === 'weapon') {
        pivot.position.y = Math.sin(t * 1.5 + phase) * 0.12 + 0.2;
        pivot.rotation.y += dt * 0.55;
        pivot.rotation.z = Math.sin(t * 1.2 + phase) * 0.08;
        applyProceduralIdle(t);
        glow.material.opacity = Math.max(
          glow.material.opacity * 0.94,
          hovered ? 0.35 : 0.18
        );
        return;
      }

      if (active === 'walk' && entry.canWalk) {
        applyProceduralWalk(t, 1);
        turnTimer -= dt;
        if (turnTimer <= 0) {
          heading += (Math.random() - 0.5) * 1.4;
          turnTimer = 1.4 + Math.random() * 2.4;
          speed = 0.45 + Math.random() * 0.35;
        }
        const vx = Math.sin(heading) * speed * dt;
        const vz = Math.cos(heading) * speed * dt;
        wrapper.position.x += vx;
        wrapper.position.z += vz;
        const r = Math.hypot(wrapper.position.x, wrapper.position.z);
        if (r > ARENA_RADIUS) {
          heading =
            Math.atan2(-wrapper.position.x, -wrapper.position.z) +
            (Math.random() - 0.5) * 0.5;
          wrapper.position.multiplyScalar((ARENA_RADIUS - 0.1) / r);
        }
        wrapper.rotation.y = THREE.MathUtils.lerp(
          wrapper.rotation.y,
          Math.atan2(vx, vz),
          0.12
        );
      } else if (active === 'idle') {
        applyProceduralIdle(t);
      } else if (active === 'action') {
        const body = bones.body || bones.torso;
        if (body) body.rotation.x = -0.15;
        if (bones.arm_r) bones.arm_r.rotation.x = -0.8;
        if (bones.jaw) bones.jaw.rotation.x = 0.35;
      }

      if (glow.material.opacity > 0.05 && active === 'action') {
        glow.material.opacity = 0.35 + Math.sin(t * 4) * 0.15;
        glow.scale.setScalar(1 + Math.sin(t * 4) * 0.05);
      }
      if (hovered && !held) {
        halo.material.opacity = 0.35 + Math.sin(t * 4) * 0.08;
      }
    },
  };

  wrapper.traverse((o) => {
    o.userData.actorId = entry.id;
  });

  return actor;
}
