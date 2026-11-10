import io
import json
import os
import shutil
import threading
import unittest
import zipfile
import http.client
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(HERE, ".cache", "unit-tmp")
os.makedirs(TMP, exist_ok=True)
os.environ["TYPECASE_STATE"] = os.path.join(TMP, "import-state.json")
import typecase as t


class ParseSource(unittest.TestCase):
    def test_repo(self):
        s = t.parse_source("https://github.com/example/Some-Font")
        self.assertEqual((s["kind"], s["owner"], s["repo"], s["branch"]), ("github", "example", "Some-Font", None))
        self.assertTrue(s["zip"].endswith("/zip/HEAD"))

    def test_tree_root(self):
        s = t.parse_source("https://github.com/example/Some-Font/tree/main")
        self.assertEqual((s["branch"], s["sub"]), ("main", ""))
        self.assertEqual(s["zip"], "https://codeload.github.com/example/Some-Font/zip/refs/heads/main")

    def test_tree_sub(self):
        s = t.parse_source("https://github.com/o/r/tree/dev/fonts/Sans")
        self.assertEqual((s["branch"], s["sub"]), ("dev", "fonts/Sans"))

    def test_blob_and_raw(self):
        a = t.parse_source("https://github.com/o/r/blob/main/f/A%20B.ttf")
        self.assertEqual(a["kind"], "file")
        self.assertEqual(a["url"], "https://raw.githubusercontent.com/o/r/main/f/A%20B.ttf")
        b = t.parse_source("https://raw.githubusercontent.com/o/r/main/x.otf")
        self.assertEqual(b["kind"], "file")

    def test_direct(self):
        self.assertEqual(t.parse_source("https://example.com/a/b.TTF")["kind"], "file")
        self.assertEqual(t.parse_source("https://example.com/a.zip")["kind"], "zip")
        self.assertEqual(t.parse_source("example.com/a.otf")["kind"], "file")

    def test_woff_rejected(self):
        with self.assertRaises(ValueError):
            t.parse_source("https://example.com/a.woff2")

    def test_google(self):
        s = t.parse_source("https://fonts.google.com/specimen/Open+Sans?query=open")
        self.assertEqual((s["kind"], s["slug"]), ("google", "opensans"))

    def test_bad(self):
        for bad in ("", "https://example.com/page", "ftp://x/a.ttf", "https://github.com/onlyowner"):
            with self.assertRaises(ValueError):
                t.parse_source(bad)


class Allowlist(unittest.TestCase):
    A = {"/usr/share/fonts/a.ttf", "/home/u/.local/share/fonts/b.otf"}

    def test_ok(self):
        self.assertTrue(t.path_allowed("/usr/share/fonts/a.ttf", self.A))

    def test_reject(self):
        for p in ("/etc/passwd", "/usr/share/fonts/../../etc/passwd", "usr/share/fonts/a.ttf", "",
                  "/usr/share/fonts//a.ttf", "/usr/share/fonts/./a.ttf", "/usr/share/fonts/a.ttf\x00.png",
                  "/usr/share/fonts/a.ttf/"):
            self.assertFalse(t.path_allowed(p, self.A), p)


import os, subprocess

