#!/usr/bin/python3
"""Typecase backend: font library, installer and static file server. Stdlib only."""
import hashlib
import io
import ipaddress
import socket
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
HOME = os.path.expanduser("~")
USER_FONTS = os.path.join(HOME, ".local/share/fonts")
STATE_PATH = os.environ.get("TYPECASE_STATE") or os.path.join(HOME, ".local/share/typecase/state.json")
STAGE_ROOT = os.path.join(os.environ.get("TYPECASE_CACHE") or os.path.join(ROOT, ".cache"), "staging")
UA = "Typecase/1.0 (+font manager)"
FONT_EXT = (".ttf", ".otf", ".ttc")
SKIP_EXT = (".woff", ".woff2", ".eot")
MAX_BYTES = 400 * 1024 * 1024
MAX_FILE = 60 * 1024 * 1024        # largest single font file taken from a zip
MAX_TOTAL = 500 * 1024 * 1024      # largest total unpacked size of one zip
MAGIC = (b"\x00\x01\x00\x00", b"OTTO", b"true", b"ttcf")
INSTALLS_PATH = os.path.join(os.path.dirname(STATE_PATH), "installs.json")

LOCK = threading.RLock()
ALLOWED = set()          # absolute font paths the /font route may serve
JOBS = {}
STAGES = {}
_fonts_cache = {"t": 0, "data": None}
_last_rescan = [0.0]
_face_cache = {}


def font_dir_root():
    return os.path.abspath(os.environ.get("TYPECASE_FONT_DIR") or os.path.join(USER_FONTS, "Typecase"))


# ---------------------------------------------------------------- URL parsing
def _gh_zip(owner, repo, branch=None):
    ref = "refs/heads/" + branch if branch else "HEAD"
    return "https://codeload.github.com/%s/%s/zip/%s" % (owner, repo, ref)


def google_family(u, parts):
    """First family name in any Google Fonts link: /specimen/Name, /share?selection.family=Name:wght@..,
    css/css2?family=Name:ital,wght@..|Other, /download?family=.., ?query=Name, or the same inside the #fragment."""
    def clean(v):
        v = urllib.parse.unquote_plus(v or "")
        v = re.split(r"[|&]", v)[0]              # several families: take the first
        v = re.split(r"[:@]", v)[0]              # drop axes and styles (":wght@100..900")
        return re.sub(r"\s+", " ", v).strip()
    for i, p in enumerate(parts):
        if p.lower() in ("specimen", "share", "family") and i + 1 < len(parts):
            name = clean(parts[i + 1])
            if name:
                return name
    for qs in (u.query, u.fragment.split("?", 1)[-1]):
        q = urllib.parse.parse_qs(qs, keep_blank_values=False)
        for key in ("selection.family", "family", "specimen", "query", "q"):
            for v in q.get(key, []):
                name = clean(v)
                if name:
                    return name
    return ""


