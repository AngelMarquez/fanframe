"""Fanframe: pick a show, pick an image slot, drop art in, crop it, save it to Jellyfin.

Local web app. The API key never reaches the browser: the page talks to this server, this server
talks to Jellyfin.

    python server.py            # opens http://127.0.0.1:8765 (or just opens it if already running)

Settings (environment variables win over config.json in the data folder; see README):
    JELLYFIN_URL, JELLYFIN_API_KEY, JELLYFIN_PUBLIC_URL, FANFRAME_PASSWORD, MEDIA_READONLY,
    FANFRAME_DATA, FANFRAME_HOST, FANFRAME_PORT
"""
import base64
import hmac
import ipaddress
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
# Run from source, everything sits next to this file. In the container FANFRAME_DATA=/config holds
# config.json (optional), backups/ and custom.json, and FANFRAME_HOST=0.0.0.0.
DATA = Path(os.environ.get("FANFRAME_DATA", ROOT))
BACKUPS = DATA / "backups"
CUSTOM = DATA / "custom.json"
HOST = os.environ.get("FANFRAME_HOST", "127.0.0.1")
PORT = int(os.environ.get("FANFRAME_PORT", "8765"))


def load_settings():
    """config.json (if present) with environment variables on top."""
    cfg = {}
    f = DATA / "config.json"
    if f.exists():
        try:
            cfg = json.loads(f.read_text())
        except (OSError, ValueError) as e:
            sys.exit(f"Fanframe: can't read {f} ({e}).")
    env = {"url": "JELLYFIN_URL", "api_key": "JELLYFIN_API_KEY", "public_url": "JELLYFIN_PUBLIC_URL",
           "password": "FANFRAME_PASSWORD", "media_readonly": "MEDIA_READONLY"}
    for key, var in env.items():
        if os.environ.get(var):
            cfg[key] = os.environ[var]
    missing = [env[k] for k in ("url", "api_key") if not cfg.get(k)]
    if missing:
        sys.exit(f"Fanframe: set {' and '.join(missing)} (or \"url\"/\"api_key\" in {f}). "
                 "The API key comes from Jellyfin: Dashboard → API Keys → +.")
    return cfg


def truthy(v, default):
    return default if v is None or v == "" else str(v).strip().lower() in ("1", "true", "yes", "on")


def drop_privileges():
    """In the container the server starts as root: make sure the data folder exists and belongs to
    PUID:PGID (default 99:100, Unraid's nobody:users; Docker creates a missing bind-mount folder as
    root), then run as that user. Does nothing when already started as a normal user (--user)."""
    if os.name != "posix" or os.geteuid() != 0:
        return
    uid, gid = int(os.environ.get("PUID", "99")), int(os.environ.get("PGID", "100"))
    DATA.mkdir(parents=True, exist_ok=True)
    for top, dirs, files in os.walk(DATA):
        for name in [top] + [os.path.join(top, n) for n in dirs + files]:
            try:
                os.lchown(name, uid, gid)
            except OSError:
                pass
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)


drop_privileges()
CFG = load_settings()
MAX_BYTES = 50 * 1024 * 1024  # biggest image accepted from the page or from the web
JF = CFG["url"].rstrip("/")
# The address the *browser* uses for "Open in Jellyfin" (the server may reach Jellyfin another way).
JF_PUBLIC = (CFG.get("public_url") or JF).rstrip("/")
AUTH = f'MediaBrowser Token="{CFG["api_key"]}"'
PASSWORD = CFG.get("password") or ""
# Images stored inside a library folder (next to the media) can't be changed when Jellyfin's view of
# the media is read-only: deletes fail and a reorder fails halfway (it once copied the old file over
# a fresh upload). True (the default) treats them as locked; set false when Jellyfin can write there.
MEDIA_READONLY = truthy(CFG.get("media_readonly"), True)

# Image types the app can change. Backdrop is a list; the rest hold one image each.
TYPES = {"Backdrop", "Primary", "Thumb", "Logo", "Banner"}
MIME_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}


