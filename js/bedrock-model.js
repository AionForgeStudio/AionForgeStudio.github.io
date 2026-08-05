/**
 * Bedrock geometry.geo.json → Three.js loader.
 * Builds bone hierarchies with textured cubes (per-face UVs).
 */
import * as THREE from './vendor/three.module.js';

const DEG = Math.PI / 180;

/** Bedrock face → BoxGeometry group index (right, left, top, bottom, front, back) */
const FACE_MAP = {
  east: 0,  // +X
  west: 1,  // -X
  up: 2,    // +Y
  down: 3,  // -Y
  south: 4, // +Z
  north: 5, // -Z
};

function setFaceUVs(uvAttr, groupIndex, uv, texW, texH) {
  const i0 = groupIndex * 4;
  let u0; let v0; let u1; let v1;
  if (Array.isArray(uv)) {
    u0 = uv[0]; v0 = uv[1]; u1 = uv[0] + (uv[2] || 0); v1 = uv[1] + (uv[3] || 0);
  } else if (uv && typeof uv === 'object' && Array.isArray(uv.uv)) {
    [u0, v0, u1, v1] = uv.uv;
  } else {
    return;
  }
  // Bedrock: v=0 is top of texture. Three with flipY=true expects v=0 at bottom.
  const su0 = u0 / texW;
  const su1 = u1 / texW;
  const sv0 = 1 - v0 / texH;
  const sv1 = 1 - v1 / texH;
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
  const sx = Math.max(Math.abs(size[0]), 0.001);
  const sy = Math.max(Math.abs(size[1]), 0.001);
  const sz = Math.max(Math.abs(size[2]), 0.001);

  const geo = new THREE.BoxGeometry(sx, sy, sz);
  const uvAttr = geo.attributes.uv;
  const faceUV = cube.uv || {};

  if (faceUV && typeof faceUV === 'object' && !Array.isArray(faceUV)) {
    for (const [face, group] of Object.entries(FACE_MAP)) {
      const u = faceUV[face];
      if (u) setFaceUVs(uvAttr, group, u, texW, texH);
    }
  } else if (Array.isArray(faceUV)) {
    const fake = { uv: [faceUV[0], faceUV[1], faceUV[0] + Math.min(sx, 8), faceUV[1] + Math.min(sy, 8)] };
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

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (tex) => resolve(tex),
      undefined,
      (err) => reject(err || new Error(`Texture failed: ${url}`))
    );
  });
}

/**
 * Load a Bedrock geo + texture into a Group with bone map.
 */
export async function loadBedrockModel(basePath, { texFilter = THREE.NearestFilter } = {}) {
  const geoUrl = `${basePath}/geo.json`;
  const texUrl = `${basePath}/texture.png`;

  const geoRes = await fetch(geoUrl);
  if (!geoRes.ok) throw new Error(`Failed to fetch ${geoUrl} (${geoRes.status})`);
  const geoJson = await geoRes.json();
  const tex = await loadTexture(texUrl);

  tex.magFilter = texFilter;
  tex.minFilter = texFilter;
  tex.generateMipmaps = false;
  if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
  else if ('encoding' in tex) tex.encoding = THREE.sRGBEncoding;
  tex.flipY = true;
  tex.needsUpdate = true;

  const geomList = geoJson['minecraft:geometry'] || [];
  if (!geomList.length) throw new Error(`No geometry in ${geoUrl}`);
  const g = geomList[0];
  const desc = g.description || {};
  const texW = desc.texture_width || 32;
  const texH = desc.texture_height || 32;
  const bonesData = g.bones || [];

  const material = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.68,
    metalness: 0.12,
    side: THREE.DoubleSide,
  });

  /** @type {Record<string, THREE.Group>} */
  const bones = {};
  const root = new THREE.Group();
  root.name = desc.identifier || 'bedrock_model';

  for (const b of bonesData) {
    const group = new THREE.Group();
    group.name = b.name;
    bones[b.name] = group;
  }

  for (const b of bonesData) {
    const group = bones[b.name];
    const pivot = b.pivot || [0, 0, 0];
    group.userData.pivot = pivot.slice();
    group.userData.bindRotation = (b.rotation || [0, 0, 0]).map((d) => d * DEG);

    if (b.rotation) {
      group.rotation.set(b.rotation[0] * DEG, b.rotation[1] * DEG, b.rotation[2] * DEG);
    }

    for (const cube of b.cubes || []) {
      const mesh = makeCubeMesh(cube, material, texW, texH);
      mesh.position.x -= pivot[0];
      mesh.position.y -= pivot[1];
      mesh.position.z -= pivot[2];
      group.add(mesh);
    }

    const parentName = b.parent;
    if (parentName && bones[parentName]) {
      const parent = bones[parentName];
      const pp = parent.userData.pivot || [0, 0, 0];
      group.position.set(pivot[0] - pp[0], pivot[1] - pp[1], pivot[2] - pp[2]);
      parent.add(group);
    } else {
      group.position.set(pivot[0], pivot[1], pivot[2]);
      root.add(group);
    }
  }

  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);

  if (!Number.isFinite(size.y) || size.y < 0.001) {
    console.warn('Model bounds look empty', basePath, size);
  }

  return {
    root,
    bones,
    height: size.y,
    minY: box.min.y,
    size,
    material,
    identifier: desc.identifier,
  };
}

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
      const r = sampleChannel(channels.rotation, t);
      if (r) {
        bone.rotation.x = r[0] * DEG;
        bone.rotation.y = r[1] * DEG;
        bone.rotation.z = r[2] * DEG;
      }
    }
    if (channels.position) {
      const p = sampleChannel(channels.position, t);
      if (p) {
        if (!bone.userData.baseLocal) bone.userData.baseLocal = bone.position.clone();
        const bpos = bone.userData.baseLocal;
        bone.position.set(bpos.x + p[0], bpos.y + p[1], bpos.z + p[2]);
      }
    }
  }
}

function sampleChannel(channel, t) {
  if (Array.isArray(channel)) return channel;
  if (typeof channel !== 'object' || !channel) return null;

  // Bedrock keyframe keys may be "0.0" or 0
  const keys = Object.keys(channel)
    .map((k) => ({ raw: k, t: parseFloat(k) }))
    .filter((k) => !Number.isNaN(k.t))
    .sort((a, b) => a.t - b.t);
  if (!keys.length) return null;

  const get = (entry) => resolveKF(channel[entry.raw]);

  if (t <= keys[0].t) return get(keys[0]);
  if (t >= keys[keys.length - 1].t) return get(keys[keys.length - 1]);

  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t < t) i += 1;
  const a = get(keys[i]);
  const b = get(keys[i + 1]);
  if (!a || !b) return a || b;
  const u = (t - keys[i].t) / Math.max(keys[i + 1].t - keys[i].t, 1e-6);
  return [
    a[0] + (b[0] - a[0]) * u,
    a[1] + (b[1] - a[1]) * u,
    a[2] + (b[2] - a[2]) * u,
  ];
}

function resolveKF(v) {
  if (!v) return null;
  if (Array.isArray(v)) return v.map(Number);
  if (Array.isArray(v.post)) return v.post.map(Number);
  if (Array.isArray(v.pre)) return v.pre.map(Number);
  return null;
}

export async function loadAnimation(basePath) {
  try {
    const res = await fetch(`${basePath}/animation.json`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.animations || {};
  } catch {
    return null;
  }
}
