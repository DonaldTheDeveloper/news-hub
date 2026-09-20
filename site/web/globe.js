// Three.js scenes for News Hub: a news globe and an immersive story wall.
import * as THREE from 'three';

const DEG = Math.PI / 180;
export const TOPIC_COLORS = {
  world: '#7aa2ff', politics: '#ff7a90', business: '#ffd166', tech: '#5ee0ff', science: '#a58bff',
  health: '#6ee7a8', sports: '#ff9f5a', entertainment: '#ff7ae0', environment: '#7be07b', culture: '#e2c08d',
};

/** lat/lon (degrees) -> point on a sphere, matching THREE.SphereGeometry's texture layout. */
export function latLonToVec3(lat, lon, r = 1, out = new THREE.Vector3()) {
  const th = (90 - lat) * DEG, ph = (lon + 180) * DEG;
  return out.set(-r * Math.cos(ph) * Math.sin(th), r * Math.cos(th), r * Math.sin(ph) * Math.sin(th));
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export class NewsScene {
  constructor(container, world, countriesMeta) {
    this.container = container;
    this.meta = countriesMeta;
    this.handlers = {};
    this.mode = 'globe';
    this.autoRotate = true;
    this.showLabels = true;
    this.heat = {};
    this.topicOf = {};
    this.selected = new Set();
    this.hovered = null;
    this.idle = 0;
    this.pins = [];
    this.cards = [];
    this.dragging = null;
    this.velocity = new THREE.Vector2();
    this.clock = new THREE.Clock();
    this._prepareCountries(world);
    this._initRenderer();
    this._buildGlobe();
    this._buildWall();
    this._bindEvents();
    this.setMode('globe');
    this._loop();
  }

  on(name, fn) { this.handlers[name] = fn; }
  emit(name, ...a) { if (this.handlers[name]) this.handlers[name](...a); }

  // ------------------------------------------------------------------ setup
  _prepareCountries(world) {
    this.features = [];
    for (const f of world.features) {
      const p = f.properties;
      let iso = p.ISO_A2_EH && p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH : ({ 'N. Cyprus': 'XC', Somaliland: 'XS', Kosovo: 'XK' }[p.NAME] || null);
      const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
      let minx = 999, maxx = -999, miny = 999, maxy = -999;
      for (const poly of polys) for (const [x, y] of poly[0]) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
      this.features.push({ iso, name: p.NAME, polys, bbox: [minx, miny, maxx, maxy] });
    }
  }

  _initRenderer() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x050a18, 1);
    this.container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.05, 200);
    this.zoom = 1;                 // user zoom factor (pinch / wheel)
    this.inset = 0; this.insetBottom = 0;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(-9, -9);

    // stars
    const n = 1800, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 40 + Math.random() * 60, th = Math.acos(2 * Math.random() - 1), ph = Math.random() * Math.PI * 2;
      pos.set([r * Math.sin(th) * Math.cos(ph), r * Math.cos(th), r * Math.sin(th) * Math.sin(ph)], i * 3);
      const c = 0.55 + Math.random() * 0.45;
      col.set([c, c, 0.8 + 0.2 * Math.random()], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ size: 0.28, vertexColors: true, transparent: true, opacity: 0.9, sizeAttenuation: true }));
    this.scene.add(this.stars);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(4, 2.5, 5);
    this.scene.add(sun);
    new ResizeObserver(() => this.resize()).observe(this.container);
  }

  _buildGlobe() {
    this.globe = new THREE.Group();
    this.scene.add(this.globe);
    // main texture (land, borders, heat)
    this.tex = document.createElement('canvas');
    const small = Math.min(window.innerWidth, window.innerHeight) < 700;      // phones: a lighter texture
    this.tex.width = small ? 2048 : 4096; this.tex.height = small ? 1024 : 2048;
    this.texture = new THREE.CanvasTexture(this.tex);
    this.texture.anisotropy = 8;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96),
      new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.85, metalness: 0.0 }));
    this.globe.add(this.earth);
    // outlines for hover / selection
    this.ov = document.createElement('canvas');
    this.ov.width = 2048; this.ov.height = 1024;
    this.ovTexture = new THREE.CanvasTexture(this.ov);
    this.ovTexture.colorSpace = THREE.SRGBColorSpace;
    this.overlay = new THREE.Mesh(new THREE.SphereGeometry(1.002, 96, 64),
      new THREE.MeshBasicMaterial({ map: this.ovTexture, transparent: true, depthWrite: false }));
    this.globe.add(this.overlay);
    // atmosphere
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.09, 64, 48), new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
      uniforms: { c: { value: new THREE.Color(0x4b8dff) } },
      vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix*normal); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} ',
      fragmentShader: 'varying vec3 vN; uniform vec3 c; void main(){ float i = pow(0.72 - dot(vN, vec3(0.0,0.0,1.0)), 3.0); gl_FragColor = vec4(c, 1.0) * i; }',
    }));
    this.scene.add(atmo);
    this.pinGroup = new THREE.Group();
    this.globe.add(this.pinGroup);
    this.globe.rotation.set(0.35, -1.2, 0);
    this.paint();
  }

  // paints ocean + countries (+ heat) into the main texture
  paint() {
    const ctx = this.tex.getContext('2d'), W = this.tex.width, H = this.tex.height;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0a1a3a'); g.addColorStop(0.5, '#0b2148'); g.addColorStop(1, '#0a1a3a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(120,170,255,0.07)'; ctx.lineWidth = 2;
    for (let lon = -180; lon <= 180; lon += 30) { const x = (lon + 180) / 360 * W; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let lat = -60; lat <= 60; lat += 30) { const y = (90 - lat) / 180 * H; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    const max = Math.max(1, ...Object.values(this.heat));
    for (const f of this.features) {
      const h = f.iso ? (this.heat[f.iso] || 0) : 0;
      const t = h ? Math.pow(h / max, 0.55) : 0;
      ctx.fillStyle = this._heatColor(t);
      ctx.strokeStyle = t ? 'rgba(160,220,255,0.55)' : 'rgba(90,140,210,0.45)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      for (const poly of f.polys) for (const ring of poly) {
        ring.forEach(([lon, lat], i) => { const x = (lon + 180) / 360 * W, y = (90 - lat) / 180 * H; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.closePath();
      }
      ctx.fill('evenodd'); ctx.stroke();
    }
    this.texture.needsUpdate = true;
  }

  _heatColor(t) {
    const stops = [[0, [24, 48, 86]], [0.25, [28, 84, 132]], [0.55, [30, 150, 170]], [0.8, [90, 205, 150]], [1, [255, 209, 102]]];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, c0] = stops[i - 1], [t1, c1] = stops[i], k = (t - t0) / (t1 - t0);
        return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(',')})`;
      }
    }
    return 'rgb(255,209,102)';
  }

  paintOverlay() {
    const ctx = this.ov.getContext('2d'), W = this.ov.width, H = this.ov.height;
    ctx.clearRect(0, 0, W, H);
    const draw = (iso, stroke, fill, lw) => {
      for (const f of this.features) {
        if (f.iso !== iso) continue;
        ctx.beginPath();
        for (const poly of f.polys) for (const ring of poly) {
          ring.forEach(([lon, lat], i) => { const x = (lon + 180) / 360 * W, y = (90 - lat) / 180 * H; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
          ctx.closePath();
        }
        if (fill) { ctx.fillStyle = fill; ctx.fill('evenodd'); }
        ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke();
      }
    };
    for (const iso of this.selected) draw(iso, '#ffd166', 'rgba(255,209,102,0.22)', 3);
    if (this.hovered && !this.selected.has(this.hovered)) draw(this.hovered, '#ffffff', 'rgba(255,255,255,0.14)', 2.5);
    this.ovTexture.needsUpdate = true;
  }

  // ------------------------------------------------------------------ data
  setHeat(heat, topicOf) {
    this.heat = heat || {};
    this.topicOf = topicOf || {};
    this.paint();
    this._buildPins();
  }

  setSelected(isos) {
    this.selected = new Set(isos);
    this.paintOverlay();
    if (isos.length === 1) this.focusCountry(isos[0]);
  }

  _buildPins() {
    for (const p of this.pins) { this.pinGroup.remove(p.group); p.group.traverse(o => { o.geometry && o.geometry.dispose(); o.material && o.material.dispose(); }); }
    this.pins = [];
    const labels = document.getElementById('labels');
    labels.innerHTML = '';
    const list = Object.entries(this.heat).filter(([iso]) => this.meta[iso]).sort((a, b) => b[1] - a[1]).slice(0, 46);
    const max = list.length ? list[0][1] : 1;
    list.forEach(([iso, n], rank) => {
      const m = this.meta[iso];
      const color = new THREE.Color(TOPIC_COLORS[this.topicOf[iso]] || '#7aa2ff');
      const h = 0.04 + 0.2 * Math.pow(n / max, 0.6);
      const group = new THREE.Group();
      const base = latLonToVec3(m.lat, m.lon, 1.0);
      group.position.copy(base);
      group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), base.clone().normalize());
      const spike = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.007, h, 10),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 }));
      spike.position.y = h / 2;
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.011 + 0.007 * Math.min(3, n / 8), 14, 10),
        new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.9 }));
      tip.position.y = h;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.02, 0.026, 40),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.004;
      group.add(spike, tip, ring);
      group.userData = { iso };
      spike.userData.iso = iso; tip.userData.iso = iso;
      this.pinGroup.add(group);
      const pin = { group, ring, tip, iso, n, h, base, phase: rank * 0.7, label: null };
      if (rank < 9) {
        const el = document.createElement('div');
        el.className = 'pinlabel';
        el.innerHTML = `<b></b><span></span>`;
        el.firstChild.textContent = m.name; el.lastChild.textContent = n;
        el.onclick = () => this.emit('country-click', iso);
        labels.appendChild(el);
        pin.label = el;
      }
      this.pins.push(pin);
    });
  }

  focusCountry(iso) {
    const m = this.meta[iso];
    if (!m || this.mode !== 'globe') return;
    const target = new THREE.Quaternion().setFromUnitVectors(latLonToVec3(m.lat, m.lon, 1).normalize(), new THREE.Vector3(0, 0, 1));
    this.focus = { q: target, t: 0 };
    this.idle = -4;
  }

  // ------------------------------------------------------------------ wall mode
  _buildWall() {
    this.wall = new THREE.Group();
    this.scene.add(this.wall);
    this.wallYaw = 0; this.wallPitch = 0;
    this.wallTextures = [];
  }

  setItems(items, titleFor) {
    this.items = items;
    this.titleFor = titleFor || (it => it.title);
    if (this.mode === 'wall') this._layoutWall();
    else this.wallDirty = true;
  }

  refreshCards() { if (this.cards.length) this._layoutWall(true); }

  _layoutWall(keepView) {
    for (const c of this.cards) { this.wall.remove(c.mesh); c.mesh.material.map.dispose(); c.mesh.material.dispose(); c.mesh.geometry.dispose(); }
    this.cards = [];
    const items = (this.items || []).slice(0, 51), rows = 3, perRow = 17, R = 4.3, step = (Math.PI * 2) / perRow;
    items.forEach((it, i) => {
      const row = i % rows, col = Math.floor(i / rows);
      const ang = col * step, y = (1 - row) * 1.12;
      const tex = this._cardTexture(it, this.titleFor(it));
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.06), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
      mesh.position.set(Math.sin(ang) * R, y, -Math.cos(ang) * R);
      mesh.lookAt(0, y, 0);
      mesh.userData = { id: it.id, item: it, base: mesh.position.clone(), scale: 1 };
      this.wall.add(mesh);
      this.cards.push({ mesh, id: it.id });
    });
    this.wallDirty = false;
  }

  _cardTexture(it, title) {
    const W = 680, H = 424, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const color = TOPIC_COLORS[it.topics[0]] || '#7aa2ff';
    const g = x.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#111c3a'); g.addColorStop(1, '#0a1226');
    x.fillStyle = g; this._roundRect(x, 0, 0, W, H, 26); x.fill();
    x.fillStyle = color; x.fillRect(0, 0, 14, H);
    x.strokeStyle = 'rgba(160,190,255,0.25)'; x.lineWidth = 3; this._roundRect(x, 1.5, 1.5, W - 3, H - 3, 26); x.stroke();
    x.textBaseline = 'alphabetic';
    const rtl = /[֐-ࣿ]/.test(title);
    x.direction = rtl ? 'rtl' : 'ltr';
    x.textAlign = rtl ? 'right' : 'left';
    const left = rtl ? W - 44 : 44;
    x.fillStyle = color; x.font = '600 24px "Segoe UI", "Noto Sans", sans-serif';
    x.fillText((it.topics[0] || 'world').toUpperCase(), left, 52);
    x.fillStyle = '#eaf0ff'; x.font = '700 35px "Segoe UI", "Noto Sans", "Noto Sans CJK", sans-serif';
    const lines = this._wrap(x, title, W - 96, 5);
    lines.forEach((l, i) => x.fillText(l, left, 108 + i * 45));
    x.fillStyle = '#9db0d6'; x.font = '500 23px "Segoe UI", sans-serif';
    x.direction = 'ltr'; x.textAlign = 'left';
    const ago = this._ago(it.published);
    x.fillText(`${it.source.name}  ·  ${ago}`, 44, H - 30);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    return tex;
  }

  _roundRect(x, px, py, w, h, r) {
    x.beginPath(); x.moveTo(px + r, py); x.arcTo(px + w, py, px + w, py + h, r); x.arcTo(px + w, py + h, px, py + h, r);
    x.arcTo(px, py + h, px, py, r); x.arcTo(px, py, px + w, py, r); x.closePath();
  }

  _wrap(ctx, text, maxW, maxLines) {
    const cjk = /[　-鿿가-힯]/.test(text);
    const words = cjk ? Array.from(text) : text.split(/\s+/);
    const lines = []; let cur = '';
    for (const w of words) {
      const test = cur ? (cjk ? cur + w : cur + ' ' + w) : w;
      if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; if (lines.length === maxLines) break; } else cur = test;
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    if (lines.length === maxLines && words.join('').length > lines.join('').length + 3) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S{0,3}$/, '') + '…';
    return lines;
  }

  _ago(ts) {
    const m = Math.max(1, Math.round((Date.now() / 1000 - ts) / 60));
    return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  }

  // ------------------------------------------------------------------ modes / interaction
  setMode(mode) {
    this.mode = mode;
    const globe = mode === 'globe';
    this.globe.visible = globe; this.overlay.visible = globe;
    this.scene.children.forEach(c => { if (c.material && c.material.type === 'ShaderMaterial') c.visible = globe; });
    this.wall.visible = !globe;
    document.getElementById('labels').style.display = globe && this.showLabels ? '' : 'none';
    if (!globe && (this.wallDirty || !this.cards.length)) this._layoutWall();
    this.camera.fov = globe ? 45 : (this.portrait ? 78 : 62);
    this.camera.updateProjectionMatrix();
    this.emit('mode', mode);
  }

  _bindEvents() {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';
    this.pointers = new Map();
    el.addEventListener('pointerdown', e => {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: this.zoom, fov: this.camera.fov }; this.dragging = null; return; }
      this.dragging = { x: e.clientX, y: e.clientY, moved: 0, id: e.pointerId }; el.setPointerCapture(e.pointerId); this.idle = 0;
    });
    el.addEventListener('pointermove', e => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.pointers.size === 2) {                       // two fingers: zoom
        const [a, b] = [...this.pointers.values()], k = this.pinch.d / Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
        if (this.mode === 'globe') this.zoom = Math.max(0.5, Math.min(1.9, this.pinch.z * k));
        else { this.camera.fov = Math.max(35, Math.min(100, this.pinch.fov * k)); this.camera.updateProjectionMatrix(); }
        this.idle = 0;
        return;
      }
      const r = el.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.mouse = { x: e.clientX, y: e.clientY };
      if (this.dragging) {
        const dx = e.clientX - this.dragging.x, dy = e.clientY - this.dragging.y;
        this.dragging.moved += Math.abs(dx) + Math.abs(dy);
        this.dragging.x = e.clientX; this.dragging.y = e.clientY;
        if (this.mode === 'globe') {
          const k = 0.0052 * this.zoom * this._baseDist() / 3.4;
          this.velocity.set(dx * k, dy * k);
          this._rotateGlobe(dx * k, dy * k);
          this.focus = null;
        } else {
          this.wallYaw -= dx * 0.0032; this.wallPitch = Math.max(-0.5, Math.min(0.5, this.wallPitch - dy * 0.0028));
        }
        this.idle = 0;
      }
    });
    const up = e => {
      this.pointers.delete(e.pointerId);
      if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; this.dragging = null; return; }
      const moved = this.dragging ? this.dragging.moved : 99;
      this.dragging = null;
      if (e.type === 'pointerup' && moved < 6) this._click();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', () => { this.pointer.set(-9, -9); this.hovered = null; this.emit('hover', null); this.paintOverlay(); });
    el.addEventListener('wheel', e => {
      e.preventDefault();
      if (this.mode === 'globe') this.zoom = Math.max(0.5, Math.min(1.9, this.zoom * (1 + e.deltaY * 0.0011)));
      else { this.camera.fov = Math.max(35, Math.min(85, this.camera.fov + e.deltaY * 0.03)); this.camera.updateProjectionMatrix(); }
      this.idle = 0;
    }, { passive: false });
  }

  _rotateGlobe(dx, dy) {
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx);
    const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy);
    this.globe.quaternion.premultiply(qy).premultiply(qx);
  }

  _pickGlobe() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const pinHits = this.raycaster.intersectObjects(this.pinGroup.children, true);
    if (pinHits.length && pinHits[0].object.userData.iso) return { iso: pinHits[0].object.userData.iso, pin: true };
    const hit = this.raycaster.intersectObject(this.earth, false)[0];
    if (!hit || !hit.uv) return null;
    const lon = hit.uv.x * 360 - 180, lat = hit.uv.y * 180 - 90;
    for (const f of this.features) {
      if (lon < f.bbox[0] || lon > f.bbox[2] || lat < f.bbox[1] || lat > f.bbox[3]) continue;
      for (const poly of f.polys) {
        if (pointInRing(lon, lat, poly[0]) && !poly.slice(1).some(h => pointInRing(lon, lat, h))) return { iso: f.iso, name: f.name };
      }
    }
    return null;
  }

  _click() {
    if (this.mode === 'globe') {
      const p = this._pickGlobe();
      if (p && p.iso) this.emit('country-click', p.iso);
    } else if (this.hoverCard) {
      this.emit('card-click', this.hoverCard.userData.item);
    }
  }

  /** Shift the view right by `px` so the scene is centred in the space beside the news panel. */
  setInset(px, bottom = 0) { this.inset = px || 0; this.insetBottom = bottom || 0; this.resize(); }

  /** Camera distance that fits the globe on this screen (narrow phones need to sit farther back). */
  _baseDist() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    const visibleH = Math.max(120, h - this.insetBottom), visibleW = Math.max(120, w - this.inset);
    const t = Math.tan(22.5 * DEG), r = 1.16;                      // globe radius + atmosphere margin
    // the camera frames the whole container; only the visibleW x visibleH part is free of panels
    const needW = r * h / (t * visibleW), needH = r * h / (t * visibleH);
    return Math.max(3.2, needW, needH);
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    const portrait = w / h < 0.85;
    if (portrait !== this.portrait) { this.portrait = portrait; if (this.mode === 'wall') this.camera.fov = portrait ? 78 : 62; }
    const dx = (this.inset || 0) / 2, dy = (this.insetBottom || 0) / 2;        // centre the scene in the free area
    if (dx > 0 || dy > 0) this.camera.setViewOffset(w, h, -dx, dy, w, h); else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ frame loop
  _loop() {
    const dt = Math.min(0.05, this.clock.getDelta()), t = this.clock.elapsedTime;
    this.idle += dt;
    this.stars.rotation.y += dt * 0.004;
    if (this.mode === 'globe') this._frameGlobe(dt, t); else this._frameWall(dt);
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(() => this._loop());
  }

  _frameGlobe(dt, t) {
    this.camera.position.set(0, 0, this._baseDist() * this.zoom);
    this.camera.lookAt(0, 0, 0);
    if (this.focus) {
      this.focus.t = Math.min(1, this.focus.t + dt * 1.6);
      this.globe.quaternion.slerp(this.focus.q, 0.09);
      if (this.focus.t >= 1 || this.globe.quaternion.angleTo(this.focus.q) < 0.002) this.focus = null;
    } else if (!this.dragging) {
      if (this.velocity.lengthSq() > 1e-8) { this._rotateGlobe(this.velocity.x, this.velocity.y); this.velocity.multiplyScalar(0.94); }
      else if (this.autoRotate && this.idle > 2.5 && !this.selected.size) this._rotateGlobe(dt * 0.06, 0);
    }
    // hover
    if (!this.dragging) {
      const p = this._pickGlobe();
      const iso = p && p.iso ? p.iso : null;
      if (iso !== this.hovered) {
        this.hovered = iso; this.paintOverlay();
        this.renderer.domElement.style.cursor = iso ? 'pointer' : 'grab';
        this.emit('hover', iso, p && p.name);
      }
    }
    for (const p of this.pins) {
      const s = 1 + 0.55 * ((t * 0.9 + p.phase) % 2.4) / 2.4;
      p.ring.scale.set(s * 1.5, s * 1.5, s * 1.5);
      p.ring.material.opacity = 0.6 * (1 - ((t * 0.9 + p.phase) % 2.4) / 2.4);
    }
    // labels
    if (this.showLabels) {
      const camDir = this.camera.position.clone().normalize(), v = new THREE.Vector3(), w = this.container.clientWidth, h = this.container.clientHeight;
      for (const p of this.pins) {
        if (!p.label) continue;
        v.copy(p.base).multiplyScalar(1 + p.h + 0.02);
        this.globe.localToWorld(v);
        const facing = v.clone().normalize().dot(camDir) > 0.15;
        v.project(this.camera);
        p.label.style.display = facing ? '' : 'none';
        p.label.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px) translate(-50%, -130%)`;
      }
    }
  }

  _frameWall(dt) {
    this.camera.position.set(0, 0, 0);
    this.camera.rotation.set(this.wallPitch, this.wallYaw, 0, 'YXZ');
    if (!this.dragging && this.autoRotate && this.idle > 3) this.wallYaw += dt * 0.03;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.cards.map(c => c.mesh), false);
    const hovered = hits.length ? hits[0].object : null;
    if (hovered !== this.hoverCard) {
      this.hoverCard = hovered;
      this.renderer.domElement.style.cursor = hovered ? 'pointer' : 'grab';
      this.emit('card-hover', hovered ? hovered.userData.item : null);
    }
    for (const c of this.cards) {
      const target = c.mesh === hovered ? 1.12 : 1;
      c.mesh.userData.scale += (target - c.mesh.userData.scale) * 0.18;
      c.mesh.scale.setScalar(c.mesh.userData.scale);
      const b = c.mesh.userData.base, k = c.mesh === hovered ? 0.94 : 1;
      c.mesh.position.set(b.x * k, b.y, b.z * k);
    }
  }
}
