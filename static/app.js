// Fanframe front end. Model: pick a show → pick an image slot → bring art in (a draft) → Save.
// All Jellyfin calls go through server.py.

const TYPES = {
  Backdrop: { label: "Backdrop", hint: "16:9", ratio: 16 / 9, max: [3840, 2160], minW: 1280, multi: true,
              where: "Big background on the show page and behind menus" },
  Primary:  { label: "Poster", hint: "2:3", ratio: 2 / 3, max: [2000, 3000], minW: 600,
              where: "Poster on library grids and the show page" },
  Thumb:    { label: "Thumb", hint: "16:9", ratio: 16 / 9, max: [1920, 1080], minW: 800,
              where: "Landscape cards (Continue Watching, some home rows)" },
  Logo:     { label: "Logo", hint: "free", ratio: NaN, max: [1600, 800], minW: 400, png: true,
              where: "Title logo drawn over the backdrop (transparent PNG)" },
  Banner:   { label: "Banner", hint: "5.4:1", ratio: 1000 / 185, max: [3000, 555], minW: 1000,
              where: "Wide strip; few clients use it" },
};
const TYPE_KEYS = Object.keys(TYPES);

const $ = (id) => document.getElementById(id);
const state = {
  data: { libraries: [], items: [] }, lib: "All", jellyfin: "",
  item: null, type: "Backdrop", images: [], slot: 0,
  draft: null,          // { itemId, type, slot, blob, url, dirty }
  cropper: null,
  remote: { key: "", list: [], provider: "All" },
  preview: false, log: [],
};

// ---------- helpers ----------
async function api(path, opts = {}) {
  // The server only accepts changes that carry this header (blocks cross-site requests).
  const r = await fetch(path, { ...opts, headers: { "X-Fanframe": "1", ...(opts.headers || {}) } });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.blob();
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const imgUrl = (id, type, idx, maxWidth, tag) =>
  `api/img/${id}/${type}/${idx}?${maxWidth ? `maxWidth=${maxWidth}&` : ""}${tag ? `tag=${tag}` : `t=${Date.now()}`}`;
const typeName = (t, plural) => TYPES[t].label.toLowerCase() + (plural ? "s" : "");
const slotName = (s) => (s === "new" ? "a new slot" : TYPES[state.type].multi ? `backdrop ${s + 1}` : `the ${typeName(state.type)}`);

// Toasts: info/good fade, errors stay until closed. Every message also goes to the Activity log.
function toast(msg, kind = "", action) {
  state.log.unshift({ t: new Date().toLocaleTimeString(), msg, kind });
  state.log.length = Math.min(state.log.length, 50);
  if (!$("log").hidden) renderLog();
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.onclick = () => { el.remove(); action.run(); };
    el.append(b);
  }
  const x = document.createElement("button");
  x.className = "x"; x.textContent = "×"; x.title = "Dismiss"; x.onclick = () => el.remove();
  el.append(x);
  $("toasts").prepend(el);
  while ($("toasts").children.length > 4) $("toasts").lastChild.remove();
  if (kind !== "bad") setTimeout(() => el.remove(), action ? 15000 : 4000);
}

// ---------- shows ----------
async function loadItems() {
  const ul = $("items");
  const keep = ul.scrollTop;
  state.data = await api("api/items");
  renderLibs();
  renderItems();
  ul.scrollTop = keep;
  if (state.item) state.item = state.data.items.find((i) => i.id === state.item.id) || state.item;
}

function renderLibs() {
  const libs = ["All", ...state.data.libraries];
  if (!libs.includes(state.lib)) state.lib = "All";
  $("libs").innerHTML = libs.map((l) => `<button type="button" data-lib="${esc(l)}" class="${l === state.lib ? "on" : ""}">${esc(l)}</button>`).join("");
}

