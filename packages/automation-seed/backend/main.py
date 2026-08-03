"""The automation's HTTP surface.

This file is framework, not logic — you should rarely need to touch it. It does
four things:

1. Boots the runtime. ``bootstrap.load()`` reads ``intelligence.yaml``, imports
   every handler it references, checks the shapes line up, and returns a live
   :class:`WorkflowEngine`. If anything is wrong the process refuses to start
   with a message naming the offending manifest entry — a broken automation
   fails at boot, never silently at 3am.
2. Serves ``/health`` so the host knows the automation is alive.
3. Serves ``/api/workflows/{id}/execute`` so a workflow can be run on demand.
4. Serves the dispatch endpoints a host calls to fire triggers:
   ``/internal/run-due-triggers`` (schedules) and ``/internal/trigger-webhook``.

The automation runs NO scheduler of its own. Something outside it — Clarity
Studio on your laptop, or a host in production — decides when a trigger is due
and calls in. That is what makes the same artifact run in both places.
"""

from __future__ import annotations

import hmac
import logging
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel

from claritty_sdk.integrations.client import make_resolver
from claritty_sdk.runtime import bootstrap

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
logger = logging.getLogger("automation")

APP_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_USER_ID = os.environ.get("CLARITTY_USER_ID", "local")

_boot: Optional[bootstrap.BootContext] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _boot
    _boot = bootstrap.load(APP_ROOT / "intelligence.yaml")
    m = _boot.manifest
    logger.info(
        "booted %s v%s — %d integration(s), %d tool(s), %d agent(s), "
        "%d workflow(s), %d trigger(s)",
        m.id, m.version, len(m.integrations), len(m.tools), len(m.agents),
        len(m.workflows), len(m.triggers),
    )
    yield


app = FastAPI(title="Clarity automation", lifespan=lifespan)


def boot() -> bootstrap.BootContext:
    if _boot is None:  # pragma: no cover — lifespan always runs first
        raise HTTPException(503, "runtime is still starting")
    return _boot


def bind_resolver(user_id: Optional[str]) -> None:
    """Point the engine at the credentials of the user this run is for.

    Integrations marked ``required: false`` resolve to ``None`` instead of
    raising, so a tool can degrade gracefully when the user hasn't connected
    that service yet.
    """
    ctx = boot()
    optional = {i.id for i in ctx.manifest.integrations if not i.required}
    ctx.engine.integration_resolver = make_resolver(user_id, optional_ids=optional)


def require_internal(header_value: Optional[str]) -> None:
    """Guard the dispatch endpoints with the host's shared secret.

    Compared in constant time. If no secret is configured the endpoints are
    open — acceptable only because the automation binds to a private network;
    Studio always sets one.
    """
    expected = os.environ.get("CLARITY_INTERNAL_SECRET", "")
    if not expected:
        return
    if not header_value or not hmac.compare_digest(header_value, expected):
        raise HTTPException(401, "bad or missing X-Claritty-Internal")


# ── health ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> Dict[str, Any]:
    m = boot().manifest
    return {
        "status": "healthy",
        "automation": m.id,
        "version": m.version,
        "workflows": [w.id for w in m.workflows],
        "triggers": [t.id for t in m.triggers],
    }


# ── introspection (Studio reads these to draw the canvas) ────────────────────

@app.get("/api/manifest")
async def get_manifest() -> Dict[str, Any]:
    return boot().manifest.model_dump(mode="json", by_alias=True, exclude_none=True)


@app.get("/api/workflows")
async def list_workflows() -> Dict[str, Any]:
    return {
        "workflows": [
            {
                "id": w.id,
                "type": w.type,
                "steps": [
                    {"id": s.id, "agent": s.agent, "tool": s.tool} for s in (w.steps or [])
                ],
            }
            for w in boot().manifest.workflows
        ]
    }


# ── run a workflow on demand ─────────────────────────────────────────────────

class ExecuteRequest(BaseModel):
    inputs: Dict[str, Any] = {}
    user_id: Optional[str] = None
    # When the caller supplies a run id, the engine checkpoints every step back
    # to the host as it goes — that is where the run timeline comes from. Omit
    # it and the workflow still runs, just unobserved.
    workflow_run_id: Optional[str] = None
    idempotency_key: Optional[str] = None


@app.post("/api/workflows/{workflow_id}/execute")
async def execute_workflow(
    workflow_id: str,
    body: ExecuteRequest,
    x_user_id: Optional[str] = Header(None, alias="X-User-ID"),
) -> Dict[str, Any]:
    user_id = body.user_id or x_user_id or DEFAULT_USER_ID
    bind_resolver(user_id)

    result = await boot().engine.run(
        workflow_id,
        inputs=body.inputs,
        user_id=user_id,
        workflow_run_id=body.workflow_run_id,
        idempotency_key=body.idempotency_key,
    )
    return _result_payload(result)


