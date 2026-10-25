# Fanframe. Build: docker build -t fanframe .   Settings: see README (JELLYFIN_URL, JELLYFIN_API_KEY, ...).
# Standard library only, so the image is just Python plus the app.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PUID=99 \
    PGID=100 \
    FANFRAME_DATA=/config \
    FANFRAME_HOST=0.0.0.0 \
    FANFRAME_PORT=8765

WORKDIR /app
COPY server.py ./
COPY static ./static
# Fail the build, not the first request, if the code needs a newer Python than the image has.
RUN python -m py_compile server.py && rm -rf __pycache__

# /config holds backups/, custom.json and (optionally) config.json. The server starts as root, gives /config
# to PUID:PGID (default 99:100, Unraid's nobody:users) and then runs as that user (server.py drop_privileges).
VOLUME /config
EXPOSE 8765
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/api/ping', timeout=4).status == 200 else 1)"
CMD ["python", "server.py", "--no-browser"]
