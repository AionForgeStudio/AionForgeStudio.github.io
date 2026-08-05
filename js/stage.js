/**
 * Interactive AionForge model stage.
 * Uses vendored Three.js (no CDN bare-import issues).
 */
import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import {
  loadBedrockModel,
  loadAnimation,
  sampleBedrockAnimation,
} from './bedrock-model.js';

const DEG = Math.PI / 180;

export async function mountStage(canvas, options = {}) {
  const {
    manifestUrl = 'assets/models/manifest.json',
    autoRotate = false,
  } = options;

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
  camera.position.set(5.2, 3.0, 7.0);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 2;
  controls.maxDistance = 16;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.target.set(0, 1.2, 0);
  controls.autoRotate = autoRotate;
  controls.autoRotateSpeed = 0.55;
  controls.update();

  scene.add(new THREE.AmbientLight(0xc8d0e0, 0.7));

  const key = new THREE.DirectionalLight(0xfff2dd, 1.25);
  key.position.set(5, 10, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const sc = key.shadow.camera;
  sc.near = 1; sc.far = 30;
  sc.left = -10; sc.right = 10; sc.top = 10; sc.bottom = -10;
  scene.add(key);

  const cyan = new THREE.PointLight(0x3ec8ff, 1.6, 20, 2);
  cyan.position.set(-3.2, 2.4, 2.2);
  scene.add(cyan);

  const amber = new THREE.PointLight(0xf0a030, 1.2, 18, 2);
  amber.position.set(3.6, 2.0, -1.8);
  scene.add(amber);

  const hemi = new THREE.HemisphereLight(0x9eb6ff, 0x1a1520, 0.45);
  scene.add(hemi);

  // Ground
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

  // Placeholder while loading
  const nameEl = document.getElementById('stage-name');
  const roleEl = document.getElementById('stage-role');
  const hintEl = document.getElementById('stage-hint');
  if (nameEl) nameEl.textContent = 'Loading models…';
  if (roleEl) roleEl.textContent = 'Fetching Bedrock geometry';

  const manifestRes = await fetch(manifestUrl);
  if (!manifestRes.ok) throw new Error(`Manifest ${manifestRes.status}`);
  const manifest = await manifestRes.json();

  /** @type {any[]} */
  const actors = [];
  let slot = 0;
  const errors = [];

  for (const entry of manifest.models || []) {
    try {
      const actor = await createActor(entry, slot, (manifest.models || []).length);
      actors.push(actor);
      scene.add(actor.wrapper);
      slot += 1;
    } catch (err) {
      console.error('Failed to load model', entry.id, err);
      errors.push(`${entry.id}: ${err && err.message ? err.message : err}`);
    }
  }

  if (!actors.length) {
    throw new Error(`No models loaded. ${errors.join(' | ')}`);
  }

  let focused = actors[0];
  updateHud(focused);

  // Click pick
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    // Ignore if user is orbit-dragging significantly — simple click only
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(actors.map((a) => a.wrapper), true);
    if (!hits.length) return;
    let obj = hits[0].object;
    while (obj && !obj.userData.actorId) obj = obj.parent;
    if (!obj) return;
    focused = actors.find((a) => a.id === obj.userData.actorId) || focused;
    focused.playAction();
    updateHud(focused);
    controls.target.lerp(
      new THREE.Vector3(focused.wrapper.position.x, 1.2, focused.wrapper.position.z),
      0.65
    );
  });

  document.querySelectorAll('[data-stage-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-stage-mode');
      document.querySelectorAll('[data-stage-mode]').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      for (const a of actors) a.setMode(mode);
      if (hintEl) {
        if (mode === 'walk') {
          hintEl.textContent = 'Models roam with walk cycles. Drag to orbit · click a model to focus.';
        } else if (mode === 'action') {
          hintEl.textContent = 'Action poses. Drag to orbit · click a model to focus.';
        } else {
          hintEl.textContent = 'Idle sway. Drag to orbit · click a model to focus.';
        }
      }
    });
  });

  function updateHud(actor) {
    if (!actor) return;
    if (nameEl) nameEl.textContent = actor.name;
    if (roleEl) roleEl.textContent = actor.role;
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

  // Kick one render immediately so the canvas isn't blank while first frame schedules
  renderer.render(scene, camera);

  const clock = new THREE.Clock();
  let running = true;

  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    for (const a of actors) a.update(dt, t);
    cyan.position.x = Math.sin(t * 0.4) * 3.2;
    amber.position.z = Math.cos(t * 0.35) * 2.5;
    ring.rotation.z = t * 0.08;
    controls.update();
    renderer.render(scene, camera);
  }
  frame();

  return {
    dispose() {
      running = false;
      controls.dispose();
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
  // Face toward camera initially (models face -Z in bedrock often)
  model.root.rotation.y = Math.PI;
  pivot.add(model.root);

  const wrapper = new THREE.Group();
  wrapper.add(pivot);
  wrapper.userData.actorId = entry.id;

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

  const actor = {
    id: entry.id,
    name: entry.name,
    role: entry.role,
    wrapper,
    setMode(m) {
      mode = m === 'walk' || m === 'action' || m === 'idle' ? m : 'idle';
      if (mode === 'action') actionUntil = performance.now() / 1000 + 1.2;
      if (mode !== 'action') glow.material.opacity = 0;
    },
    playAction() {
      mode = 'action';
      actionUntil = performance.now() / 1000 + 1.4;
      glow.material.opacity = 0.85;
    },
    update(dt, t) {
      resetBoneRots();
      const now = performance.now() / 1000;
      let active = mode;
      if (mode === 'action' && now > actionUntil) {
        active = entry.canWalk ? 'walk' : 'idle';
        mode = active;
        glow.material.opacity = 0;
      }

      if (idleDef && active !== 'action') sampleBedrockAnimation(idleDef, bones, t);
      if (active === 'action' && actionDef) {
        sampleBedrockAnimation(actionDef, bones, Math.max(0, 1.2 - (actionUntil - now)));
      }

      if (entry.kind === 'weapon') {
        pivot.position.y = Math.sin(t * 1.5 + phase) * 0.12 + 0.2;
        pivot.rotation.y += dt * 0.55;
        pivot.rotation.z = Math.sin(t * 1.2 + phase) * 0.08;
        applyProceduralIdle(t);
        glow.material.opacity = Math.max(glow.material.opacity * 0.94, 0.18);
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
        if (r > 3.6) {
          heading = Math.atan2(-wrapper.position.x, -wrapper.position.z) + (Math.random() - 0.5) * 0.5;
          wrapper.position.multiplyScalar(3.4 / r);
        }

        const face = Math.atan2(vx, vz);
        wrapper.rotation.y = THREE.MathUtils.lerp(wrapper.rotation.y, face, 0.12);
      } else if (active === 'idle') {
        applyProceduralIdle(t);
      } else if (active === 'action') {
        const body = bones.body || bones.torso;
        if (body) body.rotation.x = -0.15;
        if (bones.arm_r) bones.arm_r.rotation.x = -0.8;
        if (bones.jaw) bones.jaw.rotation.x = 0.35;
      }

      if (glow.material.opacity > 0.05) {
        glow.material.opacity = 0.35 + Math.sin(t * 4) * 0.15;
        glow.scale.setScalar(1 + Math.sin(t * 4) * 0.05);
      }
    },
  };

  wrapper.traverse((o) => {
    o.userData.actorId = entry.id;
  });

  return actor;
}