function badges(i) {
  const out = [];
  if (i.custom.length) out.push(`<span class="badge done" title="Changed here: ${esc(i.custom.join(", "))}">✓ done</span>`);
  if (!i.backdrops.length) out.push(`<span class="badge none" title="No backdrop at all">∅ none</span>`);
  else if (i.bw && i.bw < 1280) out.push(`<span class="badge low" title="First backdrop is ${i.bw}px wide">⚠ ${i.bw}px</span>`);
  return out.join("");
}

function visibleItems() {
  const q = $("search").value.trim().toLowerCase();
  const f = $("filter").value;
  let list = state.data.items.filter((i) =>
    (state.lib === "All" || i.library === state.lib) &&
    (!q || i.name.toLowerCase().includes(q)) &&
    (f === "all" || (f === "todo" && !i.custom.length) || (f === "done" && i.custom.length) ||
     (f === "lowres" && i.bw && i.bw < 1280) || (f === "none" && !i.backdrops.length)));
  list = [...list].sort($("sort").value === "fewest"
    ? (a, b) => a.backdrops.length - b.backdrops.length || a.sort.localeCompare(b.sort)
    : (a, b) => a.sort.localeCompare(b.sort));
  return list;
}

function renderItems() {
  const list = visibleItems();
  $("count").textContent = `${list.length} of ${state.data.items.length}`;
  $("items").innerHTML = list.map((i) => {
    const thumb = i.backdrops.length
      ? `<img loading="lazy" src="${imgUrl(i.id, "Backdrop", 0, 180, i.backdrops[0])}" alt="">`
      : i.tags.Thumb ? `<img loading="lazy" src="${imgUrl(i.id, "Thumb", 0, 180, i.tags.Thumb)}" alt="">`
      : `<div class="noimg">∅</div>`;
    return `<li data-id="${i.id}" class="${state.item?.id === i.id ? "sel" : ""}">${thumb}
      <div><div class="name">${esc(i.name)}</div>
      <div class="meta"><span>${i.year || ""}${state.lib === "All" ? ` · ${esc(i.library)}` : ""}</span>${badges(i)}</div></div></li>`;
  }).join("") || `<li class="muted">Nothing matches.</li>`;
}

// ---------- drafts ----------
function confirmDiscard(why) {
  if (!state.draft?.dirty) return true;
  return confirm(`You've cropped an image that isn't saved yet.\n\n${why}`);
}

function dropDraft() {
  state.cropper?.destroy();
  state.cropper = null;
  if (state.draft) URL.revokeObjectURL(state.draft.url);
  state.draft = null;
  $("crop-img").removeAttribute("src");
}

// ---------- selecting ----------
function saveHash() {
  if (!state.item) return;
  history.replaceState(null, "", `#item=${state.item.id}&type=${state.type}`);
}

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  return { id: h.get("item"), type: TYPES[h.get("type")] ? h.get("type") : null };
}

async function select(item, scroll = true) {
  if (!item || item.id === state.item?.id) return;
  if (!confirmDiscard(`Switch to ${item.name} and throw the crop away?`)) return;
  dropDraft();
  state.item = item;
  state.slot = 0;
  $("empty").hidden = true;
  $("editor").hidden = false;
  $("title").textContent = item.year ? `${item.name} (${item.year})` : item.name;
  $("open-jf").href = `${state.jellyfin}/web/#/details?id=${item.id}`;
  document.querySelectorAll("#items li").forEach((li) => li.classList.toggle("sel", li.dataset.id === item.id));
  if (scroll) document.querySelector(`#items li[data-id="${item.id}"]`)?.scrollIntoView({ block: "nearest" });
  $("history").hidden = true;
  saveHash();
  await refreshImages();
  loadRemote();
}

async function refreshImages(keepSlot) {
  const { item } = state;
  const all = await api(`api/item/${item.id}/images`);
  if (state.item !== item) return;
  state.allImages = all;
  state.images = all.filter((i) => i.ImageType === state.type);
  const multi = TYPES[state.type].multi, n = state.images.length;
  let s = keepSlot ?? state.slot;
  if (s !== "new" && Number(s) >= n) s = n ? n - 1 : "new";
  if (!multi && s === "new") s = 0;
  state.slot = s === "new" ? s : Number(s);
  if (state.draft) state.draft.slot = state.slot;
  render();
}

