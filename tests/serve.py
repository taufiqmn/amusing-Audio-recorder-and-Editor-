# Static server for tests that sends the same security headers as vercel.json / _headers.
import http.server, sys, os, functools
CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm', '.mjs': 'text/javascript', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json'}
    def end_headers(self):
        if self.path.startswith('/studio'):
            self.send_header('Content-Security-Policy', CSP)
        self.send_header('X-Content-Type-Options', 'nosniff'); self.send_header('Permissions-Policy', 'microphone=(self)')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()
    def log_message(self, *a): pass
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
os.chdir(sys.argv[2] if len(sys.argv) > 2 else 'public')
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
