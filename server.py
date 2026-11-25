#!/usr/bin/env python3
"""Garmin Connect MCP Server — exposes Garmin health, activity, and fitness data via MCP."""

import json
import logging
import os
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Literal, Optional

from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.WARNING)
logging.getLogger("garminconnect").setLevel(logging.CRITICAL)
logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────
TOKEN_STORE = Path(os.getenv("GARMIN_TOKEN_STORE", Path.home() / ".garmin_tokens"))
TODAY = date.today().isoformat()
HRV_RANGE_CHUNK_DAYS = 28    # days per request to the HRV range endpoint
MAX_HRV_RANGE_DAYS = 366
MAX_SCHEDULE_RANGE_DAYS = 366

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


def _parse_date(value: str, field: str) -> date:
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a date in YYYY-MM-DD format, got {value!r}") from None


class HrvRangeInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    start_date: Optional[str] = Field(
        default=None, description="Start date in YYYY-MM-DD format. Defaults to end_date."
    )
    end_date: str = Field(
        default_factory=lambda: date.today().isoformat(),
        description="End date in YYYY-MM-DD format. Defaults to today.",
    )
    date: Optional[str] = Field(
        default=None,
        description="Single-day shortcut (YYYY-MM-DD). Sets both start_date and end_date.",
    )

    def resolved_range(self) -> tuple[date, date]:
        if self.date:
            d = _parse_date(self.date, "date")
            return d, d
        end = _parse_date(self.end_date, "end_date")
        start = _parse_date(self.start_date, "start_date") if self.start_date else end
        if start > end:
            raise ValueError("start_date must be on or before end_date")
        if (end - start).days + 1 > MAX_HRV_RANGE_DAYS:
            raise ValueError(f"Date range is limited to {MAX_HRV_RANGE_DAYS} days")
        return start, end


_PACE_PATTERN = r"^\d{1,2}:[0-5]\d$"