function setType(type) {
  if (type === state.type) return;
  state.type = type;
  saveHash();
  // A draft keeps its image when the type changes (handy: backdrop art → poster); it just re-targets.
  if (state.draft) { state.draft.type = type; state.draft.slot = TYPES[type].multi ? "new" : 0; }
  state.slot = state.draft ? state.draft.slot : 0;
  if (state.cropper) state.cropper.setAspectRatio(TYPES[type].ratio);
  renderTypes();
  if (state.item) { refreshImages(state.slot); loadRemote(); }
}

function setSlot(slot) {
  if (state.draft && state.draft.slot !== slot) {
    // Moving the draft to another slot is fine; it's still for this show and type.
    state.draft.slot = slot;
  }
  state.slot = slot;
  render();
}

// ---------- rendering ----------
function renderTypes() {
  $("types").innerHTML = TYPE_KEYS.map((k, n) => {
    const t = TYPES[k];
    return `<button type="button" data-type="${k}" class="${k === state.type ? "on" : ""}" title="${esc(t.where)}  (${n + 1})">${t.label}<small>${t.hint}</small></button>`;
  }).join("");
}

function currentImage() {
  return typeof state.slot === "number" ? state.images[state.slot] : null;
}

function isLocked(img) { return !!img?.Locked; }

function render() {
  const t = TYPES[state.type];
  const img = currentImage();
  const d = state.draft;
  $("stage").classList.toggle("logo", state.type === "Logo");

  // Stage: the draft's cropper, or the selected image big, or an empty slot.
  $("crop-wrap").hidden = !d;
  $("view").hidden = !!d;
  if (!d) {
    $("view-img").hidden = !img;
    $("view-empty").hidden = !!img;
    if (img) {
      const src = imgUrl(state.item.id, state.type, img.ImageIndex ?? 0, 2400, img.ImageTag);
      if ($("view-img").dataset.src !== src) { $("view-img").src = src; $("view-img").dataset.src = src; }
    } else {
      $("view-img").removeAttribute("src"); $("view-img").dataset.src = "";
      $("view-empty-title").textContent = state.slot === "new" ? `Add a new ${typeName(state.type)}` : `No ${typeName(state.type)} yet`;
    }
  }
  const lock = img && isLocked(img);
  $("stage-lock").hidden = !lock;
  $("stage-lock").textContent = lock ? `🔒 This ${typeName(state.type)} is a file in the media folder, so it isn't changed from here (MEDIA_READONLY is on).` : "";

  // Bar
  $("draft-actions").hidden = !d;
  if (d) $("save").textContent = d.slot === "new" ? `Add as new ${typeName(state.type)}` : `Save to ${slotName(d.slot)}`;
  $("save").disabled = !!lock;
  updateInfo();
  renderPreview();
  renderFilm();
}