def _first(cond):
    out = subprocess.run(["fc-list", "--format", "%{file}\t%{variable}\n"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        f, _, v = line.partition("\t")
        if cond(f, v) and os.path.isfile(f):
            return f


class Tables(unittest.TestCase):
    def test_variable_font(self):
        f = _first(lambda f, v: v == "True" and f.lower().endswith(".ttf") and "Italic" not in f)
        if not f:
            self.skipTest("no variable font installed")
        d = t.parse_font_tables(f)
        self.assertTrue(d["axes"], f)
        a = d["axes"][0]
        self.assertEqual(len(a["tag"]), 4)
        self.assertLessEqual(a["min"], a["default"])
        self.assertLessEqual(a["default"], a["max"])
        self.assertTrue(d["instances"])
        self.assertIn("kern", [x["tag"] for x in d["features"]] + ["kern"])

    def test_static_otf(self):
        f = _first(lambda f, v: v != "True" and f.lower().endswith(".otf"))
        if not f:
            self.skipTest("no OTF installed")
        d = t.parse_font_tables(f)
        self.assertEqual(d["axes"], [])
        tags = [x["tag"] for x in d["features"]]
        self.assertTrue(tags)
        self.assertTrue(all(x["label"] for x in d["features"]))

    def test_garbage(self):
        with self.assertRaises(Exception):
            t.parse_font_tables(__file__)


def _a_font():
    return _first(lambda f, v: f.lower().endswith((".ttf", ".otf")))


class Sandbox(unittest.TestCase):
    """Point the module at a private state folder and font folder inside .cache."""
    def setUp(self):
        self.dir = os.path.join(TMP, self.id().split(".")[-1])
        shutil.rmtree(self.dir, ignore_errors=True)
        os.makedirs(self.dir)
        self.saved = (t.STATE_PATH, t.INSTALLS_PATH, os.environ.get("TYPECASE_FONT_DIR"), t.MAX_FILE, t.MAX_TOTAL)
        t.STATE_PATH = os.path.join(self.dir, "state.json")
        t.INSTALLS_PATH = os.path.join(self.dir, "installs.json")
        os.environ["TYPECASE_FONT_DIR"] = os.path.join(self.dir, "fonts")

    def tearDown(self):
        t.STATE_PATH, t.INSTALLS_PATH, fd, t.MAX_FILE, t.MAX_TOTAL = self.saved
        if fd is None:
            os.environ.pop("TYPECASE_FONT_DIR", None)
        else:
            os.environ["TYPECASE_FONT_DIR"] = fd
        shutil.rmtree(self.dir, ignore_errors=True)


class Csrf(Sandbox):
    def setUp(self):
        super().setUp()
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), t.Handler)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        super().tearDown()

    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        r.read()
        return r.status

    def test_origin_function(self):
        self.assertTrue(t.origin_ok(None, 5))
        self.assertTrue(t.origin_ok("http://127.0.0.1:5", 5))
        self.assertTrue(t.origin_ok("http://localhost:5", 5))
        for bad in ("https://evil.example", "http://127.0.0.1:6", "null", "http://127.0.0.1.evil.com:5", ""):
            self.assertFalse(t.origin_ok(bad, 5), bad)

    def test_post_rules(self):
        body = json.dumps({"key": "prefs", "value": {"a": 1}})
        js = {"Content-Type": "application/json"}
        self.assertEqual(self.req("POST", "/api/state", body, js), 200)
        self.assertEqual(self.req("POST", "/api/state", body, dict(js, Origin="http://127.0.0.1:%d" % self.port)), 200)
        self.assertEqual(self.req("POST", "/api/state", body, dict(js, Origin="https://evil.example")), 403)
        self.assertEqual(self.req("POST", "/api/state", body, {"Content-Type": "text/plain"}), 415)
        self.assertEqual(self.req("POST", "/api/state", body, {}), 415)
        self.assertEqual(self.req("POST", "/api/state", body, dict(js, **{"Content-Length": "-5"})), 400)
        self.assertEqual(self.req("POST", "/api/uninstall", "[1]", js), 400)

    def test_vendored_harfbuzz_is_served_with_right_types(self):
        for path, ctype in (("/vendor/harfbuzz/harfbuzz.wasm", "application/wasm"), ("/vendor/harfbuzz/index.mjs", "text/javascript")):
            c = http.client.HTTPConnection("127.0.0.1", self.port)
            c.request("GET", path)
            r = c.getresponse()
            body = r.read()
            self.assertEqual(r.status, 200, path)
            self.assertTrue(r.getheader("Content-Type").startswith(ctype), path)
            self.assertTrue(len(body) > 1000)
        self.assertTrue(os.path.exists(os.path.join(HERE, "static", "vendor", "harfbuzz", "LICENSE")))

    def test_get_rules(self):
        self.assertEqual(self.req("GET", "/api/state"), 200)
        self.assertEqual(self.req("GET", "/api/state", headers={"Origin": "https://evil.example"}), 403)
        self.assertEqual(self.req("GET", "/font?path=/etc/passwd", headers={"Sec-Fetch-Site": "cross-site"}), 403)
        self.assertEqual(self.req("GET", "/font?path=/etc/passwd"), 404)
        self.assertEqual(self.req("GET", "/", headers={"Origin": "https://evil.example"}), 200)  # the page itself