# ── dispatch: schedules ──────────────────────────────────────────────────────

class TriggerInstance(BaseModel):
    instanceId: str
    recipeTriggerId: str
    workflowId: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    lastRunAt: Optional[str] = None
    workflowRunId: Optional[str] = None
    idempotencyKey: Optional[str] = None
    userId: Optional[str] = None


class RunDueTriggersRequest(BaseModel):
    instances: List[TriggerInstance] = []


@app.post("/internal/run-due-triggers")
async def run_due_triggers(
    body: RunDueTriggersRequest,
    x_claritty_internal: Optional[str] = Header(None, alias="X-Claritty-Internal"),
) -> Dict[str, Any]:
    """Fire every instance the host says is due.

    Instances are batched, and one failure must not take out the rest — each is
    reported independently so the host can retry precisely what failed.
    """
    require_internal(x_claritty_internal)
    results = []
    for inst in body.instances:
        results.append(
            await _fire(
                recipe_trigger_id=inst.recipeTriggerId,
                workflow_id=inst.workflowId,
                user_id=inst.userId or DEFAULT_USER_ID,
                trigger={"config": inst.config or {}, "payload": {}},
                workflow_run_id=inst.workflowRunId,
                idempotency_key=inst.idempotencyKey,
                instance_id=inst.instanceId,
            )
        )
    return {"executed": len(results), "results": results}


# ── dispatch: webhooks ───────────────────────────────────────────────────────

class WebhookRequest(BaseModel):
    instanceId: str
    recipeTriggerId: str
    workflowId: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    payload: Dict[str, Any] = {}
    workflowRunId: Optional[str] = None
    idempotencyKey: Optional[str] = None
    userId: Optional[str] = None


@app.post("/internal/trigger-webhook")
async def trigger_webhook(
    body: WebhookRequest,
    x_claritty_internal: Optional[str] = Header(None, alias="X-Claritty-Internal"),
) -> Dict[str, Any]:
    require_internal(x_claritty_internal)
    return await _fire(
        recipe_trigger_id=body.recipeTriggerId,
        workflow_id=body.workflowId,
        user_id=body.userId or DEFAULT_USER_ID,
        trigger={"config": body.config or {}, "payload": body.payload},
        workflow_run_id=body.workflowRunId,
        idempotency_key=body.idempotencyKey,
        instance_id=body.instanceId,
    )


# ── internals ────────────────────────────────────────────────────────────────

async def _fire(
    *,
    recipe_trigger_id: str,
    workflow_id: Optional[str],
    user_id: str,
    trigger: Dict[str, Any],
    workflow_run_id: Optional[str],
    idempotency_key: Optional[str],
    instance_id: str,
) -> Dict[str, Any]:
    ctx = boot()

    # The manifest is the authority on what a trigger fires. The host tells us
    # which instance is due; it does not get to redirect it at a different
    # workflow, so a stale host-side row can never run the wrong thing.
    decl = next((t for t in ctx.manifest.triggers if t.id == recipe_trigger_id), None)
    target = decl.workflow if decl else workflow_id
    if decl is not None and decl.agent and not decl.workflow:
        return {
            "instanceId": instance_id,
            "success": False,
            "error": f"trigger {recipe_trigger_id!r} fires an agent directly, "
                     "which this seed does not expose over HTTP yet",
        }
    if not target:
        return {
            "instanceId": instance_id,
            "success": False,
            "error": f"unknown trigger {recipe_trigger_id!r} and no workflowId given",
        }

    bind_resolver(user_id)
    result = await ctx.engine.run(
        target,
        trigger=trigger,
        user_id=user_id,
        workflow_run_id=workflow_run_id or f"wfr_{uuid.uuid4().hex}",
        idempotency_key=idempotency_key,
    )
    payload = _result_payload(result)
    payload["instanceId"] = instance_id
    return payload


def _result_payload(result: Any) -> Dict[str, Any]:
    return {
        "success": result.status == "success",
        "status": result.status,
        "workflowId": result.workflow_id,
        "outputs": result.outputs,
        "error": result.error,
        "steps": [
            {
                "id": s.id,
                "status": s.status,
                "output": s.output,
                "error": s.error,
                "startedAt": s.started_at,
                "endedAt": s.ended_at,
            }
            for s in (result.steps or [])
        ],
    }