class JfError(Exception):
    """Jellyfin answered with an error."""
    def __init__(self, status, body):
        super().__init__(f"Jellyfin said {status}: {body[:300]}")
        self.status = status


class AppError(Exception):
    """The app refused something itself (shown to the user as plain text)."""
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status


def jf(method, path, body=None, ctype=None, raw=False):
    """Call Jellyfin. Returns parsed JSON, raw (bytes, content-type), or None for empty replies."""
    req = urllib.request.Request(JF + path, data=body, method=method)
    req.add_header("Authorization", AUTH)
    if ctype:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
            if raw:
                return data, r.headers.get("Content-Type", "application/octet-stream")
            return json.loads(data) if data else None
    except urllib.error.HTTPError as e:
        raise JfError(e.code, e.read().decode("utf-8", "replace")) from None


def _norm(p):
    # Compare paths as Jellyfin reports them (Linux or Windows style), case-insensitively.
    return p.replace("\\", "/").rstrip("/").lower() + "/"


_libs = {"at": 0.0, "paths": []}


def library_paths():
    """Every media library folder Jellyfin knows (refreshed every 5 minutes). Collections and
    playlists are skipped: Jellyfin keeps those in its own writable data folder."""
    if time.time() - _libs["at"] > 300:
        locs = [loc for lib in jf("GET", "/Library/VirtualFolders")
                if lib.get("CollectionType") not in ("boxsets", "playlists")
                for loc in lib.get("Locations") or []]
        _libs.update(at=time.time(), paths=[_norm(p) for p in locs])
    return _libs["paths"]


def image_list(item_id, image_type=None):
    """The item's images, each with InMedia (stored inside a library folder) and Locked (InMedia while
    MEDIA_READONLY is on)."""
    imgs = jf("GET", f"/Items/{item_id}/Images") or []
    if image_type:
        imgs = [i for i in imgs if i["ImageType"] == image_type]
    libs = library_paths()
    for i in imgs:
        path = _norm(i.get("Path") or "").rstrip("/")
        i["InMedia"] = any(path.startswith(lp) for lp in libs)
        i["Locked"] = MEDIA_READONLY and i["InMedia"]
    return sorted(imgs, key=lambda i: (i["ImageType"], i.get("ImageIndex") or 0))


def item_name(item_id):
    it = jf("GET", f"/Items?Ids={item_id}&Recursive=true")["Items"]
    return it[0]["Name"] if it else item_id


# ---------- "done" markers for the sidebar ----------
_custom_lock = threading.RLock()


def custom_get():
    # Read under the lock too: on Windows the replace below fails (Access denied) while
    # another thread has the file open.
    with _custom_lock:
        try:
            return json.loads(CUSTOM.read_text())
        except (OSError, ValueError):
            return {}


def custom_mark(item_id, image_type):
    with _custom_lock:
        c = custom_get()
        c.setdefault(item_id, {})[image_type] = time.strftime("%Y-%m-%d %H:%M")
        tmp = CUSTOM.with_suffix(".tmp")
        tmp.write_text(json.dumps(c, indent=1))
        tmp.replace(CUSTOM)  # atomic: a crash mid-write can't leave half a file


# ---------- backups (one set per change; History lists them, Undo restores one) ----------
def backup_dir(item_id):
    # Found by id, so a renamed show keeps its History (review finding, 10-23).
    for d in BACKUPS.glob(f"*[[]{item_id}[]]") if BACKUPS.exists() else []:
        if d.is_dir():
            return d
    safe = re.sub(r'[<>:"/\\|?*]+', "_", item_name(item_id)).strip(" .")
    return BACKUPS / f"{safe} [{item_id}]"


