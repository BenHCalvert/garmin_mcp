# Garmin Connect MCP Server

Exposes your Garmin Connect data — activities, health metrics, training readiness, and more — as MCP tools for use with Claude and other MCP clients.

YEEEHAW!!!

## Setup

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Set credentials

```bash
export GARMIN_EMAIL=you@example.com
export GARMIN_PASSWORD=yourpassword
```

Tokens are cached at `~/.garmin_tokens/<email>.pkl` after first login so you don't re-authenticate every session. To override the token directory:

```bash
export GARMIN_TOKEN_STORE=/path/to/token/dir
```

If your account has MFA enabled, you'll be prompted for the OTP on first run.

### 3. Run the server

```bash
python server.py
```

Or with the MCP inspector for testing:

```bash
npx @modelcontextprotocol/inspector python server.py
```

## Claude Desktop / Claude Code config

Add to your `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`):

```json
{
  "mcpServers": {
    "garmin": {
      "command": "python",
      "args": ["/path/to/garmin_mcp/server.py"],
      "env": {
        "GARMIN_EMAIL": "you@example.com",
        "GARMIN_PASSWORD": "yourpassword"
      }
    }
  }
}
```

## Available Tools

### Health & Recovery
| Tool | Description |
|------|-------------|
| `garmin_get_stats` | Daily summary: steps, calories, active minutes, stress |
| `garmin_get_sleep` | Sleep stages, duration, sleep score |
| `garmin_get_body_battery` | Body Battery levels over a date range |
| `garmin_get_hrv` | Nightly HRV per day over `start_date`–`end_date`: last-night avg, 7-day avg, baseline range, status (or `date` for one night) |
| `garmin_get_heart_rate` | Resting HR and intraday readings |
| `garmin_get_stress` | Stress levels throughout the day |
| `garmin_get_spo2` | Blood oxygen (SpO2) — useful post-altitude |
| `garmin_get_respiration` | Respiration rate data |
| `garmin_get_training_readiness` | Readiness score combining HRV, sleep, load |

### Activities
| Tool | Description |
|------|-------------|
| `garmin_list_activities` | List recent activities, filterable by type |
| `garmin_get_last_activity` | Most recent activity |
| `garmin_get_activity` | Full details for a specific activity ID |
| `garmin_get_activity_splits` | Lap/split data for an activity |
| `garmin_get_activities_by_date` | Activities within a date range |

### Fitness & Performance
| Tool | Description |
|------|-------------|
| `garmin_get_training_status` | VO2max, training load, recovery time |
| `garmin_get_max_metrics` | VO2 max estimates |
| `garmin_get_personal_records` | All-time PRs across activity types |
| `garmin_get_endurance_score` | Aerobic fitness trend |
| `garmin_get_race_predictions` | Predicted 5K / 10K / half / marathon times |
| `garmin_get_steps` | Daily step counts over a range |
| `garmin_get_weekly_steps` | Weekly step summary |

### Workouts
| Tool | Description |
|------|-------------|
| `garmin_create_workout` | Build a structured run / bike / strength / backcountry ski workout from steps, upload it, and optionally schedule it (`dry_run` previews the payload without uploading) |
| `garmin_schedule_workout` | Put an existing workout on a calendar date so it syncs to your watch |
| `garmin_list_scheduled_workouts` | Workouts on your Garmin calendar in a date range (default: next 30 days) |
| `garmin_list_workouts` | Workouts saved in your Garmin Connect library |
| `garmin_unschedule_workout` | Remove a calendar entry, keeping the workout in the library |
| `garmin_delete_workout` | Permanently delete a workout by ID |

### Account & Devices
| Tool | Description |
|------|-------------|
| `garmin_get_user_profile` | Account profile info |
| `garmin_get_devices` | Connected Garmin devices |

## Workout Steps

Each step has a `type` (`warmup`, `interval`, `recovery`, `rest`, `cooldown`, `repeat`), an optional end condition (`duration_seconds`, `distance_meters`, or `reps` for strength; none means "press lap"), and at most one target:

- Heart rate: `hr_zone` (1–5) or `hr_low_bpm` + `hr_high_bpm`
- Pace (run only): `pace_slow` + `pace_fast` as `"M:SS"`, with `pace_unit` `km` or `mi`
- Power (run/bike): `power_zone` (1–7) or `power_low_watts` + `power_high_watts`

Strength steps also take `exercise_category` / `exercise_name` (Garmin exercise keys, e.g. `SQUAT` / `BARBELL_BACK_SQUAT`) and `weight_kg`. A `repeat` step wraps child `steps` with `iterations` (no nested repeats).

Example: 5 × 3 min in zone 4

```json
{
  "name": "5x3 Z4",
  "sport": "run",
  "schedule_date": "2026-12-01",
  "steps": [
    {"type": "warmup", "duration_seconds": 600, "hr_zone": 2},
    {"type": "repeat", "iterations": 5, "steps": [
      {"type": "interval", "duration_seconds": 180, "hr_zone": 4},
      {"type": "recovery", "duration_seconds": 120, "hr_zone": 1}
    ]},
    {"type": "cooldown", "duration_seconds": 600}
  ]
}
```

**Backcountry ski:** Garmin's workout builder has no ski sport type, so these upload as sport "Other". On the watch, start the Backcountry Ski activity and load the workout from its Training menu.

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

All Garmin calls are mocked; the tests never touch a real account.

## Activity Type Filter Examples

Use `garmin_list_activities` with `activity_type` set to:
- `backcountry_skiing` — ski tours
- `resort_skiing` — resort days
- `cycling` / `mountain_biking`
- `running` / `trail_running`
- `hiking`

## Notes

- Uses the unofficial `garminconnect` Python library by cyberjunky
- The Garmin Connect API is not officially published; Garmin may change it
- Rate limiting: Garmin may throttle heavy API usage