def parse_source(url):
    """Classify a pasted link. Returns a dict with a 'kind' and what is needed to fetch it."""
    url = (url or "").strip().strip("<>\"'`")
    if not url:
        raise ValueError("Paste a link first.")
    # Pasted text around a link ("see https://... for more"): keep the first link-like part.
    m = re.search(r"(?:https?://|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+/)\S+", url, re.I)
    if m:
        url = m.group(0).rstrip(".,;)]>\"'")
    elif re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 +_-]{0,60}", url) and "." not in url:
        # A bare family name such as "Doto" or "Open Sans": look for it on Google Fonts.
        name = re.sub(r"\s+", " ", url.replace("+", " ").replace("_", " ")).strip()
        return {"kind": "google", "name": name, "slug": re.sub(r"[^a-z0-9]", "", name.lower()), "label": name}
    if not re.match(r"^[a-z]+://", url, re.I):
        url = "https://" + url
    u = urllib.parse.urlparse(url)
    host = (u.hostname or "").lower()
    if u.scheme not in ("http", "https"):
        raise ValueError("Only http and https links work.")
    parts = [urllib.parse.unquote(p) for p in u.path.split("/") if p]
    low = u.path.lower()

    if host in ("fonts.google.com", "www.fonts.google.com", "fonts.googleapis.com") or (host.endswith("google.com") and parts[:1] == ["fonts"]):
        name = google_family(u, parts)
        if not name:
            raise ValueError("That Google Fonts link has no family name. Use a link like fonts.google.com/specimen/Inter.")
        slug = re.sub(r"[^a-z0-9]", "", name.lower())
        return {"kind": "google", "name": name, "slug": slug, "label": name}

    if host == "github.com" or host == "www.github.com":
        if len(parts) < 2:
            raise ValueError("That GitHub link needs an owner and a repository.")
        owner, repo = parts[0], re.sub(r"\.git$", "", parts[1])
        if len(parts) >= 5 and parts[2] == "blob":
            branch, path = parts[3], "/".join(parts[4:])
            return {"kind": "file", "url": "https://raw.githubusercontent.com/%s/%s/%s/%s" % (
                owner, repo, urllib.parse.quote(branch), urllib.parse.quote(path)),
                "label": os.path.basename(path)}
        if len(parts) >= 4 and parts[2] == "raw":
            branch, path = parts[3], "/".join(parts[4:])
            return {"kind": "file", "url": "https://raw.githubusercontent.com/%s/%s/%s/%s" % (
                owner, repo, urllib.parse.quote(branch), urllib.parse.quote(path)),
                "label": os.path.basename(path)}
        if len(parts) >= 4 and parts[2] == "tree":
            branch, sub = parts[3], "/".join(parts[4:])
            if os.path.splitext(sub.lower())[1] in FONT_EXT:
                return {"kind": "file", "url": "https://raw.githubusercontent.com/%s/%s/%s/%s" % (
                    owner, repo, urllib.parse.quote(branch), urllib.parse.quote(sub)), "label": os.path.basename(sub)}
            return {"kind": "github", "owner": owner, "repo": repo, "branch": branch, "sub": sub,
                    "zip": _gh_zip(owner, repo, branch), "label": "%s/%s" % (owner, repo)}
        if len(parts) >= 3 and parts[2] == "releases":
            pass  # fall through to repo zip
        return {"kind": "github", "owner": owner, "repo": repo, "branch": None, "sub": "",
                "zip": _gh_zip(owner, repo), "label": "%s/%s" % (owner, repo)}

    if host in ("raw.githubusercontent.com", "github.com"):
        return {"kind": "file", "url": url, "label": os.path.basename(u.path)}

    ext = os.path.splitext(low)[1]
    if ext in FONT_EXT:
        return {"kind": "file", "url": url, "label": os.path.basename(u.path)}
    if ext == ".zip":
        return {"kind": "zip", "url": url, "label": os.path.basename(u.path)}
    if ext in SKIP_EXT:
        raise ValueError("Web font files (%s) are not installed on Linux. Use a .ttf, .otf, .ttc or .zip link." % ext)
    raise ValueError("This link is not one Typecase knows. Use a GitHub link, a Google Fonts family link, or a direct link to a .ttf, .otf, .ttc or .zip file.")


# ---------------------------------------------------------------- font path allowlist
def path_allowed(path, allowed):
    """True only for absolute, normalised paths that are exactly in the allowlist."""
    if not path or "\x00" in path or not os.path.isabs(path):
        return False
    if ".." in path.split("/"):
        return False
    if os.path.normpath(path) != path:
        return False
    return path in allowed



# ---------------------------------------------------------------- OpenType tables (stdlib only)
FEATURE_LABELS = {
    "liga": "Ligatures", "dlig": "Discretionary ligatures", "clig": "Contextual ligatures", "hlig": "Historical ligatures",
    "smcp": "Small caps", "c2sc": "Caps to small caps", "onum": "Oldstyle numbers", "lnum": "Lining numbers",
    "tnum": "Tabular numbers", "pnum": "Proportional numbers", "frac": "Fractions", "afrc": "Alternative fractions",
    "zero": "Slashed zero", "case": "Case-sensitive forms", "salt": "Alternates", "swsh": "Swash",
    "calt": "Contextual alternates", "kern": "Kerning", "sups": "Superscript", "subs": "Subscript",
    "ordn": "Ordinals", "titl": "Titling", "cswh": "Contextual swash", "hist": "Historical forms",
    "ccmp": "Glyph composition", "locl": "Localized forms", "mark": "Mark positioning", "mkmk": "Mark to mark",
}
AXIS_LABELS = {"wght": "Weight", "wdth": "Width", "slnt": "Slant", "ital": "Italic", "opsz": "Optical size"}
SHOW_FEATURES = set(FEATURE_LABELS) - {"ccmp", "locl", "mark", "mkmk"}
_info_cache = {}


def _tables(data, index=0):
    base = 0
    if data[:4] == b"ttcf":
        n = struct.unpack(">I", data[8:12])[0]
        index = min(max(index, 0), max(n - 1, 0))
        base = struct.unpack(">I", data[12 + 4 * index:16 + 4 * index])[0]
    if len(data) < base + 12:
        raise ValueError("not a font")
    num = struct.unpack(">H", data[base + 4:base + 6])[0]
    tabs = {}
    for i in range(num):
        o = base + 12 + 16 * i
        tag, _, off, ln = struct.unpack(">4sIII", data[o:o + 16])
        tabs[tag.decode("latin1")] = (off, ln)
    return tabs


