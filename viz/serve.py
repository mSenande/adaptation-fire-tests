"""
Local dev server for the viewer that disables caching, so edits to app.js /
manifest.json / assets always show up on reload instead of being silently
served from the browser's cache (the plain `python3 -m http.server` sends no
Cache-Control header, which lets browsers reuse stale copies of these files).
"""
import functools
import http.server

PORT = 8000


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    handler = functools.partial(NoCacheHandler, directory=__import__("os").path.dirname(__file__))
    with http.server.ThreadingHTTPServer(("", PORT), handler) as httpd:
        print(f"Serving on http://localhost:{PORT}/index.html (caching disabled)")
        httpd.serve_forever()