def backup(item_id, image_type, action):
    """Save every current image of this type before a change and return the set id. A slot that
    was empty gives an empty set, so Undo of a first push simply removes the image again."""
    imgs = image_list(item_id, image_type)
    base = backup_dir(item_id)
    while True:  # one-second names: two changes in the same second must not share a folder
        set_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{image_type}-{action}"
        if not (base / set_id).exists():
            break
        time.sleep(1)
    folder = base / set_id
    folder.mkdir(parents=True)
    for img in imgs:
        idx = img.get("ImageIndex") or 0
        data, ctype = jf("GET", f"/Items/{item_id}/Images/{image_type}/{idx}", raw=True)
        ext = MIME_EXT.get(ctype.split(";")[0], "jpg")
        (folder / f"{idx:02d}.{ext}").write_bytes(data)
    return set_id


def history(item_id):
    base = backup_dir(item_id)
    out = []
    for d in sorted(base.iterdir(), reverse=True) if base.exists() else []:
        m = re.fullmatch(r"(\d{8})-(\d{6})-(\w+?)(?:-(\w+))?", d.name)
        if not d.is_dir() or not m or m[3] not in TYPES:
            continue
        files = sorted(p.name for p in d.iterdir() if p.is_file())
        t = f"{m[1][:4]}-{m[1][4:6]}-{m[1][6:]} {m[2][:2]}:{m[2][2:4]}"
        out.append({"id": d.name, "type": m[3], "action": m[4] or "push", "time": t, "files": files})
    return out


# ---------- image operations ----------
def refuse_if_locked(item_id, image_type):
    """Refuse before changing anything when any image of this type is locked (see MEDIA_READONLY):
    with read-only media, Jellyfin fails halfway through deletes and reorders."""
    lk = [i for i in image_list(item_id, image_type) if i["Locked"]]
    if lk:
        names = ", ".join(i["Path"].replace("\\", "/").rsplit("/", 1)[-1] for i in lk)
        raise AppError(409, f"This {image_type.lower()} is a file in the item's media folder ({names}). "
                            "MEDIA_READONLY is on, so it isn't changed from here. If Jellyfin can write "
                            "to your media folders, set MEDIA_READONLY=false.")


def delete_all(item_id, image_type):
    # Highest index first, so the remaining indexes don't shift under us.
    for img in reversed(image_list(item_id, image_type)):
        jf("DELETE", f"/Items/{item_id}/Images/{image_type}/{img.get('ImageIndex') or 0}")


def upload(item_id, image_type, data, ctype):
    # Jellyfin wants the image base64-encoded in the body, with the real image content type.
    jf("POST", f"/Items/{item_id}/Images/{image_type}", base64.b64encode(data), ctype)


def swap(item_id, a, b):
    # Jellyfin's "Index" endpoint swaps two backdrops (renames the files).
    jf("POST", f"/Items/{item_id}/Images/Backdrop/{a}/Index?newIndex={b}")


def save_slot(item_id, image_type, slot, data, ctype):
    """Replace one slot, or add a new image when slot is 'new' (or past the end)."""
    refuse_if_locked(item_id, image_type)
    n = len(image_list(item_id, image_type))
    set_id = backup(item_id, image_type, "add" if slot == "new" else "replace")
    if image_type != "Backdrop":
        # Upload replaces the single image itself; no delete first, so a failed upload can't
        # leave the slot empty (review finding, 10-23).
        upload(item_id, image_type, data, ctype)
    elif slot == "new" or int(slot) >= n:
        upload(item_id, image_type, data, ctype)
    else:
        i = int(slot)
        upload(item_id, image_type, data, ctype)  # lands at index n
        swap(item_id, n, i)                      # new one to slot i, old one to n
        jf("DELETE", f"/Items/{item_id}/Images/Backdrop/{n}")
    custom_mark(item_id, image_type)
    return set_id


def delete_slot(item_id, image_type, slot):
    refuse_if_locked(item_id, image_type)
    set_id = backup(item_id, image_type, "delete")
    jf("DELETE", f"/Items/{item_id}/Images/{image_type}/{int(slot)}")
    custom_mark(item_id, image_type)
    return set_id