def _names(data, tabs):
    if "name" not in tabs:
        return {}
    off, ln = tabs["name"]
    fmt, count, so = struct.unpack(">HHH", data[off:off + 6])
    out, rank = {}, {}
    for i in range(count):
        pid, eid, lid, nid, length, o = struct.unpack(">6H", data[off + 6 + 12 * i:off + 18 + 12 * i])
        raw = data[off + so + o:off + so + o + length]
        if pid in (0, 3):
            txt, r = raw.decode("utf-16-be", "replace"), (2 if lid == 0x409 else 1)
        elif pid == 1:
            txt, r = raw.decode("mac_roman", "replace"), 0
        else:
            continue
        if nid not in out or r > rank[nid]:
            out[nid], rank[nid] = txt, r
    return out


def _fixed(b):
    return round(struct.unpack(">i", b)[0] / 65536.0, 4)


def parse_font_tables(path, index=0):
    """Return {'features': [{tag,label}], 'axes': [...], 'instances': [...]} using only struct."""
    with open(path, "rb") as f:
        data = f.read()
    tabs = _tables(data, index)
    names = _names(data, tabs)
    feats = {}
    for t in ("GSUB", "GPOS"):
        if t not in tabs:
            continue
        off = tabs[t][0]
        flo = struct.unpack(">H", data[off + 6:off + 8])[0]
        fl = off + flo
        cnt = struct.unpack(">H", data[fl:fl + 2])[0]
        for i in range(cnt):
            tag, fo = struct.unpack(">4sH", data[fl + 2 + 6 * i:fl + 8 + 6 * i])
            tag = tag.decode("latin1")
            label = None
            if re.match(r"^ss(0[1-9]|1\d|20)$", tag):
                try:
                    po = struct.unpack(">H", data[fl + fo:fl + fo + 2])[0]
                    if po:
                        nid = struct.unpack(">HH", data[fl + fo + po:fl + fo + po + 4])[1]
                        label = names.get(nid)
                except struct.error:
                    pass
                label = label or "Set %d" % int(tag[2:])
                label = "Stylistic set %d: %s" % (int(tag[2:]), label) if not label.startswith("Set ") else "Stylistic " + label.lower()
            elif re.match(r"^cv\d\d$", tag):
                label = "Character variant %d" % int(tag[2:])
            elif tag in SHOW_FEATURES:
                label = FEATURE_LABELS[tag]
            if label and tag not in feats:
                feats[tag] = label
    axes, instances = [], []
    if "fvar" in tabs:
        off = tabs["fvar"][0]
        ao, _, ac, asz, ic, isz = struct.unpack(">HHHHHH", data[off + 4:off + 16])
        for i in range(ac):
            o = off + ao + asz * i
            tag = data[o:o + 4].decode("latin1")
            mn, df, mx = _fixed(data[o + 4:o + 8]), _fixed(data[o + 8:o + 12]), _fixed(data[o + 12:o + 16])
            nid = struct.unpack(">H", data[o + 18:o + 20])[0]
            axes.append({"tag": tag, "label": AXIS_LABELS.get(tag) or names.get(nid) or tag, "min": mn, "default": df, "max": mx})
        for i in range(ic):
            o = off + ao + asz * ac + isz * i
            nid = struct.unpack(">H", data[o:o + 2])[0]
            coords = [_fixed(data[o + 4 + 4 * k:o + 8 + 4 * k]) for k in range(ac)]
            instances.append({"name": names.get(nid, "Instance %d" % (i + 1)), "coords": {axes[k]["tag"]: coords[k] for k in range(ac)}})
    order = sorted(feats, key=lambda t: (t.startswith("ss"), t.startswith("cv"), t))
    return {"features": [{"tag": t, "label": feats[t]} for t in order], "axes": axes, "instances": instances}


def font_info(path, index=0):
    try:
        key = (path, index, os.path.getmtime(path))
    except OSError:
        raise ValueError("File not found.")
    if key not in _info_cache:
        try:
            _info_cache[key] = parse_font_tables(path, index)
        except (struct.error, ValueError, IndexError, OSError):
            _info_cache[key] = {"features": [], "axes": [], "instances": []}
    return _info_cache[key]

# ---------------------------------------------------------------- state
def _read_json(path, want):
    """Read a JSON file. A broken file is renamed to <name>.bad-<time> so it is never overwritten."""
    try:
        with open(path) as f:
            v = json.load(f)
        if isinstance(v, want):
            return v
        raise ValueError("wrong type")
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        try:
            os.replace(path, "%s.bad-%s" % (path, time.strftime("%Y%m%d-%H%M%S")))
        except OSError:
            pass
        return None


def _write_json(path, v):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(v, f)
    os.replace(tmp, path)


def load_state():
    s = _read_json(STATE_PATH, dict) or {}
    if "installs" in s:  # old layout: move installs to their own file
        old = s.pop("installs")
        if isinstance(old, list) and not os.path.exists(INSTALLS_PATH):
            _write_json(INSTALLS_PATH, old)
        _write_json(STATE_PATH, s)
    return s