function renderFilm() {
  const t = TYPES[state.type];
  const id = state.item.id;
  const slots = state.images.map((img, n) => {
    const idx = img.ImageIndex ?? 0;
    const full = `api/img/${id}/${state.type}/${idx}${img.ImageTag ? `?tag=${img.ImageTag}` : ""}`;
    const lock = isLocked(img);
    const draftHere = state.draft && state.draft.slot === n;
    return `<div class="slot ${state.type === "Logo" ? "logo" : ""} ${state.slot === n ? "sel" : ""}" data-slot="${n}">
      <div class="thumb"><img src="${imgUrl(id, state.type, idx, 400, img.ImageTag)}" alt="">
        <span class="tag">${lock ? "🔒 " : ""}${t.multi ? `${n + 1}${n === 0 ? " ★ main" : ""} · ` : ""}${img.Width}×${img.Height}</span>
        ${draftHere ? `<span class="tag draft">draft</span>` : ""}</div>
      <div class="acts">
        ${t.multi ? `<button type="button" data-act="first" ${n === 0 || lock ? "disabled" : ""} title="Make this the main backdrop (F)">★ First</button>` : ""}
        <button type="button" data-act="recrop" title="Load the full-size original into the cropper">Recrop</button>
        <a href="${full}" download="${esc(state.item.name)} ${t.label} ${n + 1}" title="Save the full-size original to your PC">Save</a>
        <button type="button" data-act="delete" class="del" ${lock ? "disabled" : ""} title="Delete this image (Del)">Delete</button>
      </div></div>`;
  });
  const canAdd = t.multi || !state.images.length;
  if (canAdd) {
    const key = t.multi ? "new" : 0;
    const draftHere = state.draft && state.draft.slot === key;
    slots.push(`<div class="slot ${state.slot === key ? "sel" : ""}" data-slot="${key}">
      <div class="thumb"><div class="add"><b>+</b>${t.multi ? "Add a backdrop" : `Add a ${typeName(state.type)}`}</div>
      ${draftHere ? `<span class="tag draft">draft</span>` : ""}</div></div>`);
  }
  $("film").innerHTML = slots.join("");
}

function updateInfo() {
  const c = state.cropper;
  const img = currentImage();
  if (!c) {
    $("info").innerHTML = img ? `${TYPES[state.type].label}${TYPES[state.type].multi ? ` ${state.slot + 1} of ${state.images.length}` : ""} · ${img.Width}×${img.Height}` : "";
    return;
  }
  const data = c.getImageData();
  const cd = c.getData(true);
  if (!cd.width) return;
  const t = TYPES[state.type];
  const scale = Math.min(1, t.max[0] / cd.width, t.max[1] / cd.height);
  const outW = Math.round(cd.width * scale), outH = Math.round(cd.height * scale);
  const low = outW < t.minW;
  $("info").innerHTML = `Draft: source ${data.naturalWidth}×${data.naturalHeight} → saves <span class="${low ? "warn" : ""}">${outW}×${outH}${low ? " (low-res, will look soft on a TV)" : ""}</span>`;
}

// ---------- Jellyfin preview overlay ----------
function renderPreview() {
  const pv = $("preview");
  const show = state.preview && state.type === "Backdrop" && (state.draft || currentImage());
  pv.hidden = !show;
  if (!show) return;
  const logo = (state.allImages || []).find((i) => i.ImageType === "Logo");
  $("pv-logo").hidden = !logo;
  if (logo) $("pv-logo").src = imgUrl(state.item.id, "Logo", 0, 800, logo.ImageTag);
  $("pv-title").hidden = !!logo;
  $("pv-title").textContent = state.item.name;
  $("pv-meta").textContent = [state.item.year, state.item.library].filter(Boolean).join(" · ");
  positionPreview();
}

function positionPreview() {
  const pv = $("preview");
  if (pv.hidden) return;
  const stage = $("stage").getBoundingClientRect();
  let r;
  if (state.cropper) r = document.querySelector(".cropper-crop-box")?.getBoundingClientRect();
  else if ($("view-img").naturalWidth) r = $("view-img").getBoundingClientRect();
  if (!r || !r.width) return;
  Object.assign(pv.style, { left: `${r.left - stage.left}px`, top: `${r.top - stage.top}px`, width: `${r.width}px`, height: `${r.height}px` });
}

// ---------- bringing art in ----------
function startDraft(blob, label) {
  if (!state.item) return toast("Pick a show first.");
  if (!blob?.type?.startsWith("image/")) return toast("That isn't an image.", "bad");
  if (!confirmDiscard("Replace it with the new image?")) return;
  const img = currentImage();
  if (img && isLocked(img)) state.slot = TYPES[state.type].multi ? "new" : state.slot;
  dropDraft();
  state.draft = { itemId: state.item.id, type: state.type, slot: state.slot, blob, url: URL.createObjectURL(blob), dirty: false };
  render();
  const el = $("crop-img");
  el.src = state.draft.url;
  state.cropper = new Cropper(el, {
    aspectRatio: TYPES[state.type].ratio, viewMode: 1, autoCropArea: 1, dragMode: "move",
    background: false, toggleDragModeOnDblclick: false,
    ready: () => { updateInfo(); positionPreview(); },
    crop: () => { updateInfo(); positionPreview(); },
    cropstart: () => { if (state.draft) state.draft.dirty = true; },
    zoom: () => { if (state.draft) state.draft.dirty = true; },
  });
  if (label) toast(`Loaded ${label} into ${slotName(state.draft.slot)}.`);
}

