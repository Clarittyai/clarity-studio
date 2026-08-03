# Clarity automation — runtime image.
#
# Deliberately NOT pinned to linux/amd64. Studio builds this on whatever the
# developer is sitting at; forcing amd64 puts Apple Silicon through emulation
# and turns a 20-second build into two minutes. Hosts that need amd64 pass
# --platform at build time, which is where that decision belongs.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    APP_DATA_DIR=/data

WORKDIR /app

# Dependencies first so a code edit doesn't re-resolve the whole tree.
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY . .

# ── boot smoke ───────────────────────────────────────────────────────────────
# Import the app and drive the real ASGI lifespan, which runs bootstrap.load():
# it reads intelligence.yaml, imports every handler, and validates the wiring.
# A dangling tool reference or a typo'd handler path therefore fails the BUILD,
# with the real traceback, instead of producing an image that crash-loops at
# runtime and 502s every request.
RUN APP_DATA_DIR=/tmp CLARITTY_ENV=build python - <<'PY'
import asyncio, sys, traceback

async def boot():
    from backend.main import app
    async with app.router.lifespan_context(app):
        pass

try:
    asyncio.run(boot())
except BaseException:
    sys.stderr.write("CLARITTY_BOOTCHECK_FAILED: the automation did not boot\n")
    traceback.print_exc()
    sys.exit(1)
print("CLARITTY_BOOTCHECK_OK")
PY

RUN mkdir -p /data && useradd -m -u 10001 automation && chown -R automation:automation /app /data
USER automation

EXPOSE 3200

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:3200/health',timeout=3).status==200 else 1)"

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "3200"]