def save_state(s):
    _write_json(STATE_PATH, {k: v for k, v in s.items() if k != "installs"})


def load_installs():
    v = _read_json(INSTALLS_PATH, list) or []
    return [i for i in v if isinstance(i, dict) and isinstance(i.get("id"), str) and isinstance(i.get("dir"), str)
            and isinstance(i.get("files"), list)]


def save_installs(v):
    _write_json(INSTALLS_PATH, v)


def origin_ok(origin, port):
    """A request with an Origin header must come from this app's own page."""
    if origin is None:
        return True
    return origin in ("http://127.0.0.1:%s" % port, "http://localhost:%s" % port)


def extract_face(data, index):
    """Return one face of a .ttc as a standalone sfnt file."""
    if data[:4] != b"ttcf":
        return data
    n = struct.unpack(">I", data[8:12])[0]
    if not 0 <= index < n:
        raise ValueError("no such face")
    base = struct.unpack(">I", data[12 + 4 * index:16 + 4 * index])[0]
    ver = data[base:base + 4]
    num, a, b, c = struct.unpack(">HHHH", data[base + 4:base + 12])
    recs = []
    for k in range(num):
        tag, cs, off, ln = struct.unpack(">4sIII", data[base + 12 + 16 * k:base + 28 + 16 * k])
        recs.append((tag, cs, off, ln))
    pos = 12 + 16 * num
    out_recs, blobs = [], []
    for tag, cs, off, ln in recs:
        pad = (-pos) % 4
        blobs.append(b"\0" * pad + data[off:off + ln])
        pos += pad
        out_recs.append(struct.pack(">4sIII", tag, cs, pos, ln))
        pos += ln
    return ver + struct.pack(">HHHH", num, a, b, c) + b"".join(out_recs) + b"".join(blobs)


# ---------------------------------------------------------------- library
def fc_weight_to_css(w):
    table = [(0, 100), (40, 200), (50, 300), (55, 350), (80, 400), (100, 500), (180, 600), (200, 700), (205, 800), (210, 900)]
    best = min(table, key=lambda t: abs(t[0] - w))
    return best[1]


def fc_width_to_css(w):
    table = {50: 50, 63: 62.5, 75: 75, 87: 87.5, 100: 100, 113: 112.5, 125: 125, 150: 150, 200: 200}
    best = min(table, key=lambda k: abs(k - w))
    return table[best]


def scan_fonts(force=False):
    with LOCK:
        if not force and _fonts_cache["data"] and time.time() - _fonts_cache["t"] < 30:
            return _fonts_cache["data"]
    fmt = "%{family}\t%{style}\t%{file}\t%{spacing}\t%{weight}\t%{slant}\t%{width}\t%{index}\t%{variable}\n"
    try:
        out = subprocess.run(["fc-list", "--format", fmt], capture_output=True, text=True, timeout=60).stdout
    except (OSError, subprocess.TimeoutExpired):
        out = ""
    state = load_state()
    mine = set()
    for inst in load_installs():
        for f in inst.get("files", []):
            mine.add(f)
    fams = {}
    seen = set()
    allowed = set()
    for line in out.splitlines():
        p = line.split("\t")
        if len(p) < 9:
            continue
        family, style, file_, spacing, weight, slant, width, index, variable = p[:9]
        family = family.split(",")[0].strip()
        style = style.split(",")[0].strip() or "Regular"
        if not family or not os.path.isabs(file_):
            continue
        key = (family, style, file_)
        if key in seen:
            continue
        seen.add(key)
        allowed.add(os.path.normpath(file_))
        try:
            mtime = os.path.getmtime(file_)
        except OSError:
            mtime = 0
        try:
            idx = int(index or 0)
        except ValueError:
            idx = 0
        try:
            w = int(float(weight or 80))
        except ValueError:
            w = 80
        try:
            wd = int(float(width or 100))
        except ValueError:
            wd = 100
        try:
            sl = int(float(slant or 0))
        except ValueError:
            sl = 0
        fam = fams.setdefault(family, {"name": family, "styles": [], "mono": False, "user": False, "mine": False, "variable": False, "mtime": 0})
        fam["styles"].append({
            "style": style, "file": file_, "weight": fc_weight_to_css(w), "width": fc_width_to_css(wd),
            "italic": sl > 0, "variable": variable == "True" or (idx >> 16) > 0, "index": idx & 0xFFFF,
            "mtime": mtime,
        })
        if variable == "True" or (idx >> 16) > 0:
            fam["variable"] = True
        if spacing in ("100", "90"):
            fam["mono"] = True
        if file_.startswith(USER_FONTS + "/"):
            fam["user"] = True
        if file_ in mine:
            fam["mine"] = True
        fam["mtime"] = max(fam["mtime"], mtime)
    for fam in fams.values():
        vfiles = {st["file"] for st in fam["styles"] if st["variable"]}
        for st in fam["styles"]:
            if st["file"] in vfiles:
                st["variable"] = True
        fam["styles"].sort(key=lambda s: (s["italic"], s["weight"], s["width"], s["style"]))
    data = {"families": sorted(fams.values(), key=lambda f: f["name"].lower())}
    with LOCK:
        ALLOWED.intersection_update({p for p in ALLOWED if p.startswith(STAGE_ROOT + "/")})
        ALLOWED.update(allowed)
        _fonts_cache["t"] = time.time()
        _fonts_cache["data"] = data
    return data


