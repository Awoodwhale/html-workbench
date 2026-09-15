import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from types import SimpleNamespace
from unittest import mock
from html.parser import HTMLParser
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = PROJECT_ROOT / "service" / "server" / "workbench.py"
SPEC = importlib.util.spec_from_file_location("workbench", MODULE_PATH)
workbench = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = workbench
SPEC.loader.exec_module(workbench)


SAMPLE_HTML = """<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="styles/site.css">
  <style>.card { color: red; }</style>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="page">
  <main><h1>Hello</h1><img src="images/demo.png"></main>
  <script>window.ready = true</script>
</body>
</html>
"""


class BundleInspector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.links = []
        self.bundles = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "script":
            self.scripts.append(attributes)
        if tag == "link":
            self.links.append(attributes)
        if attributes.get("data-bundle"):
            self.bundles.append((tag, attributes["data-bundle"]))


class BundleTests(unittest.TestCase):
    def test_frontend_keeps_only_vendor_assets_external(self):
        bundle = PROJECT_ROOT / "skill" / "html-workbench" / "assets" / "workbench.html"
        inspector = BundleInspector()
        inspector.feed(bundle.read_text(encoding="utf-8"))
        self.assertTrue(inspector.scripts)
        self.assertEqual(
            [script.get("src") for script in inspector.scripts if script.get("src")],
            ["/vendor/grapesjs/grapes.min.js"],
        )
        self.assertEqual(
            [link.get("href") for link in inspector.links if link.get("rel") == "stylesheet"],
            ["/vendor/grapesjs/css/grapes.min.css"],
        )
        self.assertEqual(sorted(inspector.bundles), [
            ("script", "workbench"),
            ("style", "workbench"),
        ])
        self.assertLess(bundle.stat().st_size, 100_000)

    def test_frontend_exposes_edit_and_preview_modes(self):
        bundle = PROJECT_ROOT / "skill" / "html-workbench" / "assets" / "workbench.html"
        source = bundle.read_text(encoding="utf-8")
        self.assertIn('data-mode="edit"', source)
        self.assertIn('data-mode="preview"', source)
        self.assertIn('id="preview-frame"', source)
        self.assertIn("previewFrame.srcdoc = buildPreviewDocument()", source)
        self.assertIn("workbenchMode !== 'edit'", source)


class ParserTests(unittest.TestCase):
    def test_fixture_contains_realistic_editable_sections(self):
        fixture = (PROJECT_ROOT / "tests" / "fixtures" / "sample.html").read_text(encoding="utf-8")
        document = workbench.parse_source(fixture)
        self.assertIn("class=\"hero", document["bodyHtml"])
        self.assertIn("class=\"bento", document["bodyHtml"])
        self.assertIn("class=\"workflow", document["bodyHtml"])
        self.assertIn("assets/workbench-studio.webp", document["bodyHtml"])
        self.assertGreater(len(document["bodyHtml"]), 3_000)

    def test_extracts_document_context(self):
        document = workbench.parse_source(SAMPLE_HTML)
        self.assertEqual(document["htmlAttributes"]["lang"], "zh-CN")
        self.assertEqual(document["bodyAttributes"]["class"], "page")
        self.assertEqual(document["links"], ["styles/site.css"])
        self.assertIn(".card", document["sourceCss"])
        self.assertEqual(document["headScripts"][0]["attributes"]["src"], "https://cdn.tailwindcss.com")
        self.assertNotIn("window.ready", document["bodyHtml"])
        self.assertIn("window.ready", document["bodyScripts"][0])

    def test_requires_complete_document(self):
        with self.assertRaises(workbench.WorkbenchError) as context:
            workbench.parse_source("<div>fragment</div>")
        self.assertEqual(context.exception.code, "INVALID_DOCUMENT")


class SaveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.page = self.root / "page.html"
        self.page.write_text(SAMPLE_HTML, encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_saves_body_and_override_css_atomically(self):
        current = workbench.read_document(self.page)
        updated = workbench.save_document(self.page, {
            "baseRevision": current["revision"],
            "bodyHtml": "<main><h1>Updated</h1></main>",
            "css": "h1 { color: blue; }",
            "bodyScripts": current["bodyScripts"],
        })
        source = self.page.read_text(encoding="utf-8")
        self.assertIn("<h1>Updated</h1>", source)
        self.assertIn("data-grapesjs-overrides", source)
        self.assertIn("h1 { color: blue; }", source)
        self.assertIn("window.ready = true", source)
        self.assertNotEqual(current["revision"], updated["revision"])

    def test_preserves_inline_event_attributes_stripped_by_grapesjs(self):
        source = """<!doctype html>
<html><head><title>Events</title></head><body>
  <button id="switcher" onclick="switchMode('daemon')">Daemon</button>
  <section data-mode="daemon"><p>Content</p></section>
  <script>function switchMode() {}</script>
</body></html>"""
        self.page.write_text(source, encoding="utf-8")
        current = workbench.read_document(self.page)
        # Simulate GrapesJS serialization: component markup retains the element
        # but silently drops its inline onclick attribute.
        workbench.save_document(self.page, {
            "baseRevision": current["revision"],
            "bodyHtml": """
  <button id=\"switcher\">Daemon</button>
  <section data-mode=\"daemon\"><p>Edited content</p></section>
""",
            "css": "",
            "bodyScripts": current["bodyScripts"],
        })
        saved = self.page.read_text(encoding="utf-8")
        self.assertIn('onclick="switchMode(&#x27;daemon&#x27;)"', saved)
        self.assertIn("Edited content", saved)

    def test_does_not_restore_handler_when_source_element_was_deleted(self):
        source = """<!doctype html>
<html><head><title>Events</title></head><body>
  <button id="removed" onclick="run()">Remove me</button>
</body></html>"""
        self.page.write_text(source, encoding="utf-8")
        current = workbench.read_document(self.page)
        workbench.save_document(self.page, {
            "baseRevision": current["revision"],
            "bodyHtml": "<main>Remaining content</main>",
            "css": "",
        })
        saved = self.page.read_text(encoding="utf-8")
        self.assertNotIn("onclick=", saved)

    def test_rejects_stale_revision(self):
        current = workbench.read_document(self.page)
        self.page.write_text(SAMPLE_HTML.replace("Hello", "External"), encoding="utf-8")
        with self.assertRaises(workbench.WorkbenchError) as context:
            workbench.save_document(self.page, {
                "baseRevision": current["revision"],
                "bodyHtml": "<main>Browser</main>",
                "css": "",
            })
        self.assertEqual(context.exception.code, "REVISION_CONFLICT")
        self.assertIn("External", context.exception.extra["document"]["html"])


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.page = self.root / "page.html"
        self.page.write_text(SAMPLE_HTML, encoding="utf-8")
        self.asset = self.root / "workbench.html"
        self.asset.write_text("<!doctype html><title>Workbench</title>", encoding="utf-8")
        self.vendor = {}
        for name in workbench.VENDOR_ASSETS:
            path = self.root / name
            path.write_bytes(f"test-{name}".encode())
            self.vendor[name] = path
        self.server = workbench.WorkbenchServer(
            ("127.0.0.1", 0), self.asset, self.root, self.vendor,
            log_dir=self.root / "logs", vendor_cache=self.root / "vendor",
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def read_json(self, route):
        with urllib.request.urlopen(self.base + route, timeout=2) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def test_health_and_document_endpoints(self):
        status, health = self.read_json("/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(health["service"], workbench.SERVICE_NAME)
        # The host reports these in its diagnostics. A REUSED service leaves it no
        # startup output, so /api/health is the only way it can learn — and show —
        # the directories really in use.
        self.assertEqual(health["logDir"], str(self.root / "logs"))
        self.assertEqual(health["vendorCache"], str(self.root / "vendor"))
        query = urllib.parse.urlencode({"file": str(self.page)})
        status, document = self.read_json(f"/api/document?{query}")
        self.assertEqual(status, 200)
        self.assertEqual(document["fileName"], "page.html")

    def test_serves_file_outside_editor_root(self):
        outside = Path(self.temp.name).parent / "outside-workbench.html"
        outside.write_text(SAMPLE_HTML, encoding="utf-8")
        self.addCleanup(lambda: outside.unlink(missing_ok=True))
        query = urllib.parse.urlencode({"file": str(outside)})
        status, document = self.read_json(f"/api/document?{query}")
        self.assertEqual(status, 200)
        self.assertEqual(document["fileName"], "outside-workbench.html")

    def test_serves_vendor_assets_locally(self):
        route = workbench.VENDOR_ASSETS["grapes.min.js"]["route"]
        with urllib.request.urlopen(self.base + route, timeout=2) as response:
            self.assertEqual(response.read(), b"test-grapes.min.js")
            self.assertIn("immutable", response.headers["Cache-Control"])


HEALTHY_PAYLOAD = {
    "service": workbench.SERVICE_NAME,
    "capabilities": list(workbench.SERVICE_CAPABILITIES),
}


class OpenCommandTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.page = self.root / "page.html"
        self.page.write_text(SAMPLE_HTML, encoding="utf-8")
        self.args = SimpleNamespace(
            file=str(self.page),
            editor_root=str(self.root),
            port=4317,
            asset=None,
            vendor_cache=str(self.root / "vendor"),
            log_dir=str(self.root / "logs"),
            wait=0.2,
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_open_reuses_healthy_service_without_starting_again(self):
        output = io.StringIO()
        with mock.patch.object(workbench, "health", return_value=HEALTHY_PAYLOAD), \
             mock.patch.object(workbench, "start_detached") as start, \
             contextlib.redirect_stdout(output):
            self.assertEqual(workbench.command_open(self.args, MODULE_PATH), 0)
        payload = json.loads(output.getvalue())
        self.assertTrue(payload["reused"])
        self.assertNotIn("pid", payload)
        start.assert_not_called()

    def test_open_starts_service_when_no_healthy_service_exists(self):
        output = io.StringIO()
        with mock.patch.object(workbench, "health", side_effect=[None, HEALTHY_PAYLOAD]), \
             mock.patch.object(workbench, "start_detached", return_value=(12345, self.root / "service.log")) as start, \
             contextlib.redirect_stdout(output):
            self.assertEqual(workbench.command_open(self.args, MODULE_PATH), 0)
        payload = json.loads(output.getvalue())
        self.assertFalse(payload["reused"])
        self.assertEqual(payload["pid"], 12345)
        start.assert_called_once()

    # A long-lived service keeps running the code it was started with, but serves
    # HTML/JS from disk on every request. Reusing an old process therefore feeds a
    # NEW frontend to an OLD API, and the missing route answers 501 with an HTML
    # error page that the frontend cannot parse as JSON. These tests pin the gate
    # that makes `open` retire such a process instead of reusing it.
    def test_open_refuses_to_reuse_service_missing_a_capability(self):
        stale = {"service": workbench.SERVICE_NAME, "capabilities": ["grapesjs-canvas", "autosave"]}
        output = io.StringIO()
        with mock.patch.object(workbench, "health", side_effect=[stale, None, HEALTHY_PAYLOAD]), \
             mock.patch.object(workbench, "stop_service", return_value=True) as stop, \
             mock.patch.object(workbench, "start_detached", return_value=(999, self.root / "service.log")) as start, \
             contextlib.redirect_stdout(output):
            self.assertEqual(workbench.command_open(self.args, MODULE_PATH), 0)
        stop.assert_called_once()
        start.assert_called_once()
        self.assertFalse(json.loads(output.getvalue())["reused"])

    def test_open_fails_loudly_when_outdated_service_will_not_stop(self):
        stale = {"service": workbench.SERVICE_NAME, "capabilities": []}
        with mock.patch.object(workbench, "health", return_value=stale), \
             mock.patch.object(workbench, "stop_service", return_value=False), \
             mock.patch.object(workbench, "start_detached") as start:
            with self.assertRaises(workbench.WorkbenchError) as caught:
                workbench.command_open(self.args, MODULE_PATH)
        self.assertEqual(caught.exception.code, "SERVER_OUTDATED")
        start.assert_not_called()

    def test_is_reusable_requires_every_advertised_capability(self):
        self.assertTrue(workbench.is_reusable(HEALTHY_PAYLOAD))
        # A future service may advertise more; that is still compatible.
        self.assertTrue(workbench.is_reusable({"capabilities": list(workbench.SERVICE_CAPABILITIES) + ["future"]}))
        self.assertFalse(workbench.is_reusable({"capabilities": []}))
        self.assertFalse(workbench.is_reusable({}))
        self.assertFalse(workbench.is_reusable(None))


class StopCommandTests(unittest.TestCase):
    """`stop` exists so a caller can recover from PORT_IN_USE.

    The listener is often a process the caller does not own (a leftover from an
    earlier run), so the plugin calls this blindly before spawning. That makes
    "nothing was listening" a SUCCESS, not an error.
    """

    def test_stop_succeeds_when_nothing_listens(self):
        args = SimpleNamespace(port=4318)
        output = io.StringIO()
        with mock.patch.object(workbench, "health", return_value=None), \
             mock.patch.object(workbench, "listeners_on_port", return_value=[]), \
             mock.patch.object(workbench, "stop_service") as stop, \
             contextlib.redirect_stdout(output):
            self.assertEqual(workbench.command_stop(args), 0)
        payload = json.loads(output.getvalue())
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["stopped"])
        stop.assert_not_called()

    def test_stop_retires_a_live_service(self):
        args = SimpleNamespace(port=4318)
        output = io.StringIO()
        with mock.patch.object(workbench, "health", return_value=HEALTHY_PAYLOAD), \
             mock.patch.object(workbench, "stop_service", return_value=True) as stop, \
             contextlib.redirect_stdout(output):
            self.assertEqual(workbench.command_stop(args), 0)
        self.assertTrue(json.loads(output.getvalue())["stopped"])
        stop.assert_called_once_with(4318)

    def test_stop_kills_a_listener_that_fails_health(self):
        # A half-dead process still holds the port, so binding would fail. It must
        # be retired even though `health` cannot reach it.
        args = SimpleNamespace(port=4318)
        output = io.StringIO()
        with mock.patch.object(workbench, "health", return_value=None), \
             mock.patch.object(workbench, "listeners_on_port", return_value=[4242]), \
             mock.patch.object(workbench, "stop_service", return_value=True) as stop, \
             contextlib.redirect_stdout(output):
            self.assertEqual(workbench.command_stop(args), 0)
        self.assertTrue(json.loads(output.getvalue())["stopped"])
        stop.assert_called_once()

    def test_stop_reports_failure_when_the_port_stays_busy(self):
        args = SimpleNamespace(port=4318)
        with mock.patch.object(workbench, "health", return_value=HEALTHY_PAYLOAD), \
             mock.patch.object(workbench, "stop_service", return_value=False):
            with self.assertRaises(workbench.WorkbenchError) as caught:
                workbench.command_stop(args)
        self.assertEqual(caught.exception.code, "SERVER_OUTDATED")


class CrossPlatformProcessTests(unittest.TestCase):
    """The service is dependency-free, including on Windows.

    DSH uses the same `stop` recovery path everywhere, so a Windows port holder
    must be visible and terminable without relying on Unix-only `lsof`/signals.
    """

    def test_windows_listener_parser_reads_netstat_listening_pid(self):
        netstat = """\
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:4317         0.0.0.0:0              LISTENING       9123
  TCP    127.0.0.1:9999         0.0.0.0:0              LISTENING       4567
  TCP    [::]:4317              [::]:0                 LISTENING       9124
  TCP    127.0.0.1:4317         127.0.0.1:55555        ESTABLISHED     9999
"""
        result = SimpleNamespace(stdout=netstat)
        with mock.patch.object(workbench.os, "name", "nt"), \
             mock.patch.object(workbench.subprocess, "run", return_value=result) as run, \
             mock.patch.object(workbench.os, "getpid", return_value=1):
            self.assertEqual(workbench.listeners_on_port(4317), [9123, 9124])
        run.assert_called_once_with(
            ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, timeout=5,
        )

    def test_windows_terminate_uses_taskkill_for_the_process_tree(self):
        with mock.patch.object(workbench.os, "name", "nt"), \
             mock.patch.object(workbench.subprocess, "run") as run:
            workbench.terminate_process(9123)
        run.assert_called_once_with(
            ["taskkill", "/PID", "9123", "/T", "/F"], capture_output=True, text=True, timeout=5,
        )

    def test_wait_for_port_free_does_not_treat_unhealthy_listener_as_free(self):
        # Regression: health=None only says the service does not answer; it does
        # NOT say TCP bind will work. We must wait for the listener to disappear.
        with mock.patch.object(workbench, "listeners_on_port", side_effect=[[9123], []]), \
             mock.patch.object(workbench.time, "sleep"):
            self.assertTrue(workbench.wait_for_port_free(4317, 1.0))


class FileReferenceTests(unittest.TestCase):
    """Address-bar input accepts native paths and browser-copied file:// URLs."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.page = self.root / "含 空格.html"
        self.page.write_text(SAMPLE_HTML, encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_decodes_percent_encoded_file_url(self):
        url = self.page.as_uri()
        self.assertIn("%20", url)
        self.assertEqual(workbench.normalize_file_reference(url), str(self.page))
        self.assertEqual(workbench.resolve_html_file(url), self.page.resolve())

    def test_native_path_is_unchanged(self):
        self.assertEqual(workbench.normalize_file_reference(str(self.page)), str(self.page))

    def test_rejects_file_url_with_query_or_hash(self):
        for suffix in ("?version=2", "#section"):
            with self.assertRaises(workbench.WorkbenchError) as caught:
                workbench.normalize_file_reference(self.page.as_uri() + suffix)
            self.assertEqual(caught.exception.code, "INVALID_FILE_URL")

    def test_windows_drive_url_loses_leading_url_slash(self):
        with mock.patch.object(workbench.os, "name", "nt"):
            self.assertEqual(
                workbench.normalize_file_reference("file:///C:/Users/Alice/page.html"),
                "C:/Users/Alice/page.html",
            )

    def test_windows_unc_url_becomes_unc_path(self):
        with mock.patch.object(workbench.os, "name", "nt"):
            self.assertEqual(
                workbench.normalize_file_reference("file://server/share/page.html"),
                "//server/share/page.html",
            )

    def test_default_log_dir_is_fixed_and_user_scoped(self):
        log_dir = workbench.default_log_dir()
        self.assertEqual(log_dir.name, "logs")
        self.assertEqual(log_dir.parent.name, "html-workbench")
        # Same project base as the vendor cache, so everything lives under one dir.
        self.assertEqual(log_dir, workbench.default_vendor_cache().parents[2] / "logs")

    def test_setup_logging_writes_rotating_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            port = 4399
            logger, directory = workbench.setup_logging(tmp, port)
            logger.info("hello %s", "world")
            # The resolved directory comes back so the host can report where the
            # log really is; asserting the file is INSIDE it states that contract
            # without assuming the requested directory was the one that won.
            log_file = directory / f"workbench-{port}.log"
            self.assertTrue(log_file.is_file(), f"log written to {directory}")
            self.assertIn("hello world", log_file.read_text(encoding="utf-8"))

    def test_setup_logging_survives_when_no_directory_is_writable(self):
        # The whole point of the fallback chain is that the service still binds
        # its port. If EVERY candidate refuses writes, losing the file log is
        # acceptable; refusing to start is the bug this replaced.
        with mock.patch.object(workbench, "make_temp_file", side_effect=PermissionError(13, "denied")), \
             mock.patch.object(workbench.Path, "mkdir"):
            logger, directory = workbench.setup_logging("/definitely/not/writable/logs", 4399)

        self.assertEqual(directory, Path("/definitely/not/writable/logs"))
        self.assertFalse(
            any(isinstance(handler, workbench.RotatingFileHandler) for handler in logger.handlers),
            "an unopenable log file must leave no handler behind",
        )
        # And the logger stays usable: a call must not raise.
        logger.info("service continues without a file log")


class DetachedStartTests(unittest.TestCase):
    """`open` spawns `serve`; an uncapturable console must not block the spawn."""

    def spawn(self, log_dir):
        spawned = {}

        def fake_popen(command, **kwargs):
            spawned["command"] = command
            spawned["stdout"] = kwargs.get("stdout")
            return mock.Mock(pid=4242)

        with mock.patch.object(workbench.subprocess, "Popen", fake_popen):
            pid, log_file = workbench.start_detached(
                Path(__file__), 4399, Path.cwd(), None,
                Path(log_dir) / "vendor", Path(log_dir) / "logs",
            )
        return pid, log_file, spawned

    def test_captures_output_when_a_directory_accepts_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            pid, log_file, spawned = self.spawn(tmp)

        self.assertEqual(pid, 4242)
        self.assertIsNotNone(log_file)
        self.assertEqual(log_file.name, "html-workbench-4399.log")
        self.assertIn("--log-dir", spawned["command"])

    def test_starts_without_a_log_when_the_file_cannot_be_opened(self):
        with mock.patch.object(workbench, "make_temp_file", side_effect=PermissionError(13, "denied")), \
             mock.patch.object(workbench.Path, "mkdir"):
            pid, log_file, spawned = self.spawn("/definitely/not/writable")

        self.assertEqual(pid, 4242)
        # No path to report, and the child's output goes nowhere — but it RUNS.
        self.assertIsNone(log_file)
        self.assertEqual(spawned["stdout"], workbench.subprocess.DEVNULL)


class WritableDirectoryTests(unittest.TestCase):
    """Runtime directories must be probed, and a refused probe must fail fast.

    DSH runs the service as a sandboxed child whose restricted token may write
    only the session workspace and a private temp directory: a folder whose DACL
    looks writable to `os.access` (the ambient %TEMP% root on Windows) rejects
    every create with EACCES / WinError 5. `tempfile.mkstemp` misreads that as a
    taken name and retries 10 000 times, which turned a one-second error into a
    service that never became healthy while pinning a CPU core — so these tests
    pin down both the fallback and the fact that nothing retries.

    They stub the file-system calls rather than creating files: a test asserting
    "this directory refuses writes" must not itself need a writable directory.
    """

    def test_make_temp_file_raises_immediately_instead_of_retrying(self):
        attempted = []

        def deny(path, flags, mode=0o777):
            attempted.append(path)
            raise PermissionError(13, "Permission denied", str(path))

        with mock.patch.object(workbench.os, "open", deny):
            with self.assertRaises(PermissionError):
                workbench.make_temp_file(Path("denied-dir"), prefix=".probe.")
        # Exactly one attempt: a retry loop here is the bug being prevented.
        self.assertEqual(len(attempted), 1)

    def test_make_temp_file_retries_only_when_the_name_is_taken(self):
        attempted = []

        def collide_once(path, flags, mode=0o777):
            attempted.append(path)
            if len(attempted) == 1:
                raise FileExistsError(17, "File exists", str(path))
            return 7

        with mock.patch.object(workbench.os, "open", collide_once), \
             mock.patch.object(workbench.os, "close"):
            descriptor, path = workbench.make_temp_file(Path("probe-dir"), prefix=".probe.")

        # The caller owns the descriptor (pick_writable_dir closes it), so the
        # function must hand back the one it opened.
        self.assertEqual(descriptor, 7)
        self.assertEqual(len(attempted), 2)
        self.assertEqual(Path(path).parent, Path("probe-dir"))
        self.assertTrue(Path(path).name.startswith(".probe."))

    def test_pick_writable_dir_skips_a_folder_that_denies_writes(self):
        denied = Path("denied-dir")
        allowed = Path("allowed-dir")

        def probe(directory, prefix, suffix=""):
            if Path(directory) == denied:
                raise PermissionError(13, "Permission denied", str(directory))
            return 8, Path(directory) / ".wb-write-probe.fake"

        with mock.patch.object(workbench, "make_temp_file", probe), \
             mock.patch.object(workbench.Path, "mkdir"), \
             mock.patch.object(workbench.os, "close"):
            self.assertEqual(workbench.pick_writable_dir(denied, allowed), allowed)

    def test_pick_writable_dir_falls_back_to_the_first_candidate(self):
        denied = Path("denied-dir")
        with mock.patch.object(workbench, "make_temp_file", side_effect=PermissionError(13, "denied")), \
             mock.patch.object(workbench.Path, "mkdir"):
            # Nothing is writable: return a deterministic path so the real write
            # raises something the caller can explain.
            self.assertEqual(workbench.pick_writable_dir(denied), denied)

    def test_log_candidates_try_the_request_then_the_workspace(self):
        candidates = workbench.log_candidates("/requested/logs")
        self.assertEqual(candidates[0], Path("/requested/logs"))
        self.assertEqual(candidates[1], workbench.runtime_directory() / "logs")

    def test_vendor_cache_follows_the_log_directory_that_won(self):
        candidates = workbench.vendor_candidates("/requested/vendor", Path("/granted") / workbench.RUNTIME_DIR_NAME / "logs")
        self.assertEqual(candidates[0], Path("/requested/vendor"))
        # Beside the directory that accepted the log, whose parent is proven writable.
        self.assertEqual(candidates[1], Path("/granted") / workbench.RUNTIME_DIR_NAME / "vendor")


if __name__ == "__main__":
    unittest.main()
