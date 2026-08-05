/**
 * Minimal Bedrock geometry.geo.json → Three.js loader.
 * Builds bone hierarchies with textured cubes (per-face UVs).
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const DEG = Math.PI / 180;

/** Bedrock face → BoxGeometry group index (right,left,top,bottom,front,back) */
const FACE_MAP = {
  east: 0,  // +X
  west: 1,  // -X
  up: 2,    // +Y
  down: 3,  // -Y
  south: 4, // +Z
  north: 5, // -Z
};

function setFaceUVs(uvAttr, groupIndex, uv, texW, texH) {
  // Each face has 4 verts * 2 floats, starting at groupIndex * 4
  // BoxGeometry default: each face 4 vertices
  const i0 = groupIndex * 4;
  let u0, v0, u1, v1;
  if (Array.isArray(uv)) {
    // [u, v, w, h] box UV style (rare here)
    u0 = uv[0]; v0 = uv[1]; u1 = uv[0] + (uv[2] || 0); v1 = uv[1] + (uv[3] || 0);
  } else if (uv && typeof uv === 'object' && 'uv' in uv) {
    [u0, v0, u1, v1] = uv.uv;
  } else if (uv && Array.isArray(uv.uv)) {
    [u0, v0, u1, v1] = uv.uv;
  } else {
    return;
  }
  // Bedrock pixel coords → 0..1; V is top-down in MC, Three is bottom-up
  const su0 = u0 / texW;
  const su1 = u1 / texW;
  const sv0 = 1 - v0 / texH;
  const sv1 = 1 - v1 / texH;
  // Triangle strip order for BoxGeometry faces: (0,1),(1,1),(0,0),(1,0) roughly
  // three.js BoxGeometry UV order per face: bl, br, tl, tr in some versions —
  // use corners: (su0,sv1),(su1,sv1),(su0,sv0),(su1,sv0)
  const corners = [
    [su0, sv1],
    [su1, sv1],
    [su0, sv0],
    [su1, sv0],
  ];
  for (let i = 0; i < 4; i++) {
    uvAttr.setXY(i0 + i, corners[i][0], corners[i][1]);
  }
}

function makeCubeMesh(cube, material, texW, texH) {
  const origin = cube.origin || [0, 0, 0];
  const size = cube.size || [1, 1, 1];
  const sx = Math.max(size[0], 0.001);
  const sy = Math.max(size[1], 0.001);
  const sz = Math.max(size[2], 0.001);

  const geo = new THREE.BoxGeometry(sx, sy, sz);
  const uvAttr = geo.attributes.uv;

  const faceUV = cube.uv || {};
  if (faceUV && typeof faceUV === 'object' && !Array.isArray(faceUV)) {
    for (const [face, group] of Object.entries(FACE_MAP)) {
      const u = faceUV[face];
      if (u) setFaceUVs(uvAttr, group, u, texW, texH);
    }
  } else if (Array.isArray(faceUV)) {
    // box_uv [u,v] — paint all faces with a small tile
    const fake = { uv: [faceUV[0], faceUV[1], faceUV[0] + sx, faceUV[1] + sy] };
    for (let g = 0; g < 6; g++) setFaceUVs(uvAttr, g, fake, texW, texH);
  }
  uvAttr.needsUpdate = true;

  const mesh = new THREE.Mesh(geo, material);
  // Bedrock origin is min-corner; BoxGeometry is centered
  mesh.position.set(
    origin[0] + sx / 2,
    origin[1] + sy / 2,
    origin[2] + sz / 2
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Load a Bedrock geo + texture into a Group with bone map.
 * @returns {Promise<{root: THREE.Group, bones: Record<string, THREE.Group>, height: number}>}
 */
export async function loadBedrockModel(basePath, { texFilter = THREE.NearestFilter } = {}) {
  const [geoRes, tex] = await Promise.all([
    fetch(`${basePath}/geo.json`).then((r) => r.json()),
    new THREE.TextureLoader().loadAsync(`${basePath}/texture.png`),
  ]);

  tex.magFilter = texFilter;
  tex.minFilter = texFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = true; // Three default; Bedrock v=0 is top → invert below

  const geomList = geoRes['minecraft:geometry'] || [];
  if (!geomList.length) throw new Error(`No geometry in ${basePath}/geo.json`);
  const g = geomList[0];
  const desc = g.description || {};
  const texW = desc.texture_width || 32;
  const texH = desc.texture_height || 32;
  const bonesData = g.bones || [];

  const material = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.72,
    metalness: 0.18,
    side: THREE.FrontSide,
  });

  /** @type {Record<string, THREE.Group>} */
  const bones = {};
  const root = new THREE.Group();
  root.name = desc.identifier || 'bedrock_model';

  // Create empty groups first
  for (const b of bonesData) {
    const group = new THREE.Group();
    group.name = b.name;
    bones[b.name] = group;
  }

  // Parent + pivot
  for (const b of bonesData) {
    const group = bones[b.name];
    const pivot = b.pivot || [0, 0, 0];
    // Store pivot for animation (Bedrock anim rotates around pivot)
    group.userData.pivot = pivot.slice();
    group.userData.bindRotation = (b.rotation || [0, 0, 0]).map((d) => d * DEG);

    // Place group at pivot; cubes will be offset relative to pivot
    group.position.set(pivot[0], pivot[1], pivot[2]);
    if (b.rotation) {
      group.rotation.set(b.rotation[0] * DEG, b.rotation[1] * DEG, b.rotation[2] * DEG);
    }

    // Cubes relative to bone pivot
    for (const cube of b.cubes || []) {
      const mesh = makeCubeMesh(cube, material, texW, texH);
      // convert absolute cube origin → relative to pivot
      mesh.position.x -= pivot[0];
      mesh.position.y -= pivot[1];
      mesh.position.z -= pivot[2];
      group.add(mesh);
    }

    const parentName = b.parent;
    if (parentName && bones[parentName]) {
      const parent = bones[parentName];
      const pp = parent.userData.pivot || [0, 0, 0];
      // Child group world pivot → local to parent
      group.position.set(pivot[0] - pp[0], pivot[1] - pp[1], pivot[2] - pp[2]);
      parent.add(group);
    } else {
      // Root-level bone
      root.add(group);
    }
  }

  // Prefer named root bone as visual root if present
  // (already parented under `root` group)

  // Measure height for grounding
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const min = box.min;

  return {
    root,
    bones,
    height: size.y,
    minY: min.y,
    size,
    material,
    identifier: desc.identifier,
  };
}

