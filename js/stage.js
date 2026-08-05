/**
 * Interactive AionForge model stage.
 * - Loads real Bedrock geo + textures
 * - Procedural walk / idle (exported idles are light sway only)
 * - Orbit drag, click-to-focus, roaming actors
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js';
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

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0b0e14, 0.045);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(4.2, 2.6, 6.2);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 2.2;
  controls.maxDistance = 14;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.target.set(0, 1.1, 0);
  controls.autoRotate = autoRotate;
  controls.autoRotateSpeed = 0.6;

  // Lights
  scene.add(new THREE.AmbientLight(0xb8c4d8, 0.55));
  const key = new THREE.DirectionalLight(0xfff2dd, 1.15);
  key.position.set(5, 10, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -8;
  key.shadow.camera.right = 8;
  key.shadow.camera.top = 8;
  key.shadow.camera.bottom = -8;
  scene.add(key);

  const cyan = new THREE.PointLight(0x3ec8ff, 1.4, 18, 2);
  cyan.position.set(-3, 2.2, 2);
  scene.add(cyan);

  const amber = new THREE.PointLight(0xf0a030, 1.1, 16, 2);
  amber.position.set(3.5, 1.8, -1.5);
  scene.add(amber);

  // Ground
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(9, 64),
    new THREE.MeshStandardMaterial({
      color: 0x121722,
      roughness: 0.92,
      metalness: 0.05,
    })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(3.6, 3.72, 64),
    new THREE.MeshBasicMaterial({
      color: 0x3ec8ff,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  scene.add(ring);

  // Grid helper faint
  const grid = new THREE.GridHelper(12, 24, 0x2a3348, 0x1a2233);
  grid.position.y = 0.005;
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);

  const manifest = await fetch(manifestUrl).then((r) => r.json());
  /** @type {Actor[]} */
  const actors = [];

  let slot = 0;
  for (const entry of manifest.models) {
    try {
      const actor = await createActor(entry, slot, manifest.models.length);
      actors.push(actor);
      scene.add(actor.wrapper);
      slot += 1;
    } catch (err) {
      console.warn('Failed to load model', entry.id, err);
    }
  }

  // UI HUD binding
  const nameEl = document.getElementById('stage-name');
  const roleEl = document.getElementById('stage-role');
  const hintEl = document.getElementById('stage-hint');

  let focused = actors[0] || null;
  updateHud(focused);

  // Click pick
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(
      actors.map((a) => a.wrapper),
      true
    );
    if (hits.length) {
      let obj = hits[0].object;
      while (obj && !obj.userData.actorId) obj = obj.parent;
      if (obj && obj.userData.actorId) {
        focused = actors.find((a) => a.id === obj.userData.actorId) || focused;
        focused.playAction();
        updateHud(focused);
        // ease camera target toward actor
        controls.target.lerp(
          new THREE.Vector3(focused.wrapper.position.x, 1.1, focused.wrapper.position.z),
          0.55
        );
      }
    }
  });

  // Mode buttons
  document.querySelectorAll('[data-stage-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-stage-mode');
      document.querySelectorAll('[data-stage-mode]').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      for (const a of actors) a.setMode(mode);
      if (hintEl) {
        hintEl.textContent =
          mode === 'walk'
            ? 'Models roam the stage with walk cycles. Drag to orbit · click a model to focus.'
            : mode === 'action'
              ? 'Playing action poses. Drag to orbit · click a model to focus.'
              : 'Idle sway. Drag to orbit · click a model to focus.';
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
    const w = parent.clientWidth || 800;
    const h = parent.clientHeight || 420;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  const clock = new THREE.Clock();
  let running = true;

  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    for (const a of actors) a.update(dt, t);
    // subtle light motion
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
    },
    actors,
  };
}