class StateFiles(Sandbox):
    def test_corrupt_state_is_moved_aside_and_installs_survive(self):
        t.save_installs([{"id": "abc", "dir": "/x", "files": []}])
        with open(t.STATE_PATH, "w") as f:
            f.write("{not json")
        self.assertEqual(t.load_state(), {})
        bad = [n for n in os.listdir(self.dir) if n.startswith("state.json.bad-")]
        self.assertEqual(len(bad), 1)
        self.assertEqual(open(os.path.join(self.dir, bad[0])).read(), "{not json")
        t.save_state({"favorites": ["A"]})
        self.assertEqual([i["id"] for i in t.load_installs()], ["abc"])

    def test_old_layout_installs_are_migrated(self):
        with open(t.STATE_PATH, "w") as f:
            json.dump({"favorites": [], "installs": [{"id": "old", "dir": "/x", "files": []}]}, f)
        t.load_state()
        self.assertEqual([i["id"] for i in t.load_installs()], ["old"])
        self.assertNotIn("installs", t.load_state())

    def test_bad_install_records_dropped(self):
        t.save_installs([{"dir": "/x", "files": []}, {"id": "ok", "dir": "/x", "files": []}, 5])
        self.assertEqual([i["id"] for i in t.load_installs()], ["ok"])


def _zip(entries):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            z.writestr(name, data)
    return b.getvalue()


class ZipLimits(Sandbox):
    def test_single_file_cap(self):
        t.MAX_FILE = 1 << 20
        with self.assertRaises(RuntimeError):
            t.extract_zip(_zip([("big.ttf", b"\0" * (3 << 20))]), self.dir)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "big.ttf")))

    def test_total_cap(self):
        t.MAX_TOTAL = 3 << 20
        with self.assertRaises(RuntimeError):
            t.extract_zip(_zip([("a%d.ttf" % i, b"\0" * (1 << 20)) for i in range(5)]), self.dir)

    def test_real_limits_pass_small(self):
        self.assertEqual(t.extract_zip(_zip([("a.ttf", b"x"), ("b/c.otf", b"y")]), self.dir), 2)

    def test_name_collisions_get_suffix(self):
        t.extract_zip(_zip([("f?.ttf", b"1"), ("f*.ttf", b"2")]), self.dir)
        self.assertEqual(len(os.listdir(self.dir)), 2)

    def test_subpath_is_single_file(self):
        n = t.extract_zip(_zip([("repo-main/fonts/A.ttf", b"x"), ("repo-main/fonts/B.ttf", b"y")]), self.dir, "fonts/A.ttf")
        self.assertEqual((n, os.listdir(self.dir)), (1, ["A.ttf"]))


class FakeJob:
    text = ""


class RejectNonFonts(Sandbox):
    def test_junk_dropped_real_font_kept(self):
        real = _a_font()
        if not real:
            self.skipTest("no font")
        stage = os.path.join(self.dir, "stage")
        os.makedirs(stage)
        shutil.copy(real, os.path.join(stage, "good" + os.path.splitext(real)[1]))
        open(os.path.join(stage, "html.ttf"), "w").write("<html>not a font</html>")
        open(os.path.join(stage, "magic.otf"), "wb").write(b"OTTO" + b"\0" * 20)   # right magic, no faces
        t.STAGE_ROOT = os.path.join(self.dir, "x")
        res = t.build_stage("s1", stage, {"label": "x"}, FakeJob())
        self.assertEqual([i["name"][:4] for i in res["items"]], ["good"])
        self.assertEqual(res["rejected"], 2)
        self.assertEqual([i["i"] for i in res["items"]], [0])


