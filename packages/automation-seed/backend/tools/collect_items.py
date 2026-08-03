"""app.collect_items — gather whatever needs summarising.

A tool is a plain function. The runtime hands it the declared ``input`` dict and
a :class:`claritty_sdk.context.ToolCtx`; it returns a dict matching the declared
``output``. That is the whole contract.

Replace the fixture below with your real source. Reach external services ONLY
through ``ctx.integration("<id>")`` — never a raw requests call with a key you
read from the environment, because then the credential lives in your code
instead of the vault.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict

from claritty_sdk import tool
from claritty_sdk.context import ToolCtx


@tool(id="app.collect_items")
def run(input: Dict[str, Any], ctx: ToolCtx) -> Dict[str, Any]:
    since_hours = float(input.get("since_hours") or 24)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=since_hours)

    # ── replace me ───────────────────────────────────────────────────────────
    # Real sources look like one of these:
    #
    #   gmail = ctx.integration("gmail")
    #   items = gmail.search(f"is:unread after:{cutoff:%Y/%m/%d}")
    #
    #   with get_db() as db:
    #       items = db.query(Ticket).filter(Ticket.created_at >= cutoff).all()
    #
    items = [
        {
            "id": "demo-1",
            "title": "Two builds failed on main overnight",
            "detail": "Both failures are the same flaky integration test.",
            "at": cutoff.isoformat(),
        },
        {
            "id": "demo-2",
            "title": "Signup conversion up 4% week over week",
            "detail": "The change tracks with the new onboarding copy.",
            "at": cutoff.isoformat(),
        },
    ]
    # ─────────────────────────────────────────────────────────────────────────

    ctx.log("info", f"collected {len(items)} item(s) since {cutoff.isoformat()}")
    return {"items": items, "count": len(items)}