async function createActor(entry, index, total) {
  const model = await loadBedrockModel(entry.path);
  const anims = await loadAnimation(entry.path);

  // Ground the model
  const scale = entry.scale || 0.08;
  model.root.scale.setScalar(scale);
  model.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model.root);
  const lift = -box.min.y + (entry.yOffset || 0);

  const pivot = new THREE.Group();
  model.root.position.y = lift;
  pivot.add(model.root);

  // Face -Z initially (stage forward)
  pivot.rotation.y = Math.PI;

  const wrapper = new THREE.Group();
  wrapper.add(pivot);
  wrapper.userData.actorId = entry.id;

  // Start positions in a loose arc
  const angle = (index / Math.max(total, 1)) * Math.PI * 1.2 - Math.PI * 0.6;
  const radius = 2.2 + index * 0.15;
  wrapper.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius * 0.7);

  // Selection glow ring under feet
  const glow = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 0.48, 32),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(entry.color || '#3ec8ff'),
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
    })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.02;
  wrapper.add(glow);

  // Cache base local positions for bones
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
  let mode = 'walk';
  let actionUntil = 0;
  let heading = Math.random() * Math.PI * 2;
  let speed = 0.55 + Math.random() * 0.25;
  let turnTimer = 1 + Math.random() * 2;
  let phase = Math.random() * Math.PI * 2;

  const bones = model.bones;

  function resetBoneRots() {
    for (const bone of Object.values(bones)) {
      const b = bone.userData.baseRot;
      if (b) bone.rotation.set(b.x, b.y, b.z);
      if (bone.userData.baseLocal) {
        bone.position.copy(bone.userData.baseLocal);
      }
    }
  }

  function applyProceduralWalk(t, amount = 1) {
    const swing = Math.sin(t * 6 + phase) * amount;
    const swing2 = Math.sin(t * 6 + phase + Math.PI) * amount;
    const bob = Math.abs(Math.sin(t * 6 + phase)) * 0.08 * amount;

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
        body.position.y = body.userData.baseLocal.y + bob * (1 / (entry.scale || 0.08)) * 0.15;
      }
    }
    if (head) head.rotation.y = swing * 0.08;
    if (tail) tail.rotation.y = swing2 * 0.25;
    if (jaw) jaw.rotation.x = 0.05 + Math.max(0, swing) * 0.08;

    // Weapon float when held
    const weapon = bones.weapon || bones.grip || bones.chassis;
    if (weapon && entry.kind === 'weapon') {
      /* handled on wrapper */
    }
  }

  function applyProceduralIdle(t) {
    const s = Math.sin(t * 1.4 + phase) * 0.04;
    const body = bones.body || bones.torso || bones.pelvis || bones.root;
    const head = bones.head;
    if (body) body.rotation.y = s * 8 * DEG;
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

      // Base Bedrock idle sway
      if (idleDef && active !== 'action') {
        sampleBedrockAnimation(idleDef, bones, t);
      }
      if (active === 'action' && actionDef) {
        sampleBedrockAnimation(actionDef, bones, Math.max(0, 1.2 - (actionUntil - now)));
      }

      if (entry.kind === 'weapon') {
        // Float and slow spin in place
        pivot.position.y = Math.sin(t * 1.5 + phase) * 0.12 + 0.15;
        pivot.rotation.y += dt * 0.55;
        pivot.rotation.z = Math.sin(t * 1.2 + phase) * 0.08;
        applyProceduralIdle(t);
        glow.material.opacity = Math.max(glow.material.opacity * 0.92, 0.15);
        return;
      }

      if (active === 'walk' && entry.canWalk) {
        applyProceduralWalk(t, 1);
        // roam
        turnTimer -= dt;
        if (turnTimer <= 0) {
          heading += (Math.random() - 0.5) * 1.4;
          turnTimer = 1.4 + Math.random() * 2.4;
          speed = 0.5 + Math.random() * 0.35;
        }
        const vx = Math.sin(heading) * speed * dt;
        const vz = Math.cos(heading) * speed * dt;
        wrapper.position.x += vx;
        wrapper.position.z += vz;

        // stay in arena
        const r = Math.hypot(wrapper.position.x, wrapper.position.z);
        if (r > 3.8) {
          heading = Math.atan2(-wrapper.position.x, -wrapper.position.z) + (Math.random() - 0.5) * 0.5;
          wrapper.position.multiplyScalar(3.6 / r);
        }

        // face movement direction (model faces -Z after π)
        const face = Math.atan2(vx, vz);
        wrapper.rotation.y = THREE.MathUtils.lerp(wrapper.rotation.y, face, 0.12);
      } else if (active === 'idle') {
        applyProceduralIdle(t);
      } else if (active === 'action') {
        // extra punchy lean
        const body = bones.body || bones.torso;
        if (body) body.rotation.x = -0.15;
        if (bones.arm_r) bones.arm_r.rotation.x = -0.8;
        if (bones.jaw) bones.jaw.rotation.x = 0.35;
      }

      // focus glow pulse
      if (glow.material.opacity > 0.05) {
        glow.material.opacity = 0.35 + Math.sin(t * 4) * 0.15;
        glow.scale.setScalar(1 + Math.sin(t * 4) * 0.05);
      }
    },
  };

  // tag meshes for picking
  wrapper.traverse((o) => {
    o.userData.actorId = entry.id;
  });

  return actor;
}