class InstallUninstall(Sandbox):
    def stage(self, n=2):
        real = _a_font()
        if not real:
            self.skipTest("no font")
        d = os.path.join(self.dir, "stage")
        os.makedirs(d, exist_ok=True)
        items = []
        for k in range(n):
            p = os.path.join(d, "f%d%s" % (k, os.path.splitext(real)[1]))
            shutil.copy(real, p)
            items.append({"i": k, "rel": os.path.basename(p), "name": os.path.basename(p), "path": p, "family": "Fam"})
        t.STAGES["st"] = {"dir": d, "items": items, "source": {"url": "u", "label": "o/Coll"}}
        return t.STAGES["st"]

    def test_unique_folders_and_scoped_removal(self):
        self.stage()
        a = t.do_install({"stage": "st", "files": [0, 1], "collection": "Same"})
        self.stage()
        b = t.do_install({"stage": "st", "files": [0], "collection": "Same"})
        self.assertNotEqual(a["dir"], b["dir"])
        self.assertTrue(all(f.startswith(a["dir"] + "/") for f in a["files"]))
        outside = os.path.join(self.dir, "precious.ttf")
        open(outside, "w").write("keep")
        recs = t.load_installs()
        recs[0]["files"].append(outside)                 # a tampered record
        recs[0]["files"].append(b["files"][0])           # a file that belongs to the other install
        t.save_installs(recs)
        self.assertEqual(t.do_uninstall(a["id"]), 2)
        self.assertTrue(os.path.exists(outside))
        self.assertTrue(os.path.exists(b["files"][0]))
        self.assertFalse(os.path.exists(a["dir"]))
        self.assertEqual([i["id"] for i in t.load_installs()], [b["id"]])

    def test_removed_zero(self):
        self.stage()
        a = t.do_install({"stage": "st", "files": [0], "collection": "Gone"})
        for f in a["files"]:
            os.remove(f)
        self.assertEqual(t.do_uninstall(a["id"]), 0)

    def test_record_dir_outside_root_removes_nothing(self):
        victim = os.path.join(self.dir, "victim")
        os.makedirs(victim)
        v = os.path.join(victim, "a.ttf")
        open(v, "w").write("x")
        t.save_installs([{"id": "evil", "dir": victim, "files": [v]}])
        self.assertEqual(t.do_uninstall("evil"), 0)
        self.assertTrue(os.path.exists(v))

    def test_bad_ids(self):
        for bad in (None, "", 5, ["a"], "nope"):
            with self.assertRaises(ValueError):
                t.do_uninstall(bad)


class Ttc(unittest.TestCase):
    def test_face_extraction(self):
        f = _first(lambda f, v: f.lower().endswith(".ttc"))
        if not f:
            self.skipTest("no ttc installed")
        data = open(f, "rb").read()
        n = int.from_bytes(data[8:12], "big")
        one = t.extract_face(data, min(1, n - 1))
        self.assertIn(one[:4], (b"\x00\x01\x00\x00", b"OTTO", b"true"))
        out = os.path.join(TMP, "face.ttf")
        with open(out, "wb") as fh:
            fh.write(one)
        faces = t.fc_query(out)
        self.assertEqual(len(faces), 1)
        self.assertTrue(faces[0][0])
        with self.assertRaises(ValueError):
            t.extract_face(data, n)


class PublicOnly(unittest.TestCase):
    def test_private_addresses_refused(self):
        for u in ("http://127.0.0.1/a.ttf", "http://localhost:8000/a.ttf", "http://192.168.1.1/a.ttf", "http://169.254.169.254/x", "ftp://example.com/a.ttf", "file:///etc/passwd"):
            with self.assertRaises(RuntimeError, msg=u):
                t.check_public_url(u)

    def test_tree_url_to_font_file(self):
        s = t.parse_source("https://github.com/o/r/tree/main/fonts/A.ttf")
        self.assertEqual(s["kind"], "file")



class GoogleLinkTests(unittest.TestCase):
    def test_messy_google_links(self):
        cases = {
            "https://fonts.google.com/share?selection.family=Doto:wght@100..900": "Doto",
            "fonts.google.com/share?selection.family=Doto:wght@100..900": "Doto",
            " see https://fonts.google.com/specimen/Open+Sans?query=x for this": "Open Sans",
            "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900&family=Roboto": "Inter",
            "https://fonts.google.com/?query=Space+Grotesk": "Space Grotesk",
            "https://fonts.google.com/selection?selection.family=Bricolage+Grotesque:opsz,wght@12..96,200..800|Inter": "Bricolage Grotesque",
            "<https://fonts.google.com/specimen/DM+Serif+Display>": "DM Serif Display",
            "Doto": "Doto",
            "Open Sans": "Open Sans",
        }
        for url, name in cases.items():
            s = t.parse_source(url)
            self.assertEqual((s["kind"], s["name"]), ("google", name), url)
        self.assertEqual(t.parse_source("Open Sans")["slug"], "opensans")

    def test_google_link_without_family(self):
        with self.assertRaises(ValueError):
            t.parse_source("https://fonts.google.com/")

if __name__ == "__main__":
    unittest.main()