async function loadUrl(url, label) {
  toast("Downloading image…");
  try {
    startDraft(await api(`api/fetch?url=${encodeURIComponent(url)}`), label || url.split("/").pop().split("?")[0]);
  } catch (e) {
    toast(`Couldn't download it: ${e.message}\nSave it to your PC and drop the file instead.`, "bad");
  }
}

function imageFromDataTransfer(dt) {
  const file = [...dt.files].find((f) => f.type.startsWith("image/"));
  if (file) return startDraft(file, file.name);
  // Dragged from a web page: prefer the <img src> in the HTML (the uri-list is often the link around it).
  const html = dt.getData("text/html");
  const src = html && new DOMParser().parseFromString(html, "text/html").querySelector("img")?.src;
  const url = src || dt.getData("text/uri-list").split("\n").find((l) => l && !l.startsWith("#")) || dt.getData("text/plain");
  if (url && /^https?:\/\//.test(url.trim())) return loadUrl(url.trim());
  toast("Drop an image file, or an image from a web page.", "bad");
}

// ---------- actions ----------
async function run(label, fn, keepSlot) {
  try {
    const r = await fn();
    const item = state.item;
    await refreshImages(keepSlot);
    loadItems();
    toast(label, "good", r?.undo ? { label: "Undo", run: () => undo(item, r.undo) } : null);
    return true;
  } catch (e) {
    toast(e.message, "bad");
    return false;
  }
}

async function save() {
  const d = state.draft;
  if (!d || !state.cropper || $("save").disabled) return;
  const t = TYPES[d.type];
  const canvas = state.cropper.getCroppedCanvas({ maxWidth: t.max[0], maxHeight: t.max[1], imageSmoothingQuality: "high" });
  const mime = t.png ? "image/png" : "image/jpeg";
  const blob = await new Promise((res) => canvas.toBlob(res, mime, 0.92));
  $("save").disabled = true;
  const where = slotName(d.slot);
  const added = d.slot === "new";
  const ok = await run(`${added ? "Added a new" : "Replaced"} ${added ? typeName(d.type) : where} on ${state.item.name}.`,
    () => api(`api/item/${d.itemId}/slot/${d.type}/${d.slot}`, { method: "POST", headers: { "Content-Type": mime }, body: blob }),
    added ? state.images.length : d.slot);
  if (ok) { dropDraft(); render(); } else { $("save").disabled = false; }
}

function cancelDraft() {
  if (!state.draft) return;
  dropDraft();
  if (state.slot === "new" && !TYPES[state.type].multi) state.slot = 0;
  render();
}

async function slotAction(act, n) {
  const img = state.images[n];
  if (!img) return;
  const name = `${TYPES[state.type].multi ? `backdrop ${n + 1}` : `the ${typeName(state.type)}`} of ${state.item.name}`;
  if (act === "recrop") {
    try {
      state.slot = n;
      startDraft(await api(`api/img/${state.item.id}/${state.type}/${img.ImageIndex ?? 0}${img.ImageTag ? `?tag=${img.ImageTag}` : ""}`), `the full-size ${typeName(state.type)}`);
    } catch (e) { toast(`Couldn't load it: ${e.message}`, "bad"); }
  } else if (act === "first") {
    await run(`Backdrop ${n + 1} is now the main backdrop.`, () => api(`api/item/${state.item.id}/slot/Backdrop/${n}/first`, { method: "POST" }), 0);
  } else if (act === "delete") {
    if (!confirm(`Delete ${name}?\n\nYou can undo it right after, or from History.`)) return;
    await run(`Deleted ${name}.`, () => api(`api/item/${state.item.id}/slot/${state.type}/${n}`, { method: "DELETE" }), Math.max(0, n - 1));
  }
}

async function undo(item, setId) {
  try {
    await api(`api/item/${item.id}/history/${setId}/restore`, { method: "POST" });
    toast(`Undone on ${item.name}.`, "good");
    if (state.item?.id === item.id) await refreshImages(0);
    loadItems();
  } catch (e) { toast(`Undo failed: ${e.message}`, "bad"); }
}

// ---------- history / log / help panels ----------
const ACTION_WORDS = { replace: "before a replace", add: "before an add", delete: "before a delete", reorder: "before a reorder",
                       restore: "before a restore", push: "before a push", restored: "already restored once" };

async function openHistory() {
  closePanels();
  $("history").hidden = false;
  $("history-list").innerHTML = `<p class="muted">Loading…</p>`;
  const item = state.item;
  const list = await api(`api/item/${item.id}/history`);
  $("history-list").innerHTML = list.length ? list.map((h) => `
    <div class="hist">
      <div class="what">${TYPES[h.type]?.label || h.type}: ${h.files.length} image${h.files.length === 1 ? "" : "s"}
        <small>${h.time} · ${ACTION_WORDS[h.action] || h.action}</small></div>
      <button type="button" data-restore="${esc(h.id)}">Restore</button>
      <div class="thumbs">${h.files.map((f) => `<img loading="lazy" src="api/backup/${item.id}/${encodeURIComponent(h.id)}/${encodeURIComponent(f)}" alt="">`).join("")}</div>
    </div>`).join("") : `<p class="muted">No changes made to ${esc(item.name)} from this app yet.</p>`;
}

function renderLog() {
  $("log-list").innerHTML = state.log.map((l) => `<li class="${l.kind}"><time>${l.t}</time>${esc(l.msg)}</li>`).join("") || `<li class="muted">Nothing yet.</li>`;
}

function closePanels() { ["history", "log", "help"].forEach((p) => ($(p).hidden = true)); }

// ---------- provider art ----------
async function loadRemote() {
  const { item, type, remote: r } = state;
  const key = `${item.id}/${type}`;
  if (r.key === key) return renderRemote();
  r.key = key; r.list = [];
  $("remote-filters").innerHTML = "";
  $("remote-grid").innerHTML = `<span class="none">Asking TVDB, TMDB and Fanart…</span>`;
  try {
    const list = await api(`api/item/${item.id}/remote?type=${type}`);
    if (r.key !== key) return;
    r.list = list.sort((a, b) => (b.w || 0) - (a.w || 0));
    if (r.provider !== "All" && !r.list.some((i) => i.provider === r.provider)) r.provider = "All";
    renderRemote();
  } catch (e) {
    r.key = "";
    $("remote-grid").innerHTML = `<span class="none">Couldn't load provider art: ${esc(e.message)}</span>`;
  }
}

function renderRemote() {
  const r = state.remote;
  const t = TYPES[state.type];
  const counts = r.list.reduce((m, i) => ({ ...m, [i.provider]: (m[i.provider] || 0) + 1 }), {});
  $("remote-filters").innerHTML = [["All", r.list.length], ...Object.entries(counts)].map(([p, n]) =>
    `<button type="button" data-provider="${esc(p)}" class="${p === r.provider ? "on" : ""}">${esc(p)} ${n}</button>`).join("");
  const shown = r.list.filter((i) => r.provider === "All" || i.provider === r.provider);
  const grid = $("remote-grid");
  grid.className = `remote-grid${state.type === "Primary" ? " wide" : ""}${state.type === "Logo" ? " logo" : ""}`;
  grid.style.setProperty("--ar", Number.isNaN(t.ratio) ? "2/1" : `${t.ratio}`);
  grid.innerHTML = shown.length ? shown.map((i) => `<figure data-url="${esc(i.url)}" title="Load into ${esc(slotName(state.slot))}">
      <img loading="lazy" referrerpolicy="no-referrer" src="${esc(i.thumb)}" alt="">
      <figcaption><span>${esc(i.provider)}${i.lang ? ` · ${esc(i.lang)}` : ""}</span>
      <span class="${i.w && i.w < t.minW ? "lowres" : ""}">${i.w ? `${i.w}×${i.h}` : "?"}</span></figcaption></figure>`).join("")
    : `<span class="none">The providers have no ${typeName(state.type)} for this one.</span>`;
}

// ---------- navigation ----------
function moveShow(delta) {
  const list = visibleItems();
  if (!list.length) return;
  const i = list.findIndex((x) => x.id === state.item?.id);
  select(list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + delta))]);
}