# ---------------------------------------------------------------- download / staging
class Job:
    def __init__(self):
        self.id = uuid.uuid4().hex[:12]
        self.text = "Starting"
        self.done = False
        self.error = None
        self.result = None
        JOBS[self.id] = self

    def public(self):
        return {"id": self.id, "text": self.text, "done": self.done, "error": self.error, "result": self.result}


def check_public_url(url):
    """Allow only http(s) addresses that point to the public internet."""
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise RuntimeError("Only http and https links are allowed.")
    try:
        infos = socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except OSError as e:
        raise RuntimeError("Could not find that server: %s" % e)
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global:
            raise RuntimeError("That address points to this computer or a private network. Typecase only downloads from the public internet.")


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        try:
            check_public_url(newurl)
        except RuntimeError as e:
            raise urllib.error.URLError(str(e))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_SafeRedirect)


def http_get(url, job=None, label="Downloading", accept=None):
    check_public_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": UA, **({"Accept": accept} if accept else {})})
    try:
        resp = _opener.open(req, timeout=40)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise RuntimeError("Not found (404). Check the link.")
        if e.code == 403:
            raise RuntimeError("The server refused the request (403). GitHub may be rate limiting; try again in a few minutes.")
        raise RuntimeError("The server answered with error %s." % e.code)
    except urllib.error.URLError as e:
        raise RuntimeError("Could not connect: %s" % getattr(e, "reason", e))
    except (OSError, ValueError) as e:
        raise RuntimeError("Download failed: %s" % e)
    total = int(resp.headers.get("Content-Length") or 0)
    buf = io.BytesIO()
    while True:
        chunk = resp.read(262144)
        if not chunk:
            break
        buf.write(chunk)
        if buf.tell() > MAX_BYTES:
            raise RuntimeError("The download is larger than 400 MB. Stopped.")
        if job:
            if total:
                job.text = "%s: %d of %d MB" % (label, buf.tell() >> 20, total >> 20)
            else:
                job.text = "%s: %d MB" % (label, buf.tell() >> 20)
    return buf.getvalue()


def safe_rel(name):
    parts = [p for p in name.replace("\\", "/").split("/") if p not in ("", ".", "..")]
    return "/".join(re.sub(r"[^\w.\- +()&,]", "_", p) for p in parts)


def unique_path(p):
    if not os.path.exists(p):
        return p
    root, ext = os.path.splitext(p)
    n = 2
    while os.path.exists("%s (%d)%s" % (root, n, ext)):
        n += 1
    return "%s (%d)%s" % (root, n, ext)


