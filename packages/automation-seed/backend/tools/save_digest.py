"""app.save_digest — persist the finished digest.

Kept deliberately dumb: it writes to a JSON-lines file under the data directory
so the seed runs with no database and no credentials on the very first boot.
Swap it for your real sink — a table, an email, a Slack post via
``ctx.integration("slack")``.

Note what this tool does NOT do: it does not decide what to write, and it does
not call a model. Tools act; agents decide. Keeping that line clean is what
makes a run trace readable six weeks later.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

from claritty_sdk import tool
from claritty_sdk.context import ToolCtx

DATA_DIR = Path(os.environ.get("APP_DATA_DIR", "/data"))


@tool(id="app.save_digest")
def run(input: Dict[str, Any], ctx: ToolCtx) -> Dict[str, Any]:
    digest_id = f"dg_{uuid.uuid4().hex[:12]}"
    saved_at = datetime.now(timezone.utc).isoformat()

    record = {
        "digest_id": digest_id,
        "saved_at": saved_at,
        "user_id": ctx.user_id,
        "item_count": int(input.get("item_count") or 0),
        "summary": input["summary"],
    }

    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with (DATA_DIR / "digests.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
    except OSError as exc:
        # A read-only volume shouldn't fail the run — the digest is already in
        # the step output, which Studio has captured. Say so and move on.
        ctx.log("warning", f"could not persist digest to {DATA_DIR}: {exc}")

    ctx.log("info", f"saved digest {digest_id}")
    return {"digest_id": digest_id, "saved_at": saved_at}
