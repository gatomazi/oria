# Gunicorn config, loaded automatically from the working directory (Railway Root Directory =
# services/creative-core). Keeps the start command free of shell expansion ($PORT) so it works
# the same from Procfile, Railpack and the Railway dashboard.
import os

# "[::]" accepts IPv4 and IPv6: Railway private networking may be IPv6-only on older environments.
bind = f"[::]:{os.environ.get('PORT', '8765')}"
workers = int(os.environ.get("WEB_CONCURRENCY", "2"))
# Image generation calls to OpenAI can take minutes.
timeout = 240
graceful_timeout = 30
accesslog = "-"
errorlog = "-"