def fc_query(path):
    """Return a list of (family, style, full name) for each face in a file."""
    try:
        out = subprocess.run(["fc-query", "--format", "%{family}\t%{style}\t%{fullname}\n", path],
                             capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    faces = []
    for line in out.splitlines():
        p = line.split("\t")
        if len(p) >= 2 and p[0].strip():
            faces.append((p[0].split(",")[0].strip(), p[1].split(",")[0].strip(), (p[2].split(",")[0].strip() if len(p) > 2 else "")))
    return faces


def new_stage():
    sid = uuid.uuid4().hex[:12]
    d = os.path.join(STAGE_ROOT, sid)
    os.makedirs(d, exist_ok=True)
    return sid, d


def build_stage(sid, d, source, job):
    """Scan staged directory, fc-query every font, build the preview model."""
    names = {f["name"].lower() for f in scan_fonts(True)["families"]}
    files = []
    skipped = 0
    for dp, _, fns in os.walk(d):
        for fn in sorted(fns):
            ext = os.path.splitext(fn)[1].lower()
            full = os.path.join(dp, fn)
            if ext in SKIP_EXT:
                skipped += 1
            elif ext in FONT_EXT:
                files.append(full)
    files.sort()
    items = []
    rejected = 0
    for i, full in enumerate(files):
        if i % 10 == 0:
            job.text = "Reading font info: %d of %d" % (i, len(files))
        rel = os.path.relpath(full, d)
        try:
            with open(full, "rb") as fh:
                magic = fh.read(4)
        except OSError:
            magic = b""
        faces = fc_query(full) if magic in MAGIC else []
        if not faces:  # not a real font: drop it
            rejected += 1
            try:
                os.remove(full)
            except OSError:
                pass
            continue
        fam, sty = faces[0][0], faces[0][1]
        folder = os.path.dirname(rel) or "(top level)"
        items.append({"i": len(items), "rel": rel, "folder": folder, "name": os.path.basename(full), "family": fam, "style": sty,
                      "faces": len(faces), "path": full, "size": os.path.getsize(full),
                      "dup": fam.lower() in names, "variable": False})
        with LOCK:
            ALLOWED.add(full)
    STAGES[sid] = {"dir": d, "items": items, "source": source}
    return {"stage": sid, "items": items, "skipped": skipped, "rejected": rejected, "source": source}


def _copy_limited(src, out, limit, used):
    """Copy while counting real bytes (the zip header can lie about its size)."""
    n = 0
    while True:
        chunk = src.read(262144)
        if not chunk:
            return n
        n += len(chunk)
        if n > limit:
            raise RuntimeError("A file in the zip is larger than %d MB. Stopped." % (limit >> 20))
        if used + n > MAX_TOTAL:
            raise RuntimeError("The zip unpacks to more than %d MB. Stopped." % (MAX_TOTAL >> 20))
        out.write(chunk)


def extract_zip(data, dest, subpath=""):
    count = 0
    total = 0
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise RuntimeError("The download is not a valid zip file.")
    names = [n for n in zf.namelist() if not n.endswith("/")]
    # GitHub zips have one top folder. Drop it so subpath matches the repo layout.
    strip = ""
    tops = {n.split("/")[0] for n in names}
    if len(tops) == 1 and all("/" in n for n in names):
        strip = tops.pop() + "/"
    subpath = subpath.strip("/")
    for info in zf.infolist():
        n = info.filename
        if n.endswith("/"):
            continue
        rel = n[len(strip):] if strip and n.startswith(strip) else n
        if subpath and not (rel == subpath or rel.startswith(subpath + "/")):
            continue
        ext = os.path.splitext(rel)[1].lower()
        if ext not in FONT_EXT + SKIP_EXT:
            continue
        inner = rel[len(subpath):].lstrip("/") if subpath else rel
        if not safe_rel(inner):          # the subpath names a single file
            inner = os.path.basename(rel)
        if not safe_rel(inner):
            continue
        target = unique_path(os.path.join(dest, safe_rel(inner)))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        try:
            with zf.open(info) as src, open(target, "wb") as out:
                total += _copy_limited(src, out, MAX_FILE, total)
        except RuntimeError:
            try:
                os.remove(target)
            except OSError:
                pass
            raise
        count += 1
    return count


def run_fetch(job, url):
    try:
        src = parse_source(url)
        sid, d = new_stage()
        kind = src["kind"]
        if kind == "github":
            job.text = "Contacting GitHub"
            try:
                data = http_get(src["zip"], job, "Downloading repository")
            except RuntimeError as e:
                if src["branch"] is None or "404" not in str(e):
                    raise
                raise RuntimeError("Branch '%s' was not found in %s." % (src["branch"], src["label"]))
            job.text = "Unpacking"
            extract_zip(data, d, src["sub"])
        elif kind == "zip":
            data = http_get(src["url"], job, "Downloading zip")
            job.text = "Unpacking"
            extract_zip(data, d)
        elif kind == "file":
            data = http_get(src["url"], job, "Downloading font")
            name = safe_rel(os.path.basename(urllib.parse.urlparse(src["url"]).path)) or "font.ttf"
            if name.lower().endswith(".zip"):
                extract_zip(data, d)
            else:
                if not name.lower().endswith(FONT_EXT + SKIP_EXT):
                    raise RuntimeError("That file is not a .ttf, .otf or .ttc font.")
                with open(os.path.join(d, name), "wb") as f:
                    f.write(data)
        elif kind == "google":
            job.text = "Looking up %s on Google Fonts" % src["name"]
            found = False
            for lic in ("ofl", "apache", "ufl"):
                api = "https://api.github.com/repos/google/fonts/contents/%s/%s" % (lic, src["slug"])
                try:
                    raw = http_get(api, accept="application/vnd.github+json")
                except RuntimeError as e:
                    if "404" in str(e):
                        continue
                    raise
                listing = json.loads(raw)
                files = [x for x in listing if x.get("type") == "file" and x["name"].lower().endswith(FONT_EXT)]
                if not files:
                    continue
                for n, x in enumerate(files):
                    job.text = "Downloading %d of %d: %s" % (n + 1, len(files), x["name"])
                    blob = http_get(x["download_url"])
                    with open(os.path.join(d, safe_rel(x["name"])), "wb") as f:
                        f.write(blob)
                found = True
                break
            if not found:
                raise RuntimeError("Could not find '%s' in the Google Fonts collection on GitHub." % src["name"])
        job.text = "Reading font info"
        result = build_stage(sid, d, {"url": url, "label": src["label"], "kind": kind}, job)
        if not result["items"]:
            msg = "No installable fonts (.ttf, .otf, .ttc) found in that link."
            if result.get("rejected"):
                msg += " %d files had a font name but were not valid fonts." % result["rejected"]
            if result["skipped"]:
                msg += " It has %d web font files (woff/woff2), which Linux does not use." % result["skipped"]
            raise RuntimeError(msg)
        job.result = result
        job.text = "Found %d font files" % len(result["items"])
    except ValueError as e:
        job.error = str(e)
    except RuntimeError as e:
        job.error = str(e)
    except Exception as e:  # keep the server alive; show a plain message
        job.error = "Something went wrong: %s" % e
    job.done = True


def safe_name(s, default="Fonts"):
    s = re.sub(r"[^\w.\- +()&,]", "_", s or "").strip(" .")
    return s[:80] or default


def do_install(body):
    if not isinstance(body, dict):
        raise ValueError("Bad request.")
    st = STAGES.get(body.get("stage"))
    if not st:
        raise ValueError("This preview has expired. Fetch the link again.")
    picks = body.get("files") or []
    if not isinstance(picks, list):
        raise ValueError("Bad request.")
    items = {it["i"]: it for it in st["items"]}
    chosen = [items[i] for i in picks if isinstance(i, int) and i in items]
    if not chosen:
        raise ValueError("Select at least one font file.")
    coll = safe_name(body.get("collection") or st["source"].get("label", "").split("/")[-1])
    root = font_dir_root()
    target = os.path.join(root, coll)
    if os.path.exists(target):  # never share a folder with an older install
        target = os.path.join(root, "%s-%s" % (coll, uuid.uuid4().hex[:6]))
    os.makedirs(target)
    written = []
    for it in chosen:
        rel = safe_rel(it["rel"]) or it["name"]
        dest = unique_path(os.path.join(target, rel))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copyfile(it["path"], dest)
        written.append(os.path.abspath(dest))
    subprocess.run(["fc-cache", "-f", target], capture_output=True, timeout=300)
    with LOCK:
        inst = {"id": uuid.uuid4().hex[:10], "collection": os.path.basename(target), "dir": os.path.abspath(target),
                "source": st["source"].get("url"), "files": written, "date": time.strftime("%Y-%m-%d %H:%M"),
                "families": sorted({it["family"] for it in chosen})}
        insts = load_installs()
        insts.append(inst)
        save_installs(insts)
    scan_fonts(True)
    shutil.rmtree(st["dir"], ignore_errors=True)
    STAGES.pop(body["stage"], None)
    return inst


def do_uninstall(inst_id):
    if not isinstance(inst_id, str) or not inst_id:
        raise ValueError("Typecase did not install that font.")
    with LOCK:
        insts = load_installs()
        inst = next((i for i in insts if i["id"] == inst_id), None)
        if not inst:
            raise ValueError("Typecase did not install that font.")
        root = os.path.realpath(font_dir_root())
        d = os.path.realpath(inst["dir"])
        removed = 0
        if d.startswith(root + "/"):      # only ever delete inside this install's own folder
            for f in inst["files"]:
                if not isinstance(f, str):
                    continue
                ap = os.path.abspath(f)
                if ap.startswith(os.path.abspath(inst["dir"]) + "/") and os.path.isfile(ap) and not os.path.islink(ap) \
                        and os.path.realpath(ap).startswith(d + "/"):
                    os.remove(ap)
                    removed += 1
            for dp, dn, fn in os.walk(d, topdown=False):
                if not os.listdir(dp):
                    os.rmdir(dp)
        save_installs([i for i in insts if i["id"] != inst_id])
    if removed:
        subprocess.run(["fc-cache", "-f", root], capture_output=True, timeout=300)
    scan_fonts(True)
    return removed


# ---------------------------------------------------------------- HTTP
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
        ".mjs": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8"}


class Handler(BaseHTTPRequestHandler):
    server_version = "Typecase"

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if "Cache-Control" not in (extra or {}):
            self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ValueError("Bad Content-Length.")
        if n < 0:
            raise ValueError("Bad Content-Length.")
        if n > 10 * 1024 * 1024:
            raise ValueError("Request too large.")
        raw = self.rfile.read(n) if n else b"{}"
        v = json.loads(raw or b"{}")
        if not isinstance(v, dict):
            raise ValueError("Bad request.")
        return v

    def _host_ok(self):
        h = (self.headers.get("Host") or "").split(":")[0]
        return h in ("127.0.0.1", "localhost")

    def _origin_ok(self):
        if not origin_ok(self.headers.get("Origin"), self.server.server_address[1]):
            return False
        return self.headers.get("Sec-Fetch-Site") in (None, "same-origin", "none")

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, {"error": "bad host"})
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if (u.path.startswith("/api/") or u.path == "/font") and not self._origin_ok():
            return self._send(403, {"error": "cross-site request refused"})
        try:
            if u.path == "/api/fonts":
                data = scan_fonts(q.get("refresh") == ["1"])
                state = load_state()
                return self._send(200, {"families": data["families"], "favorites": state.get("favorites", []),
                                        "installs": load_installs(), "fontDir": font_dir_root()})
            if u.path == "/api/fontinfo":
                path = (q.get("path") or [""])[0]
                with LOCK:
                    ok = path_allowed(path, ALLOWED)
                if not ok:
                    return self._send(404, {"error": "not an allowed font"})
                return self._send(200, font_info(path, int((q.get("index") or ["0"])[0] or 0)))
            if u.path == "/api/state":
                s = load_state()
                return self._send(200, {k: v for k, v in s.items() if k != "installs"})
            if u.path == "/api/job":
                j = JOBS.get((q.get("id") or [""])[0])
                if not j:
                    return self._send(404, {"error": "unknown job"})
                return self._send(200, j.public())
            if u.path == "/font":
                path = (q.get("path") or [""])[0]
                with LOCK:
                    ok = path_allowed(path, ALLOWED)
                if not ok and time.time() - _last_rescan[0] > 10:   # a miss may rescan, at most every 10 s
                    _last_rescan[0] = time.time()
                    scan_fonts(True)
                    with LOCK:
                        ok = path_allowed(path, ALLOWED)
                if not ok or not os.path.isfile(path):
                    return self._send(404, {"error": "not an allowed font"})
                try:
                    index = max(0, int((q.get("index") or ["0"])[0] or 0))
                except ValueError:
                    index = 0
                with open(path, "rb") as f:
                    data = f.read()
                if data[:4] == b"ttcf":
                    key = (path, index, len(data))
                    if key not in _face_cache:
                        if len(_face_cache) > 64:
                            _face_cache.clear()
                        try:
                            _face_cache[key] = extract_face(data, index)
                        except (ValueError, struct.error):
                            return self._send(404, {"error": "no such face"})
                    data = _face_cache[key]
                    path = path[:-4] + ".ttf" if path.lower().endswith(".ttc") else path
                ext = os.path.splitext(path)[1].lower()
                ctype = {"otf": "font/otf", "ttf": "font/ttf", "ttc": "font/collection"}.get(ext[1:], "application/octet-stream")
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "max-age=3600")
                self.end_headers()
                self.wfile.write(data)
                return
            return self._static(u.path)
        except Exception as e:
            return self._send(500, {"error": str(e)})

    def _static(self, p):
        if p in ("", "/"):
            p = "/index.html"
        full = os.path.normpath(os.path.join(STATIC, p.lstrip("/")))
        if not full.startswith(STATIC + "/") or not os.path.isfile(full):
            return self._send(404, {"error": "not found"})
        with open(full, "rb") as f:
            data = f.read()
        self._send(200, data, MIME.get(os.path.splitext(full)[1], "application/octet-stream"),
                   {"Cache-Control": "max-age=86400"} if p.startswith("/vendor/") else None)

    def do_POST(self):
        if not self._host_ok():
            return self._send(403, {"error": "bad host"})
        if not self._origin_ok():
            return self._send(403, {"error": "cross-site request refused"})
        if not (self.headers.get("Content-Type") or "").lower().startswith("application/json"):
            return self._send(415, {"error": "Content-Type must be application/json"})
        u = urllib.parse.urlparse(self.path)
        try:
            body = self._body()
            if u.path == "/api/fetch":
                try:
                    parse_source(body.get("url"))
                except ValueError as e:
                    return self._send(400, {"error": str(e)})
                job = Job()
                threading.Thread(target=run_fetch, args=(job, body.get("url")), daemon=True).start()
                return self._send(200, {"job": job.id})
            if u.path == "/api/install":
                return self._send(200, do_install(body))
            if u.path == "/api/uninstall":
                return self._send(200, {"removed": do_uninstall(body.get("id"))})
            if u.path == "/api/cancel":
                st = STAGES.pop(body.get("stage"), None)
                if st:
                    shutil.rmtree(st["dir"], ignore_errors=True)
                return self._send(200, {"ok": True})
            if u.path == "/api/state":
                with LOCK:
                    s = load_state()
                    key = body.get("key")
                    val = body.get("value")
                    if key not in ("favorites", "canvas", "prefs") or \
                            not isinstance(val, list if key == "favorites" else dict):
                        return self._send(400, {"error": "bad key or value"})
                    s[key] = body.get("value")
                    save_state(s)
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "not found"})
        except ValueError as e:
            return self._send(400, {"error": str(e)})
        except Exception as e:
            return self._send(500, {"error": str(e)})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    shutil.rmtree(STAGE_ROOT, ignore_errors=True)
    os.makedirs(STAGE_ROOT, exist_ok=True)
    scan_fonts(True)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(srv.server_address[1], flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