function moveSlot(delta) {
  if (!state.item) return;
  const keys = state.images.map((_, n) => n);
  if (TYPES[state.type].multi || !state.images.length) keys.push(TYPES[state.type].multi ? "new" : 0);
  const i = keys.indexOf(state.slot);
  setSlot(keys[Math.max(0, Math.min(keys.length - 1, i + delta))]);
}

// ---------- wiring ----------
function wire() {
  renderTypes();
  $("search").oninput = renderItems;
  $("filter").onchange = () => { lsSet("filter", $("filter").value); renderItems(); };
  $("sort").onchange = () => { lsSet("sort", $("sort").value); renderItems(); };
  $("libs").onclick = (e) => {
    const b = e.target.closest("button[data-lib]");
    if (b) { state.lib = b.dataset.lib; lsSet("lib", state.lib); renderLibs(); renderItems(); }
  };
  $("items").onclick = (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) select(state.data.items.find((i) => i.id === li.dataset.id), false);
  };
  $("types").onclick = (e) => { const b = e.target.closest("button[data-type]"); if (b) setType(b.dataset.type); };
  $("film").onclick = (e) => {
    const s = e.target.closest(".slot");
    if (!s) return;
    const n = s.dataset.slot === "new" ? "new" : Number(s.dataset.slot);
    const act = e.target.closest("button[data-act]");
    if (act) { e.stopPropagation(); return slotAction(act.dataset.act, n); }
    if (!e.target.closest("a")) setSlot(n);
  };
  $("browse").onclick = () => $("file").click();
  $("file").onchange = () => { const f = $("file").files[0]; if (f) startDraft(f, f.name); $("file").value = ""; };
  $("save").onclick = save;
  $("cancel").onclick = cancelDraft;
  $("reset").onclick = () => state.cropper?.reset();
  $("pv-toggle").onchange = () => { state.preview = $("pv-toggle").checked; lsSet("preview", state.preview ? "1" : ""); renderPreview(); };
  $("view-img").onload = positionPreview;
  window.addEventListener("resize", positionPreview);

  $("remote-filters").onclick = (e) => {
    const b = e.target.closest("button[data-provider]");
    if (b) { state.remote.provider = b.dataset.provider; renderRemote(); }
  };
  $("remote-grid").onclick = (e) => {
    const f = e.target.closest("figure[data-url]");
    if (f) { document.body.classList.remove("rail-on"); loadUrl(f.dataset.url, "provider art"); }
  };
  $("rail-open").onclick = () => document.body.classList.add("rail-on");
  $("rail-close").onclick = () => document.body.classList.remove("rail-on");

  $("history-btn").onclick = openHistory;
  $("history-list").onclick = async (e) => {
    const b = e.target.closest("button[data-restore]");
    if (!b) return;
    b.disabled = true;
    const item = state.item;
    const ok = await run(`Restored an earlier version on ${item.name}.`,
      () => api(`api/item/${item.id}/history/${b.dataset.restore}/restore`, { method: "POST" }), 0);
    if (ok) openHistory();
  };
  $("log-btn").onclick = () => { closePanels(); renderLog(); $("log").hidden = false; };
  $("help-btn").onclick = () => { closePanels(); $("help").hidden = false; };
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closePanels));

  // Drag and drop anywhere on the page.
  let depth = 0;
  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (++depth === 1 && state.item) { $("drop-target").textContent = `${slotName(state.slot)} of ${state.item.name}`; $("drop-veil").hidden = false; }
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; $("drop-veil").hidden = true; } });
  document.addEventListener("drop", (e) => {
    e.preventDefault(); depth = 0; $("drop-veil").hidden = true;
    if (!state.item) return toast("Pick a show first.");
    imageFromDataTransfer(e.dataTransfer);
  });
  document.addEventListener("paste", (e) => {
    if (e.target.matches?.("input, select")) return;
    if (!state.item) return toast("Pick a show first.");
    const file = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"))?.getAsFile();
    if (file) return startDraft(file, "the pasted image");
    const text = e.clipboardData.getData("text").trim();
    if (/^https?:\/\//.test(text)) loadUrl(text);
  });

  document.addEventListener("keydown", (e) => {
    const typing = e.target.matches?.("input[type=search], select");
    if (e.key === "Escape") {
      if (typing) return e.target.blur();
      if (![...document.querySelectorAll(".panel")].every((p) => p.hidden)) return closePanels();
      if (document.body.classList.contains("rail-on")) return document.body.classList.remove("rail-on");
      return cancelDraft();
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && state.draft) { e.preventDefault(); return save(); }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === "/") { e.preventDefault(); $("search").focus(); }
    else if (k === "?") { closePanels(); $("help").hidden = false; }
    else if (k === "ArrowDown" || k === "ArrowUp") { e.preventDefault(); moveShow(k === "ArrowDown" ? 1 : -1); }
    else if (k === "ArrowRight" || k === "ArrowLeft") { if (!state.cropper) { e.preventDefault(); moveSlot(k === "ArrowRight" ? 1 : -1); } }
    else if (k >= "1" && k <= "5") setType(TYPE_KEYS[Number(k) - 1]);
    else if (k === "Enter" && state.draft) { e.preventDefault(); save(); }
    else if (k.toLowerCase() === "p") { $("pv-toggle").checked = !$("pv-toggle").checked; $("pv-toggle").onchange(); }
    else if (k.toLowerCase() === "f" && TYPES[state.type].multi && typeof state.slot === "number" && state.slot > 0) slotAction("first", state.slot);
    else if (k === "Delete" && typeof state.slot === "number" && state.images[state.slot] && !state.draft) slotAction("delete", state.slot);
    else if (k === " " && state.draft && !e.repeat) {
      e.preventDefault();
      const img = currentImage();
      if (!img) return;
      $("compare-img").src = imgUrl(state.item.id, state.type, img.ImageIndex ?? 0, 2400, img.ImageTag);
      $("compare-img").hidden = $("compare-tag").hidden = false;
    }
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === " ") $("compare-img").hidden = $("compare-tag").hidden = true;
  });
  window.addEventListener("beforeunload", (e) => { if (state.draft?.dirty) e.preventDefault(); });
}

async function init() {
  wire();
  $("filter").value = lsGet("filter") || "all";
  $("sort").value = lsGet("sort") || "name";
  state.lib = lsGet("lib") || "All";
  state.preview = lsGet("preview") === "1";
  $("pv-toggle").checked = state.preview;
  try {
    const cfg = await api("api/config");
    state.jellyfin = cfg.jellyfin;
    $("version").textContent = /^\d/.test(cfg.version) ? `v${cfg.version}` : cfg.version;
    await loadItems();
    const want = readHash();
    if (want.type) { state.type = want.type; renderTypes(); }
    const item = want.id && state.data.items.find((i) => i.id === want.id);
    if (item) await select(item);
  } catch (e) {
    toast(`Can't reach Jellyfin: ${e.message}`, "bad");
  }
}
init();
