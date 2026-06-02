#!/usr/bin/env python3
"""Garmin Connect MCP Server — exposes Garmin health, activity, and fitness data via MCP."""

import json
import logging
import os
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Optional

from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, ConfigDict, Field

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.WARNING)
logging.getLogger("garminconnect").setLevel(logging.CRITICAL)
logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────
TOKEN_STORE = Path(os.getenv("GARMIN_TOKEN_STORE", Path.home() / ".garmin_tokens"))
TODAY = date.today().isoformat()

# ── MCP Server ────────────────────────────────────────────────────────────────
mcp = FastMCP(
    "garmin_mcp",
    host=os.getenv("MCP_HOST", "127.0.0.1"),
    port=int(os.getenv("MCP_PORT", "8000")),
)

# ── Auth helpers ──────────────────────────────────────────────────────────────

_client: Garmin | None = None


def _get_client() -> Garmin:
    """Return an authenticated Garmin client, reusing saved tokens when possible."""
    global _client
    if _client is not None:
        return _client

    email = os.environ.get("GARMIN_EMAIL")
    password = os.environ.get("GARMIN_PASSWORD")

    if not email or not password:
        raise ValueError(
            "GARMIN_EMAIL and GARMIN_PASSWORD environment variables must be set. "
            "Example: export GARMIN_EMAIL=you@example.com GARMIN_PASSWORD=secret"
        )

    client = Garmin(email, password, is_cn=False, prompt_mfa=_prompt_mfa)
    token_dir = TOKEN_STORE / email

    if (token_dir / "garmin_tokens.json").exists():
        try:
            client.login(str(token_dir))
            _client = client
            return client
        except Exception:
            logger.info("Saved tokens invalid, falling back to credential login…")

    client.login()
    token_dir.mkdir(parents=True, exist_ok=True)
    client.client.dump(str(token_dir))
    _client = client
    return client


def _prompt_mfa() -> str:
    """Called by garminconnect when MFA is required."""
    if not sys.stdin.isatty():
        raise RuntimeError(
            "Garmin MFA required but server is non-interactive. Run `python server.py` "
            "in a terminal once to refresh tokens, then copy them to this host."
        )
    return input("Enter Garmin MFA/OTP code: ")


# ── Formatting helpers ────────────────────────────────────────────────────────

def _json(data: Any) -> str:
    """Serialize to compact JSON, handling non-serialisable types."""
    return json.dumps(data, indent=2, default=str)


def _handle_error(e: Exception) -> str:
    if isinstance(e, GarminConnectAuthenticationError):
        return "Error: Authentication failed. Check GARMIN_EMAIL / GARMIN_PASSWORD."
    if isinstance(e, GarminConnectTooManyRequestsError):
        return "Error: Garmin rate limit hit. Wait a few minutes and retry."
    if isinstance(e, GarminConnectConnectionError):
        return f"Error: Could not reach Garmin Connect — {e}"
    if isinstance(e, ValueError):
        return f"Error: {e}"
    return f"Error: {type(e).__name__}: {e}"


def _date_range(days_back: int) -> tuple[str, str]:
    end = date.today()
    start = end - timedelta(days=days_back)
    return start.isoformat(), end.isoformat()


# ── Input models ──────────────────────────────────────────────────────────────

class DateInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    date: str = Field(
        default_factory=lambda: date.today().isoformat(),
        description="Date in YYYY-MM-DD format. Defaults to today.",
    )


class DateRangeInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    start_date: str = Field(
        description="Start date in YYYY-MM-DD format."
    )
    end_date: str = Field(
        default_factory=lambda: date.today().isoformat(),
        description="End date in YYYY-MM-DD format. Defaults to today.",
    )


class ActivitiesInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    limit: int = Field(default=10, ge=1, le=100, description="Number of recent activities to return (1–100).")
    activity_type: Optional[str] = Field(
        default=None,
        description="Optional filter by activity type, e.g. 'running', 'cycling', 'backcountry_skiing', 'resort_skiing'.",
    )


class ActivityIdInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    activity_id: str = Field(description="Garmin activity ID (numeric string).")


class ProgressInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    start_date: str = Field(description="Start date in YYYY-MM-DD format.")
    end_date: str = Field(
        default_factory=lambda: date.today().isoformat(),
        description="End date in YYYY-MM-DD format. Defaults to today.",
    )
    metric: str = Field(
        default="com.garmin.connect.userprofile.sleep_duration",
        description=(
            "Metric key, e.g. 'com.garmin.connect.userprofile.sleep_duration', "
            "'com.garmin.connect.userprofile.distance', "
            "'com.garmin.connect.userprofile.total_calories'."
        ),
    )


# ── Tools: Health ─────────────────────────────────────────────────────────────

