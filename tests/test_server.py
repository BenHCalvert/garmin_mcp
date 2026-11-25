"""Tests for the HRV and workout tools. All Garmin calls are mocked; nothing hits the network."""

import asyncio
import json
import logging
from datetime import date
from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError

import server
from garminconnect import GarminConnectAuthenticationError


def run(coro):
    return json.loads(asyncio.run(coro))


@pytest.fixture
def client(monkeypatch):
    """A mocked Garmin client injected in place of the real authenticated one."""
    fake = MagicMock(spec=server.Garmin)
    fake.garmin_connect_hrv_url = "/hrv-service/hrv"
    monkeypatch.setattr(server, "_get_client", lambda: fake)
    return fake


def hrv_summary(day, last_night=55, weekly=58, status="BALANCED"):
    return {
        "calendarDate": day,
        "weeklyAvg": weekly,
        "lastNightAvg": last_night,
        "lastNight5MinHigh": 80,
        "baseline": {"lowUpper": 48, "balancedLow": 52, "balancedUpper": 66, "markerValue": 0.4},
        "status": status,
        "feedbackPhrase": "HRV_BALANCED_1",
        "createTimeStamp": "2026-11-20T06:00:00.0",
    }


# ── HRV ───────────────────────────────────────────────────────────────────────

class TestHrv:
    def test_range_returns_one_row_per_day_with_gaps_filled(self, client):
        client.connectapi.return_value = {
            "hrvSummaries": [hrv_summary("2026-11-20"), hrv_summary("2026-11-22", 41, 50, "UNBALANCED")],
            "userProfilePk": 1,
        }
        rows = run(server.garmin_get_hrv(server.HrvRangeInput(start_date="2026-11-20", end_date="2026-11-22")))

        client.connectapi.assert_called_once_with("/hrv-service/hrv/daily/2026-11-20/2026-11-22")
        assert [r["date"] for r in rows] == ["2026-11-20", "2026-11-21", "2026-11-22"]
        assert rows[0] == {
            "date": "2026-11-20",
            "lastNightAvg": 55,
            "lastNight5MinHigh": 80,
            "weeklyAvg": 58,
            "baseline": {"balancedLow": 52, "balancedUpper": 66, "lowUpper": 48, "markerValue": 0.4},
            "status": "BALANCED",
            "feedback": "HRV_BALANCED_1",
        }
        assert rows[1]["lastNightAvg"] is None and rows[1]["status"] is None
        assert rows[2]["status"] == "UNBALANCED" and rows[2]["lastNightAvg"] == 41

    def test_long_range_is_chunked(self, client):
        client.connectapi.return_value = {"hrvSummaries": []}
        run(server.garmin_get_hrv(server.HrvRangeInput(start_date="2026-01-01", end_date="2026-03-01")))
        urls = [c.args[0] for c in client.connectapi.call_args_list]
        assert urls == [
            "/hrv-service/hrv/daily/2026-01-01/2026-01-28",
            "/hrv-service/hrv/daily/2026-01-29/2026-02-25",
            "/hrv-service/hrv/daily/2026-02-26/2026-03-01",
        ]

    def test_falls_back_to_single_day_endpoint(self, client):
        client.connectapi.side_effect = RuntimeError("404")
        client.get_hrv_data.side_effect = lambda d: {"hrvSummary": hrv_summary(d)} if d != "2026-11-21" else None
        rows = run(server.garmin_get_hrv(server.HrvRangeInput(start_date="2026-11-20", end_date="2026-11-21")))
        assert client.get_hrv_data.call_count == 2
        assert rows[0]["status"] == "BALANCED"
        assert rows[1]["status"] is None

    def test_prefers_library_range_method_when_available(self, client):
        client.get_hrv_data_range = MagicMock(return_value={"hrvSummaries": [hrv_summary("2026-11-20")]})
        rows = run(server.garmin_get_hrv(server.HrvRangeInput(date="2026-11-20")))
        client.get_hrv_data_range.assert_called_once_with("2026-11-20", "2026-11-20")
        client.connectapi.assert_not_called()
        assert len(rows) == 1

    def test_defaults_to_today(self, client):
        client.connectapi.return_value = {"hrvSummaries": []}
        rows = run(server.garmin_get_hrv(server.HrvRangeInput()))
        assert [r["date"] for r in rows] == [date.today().isoformat()]

    def test_auth_error_is_not_swallowed_by_fallback(self, client):
        client.connectapi.side_effect = GarminConnectAuthenticationError("401")
        out = asyncio.run(server.garmin_get_hrv(server.HrvRangeInput(date="2026-11-20")))
        assert out.startswith("Error: Authentication failed")
        client.get_hrv_data.assert_not_called()

    def test_bad_range_rejected(self, client):
        out = asyncio.run(server.garmin_get_hrv(server.HrvRangeInput(start_date="2026-11-22", end_date="2026-11-20")))
        assert "start_date must be on or before end_date" in out
        client.connectapi.assert_not_called()