/**
 * Apply Bedrock keyframe animation (rotation degrees) for time t.
 * Missing walk channels are left alone so procedural walk can fill them.
 */
export function sampleBedrockAnimation(animDef, bones, timeSec) {
  if (!animDef || !animDef.bones) return;
  const length = animDef.animation_length || 1;
  const loop = animDef.loop !== false;
  let t = timeSec;
  if (loop && length > 0) t = ((t % length) + length) % length;

  for (const [boneName, channels] of Object.entries(animDef.bones)) {
    const bone = bones[boneName];
    if (!bone) continue;

    if (channels.rotation) {
      const r = sampleChannel(channels.rotation, t, length);
      if (r) {
        bone.rotation.x = r[0] * DEG;
        bone.rotation.y = r[1] * DEG;
        bone.rotation.z = r[2] * DEG;
      }
    }
    if (channels.position) {
      const p = sampleChannel(channels.position, t, length);
      if (p) {
        const pivot = bone.userData.pivot || [0, 0, 0];
        const parent = bone.parent;
        const base = bone.userData.baseLocal || null;
        if (!base) {
          bone.userData.baseLocal = bone.position.clone();
        }
        const bpos = bone.userData.baseLocal;
        bone.position.set(bpos.x + p[0], bpos.y + p[1], bpos.z + p[2]);
      }
    }
  }
}

function sampleChannel(channel, t, length) {
  if (Array.isArray(channel)) return channel;
  if (typeof channel !== 'object') return null;
  const keys = Object.keys(channel)
    .map(parseFloat)
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  if (!keys.length) return null;
  if (t <= keys[0]) return resolveKF(channel[String(keys[0])] ?? channel[keys[0]]);
  if (t >= keys[keys.length - 1]) {
    const k = keys[keys.length - 1];
    return resolveKF(channel[String(k)] ?? channel[k]);
  }
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1] < t) i++;
  const t0 = keys[i];
  const t1 = keys[i + 1];
  const a = resolveKF(channel[String(t0)] ?? channel[t0]);
  const b = resolveKF(channel[String(t1)] ?? channel[t1]);
  if (!a || !b) return a || b;
  const u = (t - t0) / Math.max(t1 - t0, 1e-6);
  return [
    a[0] + (b[0] - a[0]) * u,
    a[1] + (b[1] - a[1]) * u,
    a[2] + (b[2] - a[2]) * u,
  ];
}

function resolveKF(v) {
  if (!v) return null;
  if (Array.isArray(v)) return v;
  if (v.post && Array.isArray(v.post)) return v.post;
  if (v.pre && Array.isArray(v.pre)) return v.pre;
  return null;
}

export async function loadAnimation(basePath) {
  const res = await fetch(`${basePath}/animation.json`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.animations || {};
}