class WorkoutStep(BaseModel):
    """One step of a structured workout. Set `type='repeat'` with `iterations` + `steps` for intervals."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    type: Literal["warmup", "interval", "recovery", "rest", "cooldown", "repeat"] = Field(
        description="Step type. 'repeat' wraps child `steps` that run `iterations` times."
    )
    # How the step ends (pick at most one; none = press lap button)
    duration_seconds: Optional[float] = Field(default=None, gt=0, le=86400, description="End after this many seconds.")
    distance_meters: Optional[float] = Field(default=None, gt=0, le=500000, description="End after this distance (run/bike/ski).")
    reps: Optional[int] = Field(default=None, ge=1, le=1000, description="End after this many reps (strength only).")
    # Intensity target (pick at most one family)
    hr_zone: Optional[int] = Field(default=None, ge=1, le=5, description="Target heart-rate zone 1–5 (uses your Garmin HR zones).")
    hr_low_bpm: Optional[int] = Field(default=None, ge=30, le=250, description="Custom HR range lower bound (bpm). Requires hr_high_bpm.")
    hr_high_bpm: Optional[int] = Field(default=None, ge=30, le=250, description="Custom HR range upper bound (bpm).")
    pace_slow: Optional[str] = Field(default=None, pattern=_PACE_PATTERN, description="Slow end of pace range, 'M:SS' per pace_unit (run only).")
    pace_fast: Optional[str] = Field(default=None, pattern=_PACE_PATTERN, description="Fast end of pace range, 'M:SS' per pace_unit (run only).")
    pace_unit: Literal["km", "mi"] = Field(default="km", description="Unit for pace_slow / pace_fast.")
    power_zone: Optional[int] = Field(default=None, ge=1, le=7, description="Target power zone 1–7 (run/bike).")
    power_low_watts: Optional[int] = Field(default=None, ge=0, le=3000, description="Custom power range lower bound (W). Requires power_high_watts.")
    power_high_watts: Optional[int] = Field(default=None, ge=0, le=3000, description="Custom power range upper bound (W).")
    # Strength
    exercise_category: Optional[str] = Field(default=None, description="Strength only: Garmin exercise category, e.g. 'SQUAT', 'DEADLIFT', 'PLANK'.")
    exercise_name: Optional[str] = Field(default=None, description="Strength only: Garmin exercise variant, e.g. 'BARBELL_BACK_SQUAT'.")
    weight_kg: Optional[float] = Field(default=None, ge=0, le=1000, description="Strength only: target load in kg.")
    # Repeat
    iterations: Optional[int] = Field(default=None, ge=1, le=99, description="Repeat only: number of rounds.")
    steps: Optional[list["WorkoutStep"]] = Field(default=None, description="Repeat only: child steps (no nested repeats).")
    note: Optional[str] = Field(default=None, max_length=512, description="Optional note shown on the watch for this step.")

    @model_validator(mode="after")
    def _check_shape(self) -> "WorkoutStep":
        ends = [f for f in ("duration_seconds", "distance_meters", "reps") if getattr(self, f) is not None]
        targets = self.target_families()
        if self.type == "repeat":
            if not self.iterations or not self.steps:
                raise ValueError("repeat steps need both 'iterations' and a non-empty 'steps' list")
            if ends or targets or self.exercise_category or self.exercise_name or self.weight_kg is not None:
                raise ValueError("repeat steps take only 'iterations', 'steps' and 'note'; put durations and targets on the child steps")
            if any(child.type == "repeat" for child in self.steps):
                raise ValueError("nested repeats are not supported")
            return self
        if self.iterations is not None or self.steps is not None:
            raise ValueError("'iterations' and 'steps' are only valid on repeat steps")
        if len(ends) > 1:
            raise ValueError(f"set only one of duration_seconds, distance_meters, reps (got {', '.join(ends)})")
        if len(targets) > 1:
            raise ValueError(f"set only one target type per step (got {', '.join(targets)})")
        for low, high, label in (
            ("hr_low_bpm", "hr_high_bpm", "HR"),
            ("power_low_watts", "power_high_watts", "power"),
        ):
            lo, hi = getattr(self, low), getattr(self, high)
            if (lo is None) != (hi is None):
                raise ValueError(f"custom {label} range needs both {low} and {high}")
            if lo is not None and lo > hi:
                raise ValueError(f"{low} must be <= {high}")
        if (self.pace_slow is None) != (self.pace_fast is None):
            raise ValueError("pace range needs both pace_slow and pace_fast")
        if self.pace_slow and _pace_seconds(self.pace_slow) < _pace_seconds(self.pace_fast):
            raise ValueError("pace_slow must be the slower (larger) pace, e.g. pace_slow='5:10', pace_fast='4:50'")
        return self

    def target_families(self) -> list[str]:
        fams = []
        if self.hr_zone is not None:
            fams.append("hr_zone")
        if self.hr_low_bpm is not None or self.hr_high_bpm is not None:
            fams.append("hr_bpm")
        if self.pace_slow is not None or self.pace_fast is not None:
            fams.append("pace")
        if self.power_zone is not None:
            fams.append("power_zone")
        if self.power_low_watts is not None or self.power_high_watts is not None:
            fams.append("power_watts")
        return fams


class CreateWorkoutInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    name: str = Field(min_length=1, max_length=80, description="Workout name as shown on the watch.")
    sport: Literal["run", "bike", "strength", "backcountry_ski"] = Field(description="Workout sport.")
    steps: list[WorkoutStep] = Field(min_length=1, max_length=50, description="Ordered workout steps.")
    description: Optional[str] = Field(default=None, max_length=1024, description="Optional workout description.")
    schedule_date: Optional[str] = Field(
        default=None, description="Optional YYYY-MM-DD to also schedule the workout on your Garmin calendar."
    )
    dry_run: bool = Field(
        default=False,
        description="If true, build and validate the Garmin payload and return it WITHOUT uploading anything.",
    )

    @field_validator("schedule_date")
    @classmethod
    def _check_date(cls, v: Optional[str]) -> Optional[str]:
        return _parse_date(v, "schedule_date").isoformat() if v else v


class WorkoutIdInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    workout_id: int = Field(gt=0, description="Garmin workout ID (from garmin_create_workout or garmin_list_workouts).")


class ScheduleWorkoutInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    workout_id: int = Field(gt=0, description="Garmin workout ID to schedule.")
    date: str = Field(description="Date to schedule it on, YYYY-MM-DD.")

    @field_validator("date")
    @classmethod
    def _check_date(cls, v: str) -> str:
        return _parse_date(v, "date").isoformat()


class ScheduleIdInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    schedule_id: int = Field(gt=0, description="Calendar schedule ID (the 'scheduleId' from garmin_list_scheduled_workouts).")


class ScheduledRangeInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    start_date: str = Field(
        default_factory=lambda: date.today().isoformat(),
        description="Start date YYYY-MM-DD. Defaults to today.",
    )
    end_date: Optional[str] = Field(
        default=None, description="End date YYYY-MM-DD. Defaults to start_date + 30 days."
    )

    def resolved_range(self) -> tuple[date, date]:
        start = _parse_date(self.start_date, "start_date")
        end = _parse_date(self.end_date, "end_date") if self.end_date else start + timedelta(days=30)
        if start > end:
            raise ValueError("start_date must be on or before end_date")
        if (end - start).days + 1 > MAX_SCHEDULE_RANGE_DAYS:
            raise ValueError(f"Date range is limited to {MAX_SCHEDULE_RANGE_DAYS} days")
        return start, end


class ListWorkoutsInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    limit: int = Field(default=20, ge=1, le=100, description="Number of workouts to return (1–100).")


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


def _hrv_row(summary: dict[str, Any]) -> dict[str, Any]:
    """Flatten one Garmin hrvSummary into the fields that matter for recovery."""
    baseline = summary.get("baseline") or {}
    return {
        "date": summary.get("calendarDate"),
        "lastNightAvg": summary.get("lastNightAvg"),
        "lastNight5MinHigh": summary.get("lastNight5MinHigh"),
        "weeklyAvg": summary.get("weeklyAvg"),
        "baseline": {
            "balancedLow": baseline.get("balancedLow"),
            "balancedUpper": baseline.get("balancedUpper"),
            "lowUpper": baseline.get("lowUpper"),
            "markerValue": baseline.get("markerValue"),
        },
        "status": summary.get("status"),
        "feedback": summary.get("feedbackPhrase"),
    }


def _fetch_hrv_summaries(client: Garmin, start: date, end: date) -> list[dict[str, Any]]:
    """Fetch raw hrvSummary dicts for [start, end].

    garminconnect 0.3.3 only wraps the single-day endpoint, so we call the
    range endpoint (/hrv-service/hrv/daily/{start}/{end}, the one Garmin's web
    app uses and newer garminconnect releases wrap as get_hrv_data_range) in
    HRV_RANGE_CHUNK_DAYS windows. If the range call fails for a non-auth reason
    we fall back to one single-day request per night.
    """
    summaries: list[dict[str, Any]] = []
    chunk_start = start
    while chunk_start <= end:
        chunk_end = min(chunk_start + timedelta(days=HRV_RANGE_CHUNK_DAYS - 1), end)
        a, b = chunk_start.isoformat(), chunk_end.isoformat()
        try:
            if hasattr(client, "get_hrv_data_range"):
                data = client.get_hrv_data_range(a, b)
            else:
                data = client.connectapi(f"{client.garmin_connect_hrv_url}/daily/{a}/{b}")
            summaries.extend((data or {}).get("hrvSummaries") or [])
        except (GarminConnectAuthenticationError, GarminConnectTooManyRequestsError):
            raise
        except Exception:
            logger.info("HRV range endpoint failed; falling back to per-day requests")
            day = chunk_start
            while day <= chunk_end:
                data = client.get_hrv_data(day.isoformat()) or {}
                if data.get("hrvSummary"):
                    summaries.append(data["hrvSummary"])
                day += timedelta(days=1)
        chunk_start = chunk_end + timedelta(days=1)
    return summaries


@mcp.tool(
    name="garmin_get_hrv",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_get_hrv(params: HrvRangeInput) -> str:
    """Get nightly Heart Rate Variability (HRV) per day over a date range. Key recovery metric.

    Args:
        params.start_date: Start date YYYY-MM-DD (default: end_date).
        params.end_date: End date YYYY-MM-DD (default: today).
        params.date: Optional single-day shortcut; sets both start and end.

    Returns:
        JSON list, one entry per day (oldest first): lastNightAvg (ms), lastNight5MinHigh,
        weeklyAvg (7-day avg), baseline range (balancedLow–balancedUpper), status
        (BALANCED / UNBALANCED / LOW / POOR / NONE), and Garmin's feedback phrase.
        Days with no HRV reading are included with null values.
    """
    try:
        start, end = params.resolved_range()
        client = _get_client()
        by_date = {
            s.get("calendarDate"): _hrv_row(s)
            for s in _fetch_hrv_summaries(client, start, end)
            if s.get("calendarDate")
        }
        rows = []
        day = start
        while day <= end:
            key = day.isoformat()
            rows.append(by_date.get(key) or _hrv_row({"calendarDate": key}))
            day += timedelta(days=1)
        return _json(rows)
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


# ── Workout builder ───────────────────────────────────────────────────────────
#
# IDs below come from Garmin's /workout-service/workout/types. We build raw JSON
# rather than use garminconnect 0.3.3's typed workout models because that
# release's ConditionType/TargetType constants are wrong (e.g. its DISTANCE=1 is
# Garmin's lap.button) and it has no strength or ski sport types.

_SPORTS: dict[str, dict[str, Any]] = {
    "run": {"sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1},
    "bike": {"sportTypeId": 2, "sportTypeKey": "cycling", "displayOrder": 2},
    "strength": {"sportTypeId": 5, "sportTypeKey": "strength_training", "displayOrder": 5},
    # Garmin's workout builder has no ski sport type. "other" is the closest fit;
    # on the watch, start the Backcountry Ski activity and load the workout from
    # its Training menu.
    "backcountry_ski": {"sportTypeId": 3, "sportTypeKey": "other", "displayOrder": 3},
}
_STEP_TYPES = {"warmup": 1, "cooldown": 2, "interval": 3, "recovery": 4, "rest": 5, "repeat": 6}
_CONDITIONS = {"lap.button": 1, "time": 2, "distance": 3, "iterations": 7, "reps": 10}
_TARGETS = {"no.target": 1, "power.zone": 2, "heart.rate.zone": 4, "pace.zone": 6}
_PACE_UNIT_METERS = {"km": 1000.0, "mi": 1609.344}


def _pace_seconds(pace: str) -> int:
    minutes, seconds = pace.split(":")
    return int(minutes) * 60 + int(seconds)


def _pace_to_mps(pace: str, unit: str) -> float:
    return round(_PACE_UNIT_METERS[unit] / _pace_seconds(pace), 4)


def _ref(table: dict[str, int], key: str, id_field: str, key_field: str) -> dict[str, Any]:
    return {id_field: table[key], key_field: key, "displayOrder": table[key]}


def _end_condition(key: str) -> dict[str, Any]:
    ref = _ref(_CONDITIONS, key, "conditionTypeId", "conditionTypeKey")
    ref["displayable"] = key != "iterations"
    return ref


def _check_step_for_sport(step: WorkoutStep, sport: str) -> None:
    fams = step.target_families()
    if "pace" in fams and sport != "run":
        raise ValueError("pace targets are only supported for sport='run'")
    if {"power_zone", "power_watts"} & set(fams) and sport not in ("run", "bike"):
        raise ValueError("power targets are only supported for sport='run' or 'bike'")
    strength_only = step.reps is not None or step.exercise_category or step.exercise_name or step.weight_kg is not None
    if strength_only and sport != "strength":
        raise ValueError("reps / exercise_* / weight_kg are only valid for sport='strength'")
    if step.distance_meters is not None and sport == "strength":
        raise ValueError("distance_meters is not valid for sport='strength'")


def _executable_step(step: WorkoutStep, order: int, sport: str) -> dict[str, Any]:
    _check_step_for_sport(step, sport)
    if step.duration_seconds is not None:
        cond, value = "time", float(step.duration_seconds)
    elif step.distance_meters is not None:
        cond, value = "distance", float(step.distance_meters)
    elif step.reps is not None:
        cond, value = "reps", float(step.reps)
    else:
        cond, value = "lap.button", None

    target_key, one, two, zone = "no.target", None, None, None
    if step.hr_zone is not None:
        target_key, zone = "heart.rate.zone", step.hr_zone
    elif step.hr_low_bpm is not None:
        target_key, one, two = "heart.rate.zone", float(step.hr_low_bpm), float(step.hr_high_bpm)
    elif step.pace_slow is not None:
        # Garmin stores pace as speed in m/s; the slower pace is the lower bound.
        target_key = "pace.zone"
        one = _pace_to_mps(step.pace_slow, step.pace_unit)
        two = _pace_to_mps(step.pace_fast, step.pace_unit)
    elif step.power_zone is not None:
        target_key, zone = "power.zone", step.power_zone
    elif step.power_low_watts is not None:
        target_key, one, two = "power.zone", float(step.power_low_watts), float(step.power_high_watts)

    out: dict[str, Any] = {
        "type": "ExecutableStepDTO",
        "stepOrder": order,
        "stepType": _ref(_STEP_TYPES, step.type, "stepTypeId", "stepTypeKey"),
        "endCondition": _end_condition(cond),
        "targetType": _ref(_TARGETS, target_key, "workoutTargetTypeId", "workoutTargetTypeKey"),
    }
    optional = {
        "endConditionValue": value,
        "targetValueOne": one,
        "targetValueTwo": two,
        "zoneNumber": zone,
        "description": step.note,
        "category": step.exercise_category.upper() if step.exercise_category else None,
        "exerciseName": step.exercise_name.upper() if step.exercise_name else None,
    }
    out.update({k: v for k, v in optional.items() if v is not None})
    if step.weight_kg is not None:
        # Garmin stores strength loads in grams tagged with a kilogram unit.
        out["weightValue"] = float(step.weight_kg) * 1000.0
        out["weightUnit"] = {"unitId": 8, "unitKey": "kilogram", "factor": 1000.0}
    return out


def _estimate_seconds(steps: list[WorkoutStep]) -> int:
    total = 0.0
    for s in steps:
        if s.type == "repeat":
            total += (s.iterations or 0) * _estimate_seconds(s.steps or [])
        elif s.duration_seconds:
            total += s.duration_seconds
    return int(total)


def build_workout_payload(params: CreateWorkoutInput) -> dict[str, Any]:
    """Translate validated tool input into Garmin workout-service JSON."""
    sport = _SPORTS[params.sport]
    order = 0
    workout_steps: list[dict[str, Any]] = []
    for step in params.steps:
        order += 1
        if step.type != "repeat":
            workout_steps.append(_executable_step(step, order, params.sport))
            continue
        group_order = order
        children = []
        for child in step.steps or []:
            order += 1
            children.append(_executable_step(child, order, params.sport))
        group: dict[str, Any] = {
            "type": "RepeatGroupDTO",
            "stepOrder": group_order,
            "stepType": _ref(_STEP_TYPES, "repeat", "stepTypeId", "stepTypeKey"),
            "numberOfIterations": step.iterations,
            "smartRepeat": False,
            "endCondition": _end_condition("iterations"),
            "endConditionValue": float(step.iterations),
            "workoutSteps": children,
        }
        if step.note:
            group["description"] = step.note
        workout_steps.append(group)

    payload: dict[str, Any] = {
        "workoutName": params.name,
        "sportType": dict(sport),
        "estimatedDurationInSecs": _estimate_seconds(params.steps),
        "workoutSegments": [
            {"segmentOrder": 1, "sportType": dict(sport), "workoutSteps": workout_steps}
        ],
    }
    if params.description:
        payload["description"] = params.description
    return payload


def _months_between(start: date, end: date) -> list[tuple[int, int]]:
    months, y, m = [], start.year, start.month
    while (y, m) <= (end.year, end.month):
        months.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return months


# ── Tools: Workouts ───────────────────────────────────────────────────────────

@mcp.tool(
    name="garmin_create_workout",
    annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False},
)
async def garmin_create_workout(params: CreateWorkoutInput) -> str:
    """Create a structured workout, upload it to Garmin Connect, and optionally schedule it.

    Scheduled workouts sync to the watch on its next Garmin Connect sync. Use dry_run=true
    to preview the exact payload without touching the account.

    Example steps for 5x3min in HR zone 4:
        [{"type": "warmup", "duration_seconds": 600, "hr_zone": 2},
         {"type": "repeat", "iterations": 5, "steps": [
             {"type": "interval", "duration_seconds": 180, "hr_zone": 4},
             {"type": "recovery", "duration_seconds": 120, "hr_zone": 1}]},
         {"type": "cooldown", "duration_seconds": 600}]

    Args:
        params.name: Workout name.
        params.sport: 'run', 'bike', 'strength', or 'backcountry_ski'.
        params.steps: Ordered steps (warmup / interval / recovery / rest / cooldown / repeat).
        params.description: Optional description.
        params.schedule_date: Optional YYYY-MM-DD to schedule it on the calendar.
        params.dry_run: Build and return the payload only; nothing is uploaded.

    Returns:
        JSON with workoutId (and scheduleId if scheduled), or the payload when dry_run.
    """
    try:
        payload = build_workout_payload(params)
        if params.dry_run:
            return _json({"dry_run": True, "schedule_date": params.schedule_date, "payload": payload})
        client = _get_client()
        created = client.upload_workout(payload) or {}
        workout_id = created.get("workoutId")
        result: dict[str, Any] = {
            "workoutId": workout_id,
            "workoutName": created.get("workoutName", params.name),
            "sport": params.sport,
        }
        if params.schedule_date:
            if not workout_id:
                return _json({**result, "error": "Upload response had no workoutId; workout was not scheduled."})
            try:
                scheduled = client.schedule_workout(workout_id, params.schedule_date) or {}
            except Exception as e:
                result["scheduleError"] = _handle_error(e)
                return _json(result)
            result["scheduleId"] = scheduled.get("workoutScheduleId")
            result["scheduledDate"] = scheduled.get("calendarDate", params.schedule_date)
        return _json(result)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_schedule_workout",
    annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False},
)
async def garmin_schedule_workout(params: ScheduleWorkoutInput) -> str:
    """Schedule an existing workout on a calendar date so it syncs to the watch.

    Args:
        params.workout_id: Garmin workout ID.
        params.date: YYYY-MM-DD.

    Returns:
        JSON with scheduleId, workoutId, and date.
    """
    try:
        client = _get_client()
        scheduled = client.schedule_workout(params.workout_id, params.date) or {}
        return _json({
            "scheduleId": scheduled.get("workoutScheduleId"),
            "workoutId": params.workout_id,
            "date": scheduled.get("calendarDate", params.date),
        })
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_list_scheduled_workouts",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_list_scheduled_workouts(params: ScheduledRangeInput) -> str:
    """List workouts scheduled on the Garmin calendar within a date range.

    Args:
        params.start_date: YYYY-MM-DD (default: today).
        params.end_date: YYYY-MM-DD (default: start_date + 30 days).

    Returns:
        JSON list of {date, scheduleId, workoutId, title, sport}, sorted by date.
    """
    try:
        start, end = params.resolved_range()
        client = _get_client()
        items = []
        for year, month in _months_between(start, end):
            data = client.get_scheduled_workouts(year, month) or {}
            for item in data.get("calendarItems") or []:
                if item.get("itemType") != "workout":
                    continue
                d = item.get("date") or ""
                if not (start.isoformat() <= d <= end.isoformat()):
                    continue
                items.append({
                    "date": d,
                    "scheduleId": item.get("id"),
                    "workoutId": item.get("workoutId"),
                    "title": item.get("title"),
                    "sport": item.get("sportTypeKey"),
                })
        items.sort(key=lambda i: i["date"])
        return _json(items)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_list_workouts",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
async def garmin_list_workouts(params: ListWorkoutsInput) -> str:
    """List workouts saved in the Garmin Connect workout library (scheduled or not).

    Args:
        params.limit: Number of workouts to return (default 20).

    Returns:
        JSON list of {workoutId, workoutName, sport, updatedDate}.
    """
    try:
        client = _get_client()
        workouts = client.get_workouts(0, params.limit) or []
        return _json([
            {
                "workoutId": w.get("workoutId"),
                "workoutName": w.get("workoutName"),
                "sport": (w.get("sportType") or {}).get("sportTypeKey"),
                "updatedDate": w.get("updatedDate"),
            }
            for w in workouts
        ])
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_unschedule_workout",
    annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True},
)
async def garmin_unschedule_workout(params: ScheduleIdInput) -> str:
    """Remove a workout from the calendar, keeping it in the workout library.

    Args:
        params.schedule_id: The scheduleId from garmin_list_scheduled_workouts.

    Returns:
        JSON confirmation.
    """
    try:
        client = _get_client()
        client.unschedule_workout(params.schedule_id)
        return _json({"unscheduled": True, "scheduleId": params.schedule_id})
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="garmin_delete_workout",
    annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True},
)
async def garmin_delete_workout(params: WorkoutIdInput) -> str:
    """Permanently delete a workout from the Garmin Connect library by workout ID.

    Args:
        params.workout_id: Garmin workout ID.

    Returns:
        JSON confirmation.
    """
    try:
        client = _get_client()
        client.delete_workout(params.workout_id)
        return _json({"deleted": True, "workoutId": params.workout_id})
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