# ── Workout payload builder ───────────────────────────────────────────────────

def build(sport, steps, **kw):
    return server.build_workout_payload(server.CreateWorkoutInput(name="Test", sport=sport, steps=steps, **kw))


def flat_steps(payload):
    out = []
    for s in payload["workoutSegments"][0]["workoutSteps"]:
        out.append(s)
        out.extend(s.get("workoutSteps", []))
    return out


class TestWorkoutBuilder:
    def test_run_intervals_hr_zone(self):
        p = build("run", [
            {"type": "warmup", "duration_seconds": 600, "hr_zone": 2},
            {"type": "repeat", "iterations": 5, "steps": [
                {"type": "interval", "duration_seconds": 180, "hr_zone": 4},
                {"type": "recovery", "duration_seconds": 120},
            ]},
            {"type": "cooldown", "duration_seconds": 300},
        ])
        assert p["sportType"]["sportTypeKey"] == "running"
        assert p["estimatedDurationInSecs"] == 600 + 5 * 300 + 300
        steps = flat_steps(p)
        assert [s["stepOrder"] for s in steps] == [1, 2, 3, 4, 5]
        warmup, repeat, interval, recovery, cooldown = steps
        assert warmup["stepType"]["stepTypeKey"] == "warmup"
        assert warmup["endCondition"]["conditionTypeId"] == 2
        assert warmup["targetType"]["workoutTargetTypeKey"] == "heart.rate.zone"
        assert warmup["zoneNumber"] == 2
        assert repeat["type"] == "RepeatGroupDTO" and repeat["numberOfIterations"] == 5
        assert repeat["endCondition"]["conditionTypeKey"] == "iterations"
        assert interval["zoneNumber"] == 4
        assert recovery["targetType"]["workoutTargetTypeKey"] == "no.target"
        assert cooldown["stepType"]["stepTypeId"] == 2

    def test_custom_hr_range(self):
        (step,) = flat_steps(build("run", [{"type": "interval", "duration_seconds": 60, "hr_low_bpm": 150, "hr_high_bpm": 160}]))
        assert step["targetType"]["workoutTargetTypeId"] == 4
        assert (step["targetValueOne"], step["targetValueTwo"]) == (150.0, 160.0)
        assert "zoneNumber" not in step

    def test_pace_target_in_miles_and_distance_end(self):
        (step,) = flat_steps(build("run", [{
            "type": "interval", "distance_meters": 1609.344, "pace_slow": "7:00", "pace_fast": "6:40", "pace_unit": "mi",
        }]))
        assert step["endCondition"]["conditionTypeKey"] == "distance"
        assert step["endCondition"]["conditionTypeId"] == 3
        assert step["targetType"]["workoutTargetTypeKey"] == "pace.zone"
        assert step["targetValueOne"] == pytest.approx(1609.344 / 420, abs=1e-3)
        assert step["targetValueTwo"] == pytest.approx(1609.344 / 400, abs=1e-3)
        assert step["targetValueOne"] < step["targetValueTwo"]

    def test_bike_power_zone_and_watts(self):
        steps = flat_steps(build("bike", [
            {"type": "interval", "duration_seconds": 1200, "power_zone": 4},
            {"type": "interval", "duration_seconds": 300, "power_low_watts": 280, "power_high_watts": 300},
        ]))
        assert all(s["targetType"]["workoutTargetTypeKey"] == "power.zone" for s in steps)
        assert steps[0]["zoneNumber"] == 4
        assert (steps[1]["targetValueOne"], steps[1]["targetValueTwo"]) == (280.0, 300.0)

    def test_strength_sets_reps_weight(self):
        p = build("strength", [
            {"type": "warmup", "duration_seconds": 300},
            {"type": "repeat", "iterations": 3, "steps": [
                {"type": "interval", "reps": 5, "exercise_category": "squat",
                 "exercise_name": "barbell_back_squat", "weight_kg": 80},
                {"type": "rest", "duration_seconds": 120},
            ]},
        ])
        assert p["sportType"] == {"sportTypeId": 5, "sportTypeKey": "strength_training", "displayOrder": 5}
        _, _, squat, rest = flat_steps(p)
        assert squat["endCondition"]["conditionTypeKey"] == "reps"
        assert squat["endConditionValue"] == 5.0
        assert squat["category"] == "SQUAT" and squat["exerciseName"] == "BARBELL_BACK_SQUAT"
        assert squat["weightValue"] == 80000.0 and squat["weightUnit"]["unitKey"] == "kilogram"
        assert rest["stepType"]["stepTypeKey"] == "rest"

    def test_backcountry_ski_uses_other_sport_type(self):
        p = build("backcountry_ski", [{"type": "interval", "duration_seconds": 3600, "hr_zone": 2, "note": "Skin up"}])
        assert p["sportType"]["sportTypeKey"] == "other"
        assert p["workoutSegments"][0]["sportType"]["sportTypeId"] == 3
        assert flat_steps(p)[0]["description"] == "Skin up"

    def test_lap_button_when_no_end_condition(self):
        (step,) = flat_steps(build("run", [{"type": "cooldown"}]))
        assert step["endCondition"]["conditionTypeKey"] == "lap.button"
        assert "endConditionValue" not in step

    @pytest.mark.parametrize("sport, step, msg", [
        ("bike", {"type": "interval", "duration_seconds": 60, "pace_slow": "5:00", "pace_fast": "4:30"}, "pace targets"),
        ("strength", {"type": "interval", "duration_seconds": 60, "power_zone": 3}, "power targets"),
        ("run", {"type": "interval", "reps": 10}, "only valid for sport='strength'"),
        ("strength", {"type": "interval", "distance_meters": 100}, "distance_meters is not valid"),
    ])
    def test_sport_specific_validation(self, sport, step, msg):
        with pytest.raises(ValueError, match=msg):
            build(sport, [step])

    @pytest.mark.parametrize("step, msg", [
        ({"type": "interval", "duration_seconds": 60, "hr_zone": 3, "power_zone": 3}, "only one target"),
        ({"type": "interval", "duration_seconds": 60, "distance_meters": 400}, "only one of"),
        ({"type": "interval", "hr_low_bpm": 150}, "needs both"),
        ({"type": "interval", "hr_low_bpm": 170, "hr_high_bpm": 150}, "must be <="),
        ({"type": "interval", "pace_slow": "4:00", "pace_fast": "4:30"}, "slower"),
        ({"type": "repeat", "iterations": 3}, "iterations"),
        ({"type": "repeat", "iterations": 2, "steps": [{"type": "repeat", "iterations": 2, "steps": [{"type": "interval"}]}]}, "nested"),
        ({"type": "repeat", "iterations": 2, "duration_seconds": 30, "steps": [{"type": "interval"}]}, "child steps"),
        ({"type": "interval", "hr_zone": 6}, "less than or equal"),
        ({"type": "interval", "pace_slow": "fast", "pace_fast": "4:00"}, "pattern"),
    ])
    def test_step_validation(self, step, msg):
        with pytest.raises(ValidationError, match=msg):
            server.WorkoutStep(**step)

    def test_bad_schedule_date(self):
        with pytest.raises(ValidationError, match="YYYY-MM-DD"):
            server.CreateWorkoutInput(name="x", sport="run", steps=[{"type": "interval"}], schedule_date="next tuesday")