@mcp.tool(
    name="garmin_get_stats",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_stats(params: DateInput) -> str:
    """Get daily stats summary (steps, calories, active minutes, stress, etc.) for a given date.

    Args:
        params.date: Date in YYYY-MM-DD format (default: today).

    Returns:
        JSON object with daily activity and wellness summary.
    """
    try:
        client = _get_client()
        return _json(client.get_stats(params.date))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_body_battery",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_body_battery(params: DateRangeInput) -> str:
    """Get Body Battery levels across a date range. Useful for recovery and readiness planning.

    Args:
        params.start_date: Start date YYYY-MM-DD.
        params.end_date: End date YYYY-MM-DD (default: today).

    Returns:
        JSON list of Body Battery readings with timestamps.
    """
    try:
        client = _get_client()
        return _json(client.get_body_battery(params.start_date, params.end_date))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_sleep",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_sleep(params: DateInput) -> str:
    """Get detailed sleep data for a given date including stages (deep, light, REM, awake).

    Args:
        params.date: Date in YYYY-MM-DD format (default: today).

    Returns:
        JSON object with sleep duration, stages, sleep score, and HRV metrics.
    """
    try:
        client = _get_client()
        return _json(client.get_sleep_data(params.date))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_heart_rate",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_heart_rate(params: DateInput) -> str:
    """Get heart rate data for a given date including resting HR and intraday readings.

    Args:
        params.date: Date in YYYY-MM-DD format (default: today).

    Returns:
        JSON object with resting heart rate and time-series HR values.
    """
    try:
        client = _get_client()
        return _json(client.get_heart_rates(params.date))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_hrv",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_hrv(params: DateInput) -> str:
    """Get Heart Rate Variability (HRV) data for a given date. Key recovery metric.

    Args:
        params.date: Date in YYYY-MM-DD format (default: today).

    Returns:
        JSON object with HRV status, weekly average, and nightly readings.
    """
    try:
        client = _get_client()
        return _json(client.get_hrv_data(params.date))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_stress",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_stress(params: DateInput) -> str:
    """Get stress level data throughout the day.

    Args:
        params.date: Date in YYYY-MM-DD format (default: today).

    Returns:
        JSON object with stress timeline and average/max stress values.
    """
    try:
        client = _get_client()
        return _json(client.get_stress_data(params.date))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_training_readiness",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_training_readiness(params: DateInput) -> str:
    """Get training readiness score for a given date. Combines HRV, sleep, recovery, and load.

    Args:
        params.date: Date in YYYY-MM-DD format (default: today).

    Returns:
        JSON object with training readiness score and contributing factors.
    """
    try:
        client = _get_client()
        return _json(client.get_training_readiness(params.date))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_spo2",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_spo2(params: DateInput) -> str:
    """Get blood oxygen (SpO2) data for a given date. Relevant for altitude acclimatization.

    Args:
        params.date: Date in YYYY-MM-DD format (default: today).

    Returns:
        JSON object with SpO2 readings and average values.
    """
    try:
        client = _get_client()
        return _json(client.get_spo2_data(params.date))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_respiration",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_respiration(params: DateInput) -> str:
    """Get respiration rate data for a given date.

    Args:
        params.date: Date in YYYY-MM-DD format (default: today).

    Returns:
        JSON object with respiration rate timeline.
    """
    try:
        client = _get_client()
        return _json(client.get_respiration_data(params.date))
    except Exception as e:
        return _handle_error(e)


# ── Tools: Activities ─────────────────────────────────────────────────────────

@mcp.tool(
    name="garmin_list_activities",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_list_activities(params: ActivitiesInput) -> str:
    """List recent Garmin activities with summary stats (distance, duration, HR, elevation, etc.).

    Args:
        params.limit: Number of activities to return (default 10, max 100).
        params.activity_type: Optional filter, e.g. 'running', 'backcountry_skiing', 'cycling'.

    Returns:
        JSON list of activity summaries.
    """
    try:
        client = _get_client()
        activities = client.get_activities(0, params.limit)
        if params.activity_type:
            activities = [
                a for a in activities
                if params.activity_type.lower() in (a.get("activityType", {}).get("typeKey", "")).lower()
            ]
        # Surface the most useful fields
        summarized = []
        for a in activities:
            summarized.append({
                "activityId": a.get("activityId"),
                "activityName": a.get("activityName"),
                "activityType": a.get("activityType", {}).get("typeKey"),
                "startTimeLocal": a.get("startTimeLocal"),
                "duration_min": round(a.get("duration", 0) / 60, 1),
                "distance_km": round((a.get("distance") or 0) / 1000, 2),
                "elevationGain_m": a.get("elevationGain"),
                "avgHR": a.get("averageHR"),
                "maxHR": a.get("maxHR"),
                "calories": a.get("calories"),
                "avgSpeed_kph": round((a.get("averageSpeed") or 0) * 3.6, 1),
                "trainingEffect": a.get("aerobicTrainingEffect"),
                "description": a.get("description"),
            })
        return _json(summarized)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_activity",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_activity(params: ActivityIdInput) -> str:
    """Get full details for a specific activity by ID.

    Args:
        params.activity_id: Numeric Garmin activity ID (from garmin_list_activities).

    Returns:
        JSON object with complete activity data including splits, laps, and metrics.
    """
    try:
        client = _get_client()
        return _json(client.get_activity(params.activity_id))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_activity_splits",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_activity_splits(params: ActivityIdInput) -> str:
    """Get lap/split data for a specific activity.

    Args:
        params.activity_id: Numeric Garmin activity ID.

    Returns:
        JSON object with per-lap metrics.
    """
    try:
        client = _get_client()
        return _json(client.get_activity_splits(params.activity_id))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_last_activity",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_last_activity() -> str:
    """Get the most recent activity recorded on Garmin Connect.

    Returns:
        JSON object with the latest activity's full summary.
    """
    try:
        client = _get_client()
        return _json(client.get_last_activity())
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_activities_by_date",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_activities_by_date(params: DateRangeInput) -> str:
    """List all activities within a specific date range.

    Args:
        params.start_date: Start date YYYY-MM-DD.
        params.end_date: End date YYYY-MM-DD (default: today).

    Returns:
        JSON list of activity summaries within the date range.
    """
    try:
        client = _get_client()
        return _json(client.get_activities_by_date(params.start_date, params.end_date))
    except Exception as e:
        return _handle_error(e)


# ── Tools: Fitness Metrics ────────────────────────────────────────────────────

@mcp.tool(
    name="garmin_get_training_status",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_training_status(params: DateInput) -> str:
    """Get training status summary: VO2max, training load, recovery time, etc.

    Args:
        params.date: Date in YYYY-MM-DD format (default: today).

    Returns:
        JSON object with training status and load balance.
    """
    try:
        client = _get_client()
        return _json(client.get_training_status(params.date))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_max_metrics",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_max_metrics(params: DateInput) -> str:
    """Get VO2 max and performance condition metrics for a given date.

    Args:
        params.date: Date in YYYY-MM-DD format (default: today).

    Returns:
        JSON object with VO2 max, generic, and cycling performance estimates.
    """
    try:
        client = _get_client()
        return _json(client.get_max_metrics(params.date))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_personal_records",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_personal_records() -> str:
    """Get all personal records (PRs) across activity types stored in Garmin Connect.

    Returns:
        JSON list of personal records with distances, times, and dates.
    """
    try:
        client = _get_client()
        profile = client.get_user_profile()
        display_name = profile.get("displayName", "")
        return _json(client.get_personal_record(display_name))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_steps",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_steps(params: DateRangeInput) -> str:
    """Get daily step counts across a date range.

    Args:
        params.start_date: Start date YYYY-MM-DD.
        params.end_date: End date YYYY-MM-DD (default: today).

    Returns:
        JSON list of daily step totals.
    """
    try:
        client = _get_client()
        return _json(client.get_daily_steps(params.start_date, params.end_date))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_weekly_steps",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_weekly_steps(params: DateInput) -> str:
    """Get weekly step summary for the week containing a given date.

    Args:
        params.date: Any date within the target week (default: today).

    Returns:
        JSON object with weekly step totals and daily breakdown.
    """
    try:
        client = _get_client()
        return _json(client.get_weekly_steps(params.date))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_endurance_score",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_endurance_score(params: DateRangeInput) -> str:
    """Get endurance score data over a date range. Tracks aerobic fitness trajectory.

    Args:
        params.start_date: Start date YYYY-MM-DD.
        params.end_date: End date YYYY-MM-DD (default: today).

    Returns:
        JSON object with endurance score trend.
    """
    try:
        client = _get_client()
        return _json(client.get_endurance_score(params.start_date, params.end_date))
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_race_predictions",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_race_predictions() -> str:
    """Get Garmin's predicted race finish times (5K, 10K, half marathon, marathon) based on fitness.

    Returns:
        JSON object with predicted times for standard race distances.
    """
    try:
        client = _get_client()
        return _json(client.get_race_predictions())
    except Exception as e:
        return _handle_error(e)


# ── Tools: Devices ────────────────────────────────────────────────────────────

@mcp.tool(
    name="garmin_get_devices",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_devices() -> str:
    """List all Garmin devices connected to the account.

    Returns:
        JSON list of devices with model names, software versions, and device IDs.
    """
    try:
        client = _get_client()
        return _json(client.get_devices())
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_get_user_profile",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_user_profile() -> str:
    """Get the Garmin Connect user profile (name, location, fitness age, etc.).

    Returns:
        JSON object with user profile information.
    """
    try:
        client = _get_client()
        return _json(client.get_user_profile())
    except Exception as e:
        return _handle_error(e)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    transport = os.getenv("MCP_TRANSPORT", "stdio")
    mcp.run(transport=transport)