def make_first(item_id, slot):
    """Move a backdrop to the front, keeping the others in order (adjacent swaps)."""
    refuse_if_locked(item_id, "Backdrop")
    set_id = backup(item_id, "Backdrop", "reorder")
    for i in range(int(slot), 0, -1):
        swap(item_id, i, i - 1)
    custom_mark(item_id, "Backdrop")
    return set_id


def restore_set(item_id, set_id):
    """Put a History set back (all images of that type, as they were before that change)."""
    folder = backup_dir(item_id) / set_id
    m = re.fullmatch(r"\d{8}-\d{6}-(\w+?)(?:-\w+)?", set_id)
    if not m or m[1] not in TYPES or not folder.is_dir():
        raise AppError(404, "That history entry is gone.")
    image_type = m[1]
    files = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix[1:] in MIME_EXT.values())
    refuse_if_locked(item_id, image_type)
    new_set = backup(item_id, image_type, "restore")
    delete_all(item_id, image_type)
    for f in files:
        ctype = next((k for k, e in MIME_EXT.items() if e == f.suffix[1:]), "image/jpeg")
        upload(item_id, image_type, f.read_bytes(), ctype)
    custom_mark(item_id, image_type)
    return new_set


def public_only(url):
    """Refuse URLs that point into the home network or the box itself: /api/fetch is for images on
    the internet, not a way to make the server read LAN services (review finding, 10-24)."""
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise AppError(400, "That isn't a web address.")
    try:
        addrs = {a[4][0] for a in socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme == "https" else 80))}
    except socket.gaierror:
        raise AppError(400, f"Can't find the site {u.hostname}.") from None
    if not all(ipaddress.ip_address(a.split("%")[0]).is_global for a in addrs):
        raise AppError(403, f"{u.hostname} is a local address; only internet images can be fetched.")


class _CheckRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        public_only(newurl)  # every hop, so a public URL can't bounce to a LAN one
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_CheckRedirects)


def fetch_remote(url):
    """Download an image dragged in from a web page (the browser can't, because of CORS)."""
    public_only(url)
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Fanframe/1.0",
        "Referer": urllib.parse.urljoin(url, "/"),
    })
    with _opener.open(req, timeout=30) as r:
        ctype = r.headers.get("Content-Type", "").split(";")[0]
        if not ctype.startswith("image/"):
            raise AppError(415, f"That link gave back {ctype or 'something'}, not an image.")
        data = r.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise AppError(413, "That image is over 50 MB.")
        return data, ctype


# ---------- item list (all libraries, with what the sidebar badges need) ----------
_dims = {}  # (item id, first backdrop tag) -> width
WIDTH_LOOKUP_MAX = 2000


def first_backdrop_width(item):
    tags = item.get("BackdropImageTags") or []
    if not tags:
        return None
    key = (item["Id"], tags[0])
    if key not in _dims:
        b = image_list(item["Id"], "Backdrop")
        _dims[key] = b[0].get("Width") if b else None
    return _dims[key]