# ── Workout tools ─────────────────────────────────────────────────────────────

SIMPLE_STEPS = [{"type": "interval", "duration_seconds": 1800, "hr_zone": 2}]


class TestWorkoutTools:
    def test_dry_run_never_touches_garmin(self, monkeypatch):
        def boom():
            raise AssertionError("dry_run must not authenticate or call Garmin")
        monkeypatch.setattr(server, "_get_client", boom)
        out = run(server.garmin_create_workout(server.CreateWorkoutInput(
            name="Easy", sport="run", steps=SIMPLE_STEPS, schedule_date="2026-12-01", dry_run=True)))
        assert out["dry_run"] is True
        assert out["payload"]["workoutName"] == "Easy"

    def test_create_uploads_and_schedules(self, client):
        client.upload_workout.return_value = {"workoutId": 1234, "workoutName": "Easy", "ownerId": 1}
        client.schedule_workout.return_value = {"workoutScheduleId": 999, "calendarDate": "2026-12-01"}
        out = run(server.garmin_create_workout(server.CreateWorkoutInput(
            name="Easy", sport="run", steps=SIMPLE_STEPS, schedule_date="2026-12-01")))

        sent = client.upload_workout.call_args.args[0]
        assert sent["workoutName"] == "Easy" and sent["sportType"]["sportTypeId"] == 1
        client.schedule_workout.assert_called_once_with(1234, "2026-12-01")
        assert out == {"workoutId": 1234, "workoutName": "Easy", "sport": "run",
                       "scheduleId": 999, "scheduledDate": "2026-12-01"}

    def test_create_without_schedule(self, client):
        client.upload_workout.return_value = {"workoutId": 1}
        out = run(server.garmin_create_workout(server.CreateWorkoutInput(name="E", sport="bike", steps=SIMPLE_STEPS)))
        client.schedule_workout.assert_not_called()
        assert out["workoutId"] == 1 and "scheduleId" not in out

    def test_schedule_failure_still_reports_workout_id(self, client):
        client.upload_workout.return_value = {"workoutId": 77}
        client.schedule_workout.side_effect = RuntimeError("calendar down")
        out = run(server.garmin_create_workout(server.CreateWorkoutInput(
            name="E", sport="run", steps=SIMPLE_STEPS, schedule_date="2026-12-01")))
        assert out["workoutId"] == 77
        assert "calendar down" in out["scheduleError"]

    def test_validation_error_returned_as_text(self, client):
        out = asyncio.run(server.garmin_create_workout(server.CreateWorkoutInput(
            name="E", sport="bike", steps=[{"type": "interval", "pace_slow": "5:00", "pace_fast": "4:00"}])))
        assert out.startswith("Error: pace targets")
        client.upload_workout.assert_not_called()

    def test_schedule_tool(self, client):
        client.schedule_workout.return_value = {"workoutScheduleId": 5, "calendarDate": "2026-12-03"}
        out = run(server.garmin_schedule_workout(server.ScheduleWorkoutInput(workout_id=42, date="2026-12-03")))
        client.schedule_workout.assert_called_once_with(42, "2026-12-03")
        assert out == {"scheduleId": 5, "workoutId": 42, "date": "2026-12-03"}

    def test_list_scheduled_spans_months_and_filters(self, client):
        months = {
            (2026, 11): {"calendarItems": [
                {"id": 1, "itemType": "workout", "date": "2026-11-20", "workoutId": 10, "title": "Too early", "sportTypeKey": "running"},
                {"id": 2, "itemType": "workout", "date": "2026-11-29", "workoutId": 11, "title": "Long run", "sportTypeKey": "running"},
                {"id": 3, "itemType": "activity", "date": "2026-11-29", "title": "Not a workout"},
            ]},
            (2026, 12): {"calendarItems": [
                {"id": 4, "itemType": "workout", "date": "2026-12-02", "workoutId": 12, "title": "Strength", "sportTypeKey": "strength_training"},
                {"id": 5, "itemType": "workout", "date": "2026-12-20", "workoutId": 13, "title": "Too late"},
            ]},
        }
        client.get_scheduled_workouts.side_effect = lambda y, m: months[(y, m)]
        out = run(server.garmin_list_scheduled_workouts(
            server.ScheduledRangeInput(start_date="2026-11-25", end_date="2026-12-05")))
        assert [c.args for c in client.get_scheduled_workouts.call_args_list] == [(2026, 11), (2026, 12)]
        assert out == [
            {"date": "2026-11-29", "scheduleId": 2, "workoutId": 11, "title": "Long run", "sport": "running"},
            {"date": "2026-12-02", "scheduleId": 4, "workoutId": 12, "title": "Strength", "sport": "strength_training"},
        ]

    def test_list_scheduled_year_rollover(self):
        assert server._months_between(date(2026, 12, 15), date(2027, 1, 10)) == [(2026, 12), (2027, 1)]

    def test_list_workouts(self, client):
        client.get_workouts.return_value = [
            {"workoutId": 1, "workoutName": "A", "sportType": {"sportTypeKey": "cycling"}, "updatedDate": "2026-11-01"},
        ]
        out = run(server.garmin_list_workouts(server.ListWorkoutsInput(limit=5)))
        client.get_workouts.assert_called_once_with(0, 5)
        assert out == [{"workoutId": 1, "workoutName": "A", "sport": "cycling", "updatedDate": "2026-11-01"}]

    def test_delete_workout(self, client):
        out = run(server.garmin_delete_workout(server.WorkoutIdInput(workout_id=1234)))
        client.delete_workout.assert_called_once_with(1234)
        assert out == {"deleted": True, "workoutId": 1234}

    def test_unschedule_workout(self, client):
        out = run(server.garmin_unschedule_workout(server.ScheduleIdInput(schedule_id=999)))
        client.unschedule_workout.assert_called_once_with(999)
        assert out == {"unscheduled": True, "scheduleId": 999}


# ── Credentials never leak ────────────────────────────────────────────────────

def test_credentials_not_in_output_or_logs(monkeypatch, tmp_path, caplog):
    secret_pw = "hunter2-super-secret"
    monkeypatch.setenv("GARMIN_EMAIL", "someone@example.com")
    monkeypatch.setenv("GARMIN_PASSWORD", secret_pw)
    monkeypatch.setattr(server, "TOKEN_STORE", tmp_path)
    monkeypatch.setattr(server, "_client", None)

    fake_cls = MagicMock()
    fake_cls.return_value.login.side_effect = GarminConnectAuthenticationError("401 Unauthorized")
    monkeypatch.setattr(server, "Garmin", fake_cls)

    caplog.set_level(logging.DEBUG)
    out = asyncio.run(server.garmin_get_hrv(server.HrvRangeInput(date="2026-11-20")))
    assert out.startswith("Error: Authentication failed")
    assert secret_pw not in out
    assert secret_pw not in caplog.text