def all_items():
    libs = [l for l in jf("GET", "/Library/VirtualFolders") if l.get("CollectionType") in ("tvshows", "movies")]
    rows = []
    for lib in libs:
        start = 0
        while True:  # pages, so a big library is never cut off by a server-side limit
            r = jf("GET", "/Items?" + urllib.parse.urlencode({
                "ParentId": lib["ItemId"], "Recursive": "true",
                "IncludeItemTypes": "Series,Movie", "SortBy": "SortName",
                "Fields": "ProductionYear,SortName", "EnableImageTypes": "Backdrop,Primary,Thumb,Logo,Banner",
                "StartIndex": start, "Limit": 1000,
            }))
            rows += [(lib["Name"], i) for i in r["Items"]]
            start += len(r["Items"])
            if not r["Items"] or start >= r.get("TotalRecordCount", start):
                break
    # The low-res badge needs one image lookup per item (cached afterwards); skip it for big libraries.
    if len(rows) <= WIDTH_LOOKUP_MAX:
        with ThreadPoolExecutor(8) as ex:
            widths = list(ex.map(lambda r: first_backdrop_width(r[1]), rows))
    else:
        widths = [None] * len(rows)
    custom = custom_get()
    return {"libraries": [l["Name"] for l in libs], "items": [{
        "id": i["Id"], "name": i["Name"], "sort": i.get("SortName") or i["Name"], "year": i.get("ProductionYear"),
        "library": lib, "backdrops": i.get("BackdropImageTags") or [], "tags": i.get("ImageTags") or {},
        "bw": w, "custom": sorted(custom.get(i["Id"], {})),
    } for (lib, i), w in zip(rows, widths)]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if not self.path.startswith(("/api/img", "/api/backup", "/static")):
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    def send(self, status, body, ctype="application/json", cache=False):
        if not isinstance(body, (bytes, bytearray)):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length", 0))
        ctype = self.headers.get("Content-Type", "image/jpeg").split(";")[0]
        if not n or not ctype.startswith("image/"):
            raise AppError(400, "No image was sent.")
        if n > MAX_BYTES:
            raise AppError(413, "That image is over 50 MB.")
        return self.rfile.read(n), ctype

    def route(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        p = u.path
        m = self.command
        ID = r"([0-9a-f]{32})"

        if m == "GET" and p == "/":
            return self.send(200, (STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
        if m == "GET" and p.startswith("/static/"):
            f = (STATIC / p[len("/static/"):]).resolve()
            if STATIC in f.parents and f.is_file():
                ctype = {".js": "text/javascript", ".css": "text/css"}.get(f.suffix, "application/octet-stream")
                return self.send(200, f.read_bytes(), ctype + "; charset=utf-8")
            return self.send(404, {"error": "not found"})
        if m == "GET" and p == "/api/ping":
            return self.send(200, {"app": "fanframe"})
        if m == "GET" and p == "/api/config":
            return self.send(200, {"jellyfin": JF_PUBLIC})
        if m == "GET" and p == "/api/items":
            return self.send(200, all_items())

        mt = re.fullmatch(rf"/api/item/{ID}/images", p)
        if m == "GET" and mt:
            return self.send(200, image_list(mt[1]))

        # Every image the metadata providers (TVDB, TMDB, Fanart) offer for this item and type.
        mt = re.fullmatch(rf"/api/item/{ID}/remote", p)
        if m == "GET" and mt:
            r = jf("GET", f"/Items/{mt[1]}/RemoteImages?" + urllib.parse.urlencode(
                {"type": q.get("type", "Backdrop"), "includeAllLanguages": "true"}))
            return self.send(200, [{
                "provider": i.get("ProviderName"), "url": i["Url"],
                "thumb": i.get("ThumbnailUrl") or i["Url"],
                "w": i.get("Width"), "h": i.get("Height"), "lang": i.get("Language"),
            } for i in r.get("Images", []) if i.get("Url")])

        # Thumbnails/originals, proxied so the page never needs the Jellyfin URL or key.
        mt = re.fullmatch(rf"/api/img/{ID}/(\w+)/(\d+)", p)
        if m == "GET" and mt:
            qs = urllib.parse.urlencode({k: v for k, v in q.items() if k in ("maxWidth", "maxHeight", "tag", "quality")})
            data, ctype = jf("GET", f"/Items/{mt[1]}/Images/{mt[2]}/{mt[3]}?{qs}", raw=True)
            return self.send(200, data, ctype, cache="tag" in q)

        if m == "GET" and p == "/api/fetch":
            data, ctype = fetch_remote(q.get("url", ""))
            return self.send(200, data, ctype)

        # Slots: POST = save a draft into slot N (or "new"), DELETE = remove slot N.
        mt = re.fullmatch(rf"/api/item/{ID}/slot/(\w+)/(\d+|new)", p)
        if mt:
            item_id, image_type, slot = mt[1], mt[2], mt[3]
            if image_type not in TYPES:
                raise AppError(400, f"Unknown image type {image_type}.")
            if m == "POST":
                data, ctype = self.body()
                return self.send(200, {"undo": save_slot(item_id, image_type, slot, data, ctype)})
            if m == "DELETE" and slot != "new":
                return self.send(200, {"undo": delete_slot(item_id, image_type, slot)})

        mt = re.fullmatch(rf"/api/item/{ID}/slot/Backdrop/(\d+)/first", p)
        if m == "POST" and mt:
            return self.send(200, {"undo": make_first(mt[1], mt[2])})

        mt = re.fullmatch(rf"/api/item/{ID}/history", p)
        if m == "GET" and mt:
            return self.send(200, history(mt[1]))
        mt = re.fullmatch(rf"/api/item/{ID}/history/([\w-]+)/restore", p)
        if m == "POST" and mt:
            return self.send(200, {"undo": restore_set(mt[1], mt[2])})

        mt = re.fullmatch(rf"/api/backup/{ID}/([\w-]+)/([\w.]+)", p)
        if m == "GET" and mt:
            f = backup_dir(mt[1]) / mt[2] / mt[3]
            if f.is_file() and BACKUPS in f.resolve().parents:
                ctype = next((k for k, e in MIME_EXT.items() if e == f.suffix[1:]), "image/jpeg")
                return self.send(200, f.read_bytes(), ctype, cache=True)
            return self.send(404, {"error": "not found"})

        return self.send(404, {"error": "not found"})

    def authorized(self):
        """Optional password (FANFRAME_PASSWORD): HTTP Basic auth, any user name. /api/ping stays open for
        the container health check."""
        if not PASSWORD or self.path == "/api/ping":
            return True
        h = self.headers.get("Authorization", "")
        if h.startswith("Basic "):
            try:
                given = base64.b64decode(h[6:]).decode("utf-8", "replace").split(":", 1)[1]
            except (ValueError, IndexError):
                given = ""
            if hmac.compare_digest(given.encode(), PASSWORD.encode()):
                return True
        body = b'{"error": "Password needed."}'
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Fanframe", charset="UTF-8"')
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return False

    def handle_one(self):
        if not self.authorized():
            return
        try:
            # Changes need the page's own header. A browser won't add a custom header to a request
            # from another site without a CORS preflight, which this server never answers, so a
            # malicious web page can't make a visitor's browser change art (review finding, 10-24).
            if self.command in ("POST", "DELETE") and self.headers.get("X-Fanframe") != "1":
                raise AppError(403, "Changes must come from the Fanframe page. If it was open during an update, reload it.")
            self.route()
        except AppError as e:
            self.fail(e.status, str(e))
        except JfError as e:
            self.fail(e.status if 400 <= e.status < 600 else 502, str(e))
        except (urllib.error.URLError, TimeoutError) as e:
            self.fail(502, f"Network problem: {e}")
        except Exception as e:  # noqa: BLE001 - surface anything to the page
            self.fail(500, f"{type(e).__name__}: {e}")

    def fail(self, status, msg):
        sys.stderr.write(f"  -> {status} {msg}\n")
        self.send(status, {"error": msg})

    do_GET = do_POST = do_DELETE = handle_one


def already_running(url):
    try:
        with urllib.request.urlopen(url + "api/ping", timeout=2) as r:
            return json.loads(r.read()).get("app") == "fanframe"
    except (OSError, ValueError):
        return False


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second copy bind the same port silently (two servers answering
    # at random), so it's off there. On Linux it's needed: without it a quick container restart
    # fails while the old socket sits in TIME_WAIT (review finding, 10-24).
    allow_reuse_address = os.name != "nt"


if __name__ == "__main__":
    url = f"http://127.0.0.1:{PORT}/"
    if already_running(url):
        print(f"Fanframe is already running; opening {url}")
        webbrowser.open(url)
        sys.exit(0)
    srv = Server((HOST, PORT), Handler)
    print(f"Fanframe on {HOST}:{PORT}  (Jellyfin: {JF}, data: {DATA})  Ctrl+C to stop", flush=True)
    if "--no-browser" not in sys.argv:
        threading.Timer(0.5, webbrowser.open, [url]).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
